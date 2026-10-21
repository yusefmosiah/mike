"""Scores the benchmark: per model and fusion, per condition and duration.

Every threshold and every fusion weight is fitted on the dev speakers and
reported on the test speakers (speaker-disjoint LibriSpeech splits).
"""
import json
import os
import sys
from itertools import combinations

import numpy as np
from sklearn.linear_model import LogisticRegression

SPK = os.environ["SPEAKER_BENCH"]  # the working directory: data/, models/, bench/, emb/
TARGET_CONDITIONS = ["clean", "tv10", "tv5", "tv0", "talker5", "babble5", "music5", "noise5", "far"]
DURATIONS = [0.5, 1.0, 2.0, 4.0]


def meta(split, cond):
    return json.load(open(f"{SPK}/bench/{split}_{cond}.json"))


def emb(model, split, cond):
    path = f"{SPK}/emb/{model}/{split}_{cond}.npy"
    return np.load(path) if os.path.exists(path) else None


def centroids(model, split):
    e = emb(model, split, "enrol")
    e = e / np.linalg.norm(e, axis=1, keepdims=True)
    who = [m["spk"] for m in meta(split, "enrol")]
    spk = sorted(set(who))
    c = np.stack([e[[i for i, w in enumerate(who) if w == s]].mean(0) for s in spk])
    return spk, c / np.linalg.norm(c, axis=1, keepdims=True)


class Trials:
    """Every (enrolled speaker, test clip) pair of a condition, with labels."""

    def __init__(self, split, cond, speakers):
        m = meta(split, cond)
        self.dur = np.array([x["dur"] for x in m])
        test_spk = np.array([x["spk"] for x in m])
        gender = {x["spk"]: x["gender"] for x in meta(split, "clean")}
        test_gender = np.array([gender.get(s, "?") for s in test_spk])
        self.target = test_spk[None, :] == np.array(speakers)[:, None]
        self.same_gender = test_gender[None, :] == np.array([gender[s] for s in speakers])[:, None]
        self.cond = cond

    def labels(self, mask=None):
        return self.target if mask is None else self.target[mask]


_cohorts = {}


def cohort(model):
    """Each train-clean-100 speaker's centroid (none of them in dev or test)."""
    if model not in _cohorts:
        e = emb(model, "train", "aug")
        who = np.array([m["spk"] for m in meta("train", "aug")])
        e = e / np.linalg.norm(e, axis=1, keepdims=True)
        c = np.stack([e[who == s].mean(0) for s in sorted(set(who))])
        _cohorts[model] = c / np.linalg.norm(c, axis=1, keepdims=True)
    return _cohorts[model]


def raw_scores(model, split, cond, top=100):
    """Cosine to each enrolled centroid; MODEL+as is adaptive s-norm against the cohort."""
    base, _, norm = model.partition("+")
    spk, c = centroids(base, split)
    t = emb(base, split, cond)
    if t is None:
        return None
    t = t / np.linalg.norm(t, axis=1, keepdims=True)
    s = c @ t.T
    if norm != "as":
        return s
    k = cohort(base)
    ce, ct = np.sort(c @ k.T, 1)[:, -top:], np.sort(t @ k.T, 1)[:, -top:]
    me, se = ce.mean(1)[:, None], ce.std(1)[:, None]
    mt, st = ct.mean(1)[None, :], ct.std(1)[None, :]
    return 0.5 * ((s - me) / se + (s - mt) / st)


def eer(tar, non):
    s = np.concatenate([tar, non])
    y = np.concatenate([np.ones(len(tar)), np.zeros(len(non))])
    order = np.argsort(s)
    y = y[order]
    frr = np.cumsum(y) / len(tar)
    far = 1 - np.cumsum(1 - y) / len(non)
    i = np.argmin(np.abs(frr - far))
    return (frr[i] + far[i]) / 2


def at_far(tar, non, far):
    th = np.quantile(non, 1 - far)
    return np.mean(tar < th)


def threshold_for_frr(tar, frr):
    return np.quantile(tar, frr)


# --- systems ---------------------------------------------------------------

class System:
    """A scorer: f(scores by model, durations) -> score (higher is the owner)."""

    def __init__(self, name, models, fn):
        self.name, self.models, self.fn = name, models, fn


def single(model):
    return System(model, [model], lambda s, d: s[model])


def average(models):
    return System("avg(" + "+".join(models) + ")", models, lambda s, d: sum(s[m] for m in models) / len(models))


