#!/usr/bin/env python3
"""Tesseract runner: image path on argv, one JSON line on stdout.

Tesseract gives no per-line confidence via the CLI cheaply, so confidence
is null (escalation flags fall back to empty-text and table-density).
"""
import json
import subprocess
import sys

out = subprocess.run(
    ["tesseract", sys.argv[1], "stdout", "--psm", "3", "tsv"],
    capture_output=True, text=True,
)
if out.returncode != 0:
    print(json.dumps({"ok": False, "error": out.stderr[-300:]}))
    sys.exit(0)

# TSV: level page block par line word left top width height conf text.
# Mean of word confidences is our per-page confidence signal.
words = [l.split("\t") for l in out.stdout.splitlines()[1:] if l.strip()]
confs = [float(w[10]) for w in words if len(w) > 11 and w[10].replace("-", "").replace(".", "").isdigit() and float(w[10]) >= 0]
text = subprocess.run(
    ["tesseract", sys.argv[1], "stdout", "--psm", "3"],
    capture_output=True, text=True,
).stdout
print(json.dumps({
    "text": text,
    "confidence": (sum(confs) / len(confs) / 100) if confs else None,
    "cells": None,
}))
