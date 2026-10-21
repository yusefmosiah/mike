"""Writes the trained joined space (head.py lda lda_ws_zh wespeaker campplus_zh)
as the plugin's SpeakerFusion/speaker-fusion.bin (format in SpeakerFusion.swift).

Usage: export_fusion.py OUT.bin
"""
import os
import struct
import sys

import numpy as np

SPK = os.environ["SPEAKER_BENCH"]

h = np.load(f"{SPK}/models/heads/lda_ws_zh.npz")
means = [h["mean_wespeaker"].astype("<f4"), h["mean_campplus_zh"].astype("<f4")]
projection = np.ascontiguousarray(h["projection"].astype("<f4"))
assert means[0].shape == (256,) and means[1].shape == (192,) and projection.shape[0] == 448
with open(sys.argv[1], "wb") as f:
    f.write(b"SPKF" + struct.pack("<4I", 1, 256, 192, projection.shape[1]))
    for part in (*means, projection):
        f.write(part.tobytes())
