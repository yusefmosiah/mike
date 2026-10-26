# Modeling one person's computer-usage behavioral signature (content-free)

Date: 2026-10-26. Tags: [V] read primary source this session, [R] secondhand (search snippet / review), [K] prior knowledge, not re-verified. Search tools were thin; many claims are [K] or [R] and are flagged. Items marked UNVERIFIED need a follow-up before anyone relies on them.

## 1. Prior art in personal logging

| Tool | Captures | Input timing without content? | License / status (2026) |
|---|---|---|---|
| Wolfram personal analytics (2012) | Email since 1989, >100M keystrokes via third-party keyloggers, calendar, phone, pedometer, file mtimes, scans, GPS. [V] https://writings.stephenwolfram.com/2012/03/the-personal-analytics-of-my-life/ | No: raw keylogger. He learned ~7% of keystrokes are backspaces, ~33k distinct words/decade, strong daily regularity, and wished he had started earlier. | N/A (his own scripts + Mathematica) |
| ActivityWatch | Buckets of timestamped events; Events, Heartbeat, Query APIs; watchers: aw-watcher-afk, -window, -input, awatcher, -web. macOS supported. [V] https://github.com/ActivityWatch/activitywatch | aw-watcher-input counts presses per time span, not which keys. [V] https://github.com/ActivityWatch/aw-watcher-input . README says "work in progress"; no license shown on that page; no mouse detail; it is aggregate counts, so too coarse for trajectories. | Core MPL-2.0, ~19.4k stars [V]. v0.14.1 dated 2026-10-10, includes an aw-watcher-input change [R] https://github.com/orgs/ActivityWatch/discussions/1518 . Active. macOS 26 reports of a missing Dock icon, otherwise OK [R]. |
| Selfspy | Python daemon: window, clicks, key counts, key timings; text encrypted unless `--no-text`. [R] | Yes with `--no-text`: keeps key counts and timings, no letters. | Original last pushed 2019-03 [R]; effectively unmaintained, forks only. Useful as a schema idea. |
| arbtt | Rule-based window/time tracker (Haskell) [R] | No input timing. | GPL-2 per Hackage [R]. |
| ulogme | Window titles + key frequency graphs (Karpathy) [K] | Key-count per window, no content [K] | Not verified; believed dormant. UNVERIFIED. |
| Timing.app, RescueTime | App/doc/URL time tracking [R] | No input timing. | Proprietary paid [R]. |
| WhatPulse | Keyboard/mouse counts, heatmaps [R] | Counts and heatmaps, no content; no trajectories [K] | Proprietary freemium [R]. |
| Apple Screen Time | App usage, pickups, notifications; not an input-timing source [K] | No. | Closed; the data is not exported in any usable form [K]. |
| leafo/selfwatch | Go keystroke-rate logger [R] | Counts. | Unknown. |

Conclusion: no maintained tool records per-event inter-key timing plus mouse trajectories without content. Selfspy `--no-text` is the closest ancestor but is dead. ActivityWatch is the best infrastructure to reuse only if we want its sync, query and UI; its input watcher is too coarse. Recommendation: write a purpose-built capturer, and optionally emit coarse summaries into ActivityWatch buckets for the quantified-self view.

## 2. Mouse dynamics

