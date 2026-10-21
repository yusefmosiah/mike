"""Post-training on top of frozen speaker models: a small head over their
concatenated embeddings, trained on the augmented train-clean-100 clips.

  head.py KIND NAME MODEL...     KIND: mean | lda | linear | mlp

  mean:   subtract the train mean from each model's embedding, renormalise
  lda:    the above, then LDA+WCCN on the concatenation (classic back end)
  linear: a linear projection trained with AAM-softmax over the 251 speakers
  mlp:    one hidden layer (ReLU), same loss

Writes emb/NAME/{split}_{cond}.npy for test and dev, so score.py scores it
like any model, plus models/heads/NAME.npz with the weights.
"""
import glob
import json
import os
import sys

import numpy as np

SPK = os.environ["SPEAKER_BENCH"]  # the working directory: data/, models/, bench/, emb/


def unit(x):
    return x / np.maximum(np.linalg.norm(x, axis=-1, keepdims=True), 1e-9)


def load(models, split, cond):
    return [np.load(f"{SPK}/emb/{m}/{split}_{cond}.npy") for m in models]


def centre(parts, means):
    return np.concatenate([unit(unit(p) - mu) for p, mu in zip(parts, means)], 1)


def lda(x, y, dim):
    classes = np.unique(y)
    mu = x.mean(0)
    sw = np.zeros((x.shape[1],) * 2)
    sb = np.zeros_like(sw)
    for c in classes:
        xc = x[y == c]
        mc = xc.mean(0)
        sw += (xc - mc).T @ (xc - mc)
        sb += len(xc) * np.outer(mc - mu, mc - mu)
    sw = sw / len(x) + 1e-3 * np.eye(len(sw))
    sb = sb / len(x)
    from scipy.linalg import eigh
    w, v = eigh(sb, sw)
    p = v[:, np.argsort(w)[::-1][:dim]]
    # WCCN: whiten the within-class scatter in the projected space.
    z = x @ p
    sw2 = np.zeros((dim, dim))
    for c in classes:
        zc = z[y == c]
        sw2 += np.cov(zc.T, bias=True) * len(zc)
    sw2 /= len(z)
    l = np.linalg.cholesky(np.linalg.inv(sw2 + 1e-6 * np.eye(dim)))
    return p @ l


def train_torch(x, y, kind, dim, epochs=60):
    import torch
    torch.manual_seed(0)
    xs = torch.tensor(x, dtype=torch.float32)
    labels = torch.tensor(np.unique(y, return_inverse=True)[1])
    n_cls = int(labels.max()) + 1
    if kind == "linear":
        net = torch.nn.Linear(x.shape[1], dim, bias=False)
    else:
        net = torch.nn.Sequential(torch.nn.Linear(x.shape[1], 512), torch.nn.ReLU(), torch.nn.Dropout(0.2),
                                  torch.nn.Linear(512, dim))
    w = torch.nn.Parameter(torch.randn(n_cls, dim) * 0.01)
    opt = torch.optim.AdamW(list(net.parameters()) + [w], lr=2e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    s, m = 30.0, 0.2
    for epoch in range(epochs):
        net.train()
        perm = torch.randperm(len(xs))
        total = 0.0
        for i in range(0, len(xs), 256):
            idx = perm[i:i + 256]
            z = torch.nn.functional.normalize(net(xs[idx]), dim=1)
            cos = z @ torch.nn.functional.normalize(w, dim=1).T
            theta = torch.acos(cos.clamp(-1 + 1e-6, 1 - 1e-6))
            target = torch.nn.functional.one_hot(labels[idx], n_cls).bool()
            logits = s * torch.where(target, torch.cos(theta + m), cos)
            loss = torch.nn.functional.cross_entropy(logits, labels[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        sched.step()
        if epoch % 10 == 9:
            print(f"  epoch {epoch + 1} loss {total / len(xs):.3f}", flush=True)
    net.eval()

    def apply(v):
        with torch.no_grad():
            return net(torch.tensor(v, dtype=torch.float32)).numpy()
    state = {k: v.numpy() for k, v in net.state_dict().items()}
    return apply, state


def main(kind, name, models):
    train = load(models, "train", "aug")
    y = np.array([m["spk"] for m in json.load(open(f"{SPK}/bench/train_aug.json"))])
    means = [unit(p).mean(0) for p in train]
    x = centre(train, means)
    state = {f"mean_{m}": mu for m, mu in zip(models, means)}
    if kind == "mean":
        apply = lambda v: v
    elif kind == "lda":
        p = lda(x, y, min(150, x.shape[1] - 1))
        apply = lambda v: v @ p
        state["projection"] = p
    else:
        apply, weights = train_torch(x, y, kind, 128)
        state.update(weights)
    os.makedirs(f"{SPK}/emb/{name}", exist_ok=True)
    for split in ("test", "dev"):
        for path in sorted(glob.glob(f"{SPK}/bench/{split}_*.json")):
            cond = os.path.basename(path)[len(split) + 1:-5]
            if not all(os.path.exists(f"{SPK}/emb/{m}/{split}_{cond}.npy") for m in models):
                continue
            np.save(f"{SPK}/emb/{name}/{split}_{cond}.npy", unit(apply(centre(load(models, split, cond), means))))
    os.makedirs(f"{SPK}/models/heads", exist_ok=True)
    np.savez(f"{SPK}/models/heads/{name}.npz", **state)
    print(name, "done", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
