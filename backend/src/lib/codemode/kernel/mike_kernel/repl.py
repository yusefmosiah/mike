"""Mike's code-mode kernel: a persistent CPython REPL speaking JSON lines.

Entry point: ``python3 -u -m mike_kernel``. The harness (Mike's backend) runs
one per conversation inside the employee's workstation VM and talks to it over
the process's stdin and stdout, which ssh carries over vsock. PROTOCOL.md next
to this file is the wire contract.

The design follows Prime Agent's ``rlm.repl`` (protocol version 3) and OMP's
Python runner, both MIT licensed: newline-delimited JSON instead of Jupyter,
top-level ``await`` on one persistent event loop, tool calls sent back to the
host on the same channel (``host_request`` / ``host_reply``), and namespace
snapshots with dill. This implementation is Mike's own.

Everything here runs inside the VM, which the harness treats as untrusted: the
harness validates every frame it reads. What this file guarantees is framing:
nothing a cell prints can corrupt the protocol stream.
"""

from __future__ import annotations

import ast
import asyncio
import contextvars
import inspect
import json
import linecache
import os
import platform
import signal
import sys
import threading
import time
import traceback
import types
import uuid
from typing import Any

PROTOCOL_VERSION = 1

# One protocol frame stays bounded no matter what a cell does.
_STREAM_CHUNK = 64 * 1024
_TEXT_CAP = 1_000_000
_PAYLOAD_CAP = 8 * 1024 * 1024
_FENCE_TIMEOUT_S = 2.0

DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 32 * 1024 * 1024
_SNAPSHOT_MAGIC = b"MIKE-KERNEL-SNAPSHOT-1\n"

# Names the session re-creates on start (tools.install) or that never pickle
# usefully; never snapshotted.
_SKIP_NAMES = {
    "__builtins__", "__name__", "__doc__", "__loader__", "__spec__", "__package__",
    "tools", "ToolError", "UserQuestionPending", "emit", "In", "Out", "exit", "quit",
}

_protocol_fd = -1
_host_stderr_fd = -1
_write_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_main_thread_id = threading.get_ident()

# The cell whose code is running; asyncio tasks copy it at creation, so a
# task a cell starts keeps writing under that cell's id.
_current_cell: contextvars.ContextVar[str | None] = contextvars.ContextVar("_current_cell", default=None)
_active_lock = threading.Lock()
_active_rid: str | None = None
_active_task: asyncio.Task[Any] | None = None
_interrupted: set[str] = set()
_pending_interrupts: set[str] = set()
_cell_counter = 0

_pending_host: dict[str, asyncio.Future[dict[str, Any]]] = {}
_host_closed = False
_last_snapshot: dict[str, Any] | None = None


# --------------------------------------------------------------------------
# Framing


def _send(frame: dict[str, Any]) -> None:
    """Write one frame with a single locked write, so frames never interleave."""
    data = (json.dumps(frame, separators=(",", ":"), default=str) + "\n").encode()
    with _write_lock:
        view = memoryview(data)
        try:
            while view:
                view = view[os.write(_protocol_fd, view):]
        except OSError as err:
            try:
                os.write(_host_stderr_fd, f"mike_kernel: dropped frame: {err}\n".encode())
            except OSError:
                pass


def _cap(text: str, cap: int = _TEXT_CAP) -> str:
    if len(text) <= cap:
        return text
    return text[:cap] + f"\n[... truncated at {cap} characters ...]"


def _check_payload(kind: str, data: dict[str, Any]) -> None:
    # allow_nan=False: NaN would serialize as bare text and break the host's JSON.
    if len(json.dumps(data, allow_nan=False)) > _PAYLOAD_CAP:
        raise ValueError(f"{kind} payload exceeds {_PAYLOAD_CAP} characters")


def emit(data: dict[str, Any]) -> None:
    """Send a display frame: a dict of MIME type to JSON value, e.g. {"text/markdown": "..."}."""
    if not isinstance(data, dict) or not data or not all(isinstance(k, str) for k in data):
        raise TypeError("emit() needs a non-empty dict keyed by MIME type")
    _check_payload("display", data)
    _send({"event": "display", "id": _current_cell.get(), "data": data})


