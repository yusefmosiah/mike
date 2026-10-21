"""PyTorch speaker models for the panel (and for training). Inputs are 16 kHz
float waveforms in [-1, 1]; outputs are unit-length embeddings."""
import os
import sys
import numpy as np
import torch
import torchaudio.compliance.kaldi as kaldi

SPK = os.environ["SPEAKER_BENCH"]  # the working directory: data/, models/, bench/, emb/
sys.path.insert(0, f"{SPK}/code/wespeaker")
sys.path.insert(0, f"{SPK}/code/3D-Speaker")
torch.set_num_threads(4)


def fbank(wave, scale):
    """Kaldi 80-bin fbank with per-utterance mean removal, [T, 80]."""
    feat = kaldi.fbank(wave.unsqueeze(0) * scale, num_mel_bins=80, frame_length=25, frame_shift=10, dither=0.0,
                       window_type="hamming" if scale > 1 else "povey", sample_frequency=16000, use_energy=False)
    return feat - feat.mean(0, keepdim=True)


def repeat_to(x, n):
    return np.tile(x, int(np.ceil(n / len(x))))[:n]


class WeSpeakerTorch(torch.nn.Module):
    name = "wespeaker"
    dim = 256

    def __init__(self, pad_to=160_000):
        super().__init__()
        from vendor.resnet import ResNet34
        import safe_load
        self.net = ResNet34(feat_dim=80, embed_dim=256)
        sd = safe_load.load(f"{SPK}/models/wespeaker34/pytorch_model.bin")["state_dict"]
        self.net.load_state_dict({k.removeprefix("resnet."): v for k, v in sd.items()})
        self.net.eval()
        self.pad_to = pad_to

    def features(self, wave):
        return fbank(wave, 1 << 15)

    def forward(self, feats):  # [B, T, 80]
        return self.net(feats)[1]

    @torch.no_grad()
    def embed_many(self, clips):
        out = []
        for c in clips:
            c = repeat_to(c[-160_000:], self.pad_to) if self.pad_to else c
            e = self(self.features(torch.from_numpy(np.ascontiguousarray(c, dtype=np.float32))).unsqueeze(0))[0]
            out.append((e / e.norm()).numpy())
        return np.stack(out)


class CamPlusTorch(torch.nn.Module):
    def __init__(self, weights, name, dim=192):
        super().__init__()
        from speakerlab.models.campplus.DTDNN import CAMPPlus
        self.name = name
        self.dim = dim
        self.net = CAMPPlus(feat_dim=80, embedding_size=dim)
        self.net.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True))
        self.net.eval()

    def features(self, wave):
        return fbank(wave, 1)

    def forward(self, feats):
        return self.net(feats)

    @torch.no_grad()
    def embed_many(self, clips):
        out = []
        for c in clips:
            c = c[-160_000:]
            if len(c) < 16_000:
                c = repeat_to(c, 16_000)
            e = self(self.features(torch.from_numpy(np.ascontiguousarray(c, dtype=np.float32))).unsqueeze(0))[0]
            out.append((e / e.norm()).numpy())
        return np.stack(out)


def campplus_en():
    return CamPlusTorch(f"{SPK}/models/campplus_en_voxceleb.bin", "campplus_en", 512)


def campplus_zh():
    return CamPlusTorch(f"{SPK}/models/campplus_zh_common.bin", "campplus_zh_torch")


class Ecapa:
    name = "ecapa"
    dim = 192

    def __init__(self):
        from speechbrain.inference.speaker import EncoderClassifier
        self.m = EncoderClassifier.from_hparams(source=f"{SPK}/models/ecapa", savedir=f"{SPK}/models/ecapa",
                                                run_opts={"device": "cpu"})

    @torch.no_grad()
    def embed_many(self, clips):
        out = []
        for c in clips:
            e = self.m.encode_batch(torch.from_numpy(np.ascontiguousarray(c[-160_000:], dtype=np.float32)).unsqueeze(0))
            e = e.reshape(-1)
            out.append((e / e.norm()).numpy())
        return np.stack(out)
