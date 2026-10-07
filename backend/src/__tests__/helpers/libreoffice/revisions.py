"""Accept or reject all tracked changes with LibreOffice and export text.

An independent reader for the .docx tests: LibreOffice parses our tracked
changes with its own importer, applies Accept All / Reject All, and writes
the result as plain text (one line per paragraph).

Usage: python3 revisions.py JOBS.json
JOBS.json is a list of groups; each group is a list of
{"in": path, "mode": "accept"|"reject"|"none", "out": path}.
Each group runs in its own LibreOffice process: documents opened earlier in
a session can change how LibreOffice recalculates cross-reference fields in
later ones, so unrelated documents never share a process.
Prints one JSON line per job: {"out": path, "ok": bool, "error"?: str}.
"""

import json
import os
import subprocess
import sys
import tempfile
import time

import uno
from com.sun.star.beans import PropertyValue


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def connect(pipe):
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    for _ in range(120):
        try:
            return resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext")
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("LibreOffice did not start")


def main():
    groups = json.load(open(sys.argv[1]))
    for group in groups:
        run_group(group)


def run_group(jobs):
    profile = tempfile.mkdtemp(prefix="lo-profile-")
    pipe = f"mike_lo_{os.getpid()}"
    proc = subprocess.Popen(
        [
            "soffice",
            "--headless",
            "--invisible",
            "--norestore",
            "--nologo",
            f"-env:UserInstallation=file://{profile}",
            f"--accept=pipe,name={pipe};urp;",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ctx = connect(pipe)
        smgr = ctx.ServiceManager
        desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
        for job in jobs:
            try:
                url = uno.systemPathToFileUrl(os.path.abspath(job["in"]))
                doc = desktop.loadComponentFromURL(url, "_blank", 0, (prop("Hidden", True),))
                if doc is None:
                    raise RuntimeError("could not open")
                frame = doc.getCurrentController().getFrame()
                if job["mode"] == "accept":
                    dispatcher.executeDispatch(frame, ".uno:AcceptAllTrackedChanges", "", 0, ())
                elif job["mode"] == "reject":
                    dispatcher.executeDispatch(frame, ".uno:RejectAllTrackedChanges", "", 0, ())
                # Accept/Reject All makes LibreOffice recompute cross-reference
                # fields (with its own numbering) only when something changed;
                # refresh every document so both sides of a comparison agree.
                doc.getTextFields().refresh()
                out = uno.systemPathToFileUrl(os.path.abspath(job["out"]))
                doc.storeToURL(out, (prop("FilterName", "Text (encoded)"), prop("FilterOptions", "UTF8,LF,,,")))
                doc.close(True)
                print(json.dumps({"out": job["out"], "ok": True}), flush=True)
            except Exception as e:  # noqa: BLE001 - report and continue
                print(json.dumps({"out": job["out"], "ok": False, "error": str(e)}), flush=True)
    finally:
        try:
            desktop.terminate()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main()
