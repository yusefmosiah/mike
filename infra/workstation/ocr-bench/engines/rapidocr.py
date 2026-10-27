#!/usr/bin/env python3
"""RapidOCR (PP-OCR on ONNX Runtime) runner: image path on argv, one JSON
line on stdout. Result rows are [box, text, confidence].
`engine_ms` times the engine call itself so bench numbers don't include
the `nix shell` wrapper the driver adds around this script."""
import json
import sys
import time

from rapidocr import RapidOCR

engine = RapidOCR()
start = time.perf_counter()
result, _ = engine(sys.argv[1])
engine_ms = (time.perf_counter() - start) * 1000
if not result:
    print(json.dumps({"text": "", "confidence": None, "cells": None, "engine_ms": engine_ms}))
    sys.exit(0)
texts = [r[1] for r in result]
confs = [r[2] for r in result if r[2] is not None]
print(json.dumps({
    "text": "\n".join(texts),
    "confidence": (sum(confs) / len(confs)) if confs else None,
    "cells": None,
    "engine_ms": engine_ms,
}))
