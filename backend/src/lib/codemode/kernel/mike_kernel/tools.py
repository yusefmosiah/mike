"""The ``tools`` object a cell uses to call Mike's tools.

Each tool is an async function: ``await tools.read_document(doc_id="...")``.
Calling one sends a ``host_request`` of type ``tool`` to the harness, which runs
the call exactly as if the model had made it directly (same permissions, same
events in the chat, same write ordering) and replies with the tool's result.

Results arrive as text. Text that parses as JSON comes back parsed (dicts,
lists); anything else comes back as a string.
"""

from __future__ import annotations

import asyncio
import difflib
import json
import keyword
from typing import Any

from . import repl


class ToolError(Exception):
    """A tool ran and reported an error. ``.tool`` names it; ``.detail`` holds the full reply."""

    def __init__(self, tool: str, message: str, detail: Any = None) -> None:
        super().__init__(f"{tool}: {message}")
        self.tool = tool
        self.detail = detail


class UserQuestionPending(BaseException):
    """The user has been asked a question; this turn ends until they answer.

    A BaseException, so ``except Exception`` in a cell does not swallow it.
    Variables in the session survive; the answer arrives in the next message.
    """


_JSON_TYPES = {
    "string": "str", "integer": "int", "number": "float", "boolean": "bool",
    "array": "list", "object": "dict", "null": "None",
}


def _type_name(schema: dict[str, Any]) -> str:
    kind = schema.get("type")
    if isinstance(kind, list):
        return " | ".join(_JSON_TYPES.get(k, str(k)) for k in kind)
    if "enum" in schema and isinstance(schema["enum"], list):
        return " | ".join(json.dumps(v) for v in schema["enum"][:8])
    return _JSON_TYPES.get(kind, "Any") if isinstance(kind, str) else "Any"


def _parse(content: Any) -> Any:
    if not isinstance(content, str):
        return content
    text = content.strip()
    if text[:1] in ("{", "[", '"') or text in ("true", "false", "null") or text[:1].isdigit():
        try:
            return json.loads(text)
        except ValueError:
            pass
    return content


def _error_message(value: Any) -> str | None:
    """The error a tool reported, when its whole result is an error object."""
    if isinstance(value, dict) and isinstance(value.get("error"), str) and value.get("ok") is not True:
        return value["error"]
    return None


class _NotAwaited:
    """Placeholder returned by a tool call; reminds the cell to ``await`` it."""

    __slots__ = ("_name", "_coro")

    def __init__(self, name: str, coro: Any) -> None:
        self._name = name
        self._coro = coro

    def __await__(self) -> Any:
        coro, self._coro = self._coro, None
        if coro is None:
            raise RuntimeError(f"tools.{self._name}(...) was already awaited")
        _unawaited.discard(id(self))
        return coro.__await__()

    def _hint(self) -> RuntimeError:
        return RuntimeError(f"tools.{self._name}(...) is async: write `await tools.{self._name}(...)`")

    def __getattr__(self, name: str) -> Any:
        raise self._hint()

    def __getitem__(self, key: Any) -> Any:
        raise self._hint()

    def __iter__(self) -> Any:
        raise self._hint()

    def __bool__(self) -> bool:
        raise self._hint()

    def __repr__(self) -> str:
        return f"<tools.{self._name}(...) not awaited: write `await tools.{self._name}(...)`>"

    def __del__(self) -> None:
        coro = getattr(self, "_coro", None)
        if coro is not None:
            coro.close()  # never started, so nothing was sent


_unawaited: set[int] = set()


def _py_name(name: str) -> str:
    """A parameter as Python spells it: a keyword gets a trailing underscore (``from`` → ``from_``)."""
    return f"{name}_" if keyword.iskeyword(name) else name


