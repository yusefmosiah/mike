#!/usr/bin/env python3
"""PaddleOCR (PP-OCRv6) runner: image path on argv, one JSON line on stdout."""
import json
import sys

from paddleocr import PaddleOCR

ocr = PaddleOCR(use_textline_orientation=False, use_doc_orientation_classify=False, use_doc_unwarping=False)
result = ocr.ocr(sys.argv[1])
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
}))
