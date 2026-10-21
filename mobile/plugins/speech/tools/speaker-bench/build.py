"""Builds the owner-voice benchmark clips (deterministic, saved as float16 npz).

Protocol (per speaker, LibriSpeech test-* for the eval split, dev-* for fitting):
  enrol: 3 crops of 1.5-3 s from 3 utterances of one chapter (one setup session), always clean.
  test:  6 crops each of 0.5/1/2/4 s from other utterances, other chapters when the speaker has them.
Conditions applied to the test crops:
  clean
  tv{10,5,0}: a broadcast voice (VoxConverse, else MUSAN speech) through a room (real RIR) and a
              loudspeaker band (150 Hz-7 kHz) under the speech, at that signal-to-interference ratio
  talker5:    another person in the room (MUSAN speech, near-field) at 5 dB
  babble5, music5, noise5: MUSAN at 5 dB SNR
  far:        the speech itself through a room and a loudspeaker band: as an impostor, a TV voice;
              as the owner, the owner across the room
Plus a TTS impostor set (macOS voices), for the assistant's own echo.

Usage: build.py SPLIT   (test | dev)
"""
import glob
import json
import os
import subprocess
import sys
import zlib

import numpy as np
import soundfile as sf
from scipy.signal import butter, fftconvolve, sosfiltfilt

SPK = os.environ["SPEAKER_BENCH"]  # the working directory: data/, models/, bench/, emb/
DATA = f"{SPK}/data"
OUT = f"{SPK}/bench"
SR = 16_000
DURATIONS = [0.5, 1.0, 2.0, 4.0]
PER_DURATION = 6
CONDITIONS = ["clean", "tv10", "tv5", "tv0", "talker5", "babble5", "music5", "noise5", "far"]


def rng_for(*keys):
    return np.random.default_rng(zlib.crc32("/".join(map(str, keys)).encode()))


def read(path):
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(1)
    if sr != SR:
        from scipy.signal import resample_poly
        x = resample_poly(x, SR, sr).astype(np.float32)
    return x


