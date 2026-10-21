import json, sys
import numpy as np
rows = json.load(open(sys.argv[1]))
conds = ["clean", "tv10", "tv5", "tv0", "talker5", "babble5", "music5", "noise5", "far"]
for metric, label in (("frr@far1", "FRR at FAR 1% (lower is better)"), ("eer", "EER")):
    for d in (1.0, 2.0):
        print(f"\n### {label}, {d:g} s turns (%)\n")
        print("| system | " + " | ".join(conds) + " | mean |")
        print("|---|" + "---|" * (len(conds) + 1))
        for r in sorted(rows, key=lambda r: np.mean([r[f"{c}/{d}/{metric}"] for c in conds])):
            v = [100 * r[f"{c}/{d}/{metric}"] for c in conds]
            print(f"| {r['system']} | " + " | ".join(f"{x:.1f}" for x in v) + f" | **{np.mean(v):.1f}** |")
print("\n### At the dev-fitted threshold (2% clean misses): misses / same-gender false accepts / TTS false accepts, 1 s and 2 s (%)\n")
print("| system | clean miss | tv0 miss | far miss | clean FA | tv5 FA | far FA | TTS FA |")
print("|---|---|---|---|---|---|---|---|")
for r in rows:
    f = lambda k: 100 * np.mean([r[k.format(d=d)] for d in (1.0, 2.0)])
    print(f"| {r['system']} | {f('clean/{d}/frr'):.1f} | {f('tv0/{d}/frr'):.1f} | {f('far/{d}/frr'):.1f} | {f('clean/{d}/far_sg'):.1f} | {f('tv5/{d}/far_sg'):.1f} | {f('far/{d}/far_sg'):.1f} | {f('tts/{d}/far'):.1f} |")
