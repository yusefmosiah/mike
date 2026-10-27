#!/usr/bin/env python3
"""PaddleOCR (PP-OCRv6) runner: image path on argv, one JSON line on stdout.
`engine_ms` times the engine call itself so bench numbers don't include
the `nix shell` wrapper the driver adds around this script."""
import json
import sys
import time

from paddleocr import PaddleOCR

ocr = PaddleOCR(use_textline_orientation=False, use_doc_orientation_classify=False, use_doc_unwarping=False)
start = time.perf_counter()
result = ocr.ocr(sys.argv[1])
engine_ms = (time.perf_counter() - start) * 1000
texts, confs = [], []
for page in result or []:
    for line in (page[0] if page and page[0] else []):
        box, (text, conf) = line
        texts.append(text)
        if conf is not None:
            confs.append(conf)
print(json.dumps({
    "text": "\n".join(texts),
    "confidence": (sum(confs) / len(confs)) if confs else None,
    "cells": None,
    "engine_ms": engine_ms,
}))