# --------------------------------------------------------------------------
# Output capture
#
# Python-level writes (print, sys.stdout.write) are tagged with the writing
# context's cell. Raw writes to fds 1 and 2 (subprocesses, C extensions) are
# read from pipes by pump threads and attributed to the cell running when the
# bytes arrive. Before a cell's `done`, a fence marker is written to each pipe
# and awaited, so everything the cell wrote synchronously precedes `done`.


class _TaggedWriter:
    def __init__(self, stream: str, fd: int) -> None:
        self._stream = stream
        self._fd = fd
        self.encoding = "utf-8"
        self.errors = "replace"

    def write(self, text: Any) -> int:
        if not isinstance(text, str):
            text = str(text)
        if not text:
            return 0
        cell = _current_cell.get()
        for start in range(0, len(text), _STREAM_CHUNK):
            _send({"event": self._stream, "id": cell, "text": text[start:start + _STREAM_CHUNK]})
        return len(text)

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fd

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def readable(self) -> bool:
        return False


class _Pump:
    def __init__(self, read_fd: int, write_fd: int, stream: str) -> None:
        self._read_fd = read_fd
        self._write_fd = write_fd
        self._stream = stream
        self._buffer = b""
        self._fences: dict[bytes, threading.Event] = {}
        self._lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()

    def fence(self) -> None:
        marker = f"\x00mike-fence-{uuid.uuid4().hex}\x00".encode()
        seen = threading.Event()
        with self._lock:
            self._fences[marker] = seen
        try:
            os.write(self._write_fd, marker)
        except OSError:
            return
        seen.wait(_FENCE_TIMEOUT_S)
        with self._lock:
            self._fences.pop(marker, None)

    def _run(self) -> None:
        while True:
            try:
                chunk = os.read(self._read_fd, _STREAM_CHUNK)
            except OSError:
                return
            if not chunk:
                return
            self._buffer += chunk
            with self._lock:
                for marker, seen in list(self._fences.items()):
                    index = self._buffer.find(marker)
                    if index != -1:
                        self._emit(self._buffer[:index])
                        self._buffer = self._buffer[index + len(marker):]
                        seen.set()
            # Keep a short tail back in case a fence marker is split across reads.
            keep = 64 if b"\x00" in self._buffer[-64:] else 0
            ready, self._buffer = (self._buffer[:-keep], self._buffer[-keep:]) if keep else (self._buffer, b"")
            self._emit(ready)

    def _emit(self, data: bytes) -> None:
        if not data:
            return
        with _active_lock:
            cell = _active_rid
        _send({"event": self._stream, "id": cell, "text": data.decode("utf-8", "replace")})


_pump_out: _Pump | None = None
_pump_err: _Pump | None = None


def _drain_output() -> None:
    for pump in (_pump_out, _pump_err):
        if pump is not None:
            pump.fence()


# --------------------------------------------------------------------------
# Host bridge


async def host_request(data: dict[str, Any]) -> dict[str, Any]:
    """Send one request to the host and await its reply dict (used by tools.py)."""
    if _loop is None:
        raise RuntimeError("the kernel is not serving")
    if _host_closed:
        raise RuntimeError("the host connection is closed")
    _check_payload("host_request", data)
    rid = uuid.uuid4().hex
    future: asyncio.Future[dict[str, Any]] = _loop.create_future()
    _pending_host[rid] = future
    try:
        _send({"event": "host_request", "id": rid, "cell": _current_cell.get(), "data": data})
        return await future
    finally:
        _pending_host.pop(rid, None)


def _resolve_host_reply(rid: str, data: dict[str, Any]) -> None:
    def deliver() -> None:
        future = _pending_host.get(rid)
        if future is not None and not future.done():
            future.set_result(data)

    assert _loop is not None
    _loop.call_soon_threadsafe(deliver)


def _fail_pending_host_requests() -> None:
    global _host_closed
    _host_closed = True
    for future in _pending_host.values():
        if not future.done():
            future.set_exception(RuntimeError("the host connection is closed"))


