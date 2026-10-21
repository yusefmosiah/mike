# Speaker benchmark

How voice mode's speaker check was measured and how the "Both" check's
joined space (`ios/Sources/MikeSpeechPlugin/SpeakerFusion/speaker-fusion.bin`)
was trained. Results and the protocol are in `docs/voice-chat.md` ("Other
voices"). These scripts are not part of the app or its tests.

Needs Python 3.12 with numpy, scipy, soundfile, scikit-learn, torch,
torchaudio and coremltools (macOS, for the Core ML models), and:

- `SPEAKER_BENCH`: a working directory. Put the data in `data/`:
  LibriSpeech `test-*`, `dev-*` and `train-clean-100` with `SPEAKERS.TXT`
  (openslr.org/12), `musan/` (openslr.org/17) and `RIRS_NOISES/`
  (openslr.org/28).
- `SPEAKER_BENCH_MODELS`: the compiled Core ML models as the app downloads
  them, in `speaker/` and `speaker-campplus/` (`VoiceModels.swift` pins them).
- Only for the comparison models (`torch_models.py`): their weights in
  `models/`, the WeSpeaker and 3D-Speaker repositories in `code/`, and
  WeSpeaker's `resnet.py`, `pooling_layers.py` and `multi_view_attention.py`
  copied into `vendor/` here (imports changed to `vendor.*`).

```sh
python build.py test && python build.py dev     # clips: enrol, 9 conditions, macOS voices
python build_train.py                           # 10,040 augmented train-clean-100 clips
for m in wespeaker campplus_zh; do for s in test dev train; do python embed.py $m $s; done; done
python head.py lda lda_ws_zh wespeaker campplus_zh
python score.py wespeaker campplus_zh lda_ws_zh --fuse wespeaker,campplus_zh > report.md
python fused_app.py                             # the joined space as the app scores it, and its threshold
python export_fusion.py speaker-fusion.bin
```

Every threshold and fusion weight is fitted on the dev speakers and reported
on the test speakers; the noises and rooms are split the same way, and the
head sees only the dev halves.