- Survey: Mouse Dynamics Behavioral Biometrics: A Survey (2022), https://arxiv.org/pdf/2208.09061 . [R] The PDF did not extract; details below are from snippets and prior knowledge.
- Datasets: Balabit (10 users, free-form, 2016) [R]; SapiMouse (120 participants) [V via DMTG paper]; DFL (used for transfer learning in Antal & Fejer) [R]. Ahmed & Traore 2007 (48 users, "mouse dynamics" with movement/click/drag/silence) [K]. Shen et al. (2012-2013 mouse behavior with sub-actions) [K].
- Samples needed: Antal & Egyed-Zsigmond (https://arxiv.org/pdf/1810.04668) conclude about 10-20 mouse actions per decision, with drag-and-drop most discriminative; Random Forest on Balabit averages EER 18.8%; a 1D-CNN reaches AUC 0.98 [R]. Older work reports EER 1.3-9.8% in constrained settings [R]. Takeaway: identity is weakly discriminative per action and strong over aggregates, so about a few hundred actions per context cluster is enough to fit stable per-user distributions [K estimate].
- Identifying features [K]: velocity profile shape (peak time ratio, peak velocity vs distance), curvature / path-length ratio (straightness), submovement count and corrective tails near the target, overshoot rate, direction-dependent speed (diagonals slower), pause before click, click dwell time, jitter amplitude at rest, scroll cadence.
- Sigma-lognormal (Plamondon kinematic theory): a trajectory is a vector sum of lognormal-speed strokes with parameters D, t0, mu, sigma, theta_start, theta_end. Extractors: ScriptStudio (Robust Xzero, 2007; best SNR in a 2022 comparison [R], availability unclear) and iDeLog (MATLAB, https://github.com/gpds-ulpgc/iDeLog, [R] from search, not opened). I found no maintained Python library. Plan: a small Python reimplementation, or use iDeLog under Octave for a reference check. Sigma-lognormal has been used to synthesize handwriting and signatures [R https://link.springer.com/article/10.1007/s10032-017-0287-5], so it is plausible for cursor reaches, but I found no paper validating it for per-user desktop pointing. UNVERIFIED.
- Fitts's law: ISO 9241-411 uses effective width from the univariate SD of endpoints; this was supported by a 2026 study with 346 crowdworkers [R https://arxiv.org/pdf/2602.04432v1]. Per-user a and b (and throughput) are the primary timing parameters. Typical mouse throughput is about 4-4.5 bps, with older analyses at 2.65 bps [R].
- Generative models: DMTG (Oct 2024, entropy-controlled DDIM, trained on SapiMouse plus Open Images traces; discriminator accuracy 0.73-0.92 across ten classifiers, author-reported, attack-oriented, per-user cloning under-specified) [V] https://arxiv.org/html/2410.18233v1 . Mouse2Vec (CHI 2024, representation, not a generator) [R]. BeCAPTCHA-Mouse (2022, GAN-based synthetic traces plus detector) [R]. jrcalgo/generative-mouse-trajectories (MIT, GAN, Rust collector, no evaluation reported) [V] https://github.com/jrcalgo/generative-mouse-trajectories . Ramcharan747/cursor-trajectory claims defeating Cloudflare/DataDome; unvalidated [R]. I found no 2025-26 paper on per-user diffusion for pointing. UNVERIFIED gap.
- Evaluation: train a discriminator (RF/XGB on hand features, then 1D-CNN/TCN on raw series) real-vs-synthetic and user-A-vs-others; target near-chance accuracy on held-out reaches. DMTG used ten classifiers across independent and pooled splits, a design worth copying.

## 3. Keystroke dynamics without content

- Features are timing only: hold (dwell) time, flight times (down-down, up-down), and optionally coarse key class (letter / digit / punctuation / space / modifier / backspace / arrow) or row/column-hand zone instead of the keycode. Per-digraph stats need the pair identity, so use a keyed hash (HMAC) of the class pair, or use zone-pair classes (hand + row + finger, roughly 30-60 classes) so that text is not recoverable. Compute running aggregates (Welford mean/var, quantile sketches) on the fly and never persist raw sequences.
- Reconstruction risk [K]: timing with full key-pair identity can leak text via inter-key timing attacks (Song et al. 2001 SSH). Class-level or zone-level keys, coarsened timestamps (e.g. 1 ms to 5 ms), and no ordering beyond the last pair reduce this, but do not eliminate it.
- Minimum data: fixed-text EER about 9.6% on a 10-character password (Killourhy & Maxion) [R]. Free-text: EER 9.7% / 7.8% at 100 / 200 digraphs on Clarkson II [R https://arxiv.org/pdf/2006.09337]; a fused keystroke + wrist study gave 7.9 / 5.7 / 3.4 / 2.7% at 50 / 100 / 200 / 500 keystrokes [R]. For a stable personal profile, thousands of keystrokes are plenty.
- Health: neuroQWERTY / nQi uses only hold times during ordinary typing for early Parkinson's (85 subjects in the 2016 study; validated at home in JMIR 2018) [R] https://arxiv.org/pdf/1604.08620 , https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5891671/ . A simpler univariate model reports AUC 0.85 from a few hundred keystrokes [R]. Fatigue: TypeNet-derived classifier 72-80% [R] https://pmc.ncbi.nlm.nih.gov/articles/PMC11041424/ ; other small studies up to 91% [R]. TypeState cognitive load pilot [R, preliminary]. BiAffect mood work relates typing speed and variability to mood in bipolar disorder; I only found the 30-person pilot [R]; newer results UNVERIFIED. Keep hold-time distributions in the profile for quantified-self use; they come at no extra capture cost.

## 4. macOS capture

- CGEventTap with `kCGEventTapOptionListenOnly` needs Input Monitoring; `defaultTap` triggers Accessibility. Apple DTS recommends an event tap over NSEvent global monitors, and provides CGPreflightListenEventAccess / CGRequestListenEventAccess [R] https://developer.apple.com/forums/thread/122492 . Known quirk: on macOS 15 the prompt can appear without the app being listed, and the tap can be nil until permission is granted [R] https://developer.apple.com/forums/thread/828052 . The app must be a stable signed bundle, otherwise the TCC grant is lost on rebuild [K].
- Secure Event Input: while any process holds it (password fields, some terminals, password managers), taps do not receive keyboard events. It is a single system-wide flag; stuck holders are reported (Cursor, 1Password, July 2026 report) and the holder PID is visible via `ioreg -l -d 1 -w 0 | grep kCGSSessionSecureInputPID` [R] https://forum.cursor.com/t/cursor-leaks-secure-event-input-breaks-all-system-wide-input-taps-until-quit-or-screen-lock/167585 and Apple TN2150 https://developer.apple.com/library/mac/technotes/tn2150/_index.html . Use `IsSecureEventInputEnabled()` to record "keyboard blind" gaps, so absent data is not misread as idleness. This is a privacy feature: password timing is never captured.
- Pointer events [K]: mouseMoved / dragged have deltaX/Y, and CGEvent timestamps are in nanoseconds (mach time). Trackpad vs mouse: `kCGMouseEventSubtype` (0 default, 1 tablet point, 2 tablet proximity) and NSEvent `subtype` / `hasPreciseScrollingDeltas`; scroll events carry `kCGScrollWheelEventScrollPhase` and `MomentumPhase`; keep phases so that inertial scroll is not mistaken for human input. Distinguish a mouse from a trackpad by the presence of phase fields and `isContinuous` [K, verify on device].
- Target frame at click time: `AXUIElementCopyElementAtPosition` at the click point returns the element, then read `kAXPositionAttribute` and `kAXSizeAttribute` (frame) and role. This needs Accessibility permission (a second TCC grant), costs one IPC per click (do it on mouse-down only, with a timeout of a few ms; Electron/web content often exposes coarse frames) [K]. The frame gives Fitts's W and D. Frontmost app: `NSWorkspace.shared.frontmostApplication` bundle ID plus the activation notification [K]; do not store window titles.
- Overhead: [K estimate, not measured here] a listen-only tap on mouse-moves receives 60-1000 events/s depending on device polling (macOS coalesces; trackpads about 60-120 Hz, gaming mice up to 1 kHz). CPU is typically below 1-2% of a core if the callback only appends to a ring buffer, the run loop is on a dedicated thread, and writes are batched. At 125 Hz and 16 bytes per sample (t delta u16, dx, dy i16, flags) only during motion (about 1-2 h of actual motion/day): about 125 x 7200 x 16 = 14 MB/day raw, 2-4 MB compressed. Keystrokes at about 20k/day x 8 bytes = 160 KB. Raw is therefore cheap; the real saving is in not keeping it: segment, keep reach summaries (about 200 bytes each, 5-10k reaches/day = 1-2 MB), and keep raw paths only for a rolling 7-30 day window or a sampled subset. Measure with Instruments (Energy Log) before committing; UNVERIFIED.

## 5. Security and legal

- A behavioral profile is a biometric template: BioCatch-style vendors use mouse and typing dynamics for session authentication, and AmEx adopted BioCatch for new accounts [R] https://privacyinternational.org/examples/2737/behavioural-biometrics-flag-fraud-invade-privacy . Anyone holding your profile plus a generator (see DMTG-class models, whose stated aim is evading these detectors) could spoof you to such systems, and the profile also enables re-identification across services. The humanizer is by nature the attack tool; treating its profile like a credential is the right model.
- GDPR: biometric data processed to uniquely identify a person is Article 9 special category; commentary argues behavioral data can qualify [R] https://www.williamfry.com/knowledge/dont-press-too-hard-use-of-behavioural-biometrics-brings-privacy-issues-under-gdpr/ , https://journals.muni.cz/mujlt/article/view/8803 . A purely personal, household use is outside GDPR (Art. 2(2)(c)), but a profile of someone else, or hosted for others, is not. No EDPB position found. UNVERIFIED.
- Recommendations [K]: store in the macOS Keychain-protected key (Secure Enclave-wrapped key) with an encrypted SQLite (SQLCipher) or a file encrypted using AES-GCM / age; FileVault on; never sync raw logs to the cloud; keep the profile (a few KB) separate from raw data; tag with a version and the date range; add a retention schedule; capture off by default in Secure Input, screen locked, and a hotkey / menu bar pause; exclude a bundle-ID denylist (password managers, banking, terminals if desired); show a visible recording indicator; make the export / delete one command. Treat the generator weights as part of the credential.
- Threat to self: the profile reveals health signals (nQi, fatigue, mood), so keep it out of shared repos. This is the repo's own rule too: no private data committed.

## 6. Recommendation

### Event schema (raw, short-lived; local, encrypted ring buffer)
```
pointer_sample: {t_ns, dx, dy, buttons, device: mouse|trackpad|other}   // delta-encoded
button: {t_ns, button, down|up, x, y, app_bundle, target:{role, w, h, dx_from_center, dy_from_center}|null}
scroll: {t_ns, dy, dx, phase, momentum_phase, precise}
key: {t_ns, down|up, class, zone}            // NO keycode; class from fixed enum; secure_input=false only
gap: {t_start, t_end, reason: secure_input|locked|asleep|no_permission}
context: {t_ns, app_bundle, fullscreen?}     // no titles, no URLs
```
### Aggregates (durable, content-free)
- Reach: {app, device, D, W (if known), MT, peak_v, t_peak/MT, path_ratio, n_submovements, overshoot, endpoint_err, pre_click_pause, click_dwell}. Per user: Fitts a, b and throughput; distributions per distance bin and direction octant.
- Idle / pause: time between a reach end and the next action; micro-jitter amplitude at rest.
- Typing: per zone-pair and per class: hold and flight means, SD, quantiles (P², t-digest); burst length, inter-burst pauses, backspace rate, error-correction latency; speed by hour-of-day.
- Scroll: flick length, velocity decay constant, pause between flicks.
- Daily rhythm: active minutes by hour, app-switch rate (Wolfram-style).
### Profile JSON for the humanizer
```
{ "version":1, "built":"2026-..", "n_reaches":N,
  "fitts":{"a":..,"b":..,"sd_mt_resid":..},
  "reach":{"peak_ratio":{"mu":..,"sd":..}, "curvature":{...}, "overshoot_p":.., "submovement_p":[..],
           "sigma_lognormal":{"sigma":{..},"mu_offset":{..},"D_split":..}, "direction_scale":[8 values]},
  "click":{"pre_pause_ms":lognormal(mu,sigma), "dwell_ms":lognormal(..)},
  "typing":{"hold":{class:(mu,sd)}, "flight":{zonepair:(mu,sd)}, "burst_len":.., "pause":.., "error_rate":..},
  "scroll":{..}, "fatigue_curve":{..} }
```
### Pipeline
1. Capture (listen-only tap, Swift) to ring buffer; batch to a local DB.
2. Segment: reach = speed above threshold from rest to rest (or a click) with a smoothing filter; split corrective submovements by velocity minima; keystroke bursts by gaps over 1-2 s.
3. Fit parametric per-user model first (Fitts, lognormal timing, hold/flight distributions, plus sigma-lognormal per reach). Parametric models need few samples (hundreds of reaches) and are explainable.
4. Optional generative model: condition a small diffusion / CVAE on (D, W, direction, device) and a user embedding; fine-tune on this user's reaches only after pretraining on SapiMouse-class data (120 users). Compare against the parametric baseline to justify the added complexity.
5. Replay in the humanizer by sampling from the profile; add drift via the fatigue / time-of-day curve.
### Validation
- Hold out 20% of days; compare marginal distributions (KS / EMD) of MT, peak ratio, curvature, pause, hold and flight.
- Discriminators: real-vs-synthetic (RF, XGBoost, TCN) must approach 50% on held-out; user-ID classifier trained on your real data vs other-user data (public sets) must score synthetic as you at about the same rate as your real held-out reaches.
- Fitts regression fit (R^2) of synthetic vs real; a Turing-style blind human review (as in the 3D-signature paper's approach [R]).
- Privacy tests: attempt to recover text from stored aggregates (should fail); verify that nothing is written under Secure Input; unit-test that the key-class enum is exhaustive and that no keycode crosses the module boundary.
- Stop condition: sample sizes by learning curve (accuracy vs N reaches), expected plateau in the low thousands [K estimate].

## Open gaps
No measured overhead numbers; sigma-lognormal Python library unverified; no 2025-26 per-user generative study found; ulogme status; BiAffect recent results; ActivityWatch aw-watcher-input license and macOS specifics; legal view on personal use.