def voiced_crop(x, seconds, rng, min_voiced=0.8):
    """A crop of `seconds` mostly voiced (frame energy within 20 dB of the loud frames)."""
    n = int(seconds * SR)
    if len(x) <= n:
        return np.tile(x, n // max(len(x), 1) + 1)[:n]
    frame = 400
    k = len(range(0, len(x) - frame, frame))
    energy = (x[:k * frame].reshape(k, frame) ** 2).mean(1) + 1e-10
    db = 10 * np.log10(energy)
    voiced = db > np.percentile(db, 90) - 20
    best, best_frac = 0, -1.0
    for _ in range(30):
        start = int(rng.integers(0, len(x) - n))
        a, b = start // frame, (start + n) // frame
        frac = voiced[a:b].mean() if b > a else 0
        if frac >= min_voiced:
            return x[start:start + n]
        if frac > best_frac:
            best, best_frac = start, frac
    return x[best:best + n]


def speakers(split):
    genders = {}
    for line in open(f"{DATA}/LibriSpeech/SPEAKERS.TXT"):
        if line.startswith(";"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) >= 2:
            genders[parts[0]] = parts[1]
    out = {}
    for sub in (f"{split}-clean", f"{split}-other"):
        for spk in sorted(os.listdir(f"{DATA}/LibriSpeech/{sub}")):
            chapters = {}
            for ch in sorted(os.listdir(f"{DATA}/LibriSpeech/{sub}/{spk}")):
                chapters[ch] = sorted(glob.glob(f"{DATA}/LibriSpeech/{sub}/{spk}/{ch}/*.flac"))
            out[spk] = {"gender": genders.get(spk, "?"), "chapters": chapters}
    return out


# --- interference material -------------------------------------------------

def musan(kind, split):
    files = sorted(glob.glob(f"{DATA}/musan/{kind}/**/*.wav", recursive=True))
    # Disjoint halves for dev and test, so a fit never sees the test's interferers.
    return files[0::2] if split == "dev" else files[1::2]


def rirs(split):
    files = sorted(glob.glob(f"{DATA}/RIRS_NOISES/real_rirs_isotropic_noises/*.wav"))
    files = [f for f in files if "noise" not in os.path.basename(f)]
    return files[0::2] if split == "dev" else files[1::2]


def broadcast_voices(split):
    """Single-speaker stretches of VoxConverse (news and debates) of 5 s or more."""
    wavs = sorted(glob.glob(f"{DATA}/voxconverse/**/*.wav", recursive=True))
    if not wavs:
        return None
    rttm_dir = glob.glob(f"{DATA}/voxconverse-labels/test") or glob.glob(f"{DATA}/voxconverse-labels/*")
    pieces = []
    for wav in wavs[0::2] if split == "dev" else wavs[1::2]:
        name = os.path.splitext(os.path.basename(wav))[0]
        rttm = glob.glob(f"{DATA}/voxconverse-labels/**/{name}.rttm", recursive=True)
        if not rttm:
            continue
        segs = []
        for line in open(rttm[0]):
            p = line.split()
            segs.append((float(p[3]), float(p[3]) + float(p[4]), p[7]))
        segs.sort()
        for i, (s, e, who) in enumerate(segs):
            overlap = any(o[2] != who and o[0] < e and o[1] > s for o in segs[max(0, i - 5):i + 5])
            if e - s >= 5 and not overlap:
                pieces.append((wav, s, e))
    return pieces


class Interference:
    def __init__(self, split):
        self.split = split
        self.speech = musan("speech", split)
        self.music = musan("music", split)
        self.noise = musan("noise", split)
        self.rirs = [read(f) for f in rirs(split)[:60]]
        self.broadcast = broadcast_voices(split)
        self.cache = {}
        self.band = butter(4, [150, 7000], btype="bandpass", fs=SR, output="sos")

    def piece(self, files, n, rng):
        """A mostly voiced crop from a random 20 s (or longer) window of a random file
        (read alone: whole MUSAN files cached ran to gigabytes)."""
        path = files[int(rng.integers(len(files)))]
        if path not in self.cache:
            self.cache[path] = sf.info(path)
        info = self.cache[path]
        want = int(max(20.0, 3 * n / SR) * info.samplerate)
        start = int(rng.integers(0, max(1, info.frames - want)))
        x, sr = sf.read(path, start=start, frames=want, dtype="float32", always_2d=True)
        x = x.mean(1)
        if sr != SR:
            from scipy.signal import resample_poly
            x = resample_poly(x, SR, sr).astype(np.float32)
        return voiced_crop(x, n / SR, rng, min_voiced=0.5)

    def room(self, x, rng):
        """Through a real room and a loudspeaker's band."""
        rir = self.rirs[int(rng.integers(len(self.rirs)))]
        rir = rir[np.argmax(np.abs(rir)):][: SR // 2]
        y = fftconvolve(x, rir)[: len(x)]
        y = sosfiltfilt(self.band, y).astype(np.float32)
        return y

    def tv_voice(self, n, rng):
        if self.broadcast:
            wav, s, e = self.broadcast[int(rng.integers(len(self.broadcast)))]
            info = sf.info(wav)
            start = s + rng.uniform(0, max(0, e - s - n / SR))
            x, sr = sf.read(wav, start=int(start * info.samplerate), frames=int(n / SR * info.samplerate) + 1,
                            dtype="float32", always_2d=True)
            x = x.mean(1)
            if sr != SR:
                from scipy.signal import resample_poly
                x = resample_poly(x, SR, sr).astype(np.float32)
            x = np.pad(x, (0, max(0, n - len(x))))[:n]
        else:
            x = self.piece(self.speech, n, rng)
        return self.room(x, rng)


def mix(target, other, ratio_db):
    pt = np.mean(target ** 2) + 1e-10
    po = np.mean(other ** 2) + 1e-10
    return (target + other * np.sqrt(pt / (po * 10 ** (ratio_db / 10)))).astype(np.float32)


def apply(condition, x, inter, rng):
    n = len(x)
    if condition == "clean":
        return x
    if condition.startswith("tv"):
        return mix(x, inter.tv_voice(n, rng), float(condition[2:]))
    if condition == "talker5":
        return mix(x, inter.piece(inter.speech, n, rng), 5)
    if condition == "babble5":
        babble = sum(inter.piece(inter.speech, n, rng) for _ in range(4))
        return mix(x, babble, 5)
    if condition == "music5":
        return mix(x, inter.piece(inter.music, n, rng), 5)
    if condition == "noise5":
        return mix(x, inter.piece(inter.noise, n, rng), 5)
    if condition == "far":
        y = inter.room(x, rng)
        return (y * np.sqrt((np.mean(x ** 2) + 1e-10) / (np.mean(y ** 2) + 1e-10))).astype(np.float32)
    raise ValueError(condition)


def normalise(x):
    peak = np.max(np.abs(x)) + 1e-9
    return (x / peak * 0.5).astype(np.float32) if peak > 1 else x


def save(path, clips, meta):
    lengths = np.array([len(c) for c in clips])
    np.savez(path, audio=np.concatenate(clips).astype(np.float16), lengths=lengths)
    json.dump(meta, open(path.replace(".npz", ".json"), "w"))


def build(split, only=()):
    os.makedirs(OUT, exist_ok=True)
    spk = speakers(split)
    enrol, enrol_meta, tests, test_meta = [], [], [], []
    for s, info in spk.items():
        rng = rng_for(split, s, "plan")
        chapters = sorted(info["chapters"], key=lambda c: -len(info["chapters"][c]))
        home = chapters[0]
        utts = list(info["chapters"][home])
        rng.shuffle(utts)
        for u in utts[:3]:
            enrol.append(voiced_crop(read(u), float(rng.uniform(1.5, 3.0)), rng))
            enrol_meta.append({"spk": s})
        others = [u for c in chapters[1:] for u in info["chapters"][c]]
        cross = len(others) >= 4
        pool = others if cross else utts[3:]
        for d in DURATIONS:
            for _ in range(PER_DURATION):
                u = pool[int(rng.integers(len(pool)))]
                tests.append(voiced_crop(read(u), d, rng))
                test_meta.append({"spk": s, "dur": d, "gender": info["gender"], "cross_chapter": cross})
    save(f"{OUT}/{split}_enrol.npz", enrol, enrol_meta)
    inter = Interference(split)
    print(split, len(spk), "speakers", len(enrol), "enrol", len(tests), "tests; broadcast pieces",
          len(inter.broadcast or []), "rirs", len(inter.rirs), flush=True)
    for condition in CONDITIONS:
        if only and condition not in only:
            continue
        clips = [normalise(apply(condition, x, inter, rng_for(split, condition, i))) for i, x in enumerate(tests)]
        save(f"{OUT}/{split}_{condition}.npz", clips, test_meta)
        print(" ", condition, flush=True)
    if not only or "tts" in only:
        build_tts(split)


def build_tts(split):
    """The assistant's own voice as heard back: macOS voices saying assistant-like sentences."""
    voices = []
    for line in subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout.splitlines():
        name, _, rest = line.partition("en_")
        if "en_" in line:
            voices.append(line.split("  ")[0].strip())
    voices = sorted(set(voices))
    voices = voices[0::2] if split == "dev" else voices[1::2]
    sentences = [
        "Under the lease, the tenant must give ninety days written notice before leaving.",
        "I found three clauses that cover repairs, and the landlord pays for structural work.",
        "Let me check the contract for the termination date and get back to you.",
        "The agreement was signed in March and renews every year unless either side objects.",
    ]
    tmp = f"{OUT}/tts_tmp.aiff"
    clips, meta = [], []
    for v in voices:
        for i, text in enumerate(sentences):
            if subprocess.run(["say", "-v", v, "-o", tmp, text], capture_output=True).returncode != 0:
                break
            x = read(tmp)
            rng = rng_for(split, "tts", v, i)
            d = DURATIONS[i % len(DURATIONS)]
            clips.append(normalise(voiced_crop(x, d, rng)))
            meta.append({"spk": f"tts:{v}", "dur": d, "gender": "?", "cross_chapter": True})
    if clips:
        save(f"{OUT}/{split}_tts.npz", clips, meta)
    print("  tts", len(voices), "voices", len(clips), "clips", flush=True)


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2:])
