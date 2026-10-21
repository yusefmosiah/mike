"""The two shipped speaker models, run exactly as the app runs them (Core ML,
repeat-padding, last 10 s, unit length)."""
import os

import numpy as np
import coremltools as ct

SCRATCH = os.environ["SPEAKER_BENCH_MODELS"]  # holds speaker/ and speaker-campplus/ (the compiled Core ML models)
WIN = 160_000


def _repeat(x, n):
    reps = int(np.ceil(n / len(x)))
    return np.tile(x, reps)[:n].astype(np.float32)


def _unit(v):
    v = np.asarray(v, dtype=np.float32).reshape(-1)
    return v / max(np.linalg.norm(v), 1e-9)


class WeSpeaker:
    name = "wespeaker"
    dim = 256

    def __init__(self, units=ct.ComputeUnit.CPU_AND_GPU):
        self.m = ct.models.CompiledMLModel(f"{SCRATCH}/speaker/wespeaker_v2.mlmodelc", units)

    def embed_many(self, clips):
        # The three rows are speaker masks over one shared window (it is a
        # diarization model), so each clip is its own call, as in the app.
        out = []
        for c in clips:
            wave = np.zeros((3, WIN), np.float32)
            mask = np.zeros((3, 589), np.float32)
            wave[0] = _repeat(c[-WIN:], WIN)
            mask[0] = 1
            out.append(_unit(np.array(self.m.predict({"waveform": wave, "mask": mask})["embedding"][0], copy=True)))
        return np.stack(out)


class CamPlusZh:
    dim = 192

    def __init__(self, mean_norm=True):
        # mean_norm=False is the app before the fix (the converted preprocessor alone).
        self.mean_norm = mean_norm
        self.name = "campplus_zh" if mean_norm else "campplus_zh_unfixed"
        d = f"{SCRATCH}/speaker-campplus"
        self.pre = ct.models.CompiledMLModel(f"{d}/CamPlusPreprocessor.mlmodelc", ct.ComputeUnit.CPU_ONLY)
        self.m = ct.models.CompiledMLModel(f"{d}/CamPlusPlus.mlmodelc", ct.ComputeUnit.CPU_AND_NE)

    def embed_many(self, clips):
        out = []
        for c in clips:
            c = c[-WIN:]
            if len(c) < 16_000:
                c = _repeat(c, 16_000)
            # Copy at once: Core ML may reuse the output buffer on the next call.
            feats = np.array(self.pre.predict({"waveform": c[None, :].astype(np.float32)})["features"], copy=True)
            if self.mean_norm:
                feats = feats - feats.mean(1, keepdims=True)
            e = np.array(self.m.predict({"feats": np.ascontiguousarray(feats, dtype=np.float32)})["embedding"], copy=True)
            out.append(_unit(e))
        return np.stack(out)