# --------------------------------------------------------------------------
# Interrupts
#
# The reader thread turns an `interrupt` request into SIGINT on the main
# thread, where the loop and every cell run. The handler raises
# KeyboardInterrupt when the cell's own task is mid-step (synchronous code,
# time.sleep, a blocking call), and otherwise cancels the cell's task, which
# is then waiting at an await.


def _sigint_handler(signum: int, frame: types.FrameType | None) -> None:
    with _active_lock:
        rid, task = _active_rid, _active_task
        if rid is None or task is None or task.done():
            return
        _interrupted.add(rid)
    running = None
    if _loop is not None and _loop.is_running():
        try:
            running = asyncio.current_task(_loop)
        except RuntimeError:
            running = None
    if running is task:
        raise KeyboardInterrupt
    # The loop is idle in select(); call_soon_threadsafe wakes it.
    assert _loop is not None
    _loop.call_soon_threadsafe(task.cancel)


def _request_interrupt(rid: str | None) -> None:
    with _active_lock:
        active = _active_rid
        if active is None or (rid is not None and rid != active):
            if rid is not None:
                _pending_interrupts.add(rid)
            return
    signal.pthread_kill(_main_thread_id, signal.SIGINT)


# --------------------------------------------------------------------------
# Execution


def _compile_cell(code: str, filename: str) -> tuple[types.CodeType | None, types.CodeType | None]:
    """The cell body, and its trailing expression compiled separately for its value."""
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    try:
        tree = ast.parse(code, filename, "exec")
    except SyntaxError as original:
        # Some models send a whole cell on one line with literal "\n" escapes
        # for its newlines. Repair only when the cell has no real newline and
        # the repaired text parses.
        if "\n" in code or "\\n" not in code:
            raise
        repaired = code.replace("\\n", "\n")
        try:
            tree = ast.parse(repaired, filename, "exec")
        except SyntaxError:
            raise original from None
        linecache.cache[filename] = (len(repaired), None, repaired.splitlines(True), filename)
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    body = compile(tree, filename, "exec", flags=flags) if tree.body else None
    expr = compile(last, filename, "eval", flags=flags) if last is not None else None
    return body, expr


async def _run_code(code: types.CodeType, ns: dict[str, Any]) -> Any:
    result = eval(code, ns)  # noqa: S307 - running the cell is the point
    if code.co_flags & 0x80:  # CO_COROUTINE: the cell used top-level await
        result = await result
    return result


class _CellExit(Exception):
    """Carries SystemExit or KeyboardInterrupt out of a cell's task.

    asyncio re-raises those two out of the event loop itself, which would end
    the kernel; wrapped, they end only the cell.
    """

    def __init__(self, original: BaseException) -> None:
        super().__init__(original)
        self.original = original


async def _run_cell(body: types.CodeType | None, expr: types.CodeType | None, ns: dict[str, Any]) -> Any:
    try:
        if body is not None:
            await _run_code(body, ns)
        if expr is None:
            return None
        value = await _run_code(expr, ns)
        if inspect.isawaitable(value):
            # A cell ending in `tools.x(...)` without await means "run it".
            value = await value
        return value
    except (SystemExit, KeyboardInterrupt) as exc:
        raise _CellExit(exc) from None


_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))


def _cell_frames(exc: BaseException) -> list[str]:
    """Traceback lines with this runtime's own frames removed."""
    frames = [
        frame for frame in traceback.extract_tb(exc.__traceback__)
        if os.path.dirname(frame.filename) != _PACKAGE_DIR
        and not frame.filename.endswith(("asyncio/tasks.py", "asyncio/events.py"))
    ]
    lines = ["Traceback (most recent call last):\n"] if frames else []
    lines += traceback.format_list(frames)
    lines += traceback.format_exception_only(type(exc), exc)
    return [_cap(line, 20_000) for line in lines[-60:]]


