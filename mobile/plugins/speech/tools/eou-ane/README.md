# EOU encoder on the Neural Engine (prototype)

The end-of-utterance streaming encoder (`FluidInference/parakeet-realtime-eou-120m-coreml`,
revision `40a23f4c0b333aa17ad8c0f2ea47ec2347f2f355`, folder `320ms`) fails the
Neural Engine compiler, so the app runs it on the GPU, where Core ML redoes
its specialisation on every launch. These scripts produced and checked a
variant that compiles for the Neural Engine. Nothing here ships yet; see
"Open work" in `docs/voice-chat.md`.

## What was found (Mac, 2026-10-23)

- The model is already fixed-shape fp16, and its attention, convolution and
  mask ops all place on the Neural Engine when compiled in pieces. The
  failure comes from its interface: fp32 casts on the two large cache
  outputs and the two int32 length outputs (`encoded_length`,
  `new_cache_last_channel_len`), each of which breaks the compile alone.
- `final.py` rebuilds the published `.mlpackage` with the caches fp16 in and
  out and the two length outputs dropped (the app can count the cache length
  itself: `min(cacheLength + 4, 70)`). 1209 ops place on the Neural Engine,
  36 small ones on the CPU.
- Load: about 10 s the first time at a new path (the compile), then 0.07 to
  0.09 s, also in a fresh process. Prediction about 5 ms against 13 to 16 ms
  on the GPU.
- Over 40 stateful steps against the original on the CPU: worst cosine
  0.9993, worst max abs diff 0.295 on outputs peaking near 9.9.
- The Mac's Neural Engine compiler is not the iPhone's. The original failed
  on the phone with a different message, so only a device run settles it.

## Files

- `final.py`: the conversion (coremltools 9, Python 3.12; run beside a
  download of the `320ms` folder as `dl_eou/320ms`). `python3 final.py out.mlpackage`,
  then `xcrun coremlcompiler compile out.mlpackage .`
- `probe.swift`: load, compute plan and prediction timing per compute unit.
- `compare.swift`: `compare <orig.mlmodelc> <units> <new.mlmodelc> <units> [steps]`,
  stateful numeric comparison with caches fed back.
- `spk.swift`: compares WeSpeaker v2 with the split FBank and Embedding pair
  (which the app now uses).

Run the Swift files with `swift <file>.swift <args>` or compile with `swiftc -O`.
Downloads are untrusted data; keep them in their own directory.