class Tool:
    """One callable tool. ``help(tools.name)`` shows its parameters."""

    def __init__(self, spec: dict[str, Any]) -> None:
        self.name: str = spec["name"]
        self.description: str = str(spec.get("description") or "")
        params = spec.get("parameters") if isinstance(spec.get("parameters"), dict) else {}
        props = params.get("properties") if isinstance(params.get("properties"), dict) else {}
        required = [p for p in params.get("required") or [] if p in props]
        self.parameters: dict[str, dict[str, Any]] = props
        self.required: list[str] = required
        self.order: list[str] = required + [p for p in props if p not in required]
        self.__name__ = self.name
        self.__qualname__ = f"tools.{self.name}"
        self.__doc__ = self._doc()

    def signature(self) -> str:
        parts = []
        for name in self.order:
            schema = self.parameters.get(name) or {}
            parts.append(f"{_py_name(name)}: {_type_name(schema)}" + ("" if name in self.required else " = ..."))
        return f"{self.name}({', '.join(parts)})"

    def _doc(self) -> str:
        lines = [f"await tools.{self.signature()}", ""]
        if self.description:
            lines += [self.description, ""]
        for name in self.order:
            schema = self.parameters.get(name) or {}
            text = str(schema.get("description") or "").strip()
            flag = "required" if name in self.required else "optional"
            lines.append(f"  {_py_name(name)} ({_type_name(schema)}, {flag}){': ' + text if text else ''}")
        return "\n".join(lines).rstrip()

    def __repr__(self) -> str:
        return f"<tool {self.signature()}>"

    def _args(self, args: tuple[Any, ...], kwargs: dict[str, Any]) -> dict[str, Any]:
        if len(args) == 1 and not kwargs and isinstance(args[0], dict) and not (
            len(self.order) == 1 and _type_name(self.parameters[self.order[0]]) != "dict"
        ):
            # tools.x({"a": 1}) reads as the arguments object, as in JavaScript.
            return dict(args[0])
        if len(args) > len(self.order):
            raise TypeError(f"{self.signature()} takes at most {len(self.order)} positional arguments")
        merged = dict(zip(self.order, args))
        for key, value in kwargs.items():
            # from_=... is how Python passes a parameter named with a keyword.
            if key.endswith("_") and keyword.iskeyword(key[:-1]) and key[:-1] in self.parameters:
                key = key[:-1]
            if key in merged:
                raise TypeError(f"tools.{self.name}() got multiple values for {key!r}")
            merged[key] = value
        unknown = [key for key in merged if key not in self.parameters]
        if unknown and self.parameters:
            hints = []
            for key in unknown:
                close = difflib.get_close_matches(key, list(self.parameters), n=1)
                hints.append(f"{key!r}" + (f" (did you mean {close[0]!r}?)" if close else ""))
            raise TypeError(f"tools.{self.name}() got unknown arguments {', '.join(hints)}; signature: {self.signature()}")
        missing = [key for key in self.required if key not in merged]
        if missing:
            raise TypeError(f"tools.{self.name}() is missing {', '.join(missing)}; signature: {self.signature()}")
        return merged

    def __call__(self, *args: Any, **kwargs: Any) -> _NotAwaited:
        arguments = self._args(args, kwargs)
        call = _NotAwaited(self.name, self._run(arguments))
        _unawaited.add(id(call))
        return call

    async def _run(self, arguments: dict[str, Any]) -> Any:
        try:
            json.dumps(arguments, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise TypeError(f"tools.{self.name}() arguments must be JSON values: {exc}") from None
        reply = await repl.host_request({"type": "tool", "name": self.name, "args": arguments})
        if reply.get("paused"):
            raise UserQuestionPending(str(reply.get("message") or "Waiting for the user's answer."))
        if reply.get("ok") is False:
            raise ToolError(self.name, str(reply.get("error") or "failed"), reply)
        value = _parse(reply.get("content"))
        message = _error_message(value)
        if message is not None:
            raise ToolError(self.name, message, value)
        return value


class Tools:
    """Every tool this conversation may call, as ``tools.<name>``.

    ``tools.search("word")`` finds tools by name or description;
    ``help(tools.<name>)`` shows one tool's parameters.
    """

    def __init__(self, specs: list[dict[str, Any]]) -> None:
        self._tools: dict[str, Tool] = {}
        for spec in specs:
            name = spec.get("name") if isinstance(spec, dict) else None
            if isinstance(name, str) and name.isidentifier() and not keyword.iskeyword(name):
                self._tools[name] = Tool(spec)

    def __getattr__(self, name: str) -> Tool:
        if name.startswith("_"):
            raise AttributeError(name)
        tool = self._tools.get(name)
        if tool is None:
            close = difflib.get_close_matches(name, list(self._tools), n=3)
            hint = f" Did you mean {', '.join(close)}?" if close else ' Try tools.search("...").'
            raise AttributeError(f"No tool named {name!r}.{hint}")
        return tool

    def __dir__(self) -> list[str]:
        return sorted(self._tools)

    def __iter__(self) -> Any:
        return iter(sorted(self._tools))

    def __len__(self) -> int:
        return len(self._tools)

    def __contains__(self, name: object) -> bool:
        return name in self._tools

    def __repr__(self) -> str:
        return f"<tools: {', '.join(sorted(self._tools))}>"

    def search(self, query: str = "", limit: int = 20) -> list[str]:
        """Signatures and one-line summaries of tools whose name or description mentions every word of ``query``."""
        words = query.lower().split()
        found = []
        for name in sorted(self._tools):
            tool = self._tools[name]
            haystack = f"{name} {tool.description}".lower()
            if all(word in haystack for word in words):
                summary = tool.description.strip().split("\n", 1)[0][:160]
                found.append(f"{tool.signature()} — {summary}" if summary else tool.signature())
        return found[:limit]

    async def gather(self, *calls: Any, return_exceptions: bool = False) -> list[Any]:
        """Run several tool calls at once: ``a, b = await tools.gather(tools.x(...), tools.y(...))``."""
        return await asyncio.gather(*calls, return_exceptions=return_exceptions)


def unawaited_warning() -> str | None:
    """Called after each cell: name tool calls the cell made but never awaited."""
    if not _unawaited:
        return None
    count = len(_unawaited)
    _unawaited.clear()
    return f"Warning: {count} tool call(s) were never awaited and did not run. Write `await tools.name(...)`.\n"


def install(ns: dict[str, Any], specs: list[dict[str, Any]]) -> int:
    """Bind ``tools``, ``ToolError``, ``UserQuestionPending`` and ``emit`` in the cell namespace."""
    ns["tools"] = Tools(specs)
    ns["ToolError"] = ToolError
    ns["UserQuestionPending"] = UserQuestionPending
    ns["emit"] = repl.emit
    return len(ns["tools"])