async def _handle_execute(req: dict[str, Any], ns: dict[str, Any]) -> None:
    global _cell_counter, _active_rid, _active_task
    rid = req["id"]
    _cell_counter += 1
    filename = f"<cell-{_cell_counter}>"
    code = req["code"]
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    token = _current_cell.set(rid)
    status = "ok"
    try:
        try:
            body, expr = _compile_cell(code, filename)
        except SyntaxError as exc:
            _send({"event": "error", "id": rid, "ename": "SyntaxError", "evalue": _cap(str(exc), 20_000),
                   "traceback": traceback.format_exception_only(type(exc), exc)})
            status = "error"
            return
        task = asyncio.get_running_loop().create_task(_run_cell(body, expr, ns))
        with _active_lock:
            _active_rid, _active_task = rid, task
            interrupt_now = rid in _pending_interrupts
            _pending_interrupts.discard(rid)
        if interrupt_now:
            _request_interrupt(rid)
        try:
            value = await asyncio.shield(task)
        except asyncio.CancelledError:
            if not task.done():
                task.cancel()
                try:
                    await task
                except BaseException:  # noqa: BLE001
                    pass
            _send({"event": "error", "id": rid, "ename": "KeyboardInterrupt", "evalue": "interrupted", "traceback": []})
            status = "error"
            return
        except _CellExit as exc:
            if isinstance(exc.original, KeyboardInterrupt):
                _send({"event": "error", "id": rid, "ename": "KeyboardInterrupt", "evalue": "interrupted", "traceback": []})
            else:
                _send({"event": "error", "id": rid, "ename": "SystemExit", "evalue": _safe_str(exc.original),
                       "traceback": []})
            status = "error"
            return
        except BaseException as exc:  # noqa: BLE001 - every cell failure is reported, SystemExit included
            _send({"event": "error", "id": rid, "ename": type(exc).__name__, "evalue": _cap(_safe_str(exc), 20_000),
                   "traceback": _cell_frames(exc)})
            status = "error"
            return
        if value is not None:
            ns["_"] = value
            try:
                text = repr(value)
            except BaseException as exc:  # noqa: BLE001
                text = f"<repr failed: {type(exc).__name__}>"
            _send({"event": "result", "id": rid, "text": _cap(text)})
    finally:
        warning = _unawaited_tool_calls()
        if warning:
            _send({"event": "stderr", "id": rid, "text": warning})
        _drain_output()
        with _active_lock:
            _active_rid, _active_task = None, None
            _interrupted.discard(rid)
        _current_cell.reset(token)
        _send({"event": "done", "id": rid, "status": status})


def _unawaited_tool_calls() -> str | None:
    tools_module = sys.modules.get("mike_kernel.tools")
    return tools_module.unawaited_warning() if tools_module is not None else None


def _safe_str(exc: BaseException) -> str:
    try:
        return str(exc)
    except BaseException:  # noqa: BLE001
        return f"<{type(exc).__name__}>"


# --------------------------------------------------------------------------
# Snapshot / restore
#
# The payload is a sequence of (name, kind, bytes) records written atomically.
# Modules are recorded by import name and re-imported; everything else is
# pickled with dill one name at a time, so one unpicklable value (an open
# socket, a generator) costs only that name.


def _snapshot(ns: dict[str, Any], path: str, max_bytes: int, max_variable_bytes: int) -> dict[str, Any]:
    import pickle

    import dill  # imported lazily: the kernel runs without it, minus snapshots

    saved: list[str] = []
    skipped: list[dict[str, str]] = []
    records: list[tuple[str, str, bytes]] = []
    total = 0
    for name, value in list(ns.items()):
        if name.startswith("_") or name in _SKIP_NAMES:
            continue
        if isinstance(value, types.ModuleType):
            records.append((name, "module", value.__name__.encode()))
            saved.append(name)
            continue
        try:
            blob = dill.dumps(value, recurse=True)
        except BaseException as exc:  # noqa: BLE001
            skipped.append({"name": name, "reason": f"{type(exc).__name__}: {_safe_str(exc)}"[:200]})
            continue
        if len(blob) > max_variable_bytes:
            skipped.append({"name": name, "reason": f"{len(blob)} bytes is over the per-variable limit"})
            continue
        if total + len(blob) > max_bytes:
            skipped.append({"name": name, "reason": "the snapshot is full"})
            continue
        total += len(blob)
        records.append((name, "dill", blob))
        saved.append(name)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as fh:
        fh.write(_SNAPSHOT_MAGIC)
        pickle.dump(records, fh, protocol=pickle.HIGHEST_PROTOCOL)
    os.replace(tmp, path)
    return {"saved": saved, "skipped": skipped, "bytes": total}


