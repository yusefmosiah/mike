#!/usr/bin/env python3
"""LightOnOCR-3 runner (1B VLM; escalation candidate, not a bulk engine).

Runs through transformers in the venv: `pip install transformers torch`.
LIGHTON_MODEL overrides the model id (default lightonai/LightOnOCR-3-1B).
Confident-hallucination risk means this engine's scores need an extra look
at pages where it disagrees with itself on re-runs.
"""
import json
import os
import sys

MODEL = os.environ.get("LIGHTON_MODEL", "lightonai/LightOnOCR-3-1B")

try:
    import torch  # noqa: F401
    from transformers import AutoProcessor, AutoModelForVision2Seq
except ImportError:
    print(json.dumps({"ok": False, "error": "transformers/torch not installed in the venv"}))
    sys.exit(0)

processor = AutoProcessor.from_pretrained(MODEL)
model = AutoModelForVision2Seq.from_pretrained(MODEL, torch_dtype="float32")
inputs = processor(images=sys.argv[1], text="Extract all text from this page, preserving layout.",
                   return_tensors="pt")
out = model.generate(**inputs, max_new_tokens=4096)
text = processor.batch_decode(out[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
print(json.dumps({"text": text, "confidence": None, "cells": None}))
