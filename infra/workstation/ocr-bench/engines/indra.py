#!/usr/bin/env python3
"""Indra OCR runner (pip wheel; license unsettled — benchmark only).

Expects INDRA_WHEEL already installed in the invoking venv
(`pip install "$INDRA_WHEEL"`). Emits per-line boxes + confidence when the
API exposes them; interface follows the released package docs
(2026-10-13) — adjust `from indra_ocr import ...` if the wheel's name
differs.
"""
import json
import os
import sys
import time

try:
    from indra_ocr import IndraOCR  # wheel: datalab-indra-ocr
except ImportError:
    print(json.dumps({"ok": False, "error": "indra_ocr not installed; set INDRA_WHEEL and pip install it in the venv"}))
    sys.exit(0)

engine = IndraOCR()
start = time.perf_counter()
result = engine.recognize(sys.argv[1])
engine_ms = (time.perf_counter() - start) * 1000
texts, confs = [], []
for line in getattr(result, "lines", result if isinstance(result, list) else []):
    texts.append(line.text if hasattr(line, "text") else line[0])
    conf = getattr(line, "confidence", None)
    if conf is not None:
        confs.append(conf)
print(json.dumps({
    "text": "\n".join(texts),
    "confidence": (sum(confs) / len(confs)) if confs else None,
    "cells": None,
    "engine_ms": engine_ms,
}))