def _restore(ns: dict[str, Any], path: str) -> dict[str, Any]:
    import importlib
    import pickle

    if not os.path.exists(path):
        return {"restored": [], "failed": [], "reason": "snapshot not found"}
    import dill

    with open(path, "rb") as fh:
        if fh.read(len(_SNAPSHOT_MAGIC)) != _SNAPSHOT_MAGIC:
            return {"restored": [], "failed": [], "reason": "not a Mike kernel snapshot"}
        records = pickle.load(fh)  # noqa: S301 - written by this kernel into the VM's own disk
    restored: list[str] = []
    failed: list[dict[str, str]] = []
    for name, kind, blob in records:
        try:
            ns[name] = importlib.import_module(blob.decode()) if kind == "module" else dill.loads(blob)
            restored.append(name)
        except BaseException as exc:  # noqa: BLE001
            failed.append({"name": name, "reason": f"{type(exc).__name__}: {_safe_str(exc)}"[:200]})
    return {"restored": restored, "failed": failed}


async def _handle_state(req: dict[str, Any], ns: dict[str, Any]) -> None:
    global _last_snapshot
    rid = req["id"]
    path = os.path.expanduser(req["path"])
    try:
        if req["type"] == "snapshot":
            limits = {
                "max_bytes": int(req.get("max_bytes") or DEFAULT_SNAPSHOT_MAX_BYTES),
                "max_variable_bytes": int(req.get("max_variable_bytes") or DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES),
            }
            outcome = _snapshot(ns, path, **limits)
            _last_snapshot = {"path": path, **limits}
        else:
            outcome = _restore(ns, path)
        _send({"event": "done", "id": rid, "status": "ok", **outcome})
    except BaseException as exc:  # noqa: BLE001
        _send({"event": "done", "id": rid, "status": "error", "reason": f"{type(exc).__name__}: {_safe_str(exc)}"[:500]})


def _handle_configure(req: dict[str, Any], ns: dict[str, Any]) -> None:
    from . import tools

    specs = req.get("tools")
    if not isinstance(specs, list):
        _send({"event": "done", "id": req["id"], "status": "error", "reason": "configure needs a tools list"})
        return
    count = tools.install(ns, specs)
    _send({"event": "done", "id": req["id"], "status": "ok", "tools": count})


def _list_names(ns: dict[str, Any]) -> list[str]:
    return sorted(name for name in ns if not name.startswith("_") and name not in _SKIP_NAMES)


# --------------------------------------------------------------------------
# Serving

_REQUIRED = {
    "execute": ("id", "code"),
    "snapshot": ("id", "path"),
    "restore": ("id", "path"),
    "list_names": ("id",),
    "configure": ("id",),
    "shutdown": (),
}


def _protocol_error(message: str) -> None:
    _send({"event": "error", "id": None, "ename": "ProtocolError", "evalue": message, "traceback": []})


async def _serve(queue: asyncio.Queue[dict[str, Any]], ns: dict[str, Any]) -> None:
    while True:
        req = await queue.get()
        rtype = req["type"]
        if rtype == "shutdown":
            if req.get("eof") and _last_snapshot is not None:
                # The host went away without a goodbye (its process restarted):
                # the last chance to keep this conversation's variables.
                try:
                    _snapshot(ns, _last_snapshot["path"], _last_snapshot["max_bytes"], _last_snapshot["max_variable_bytes"])
                except BaseException:  # noqa: BLE001
                    pass
            if isinstance(req.get("id"), str):
                _send({"event": "done", "id": req["id"], "status": "ok"})
            return
        if rtype == "execute":
            await _handle_execute(req, ns)
        elif rtype in ("snapshot", "restore"):
            await _handle_state(req, ns)
        elif rtype == "configure":
            _handle_configure(req, ns)
        elif rtype == "list_names":
            _send({"event": "done", "id": req["id"], "status": "ok", "names": _list_names(ns)})


