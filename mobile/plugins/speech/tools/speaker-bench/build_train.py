"""Training clips for a fusion head: LibriSpeech train-clean-100 (251 speakers, none
in dev or test), 40 crops each of 0.5-4 s, each under a random condition. The
interferers and rooms are the dev halves, so the test's are never seen."""
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import build as b

PER_SPEAKER = 40
WEIGHTED = ["clean"] * 4 + ["tv10", "tv5", "tv0", "talker5", "babble5", "music5", "noise5", "far", "far"]


def main():
    root = f"{b.DATA}/LibriSpeech/train-clean-100"
    inter = b.Interference("dev")
    clips, meta = [], []
    for s in sorted(os.listdir(root)):
        utts = sorted(glob.glob(f"{root}/{s}/*/*.flac"))
        rng = b.rng_for("train", s)
        for i in range(PER_SPEAKER):
            d = float(rng.choice(b.DURATIONS))
            x = b.voiced_crop(b.read(utts[int(rng.integers(len(utts)))]), d, rng)
            cond = str(rng.choice(WEIGHTED))
            clips.append(b.normalise(b.apply(cond, x, inter, b.rng_for("train", s, i, cond))))
            meta.append({"spk": s, "dur": d, "cond": cond})
        print(s, len(clips), flush=True)
    b.save(f"{b.OUT}/train_aug.npz", clips, meta)


if __name__ == "__main__":
    main()
