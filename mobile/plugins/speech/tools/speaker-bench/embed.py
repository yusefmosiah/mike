"""Embeds every benchmark clip of a split with one model: embed.py MODEL SPLIT [CONDITIONS...]"""
import glob
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
SPK = os.environ["SPEAKER_BENCH"]  # the working directory: data/, models/, bench/, emb/


def model(name):
    if name == "wespeaker":
        from coreml_embed import WeSpeaker
        return WeSpeaker()
    if name == "campplus_zh":
        from coreml_embed import CamPlusZh
        return CamPlusZh(True)
    if name == "campplus_zh_unfixed":
        from coreml_embed import CamPlusZh
        return CamPlusZh(False)
    import torch_models as tm
    return {"campplus_zh_torch": tm.campplus_zh, "campplus_en": tm.campplus_en, "ecapa": tm.Ecapa, "wespeaker_torch": tm.WeSpeakerTorch}[name]()


def clips(path):
    z = np.load(path)
    audio, lengths = z["audio"].astype(np.float32), z["lengths"]
    offsets = np.concatenate([[0], np.cumsum(lengths)])
    return [audio[offsets[i]:offsets[i + 1]] for i in range(len(lengths))]


def main(name, split, conditions):
    m = model(name)
    os.makedirs(f"{SPK}/emb/{name}", exist_ok=True)
    paths = sorted(glob.glob(f"{SPK}/bench/{split}_*.npz"))
    for path in paths:
        cond = os.path.basename(path)[len(split) + 1:-4]
        if conditions and cond not in conditions and cond != "enrol":
            continue
        out = f"{SPK}/emb/{name}/{split}_{cond}.npy"
        if os.path.exists(out):
            continue
        started = time.time()
        e = m.embed_many(clips(path))
        np.save(out, e.astype(np.float32))
        print(name, split, cond, e.shape, f"{time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
