#!/usr/bin/env python3
"""RapidOCR (PP-OCR on ONNX Runtime) runner: image path on argv, one JSON
line on stdout. Result rows are [box, text, confidence]."""
import json
import sys

from rapidocr import RapidOCR

engine = RapidOCR()
result, _ = engine(sys.argv[1])
if not result:
    print(json.dumps({"text": "", "confidence": None, "cells": None}))
    sys.exit(0)
texts = [r[1] for r in result]
confs = [r[2] for r in result if r[2] is not None]
print(json.dumps({
    "text": "\n".join(texts),
    "confidence": (sum(confs) / len(confs)) if confs else None,
    "cells": None,
}))
