#!/usr/bin/env python3
"""Tesseract runner: image path on argv, one JSON line on stdout.

One TSV pass is enough: the word column rebuilds the page text and the
confidence column is the mean word score — no second plain-text run.
`engine_ms` times the subprocess itself so bench numbers don't include
the `nix shell` wrapper the driver adds around this script.
"""
import json
import subprocess
import sys
import time

start = time.perf_counter()
out = subprocess.run(
    ["tesseract", sys.argv[1], "stdout", "--psm", "3", "tsv"],
    capture_output=True, text=True,
)
engine_ms = (time.perf_counter() - start) * 1000
if out.returncode != 0:
    print(json.dumps({"ok": False, "error": out.stderr[-300:], "engine_ms": engine_ms}))
    sys.exit(0)

# TSV: level page block par line word left top width height conf text.
words = [l.split("\t") for l in out.stdout.splitlines()[1:] if l.strip()]
confs = [
    float(w[10])
    for w in words
    if len(w) > 11 and w[10].replace("-", "").replace(".", "").isdigit() and float(w[10]) >= 0
]
# Word-level rows are level 5; joining their text approximates tesseract's
# own plain-text output closely enough for CER.
texts = [w[11] for w in words if len(w) > 11 and w[0] == "5"]
print(json.dumps({
    "text": " ".join(texts),
    "confidence": (sum(confs) / len(confs) / 100) if confs else None,
    "cells": None,
    "engine_ms": engine_ms,
}))