def _handle_line(raw: bytes, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    req = json.loads(raw)
    if not isinstance(req, dict):
        raise ValueError("a request must be a JSON object")
    rtype = req.get("type")
    if rtype == "interrupt":
        rid = req.get("id")
        _request_interrupt(rid if isinstance(rid, str) else None)
        return
    if rtype == "host_reply":
        rid, data = req.get("id"), req.get("data")
        if isinstance(rid, str) and isinstance(data, dict):
            _resolve_host_reply(rid, data)
        else:
            _protocol_error("host_reply needs a string id and a dict data")
        return
    if rtype not in _REQUIRED:
        _protocol_error(f"unknown request type: {rtype!r}")
        return
    missing = [field for field in _REQUIRED[rtype] if not isinstance(req.get(field), str)]
    if missing:
        _protocol_error(f"{rtype} needs string fields: {', '.join(missing)}")
        return
    if rtype == "shutdown":
        _loop.call_soon_threadsafe(_fail_pending_host_requests)
    _loop.call_soon_threadsafe(queue.put_nowait, req)


def _read_requests(stdin_fd: int, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    with os.fdopen(stdin_fd, "rb") as stream:
        for raw in stream:
            raw = raw.strip()
            if not raw:
                continue
            try:
                _handle_line(raw, queue)
            except BaseException as err:  # noqa: BLE001 - hostile input must not kill the reader
                _protocol_error(f"{type(err).__name__}: {_safe_str(err)}"[:500])
    # stdin closed: the host is gone.
    _loop.call_soon_threadsafe(_fail_pending_host_requests)
    _loop.call_soon_threadsafe(queue.put_nowait, {"type": "shutdown", "eof": True})


def _setup_fds() -> int:
    """Keep the real stdout for frames; route fds 1 and 2 through captured pipes."""
    global _protocol_fd, _host_stderr_fd, _pump_out, _pump_err
    _protocol_fd = os.dup(1)
    os.set_inheritable(_protocol_fd, False)
    _host_stderr_fd = os.dup(2)
    os.set_inheritable(_host_stderr_fd, False)
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    os.dup2(out_w, 1)
    os.dup2(err_w, 2)
    os.close(out_w)
    os.close(err_w)
    stdin_fd = os.dup(0)
    os.set_inheritable(stdin_fd, False)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(os.devnull)  # input() sees EOF, never a protocol frame
    sys.stdout = _TaggedWriter("stdout", 1)
    sys.stderr = _TaggedWriter("stderr", 2)
    _pump_out = _Pump(out_r, 1, "stdout")
    _pump_err = _Pump(err_r, 2, "stderr")
    return stdin_fd


def main() -> None:
    global _loop
    stdin_fd = _setup_fds()
    sys.modules.setdefault("mike_kernel.repl", sys.modules[__name__])
    # A real __main__ module, so dill pickles cell-defined functions and classes by value.
    user_module = types.ModuleType("__main__")
    user_module.__dict__["__builtins__"] = __builtins__
    sys.modules["__main__"] = user_module
    os.environ.setdefault("MPLBACKEND", "Agg")

    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    signal.signal(signal.SIGINT, _sigint_handler)
    threading.Thread(target=_read_requests, args=(stdin_fd, queue), daemon=True).start()
    _send({"event": "ready", "protocol": PROTOCOL_VERSION, "python": platform.python_version(), "pid": os.getpid(),
           "started_at": time.time()})
    serve = _loop.create_task(_serve(queue, user_module.__dict__))
    # A KeyboardInterrupt raised inside a cell's step escapes run_until_complete
    # after the cell task has recorded it; keep serving.
    while not serve.done():
        try:
            _loop.run_until_complete(serve)
        except KeyboardInterrupt:
            continue
    _loop.close()