def lr_fusion(models, dev, qmf=False):
    """Logistic-regression fusion fitted on the dev trials (all conditions, balanced)."""
    def features(s, d):
        cols = [s[m] for m in models]
        if qmf:
            ld = np.log(d)
            cols += [s[m] * ld for m in models] + [ld]
        return np.stack([c.ravel() for c in cols], 1)

    xs, ys = [], []
    for cond, (scores, trials) in dev.items():
        if cond == "tts":
            continue
        d = np.broadcast_to(trials.dur[None, :], trials.target.shape)
        xs.append(features(scores, d))
        ys.append(trials.target.ravel())
    x, y = np.concatenate(xs), np.concatenate(ys)
    clf = LogisticRegression(class_weight="balanced", C=1.0, max_iter=1000).fit(x, y)
    name = ("lrq(" if qmf else "lr(") + "+".join(models) + ")"
    system = System(name, models, lambda s, d: clf.decision_function(
        features(s, np.broadcast_to(d, next(iter(s.values())).shape))).reshape(next(iter(s.values())).shape))
    system.weights = clf.coef_.ravel().tolist() + [float(clf.intercept_[0])]
    return system


# --- evaluation ------------------------------------------------------------

def load_split(models, split):
    speakers = centroids(models[0].partition("+")[0], split)[0]
    out = {}
    for cond in TARGET_CONDITIONS + ["tts"]:
        if not os.path.exists(f"{SPK}/bench/{split}_{cond}.json"):
            continue
        scores = {m: raw_scores(m, split, cond) for m in models}
        if any(v is None for v in scores.values()):
            continue
        out[cond] = (scores, Trials(split, cond, speakers))
    return out


def system_scores(system, data):
    out = {}
    for cond, (scores, trials) in data.items():
        out[cond] = system.fn({m: scores[m] for m in system.models}, trials.dur[None, :])
    return out


def report(systems, dev, test, file):
    rows = []
    for system in systems:
        sd, st = system_scores(system, dev), system_scores(system, test)
        # Operating point fitted on dev: miss the owner in 2 % of clean 1-2 s turns.
        tr = dev["clean"][1]
        sel = np.isin(tr.dur, [1.0, 2.0])[None, :] & np.ones_like(tr.target)
        th = threshold_for_frr(sd["clean"][tr.target & sel], 0.02)
        row = {"system": system.name, "threshold": float(th)}
        for cond in TARGET_CONDITIONS:
            if cond not in st:
                continue
            s, t = st[cond], test[cond][1]
            for d in DURATIONS:
                col = t.dur[None, :] == d
                tar, non = s[t.target & col], s[~t.target & col]
                non_sg = s[~t.target & col & t.same_gender]
                row[f"{cond}/{d}/eer"] = eer(tar, non)
                row[f"{cond}/{d}/frr@far1"] = at_far(tar, non, 0.01)
                row[f"{cond}/{d}/frr@far5sg"] = at_far(tar, non_sg, 0.05)
                row[f"{cond}/{d}/frr"] = float(np.mean(tar < th))
                row[f"{cond}/{d}/far_sg"] = float(np.mean(non_sg >= th))
        if "tts" in st:
            s, t = st["tts"], test["tts"][1]
            for d in DURATIONS:
                col = (t.dur[None, :] == d) & np.ones_like(t.target)
                row[f"tts/{d}/far"] = float(np.mean(s[col] >= th))
        rows.append(row)
    json.dump(rows, open(file, "w"), indent=1)
    return rows


def table(rows, metric, conds=TARGET_CONDITIONS, durs=(0.5, 1.0, 2.0, 4.0)):
    head = "| system | " + " | ".join(f"{c} {d:g}s" for c in conds for d in durs) + " |"
    lines = [head, "|" + "---|" * (1 + len(conds) * len(durs))]
    for r in rows:
        cells = [f"{100 * r[k]:.1f}" if (k := f"{c}/{d}/{metric}") in r else "–" for c in conds for d in durs]
        lines.append(f"| {r['system']} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


if __name__ == "__main__":
    # score.py MODEL... [--fuse a,b --fuse a,b,c ...] [--out results.json]
    argv = sys.argv[1:]
    models, fuse, out = [], [], f"{SPK}/results.json"
    while argv:
        a = argv.pop(0)
        if a == "--fuse":
            fuse.append(argv.pop(0).split(","))
        elif a == "--out":
            out = argv.pop(0)
        else:
            models.append(a)
    every = sorted({m for group in fuse for m in group} | set(models), key=(models + [m for g in fuse for m in g]).index)
    dev, test = load_split(every, "dev"), load_split(every, "test")
    systems = [single(m) for m in models]
    for group in fuse:
        if len(group) == 2:
            systems.append(average(group))
        systems += [lr_fusion(group, dev), lr_fusion(group, dev, qmf=True)]
    rows = report(systems, dev, test, out)
    print("conditions:", list(test))
    for metric in ("eer", "frr@far1", "frr", "far_sg"):
        print(f"\n## {metric} (%)\n")
        print(table(rows, metric))
    print("\n## TTS false accepts at the dev threshold (%)\n")
    print(table(rows, "far", conds=["tts"]))
    for s in systems:
        if hasattr(s, "weights"):
            print(s.name, "weights", np.round(s.weights, 3).tolist())
