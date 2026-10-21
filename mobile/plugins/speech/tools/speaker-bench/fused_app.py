"""The LDA head as the app would run it: project each model's stored centroid
(not each enrolment turn), and fit the threshold on dev."""
import json, sys
import numpy as np
sys.path.insert(0, ".")
import score as sc

SPK = sc.SPK
h = np.load(f"{SPK}/models/heads/lda_ws_zh.npz")
mu = [h["mean_wespeaker"], h["mean_campplus_zh"]]
P = h["projection"]
unit = lambda x: x / np.linalg.norm(x, axis=-1, keepdims=True)

def proj(ws, zh):
    x = np.concatenate([unit(unit(ws) - mu[0]), unit(unit(zh) - mu[1])], -1)
    return unit(x @ P)

def scores(split, cond):
    _, cw = sc.centroids("wespeaker", split)
    _, cz = sc.centroids("campplus_zh", split)
    c = proj(cw, cz)
    t = proj(sc.emb("wespeaker", split, cond), sc.emb("campplus_zh", split, cond))
    return c @ t.T

speakers = sc.centroids("wespeaker", "dev")[0]
tr = sc.Trials("dev", "clean", speakers)
sd = scores("dev", "clean")
sel = np.isin(tr.dur, [1.0, 2.0])[None, :] & np.ones_like(tr.target)
th = float(np.quantile(sd[tr.target & sel], 0.02))
print("dev threshold (2% clean misses at 1-2 s):", round(th, 4))
for name, fn in (("fused-from-centroids", scores),):
    tspk = sc.centroids("wespeaker", "test")[0]
    out = []
    for cond in sc.TARGET_CONDITIONS:
        t = sc.Trials("test", cond, tspk); s = fn("test", cond)
        row = []
        for d in (1.0, 2.0):
            col = t.dur[None, :] == d
            row.append(100 * sc.at_far(s[t.target & col], s[~t.target & col], 0.01))
        out.append((cond, row))
    print(name, "FRR@FAR1 1s/2s:", " ".join(f"{c} {a:.1f}/{b:.1f}" for c, (a, b) in out))
    print("  mean 1s %.1f  2s %.1f" % (np.mean([r[0] for _, r in out]), np.mean([r[1] for _, r in out])))
    t = sc.Trials("test", "tts", tspk); s = fn("test", "tts")
    print("  TTS FA at threshold %.1f%%, clean miss %.1f%%, clean same-gender FA %.1f%%" % (
        100 * np.mean(s >= th),
        100 * np.mean(fn("test", "clean")[sc.Trials("test", "clean", tspk).target & (sc.Trials("test","clean",tspk).dur[None,:] >= 1)] < th),
        100 * np.mean(fn("test", "clean")[~sc.Trials("test","clean",tspk).target & sc.Trials("test","clean",tspk).same_gender & (sc.Trials("test","clean",tspk).dur[None,:] >= 1)] >= th)))
# WeSpeaker's own dev threshold, for the record
sw = sc.raw_scores("wespeaker", "dev", "clean")
print("wespeaker dev threshold:", round(float(np.quantile(sw[tr.target & sel], 0.02)), 4))
sz = sc.raw_scores("campplus_zh", "dev", "clean")
print("campplus_zh dev threshold:", round(float(np.quantile(sz[tr.target & sel], 0.02)), 4))
