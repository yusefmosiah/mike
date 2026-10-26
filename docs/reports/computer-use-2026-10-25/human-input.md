# Human-paced input for a computer-use agent: research notes

Date: 2026-10-25. Scope: motion and timing models for an agent that drives the user's OWN computer. CAPTCHA solving and security-challenge defeat are out of scope. Platform sections list the signals that exist; they are not an evasion guide.

Tags: [V] primary source read this session. [R] secondhand (search summary, blog, README as summarized by the fetch tool). [K] prior knowledge, not re-verified.

Method note: five search rounds and ~30 fetches. Round 1 was broad. Round 2 followed leads into the Aalto paper (PDF text extracted locally), Anthropic/UI-TARS/Agent S source, and Peekaboo. Round 3 cloned Peekaboo (`openclaw/Peekaboo`, shallow) and read its Swift implementation, because it is the only Swift reference found.

---

## 1. Mouse motion models

### 1.1 Fitts's law (movement time)
- Shannon form: `MT = a + b * log2(D/W + 1)`; throughput = 1/b bits/s. MacKenzie 1992 prefers Shannon over the original because it fits slightly better and ID is never negative. [R] https://www.yorku.ca/mack/CHI92.html , https://arxiv.org/pdf/0804.3103
- Mouse constants: Card, English & Burr 1978 `MT = 1.03 + 0.096*ID` (s) [R]. MacKenzie & Soukoreff ISO 9241-9 reanalysis: ~2.65 bits/s, or 4.32 with a grasp adjustment [R] https://www.yorku.ca/mack/chi03a.html . Modern ISO 9241-9 mouse throughput is commonly cited as ~3.7-4.9 bits/s [K], which the search did NOT confirm; check before citing.
- Practical use: for a 300 px move to a 40 px target, ID = log2(8.5) = 3.09 bits, so MT ~ 0.6-0.9 s at b = 0.15-0.25 s/bit (a ~ 0.1-0.2 s). [K, arithmetic]
- ghost-cursor uses Fitts only to set the number of points on the path. [V] https://github.com/Xetera/ghost-cursor

### 1.2 Minimum jerk and two-thirds power law
- Hogan/Flash: minimum-jerk point-to-point trajectory is `s(t) = 10 t^3 - 15 t^4 + 6 t^5` (t normalized 0..1); velocity is bell-shaped and symmetric, peak at 50% of MT. [R] summary: https://pmc.ncbi.nlm.nih.gov/articles/PMC6573701
- Real aimed mouse movements are NOT symmetric: peak velocity typically at ~35-45% of MT with a longer deceleration tail (the homing phase). behaviourforge reports peak at 0.26 of the stroke fitted from SapiMouse [R] https://github.com/asmit383/behaviourforge ; ~0.4 is the figure I recall from the aimed-movement literature [K]. Use a skewed profile (see 6).
- Two-thirds power law (Viviani & Terzuolo 1982) relates speed to path curvature (`v = k * kappa^(-1/3)`); matters for curved paths and drawing, less for short straight-ish aimed moves. Viviani & Flash 1995 showed it is not implied by minimum jerk. [R] https://weizmann.academia.edu/TamarFlash . Todorov & Jordan 1998 propose a better-fitting alternative. [R]
- Peekaboo (Swift) uses minimum-jerk progress along a cubic Bezier. [V] source below.

### 1.3 Sigma-lognormal (Plamondon kinematic theory)
- A stroke's speed is a lognormal impulse response of a neuromuscular system; delta-lognormal = agonist minus antagonist; a complex movement is a vector sum of lognormal strokes (sigma-lognormal). Each stroke has parameters `D` (amplitude), `t0` (onset), `mu` (log time delay), `sigma` (log response time), plus start/end angles. [R] https://old.iapr.org/members/newsletter/Newsletter09-01/index_files/Page728.htm
- iDeLog (Ferrer et al., IEEE TPAMI 2020) fits/extracts it; shortcomings for long continuous movements. [R] https://accedacris.ulpgc.es/handle/10553/77412
- Plamondon group 2026: kinematic theory as optimal control (Frontiers in Human Neuroscience). [R] https://www.polymtl.ca/expertises/en/node/103/publications
- Good fit for a generator because it naturally yields asymmetric velocity and submovements (corrective strokes are extra lognormals with small D). Typical parameter ranges from the literature: sigma ~ 0.2-0.5, mu ~ -2.5 to -1.5 (log seconds) [K, verify against Plamondon papers before use]. No ready Swift/Rust sigma-lognormal generator was found.

### 1.4 WindMouse
- Physics-style: gravity toward target + wind (random walk force) + velocity clamp/damping near target. Python docs defaults: gravity 9, wind 3, max step 15, damped distance 12 px. [R] https://windmouse.readthedocs.io/en/latest/algorithm.html . Rust crate: https://docs.rs/windmouse-rs [R]. Original author (Benjamin Land, 2005 forum post) [K], not confirmed here.
- Weakness: step-driven, not time-driven, so the speed profile is not a Fitts/bell shape, and it emits "steps" with no timestamps unless you add them.

### 1.5 Bezier approaches
- ghost-cursor: random control points on one side of the line; Fitts for point count; overshoot beyond `overshootThreshold` (default 500 px); random landing point in element; `useTimestamps` adds per-point timestamps via trapezoidal rule. [V]
- pyclick, BezMouse (`deviation` % of displacement, overshoot, momentum), human_mouse (Bezier + spline, `speed_factor`), natural-mouse (Windows, logistic easing, micro-jitter, Fitts, SendInput) [V/R]; see section 3.
- Documented weakness of fixed-rate Bezier: a Camoufox write-up reported it was sampled at a fixed rate with a speed profile unlike a hand's. [R] search summary of https://github.com/daijro/camoufox (the cursor-movement doc page I fetched did not itself say this).

### 1.6 Overshoot, submovements, tremor
- Aimed movements are a ballistic primary submovement (reaching ~90-95% of distance, endpoint spread proportional to velocity) plus 0-3 corrective submovements (Meyer et al. 1988 optimized initial impulse model) [K; the search did not return it]. behaviourforge: mean 2 submovements per stroke. [R]
- Overshoot: Peekaboo defaults to probability 0.2 (only for moves > 120 px), overshoot 2-6% of distance, then recenter. [V]
- Tremor/jitter: physiological tremor 8-12 Hz, sub-pixel at screen scale [K]. behaviourforge uses AR(1) correlated tremor rather than white noise [R]. Peekaboo uses uniform perpendicular noise <= 0.35 px scaled by sin(pi*progress) and tapered to zero within a 6 px settle radius. [V]
- Sampling rate: behaviourforge measured pointer sampling ~59 Hz from SapiMouse [R]. Real devices report at 125-1000 Hz, OS delivers per display frame (60-120 Hz) [K].

### 1.7 Clicks, double clicks, scroll, drag
- Click dwell (mousedown->mouseup): behaviourforge median 86 ms, p90 162 ms (from SapiMouse) [R]. Commonly quoted 80-150 ms for typical mice [K]. Playwright default is 0 ms (synthetic). [R]
- Pre-click settle: human pauses ~50-200 ms between arrival and press [K]. UI-TARS waits a fixed 100 ms before clicks. [V]
- Double-click: OS maximum interval defaults to 500 ms on Windows and ~0.5 s on macOS (`NSEvent.doubleClickInterval`, user-configurable) [K; macOS page fetch returned title only]. Real double-clicks have inter-click gaps of ~80-200 ms and the same coordinates (or <=1-2 px apart). Set `kCGMouseEventClickState` = 2 on the second down/up on macOS. [K]
- Scroll wheel (discrete): behaviourforge models whole ticks (40 px per tick), 5.8% direction reversals, with uneven gaps (based on only 10 Balabit users) [R]. natural-mouse scrolls "in several small, unevenly-timed nudges". [R]
- Scroll trackpad: continuous pixel deltas, gesture phases (began/changed/ended) then momentum phases (begin/continuous/end) with exponentially decaying deltas [K]. Apple enums: `CGScrollPhase` (began, cancelled, changed, ended, mayBegin), `CGMomentumScrollPhase` (none, begin, continuous, end). [R] https://developer.apple.com/documentation/coregraphics/cgscrollphase.md . The header comments for the phase fields are empty. [V] CGEventTypes.h (10.15 SDK mirror).
- WebKit had a bug where synthetic momentum was cut off by the system's momentum phase, i.e. apps do act on phase streams. [R] https://webkit.googlesource.com/WebKit/+/89077c4863d935bb5a031f0bfc5f9ad11dc11a02%5E
- Drag: Anthropic demo = `mousemove; mousedown; mousemove; mouseup` with no intermediate moves [V]. Agent S3 = `pyautogui.dragTo(duration=1.)` [V]. Human drags need a hold-to-move threshold (~3-5 px / a few frames) and intermediate dragged events at frame rate. Peekaboo supports `--profile human` on drag. [V]

### 1.8 Data-driven generators (2024-2026)
- DMTG (Oct 2024, arXiv 2410.18233): entropy-controlled diffusion model, SapiMouse + Open Images; reports 4.75-9.73% drop in bot-detection accuracy vs other generators; framed around CAPTCHA bypass. [V abstract] https://arxiv.org/abs/2410.18233
- SapiAgent (2021, IEEE): deep-autoencoder generator on SapiMouse. [R] https://ieeexplore.ieee.org/document/9530664/
- MouseAgent (2024, IEEE): adversarial generator. [R] https://ieeexplore.ieee.org/document/10451138/
- WGAN-GP + LSTM thesis on Bogazici (2025). [R] https://www.diva-portal.org/smash/get/diva2:2003088/FULLTEXT01.pdf
- MIME-mouse (2026, Apache-2.0): ~6M-param autoregressive event model (speed bin, heading change, time gap), trained on ~4.2M trajectories from Balabit, SapiMouse, DFL, Chaoshen, Bogazici; ~0.33 s CPU per trajectory plus 1-2 s model load; outputs `{x, y, delay_ms}`. Author's detector AUC ~0.56 single-trajectory (0.504 with candidate selection). Author's own caveats: external datasets separate at 0.92-0.95, free-running generation accumulates error (too many sub-ms pauses). Stated goal is evading bot detectors. [V] https://github.com/4LAU/MIME-mouse
- Cursory (PyPI): replays/morphs/jitters/retimes from a database of recorded human trajectories (2356 per Camoufox notes). [R] https://pypi.org/project/cursory/
- Datasets: Balabit (10 users), SapiMouse (120 users), DFL, Bogazici, Chaoshen; AdSERP and M4D used for validation in MIME; CaptchaSolve30k (HF, Apache-2.0) and "Cursor Streams" (HF, gated, 156 h of desktop computer-use trajectories). [R] https://huggingface.co/datasets/Capycap-AI/CaptchaSolve30k , https://huggingface.co/datasets/Cianmcnally/cursor-streams
- Takeaway: ML generators add dependencies, 100s of ms latency per move, and licensing questions on training data (several are research-only); a parametric model fitted to the same datasets is simpler, deterministic and testable. I found no 2026 paper beyond MIME that is clearly peer-reviewed.

---

## 2. Keystroke dynamics

### 2.1 Aalto 136M keystrokes (Dhakal et al., CHI 2018) [V, text extracted from the paper PDF]
Source: https://userinterfaces.aalto.fi/136Mkeystrokes/ (data free for research/non-commercial use with attribution; 168k volunteers; ~783 participants for the headline table).
- WPM: mean 51.56, SD 20.2; fast typists > ~78 WPM (top 10%), slow < ~26 WPM (bottom 10%); max 120+. Skew 0.51.
- IKI (press-to-press): mean 238.66 ms, SD 111.6; floor ~60 ms; skew 1.98, kurtosis 7.1 (heavy right tail). Fast typists ~120 ms (SD 11); slow > 480 ms, up to 900.
- Key press duration (dwell): mean 116.25 ms, SD 23.88, 80-150 ms even for slow typists; fast vs slow differ by only ~20 ms. Speed comes from flight time, not dwell.
- Hand alternation helps only ~5-20 ms (smaller than the 30-60 ms typewriter figures); same-finger bigrams slower; repeated letter is 150+ ms faster for slow typists but 20-40 ms slower for fast typists. Letter after a space is slow (word-initiation effect).
- Rollover (next key down before previous key up) is common and correlates with speed (so IKI < dwell is legitimate).
- Errors: uncorrected 1.167% (SD 1.43); corrections 6.3% of keystrokes, 2.29 per 15-word sentence (up to 8.5 at 99th percentile); KSPC 1.173 (SD 0.094). Substitutions 1.65%, omissions 0.8%, insertions 0.67%.
- Eight typist clusters from normalized IKI.
- Caveat: transcription of sentences, not free composition; composition has longer pauses (thinking). Typing-test participants are self-selected.

### 2.2 Other
- behaviourforge (MIT, 2026) fitted from Aalto (6,000 participants): dwell mean 109 ms SD 37; flight mean 217 ms SD 218 (very heavy tail); flight autocorrelation +0.056; session tempo drift via an OU-like process (`tempo_theta`, `tempo_sigma`); same-finger digraph x1.06; idle pauses median 780 ms, p90 4.2 s, heavy tail. Its README says the Aalto-derived correlation did not generalize to KeyRecs (99 users) though marginal shapes did. [R] https://github.com/asmit383/behaviourforge
- CMU keystroke benchmark (Killourhy & Maxion 2009; fixed password ".tie5Roanl", 51 users, hold/down-down/up-down) [K]. Surveys: https://dl.acm.org/doi/10.1145/3733103 , https://arxiv.org/html/2502.16177v1 [R].
- Salthouse 1986 transcription typing: IKI decomposes into per-digraph component, hand/finger effects, lookahead [K].
- Distribution family: lognormal (or ex-Gaussian) fits IKI well [K]; Peekaboo uses lognormal sigma 0.35. [V]
- Bursts: typing occurs in bursts of ~5-10 characters / word chunks separated by pauses 300 ms - 1+ s at word, clause and sentence boundaries [K]. Peekaboo adds a 0.3-0.5 s "thinking" pause every 12 words. [V]
- Typos: realistic model = substitution with an adjacent-key (QWERTY neighbor) error, noticing latency ~ 1-3 chars later, then backspace run and retype; transposition errors for common digraphs [K]. Apply only to editable human-visible text, never to credentials, code, URLs, or data where a wrong char could do harm (see 6).
- Shift/modifiers: Shift down precedes the letter by ~30-80 ms and releases after; modifier chords overlap by tens of ms [K, unverified].

---

## 3. Libraries and implementations

| Project | Lang / License | Date / status | Output |
|---|---|---|---|
| ghost-cursor (Xetera) https://github.com/Xetera/ghost-cursor | TS, MIT | last commit 2026-08-04 (scrollTo ElementHandle), 1.6k stars, active [V] | path points; optional per-point timestamps; Puppeteer dispatch; has scroll, random move; no typing |
| ghost-cursor-playwright, python_ghost_cursor, bn-l/ghost-cursor-play | forks | varied [R] | same |
| HumanCursor (riflosnake) https://github.com/riflosnake/HumanCursor | Python, MIT | 60 commits, 543 stars, date not shown [V] | Selenium WebCursor + pyautogui SystemCursor; "natural motion" with variable speed |
| Camoufox `humanize` | C++ in Firefox fork, MPL-2.0 [K] | active; `humanize:maxTime` default 1.5 s, off by default; algorithm originates from HumanCursor, rewritten in C++, "distance-aware" [V] https://camoufox.com/fingerprint/cursor-movement/ | events dispatched inside browser |
| pyclick (patrikoss) https://github.com/patrikoss/pyclick | Python, MIT [R] | old | Bezier paths; moves via pyautogui |
| BezMouse (vincentbavitz) https://github.com/vincentbavitz/bezmouse | Python, no license file visible [V] | 3 commits, 211 stars | xdotool commands in a bash file; overshoot, momentum |
| human_mouse (sarperavci) https://github.com/sarperavci/human_mouse | Python, MIT | 14 commits | Bezier+spline; pyautogui; `speed_factor` |
| natural-mouse (jericho3110) https://github.com/jericho3110/natural-mouse | Python, MIT | 6 commits, CI on Windows [V] | many small SendInput moves; Bezier, logistic easing, jitter (1.5 px, smoothing 0.85), Fitts option, unevenly timed scroll nudges, randomized click point and hold |
| windmouse (py), windmouse-rs | Python/Rust | [R] | steps, no timing |
| pyautogui `moveTo(duration, tween)` https://pyautogui.readthedocs.io/en/latest/mouse.html | Python, BSD [K] | maintained | linear/eased tween at fixed ~10 ms pause; durations < 0.1 s become instant [R]; `typewrite(interval=)` fixed delay |
| nut.js | TS, Apache-2.0 [K] | maintained | `mouseSpeed` px/s, straight or custom path; UI-TARS uses `straightTo` at 3600 px/s [V] |
| xdotool | C, BSD [K] | maintained; X11 only | `mousemove` instant (--sync); `type --delay` default 12 ms [R] man pages; |
| libei / libeis https://sources.debian.org/src/libei/1.5.0-2/README.md | C, MIT [K] | v1.5.0 [R] | Wayland emulated input via portal; compositor decides devices |
| Peekaboo (openclaw/Peekaboo) https://github.com/openclaw/Peekaboo | Swift, MIT | v4.9.7 released 2026-10-23; pushed 2026-10-24 [V via gh] | human mouse profile + human typing cadence; see section 4 |
| behaviourforge https://github.com/asmit383/behaviourforge | JS, MIT [R] | 2026, copyright only | parameter sampler (keystroke, pointer, scroll, idle) |
| MIME-mouse, Cursory | ML / data replay | see 1.8 | `{x, y, delay}` |
| Go `smegg99/human`, `retutils/godoll/humanize`; CloakBrowser HumanConfig; `human-browser-use` | misc | [R] only seen in search listings | browser-level; typing delay, typo chance, wobble |

Stream quality: only ghost-cursor (`useTimestamps`), Cursory, MIME, natural-mouse (via SendInput), and Peekaboo (per-sample sleeps) output time-indexed motion. WindMouse/BezMouse/pyclick/human_mouse give geometry, with timing left to the caller. No library found is native CGEvent-based except Peekaboo; none for C#/Rust beyond windmouse-rs. Plan on writing our own core (~300 lines) and borrowing ideas.

---

## 4. Computer-use agents and humanization

- Anthropic computer-use demo (quickstarts): `xdotool mousemove --sync x y`, `click`, `type --delay 12` in 50-char chunks, drag = move/down/move/up, 2.0 s post-action screenshot delay. No humanization. [V] https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/computer_use_demo/tools/computer.py
- UI-TARS-desktop (ByteDance, Apache-2.0) nut-js operator: `mouseSpeed = 3600`, `straightTo` path, 100 ms pause before click, `keyboard.type` with autoDelay 0, clipboard paste on Windows. No humanization. [V]
- Agent S3 (Simular): bare `pyautogui.click/write`, drag `duration=1.`, no intervals. [V]
- Cua Driver (trycua/cua): background driver that does NOT move the user's cursor; paints its own agent cursor; uses AX, SkyLight `SLEventPostToPid`, and a priming trick for Chromium; v0.34.0 per a secondary source (2026-10-05). No human-like motion/typing found. [V] https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md ; [R] https://cua.ai/cua-driver
- Peekaboo (OpenClaw ecosystem): YES. `profile: human` for move/drag; `TypingCadence.human(wordsPerMinute)`; instant hop is the default; explicit `duration`/`steps` override. [V] source + https://peekaboo.sh/human-mouse-move.html . Details:
  - Default duration/steps by distance: <200 px 280-350 ms / 30-40; 200-800 px 400-900 ms / 40-80; >800 px 900-1700 ms / 80-96 (cap 96 samples). Duration 1-30000 ms, steps 1-100.
  - Path: cubic Bezier. control1 = start + 0.28*delta + normal * curveMag; curveMag = min(0.10*dist, 42 px) * U(0.55,1.0) * random sign. control2 = target + (dir * overshoot) - normal*curveMag*0.22. Progress through min-jerk polynomial. Final sample forced to the exact target.
  - Seeded SplitMix64 generator (`randomSeed`) for deterministic tests.
  - Typing: base delay = 60 / (max(WPM,40) * 5) s per char; lognormal sigma 0.35; x1.35 after whitespace or punctuation; x0.85 for word-char to word-char; +0.3-0.5 s pause every 12 words; clamped. Randomness injected through a `TypingCadenceRandomSource` protocol (testable). Fixed cadence also supported.
  - Events: `CGEvent` with `.hidSystemState` source posted at `.cghidEventTap` (foreground) or `postToPid`/SkyLight (background). I did not find it setting mouse delta fields. Click pre/post sleeps 50-60 ms (ClickService).
  - License MIT: ideas and constants can be reused with notice.
- browser-use, Skyvern, Stagehand: no humanization in core per a competitor vendor's claim; community add-ons exist (human-browser-use wrapper, CloakBrowser HumanConfig). [R] search results only; not verified in their repos.
- OpenClaw skills: "Desktop Control" skill exposes `move_mouse(smooth=True)` (Bezier) and `type_text(wpm=60)`; "Computer Use" skill uses xdotool in 50-char chunks at 12 ms. [R] https://llmbase.ai/openclaw/desktop-control/
- OSWorld-Human (2025): agents spend most of wall-clock time in LLM planning/reflection, 1.4-2.7x more steps than humans; so action pacing is a minor term vs model latency. [R] https://arxiv.org/pdf/2506.16042 (title/abstract-level only)
- How they balance speed: nobody found exposes "watch mode vs fast mode"; the closest are Peekaboo's explicit opt-in flags and distance-scaled defaults, Camoufox `maxTime` cap (1.5 s), and Cua's background mode which avoids visible motion altogether. The design in section 6 makes this a first-class policy.

---

## 5. Platform signals (descriptive)

### macOS (CGEvent)
- `CGEventSourceStateID`: `.privateState = -1`, `.combinedSessionState = 0`, `.hidSystemState = 1`. Apple's guidance: remote-control apps should use a private/own state table so their synthetic key state does not mix with hardware state. Field `kCGEventSourceStateID` records which was used. [V header + R] https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid.md
- Per-event fields readable by any event tap: `eventSourceStateID`, `eventSourceUserData` (64-bit, set via `CGEventSource.userData`), `eventSourceUnixProcessID` (posting PID), `eventTargetUnixProcessID`. [V header text] So a consumer with an event tap CAN tell synthetic from hardware (hardware events come from the HID system with no source PID / user data). This is a feature for our product: set `userData` to an app-specific marker so the app's own tools and the user's accessibility/audit tooling can recognize agent input. Do not spoof these.
- `kCGMouseEventDeltaX/Y`: "horizontal/vertical mouse delta since the last mouse movement event". [V] Apps that read relative motion (games, 3D tools, pointer-lock in browsers, remote desktop clients, Figma-like drag handlers) use the delta, not the absolute position. `CGEvent(mouseEventSource:mouseType:mouseCursorPosition:mouseButton:)` leaves deltas zero unless you set them. For every .mouseMoved/.leftMouseDragged, set deltas = new - previous position (integers; carry sub-pixel remainder), and keep clickState correct. [K, standard practice]
- `CGWarpMouseCursorPosition` moves the cursor without generating events; avoid for realistic streams. Also `CGEventSourceSetLocalEventsSuppressionInterval` / `CGSetLocalEventsFilterDuringSuppressionState`: by default local hardware events are suppressed for a short interval after a synthetic event, so a user's real mouse movement is momentarily ignored. [R] Apple doc search listing. Set suppression interval to 0 when the user should be able to take over instantly.
- Cadence: event delivery on a display link (60-120 Hz ProMotion); posting faster than the frame rate gets coalesced by apps/WindowServer; posting at ~8.3-16.7 ms spacing is realistic. Use `DispatchSourceTimer`/`mach_absolute_time`, not `Thread.sleep`, to avoid jitter. [K]
- Event `timestamp` is set by the system at post; you can set `event.timestamp` but apps may ignore it. [K]
- Trackpad vs wheel: wheel = line-based `scrollWheelEventIsContinuous = 0`; trackpad = continuous (pixel) with `scrollPhase` (mayBegin/began/changed/ended) and `momentumPhase`. [V comment for IsContinuous; R for phases]
- Chromium drops background-posted events lacking some fields (`mouseEventSubtype`, `clickState`, window-local coordinates); Cua's article documents the workaround. [V]
- Permissions: Accessibility/Input Monitoring TCC; per-app prompts. [K]

### Windows
- `SendInput` inserts events serially into the system input stream and is subject to UIPI (can only inject into equal-or-lower integrity). [V] https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
- Low-level hooks see `MSLLHOOKSTRUCT.flags`: `LLMHF_INJECTED (0x1)` for injected-from-any-process, `LLMHF_LOWER_IL_INJECTED (0x2)` for injected from a lower-integrity process; also `time` and `dwExtraInfo` (the sender can tag it). [V] https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-msllhookstruct . Same idea for keyboard (`LLKHF_INJECTED`). [K]
- `MOUSEEVENTF_ABSOLUTE` uses 0..65535 normalized coordinates (precision on large/multi-monitor setups; use `MOUSEEVENTF_VIRTUALDESK`); relative moves go through pointer-acceleration ("enhance pointer precision"), so absolute is safer for accuracy and relative for apps reading deltas. [K]
- Raw Input (`WM_INPUT`) receives device-level data from HID devices; SendInput events do not come from a physical device handle (`hDevice` is null/virtual). [K, unverified here]
- Wheel: `WHEEL_DELTA = 120` per notch; precision touchpads send smaller deltas. [V] (MSLLHOOKSTRUCT page).
- Time resolution: default timer ~15.6 ms unless `timeBeginPeriod(1)` / high-resolution waitable timers. [K]

### Linux
- uinput: creates a virtual kernel input device; events look like those of a device named whatever you choose; works on X11 and Wayland, needs `/dev/uinput` permission (root or udev rule); you set `EV_REL` or `EV_ABS`, `SYN_REPORT` per frame. [K]
- XTest (X11): events injected via X server, no device identity; X11 only. [K]
- libei/EIS: Wayland-native; compositor-controlled devices, user consent via XDG RemoteDesktop portal; explicitly provides "separation, distinction and control" that XTEST lacks. [R] https://sources.debian.org/src/libei/1.5.0-2/README.md
- Not verified this session: how compositors expose provenance of uinput events.

Implication: every OS exposes some "injected" provenance, and the user's own apps and any security tooling may legitimately see it. Human pacing in this product is about predictable, non-startling behavior and compatibility with apps that mis-handle teleports (hover menus, drag thresholds, debounced UI), not about hiding the agent.

---

## 6. Design recommendation (Swift first; portable to C#/Rust)

### 6.0 Architecture
Separate three layers so the model ports cleanly:
1. `Planner` (pure, deterministic): `(request, profile, seed) -> [TimedEvent]` where `TimedEvent = (tOffsetMicros, kind, x, y, dx, dy, key, flags)`. No OS calls. Unit-testable and golden-file-testable.
2. `Scheduler`: plays a timeline against a monotonic clock (`mach_absolute_time` / QPC / `CLOCK_MONOTONIC`), handles cancellation and user-takeover.
3. `Poster` (platform): CGEvent / SendInput / uinput+libei. Sets deltas, clickState, a source-marker `userData`, and honest source state.

Randomness: SplitMix64 (as Peekaboo) or PCG32; one root seed per run, derived sub-seeds per action (`hash(rootSeed, actionIndex)`) so reordering one action does not change others. Golden tests: fixed seed gives bit-identical timeline; property tests assert invariants (below).

### 6.1 Pointer move model
Recommended: minimum-jerk-with-skew along a lightly curved Bezier, plus 0-2 corrective submovements; sigma-lognormal as an optional later upgrade. Rationale: cheap, deterministic, matches Peekaboo's validated structure, avoids ML dependencies.

Parameters (D = distance px, W = target width px; use W = 20 px if unknown):
- Movement time: `MT = a + b*log2(D/W + 1)`, a ~ U(0.08, 0.20) s, b ~ U(0.12, 0.22) s/bit (throughput 4.5-8 bits/s; agent default 0.12-0.15 for snappier). Multiply per-move by lognormal noise (sigma 0.12). Clamp 120 ms to 1.8 s (Peekaboo caps ~1.7 s). Divide by `speedMultiplier`.
- Velocity profile: time warp so peak speed occurs at tau ~ Beta-ish 0.35-0.45 of MT. Implementation: `s(t') = minJerk(t'^p)` with p chosen so the peak is at 0.4, or use `ease = minJerk` then add a homing tail. Test invariant: peak position in 0.3-0.5, monotone non-decreasing along-track progress except overshoot.
- Path: cubic Bezier like Peekaboo (curve magnitude min(0.10*D, 42) * U(0.55,1)); add slow low-frequency lateral drift (OU, sigma ~0.5 px, tau 80 ms) plus tremor AR(1) amplitude <= 0.35 px, tapering to 0 within 6 px of the final target. Peak lateral deviation ~2-8% of D.
- Overshoot/correction: P(overshoot) = 0 for D < 120; ramp to 0.15-0.25 for D > 600 or small W; overshoot 2-6% of D; then a corrective submovement of 120-250 ms with its own min-jerk. Add endpoint noise sigma ~ 0.03*W (then a corrective sub-move if the endpoint falls outside the target).
- Click point: sample inside the target with a 2-D Gaussian around a point biased ~ 5-10% toward the approach direction, truncated to the central 80% (never the edge).
- Sampling: emit one event per display frame, 8.3 ms (120 Hz) or 16.7 ms (60 Hz), choose from `NSScreen.maximumFramesPerSecond`; jitter timestamps +-1 ms; cap 96-200 samples per move. Always make the final event exactly the requested point.
- Deltas: for each sample dx,dy = round(new - prev) with carried remainder; set `mouseEventDeltaX/Y`; use `.leftMouseDragged` while a button is down.

### 6.2 Click, double click, drag, scroll
- Pre-click settle after arrival: lognormal median 90 ms, sigma 0.4, clamp 40-300 ms.
- Dwell (down->up): lognormal median 90 ms, p90 ~165 ms (SapiMouse-derived, [R]); clamp 50-250 ms.
- Double click: gap between first up and second down U(60, 160) ms (must be < OS interval, read `NSEvent.doubleClickInterval`); second-click position within 0-1 px; `clickState` 1 then 2.
- Drag: after mousedown wait 60-150 ms, then move at drag speed (about 0.7-0.9x of free-move speed); release dwell 40-120 ms after arriving.
- Wheel scroll: ticks of 1-3 lines per event at 15-40 ms gaps inside bursts of 3-12 events, 120-600 ms between bursts; 5% reversal.
- Trackpad scroll (macOS): `isContinuous = 1`, pixel deltas following a velocity curve (rise over 80-150 ms, decay), phases: mayBegin -> began -> changed* -> ended, then optionally momentum begin -> continuous* (exponential decay, factor ~0.92-0.95 per 16.7 ms frame [K, tune empirically]) -> end. Emit trackpad style only when the destination view is a native scroll view that benefits (web pages, lists); otherwise use line-based wheel.

### 6.3 Keystroke model
Per-user base speed from profile `wpm` (default 55, range 35-95; Aalto mean 51.6 SD 20).
- Base IKI = 60000 / (wpm*5) ms (e.g. 55 WPM -> 218 ms). Aalto: mean 238 ms at 51.6 WPM, floor ~60 ms.
- Per-character IKI = base * digraphFactor * LogNormal(mu=-sigma^2/2, sigma=0.35) (Peekaboo uses 0.35; Aalto skew 1.98 suggests sigma 0.35-0.5 plus an occasional long-tail mixture). Add AR(1) tempo drift: multiplier m_t = exp(OU), theta ~ 0.02/char, sigma ~ 0.05.
- Digraph factors: different hand 0.90-0.95; same finger 1.05-1.15; repeated letter 1.0 (fast typists) / 0.7 (slow); first letter after space x1.25-1.35 (word initiation, Aalto); after punctuation x1.3-1.5; uppercase via Shift +30-60 ms; numbers/symbols row x1.2-1.5. Needs a QWERTY (and layout-aware) finger map; for non-QWERTY use layout from `TISCopyCurrentKeyboardLayoutInputSource`.
- Dwell: Normal-ish N(110, 25) ms, clamp 60-200 ms, nearly independent of speed (Aalto 116 +- 24). Rollover: if IKI < dwell, allow key-down of next before key-up of previous (probability rising with WPM, ~15-35%); post events in the correct time order.
- Bursts and pauses: after each word end add pause with P=0.15 of U(250, 700) ms; sentence end (`.?!`) +U(400, 1200) ms; paragraph/newline +U(600, 2000) ms; "thinking" pause every 8-15 words lognormal median 0.9 s capped at 3 s. Peekaboo uses 0.3-0.5 s per 12 words.
- Typos (opt-in, text-field only): rate ~ 1.0-2.0% of keystrokes produce an error (Aalto: ~6% of keystrokes are corrections, but that includes the whole correction run; uncorrected 1.2%). Mix: substitution with adjacent key 55%, omission 20%, insertion 15%, transposition 10%. Notice latency 1-3 further characters (or at the word boundary), then backspace x n at 90-140 ms gaps (first backspace +150-300 ms hesitation), retype. Safety rule: disable for passwords, code, shell commands, URLs, file paths, structured data, and anything where the destination might act on intermediate text (search-as-you-type is fine, send-on-enter is not an issue since newline comes last). Final text must equal intent; verify by reading the field back where possible.
- Long text: for > ~200 chars, paste via clipboard (as UI-TARS does on Windows) is what a real user would do; restore the clipboard afterwards (Peekaboo had to lengthen its restore wait in #1140). Provide `typingMode: .keys | .paste | .auto`.
- Unicode/IME: use `keyboardSetUnicodeString` for characters not on the layout; no per-key physical model for these (flat dwell).

### 6.4 Speed policy (keep the agent fast)
Pacing is expensive only when the agent chains many tiny actions; model latency (seconds) dominates anyway (OSWorld-Human [R]). Policy `PacingMode`:
- `.instant`: no interpolation, one event per action (what agents do today). Used when the target app is not frontmost and not visible to the user (background-driver mode like Cua), screen locked/headless/VM, or user chose "fast".
- `.humanLite`: shortened curve (MT x0.5-0.7, 30-60 Hz, no overshoot, typing at 90-110 WPM, no typos). Default when the user is present but not watching; also when moving between actions needed for hover/drag UI correctness.
- `.human`: full model. Default when the app under control is frontmost AND the user is idle-observing (screen recording on, "watch me" toggle, demo/teaching mode) or the destination app is known to rely on hover/drag thresholds.
- Observability signal inputs: frontmost app == target, target window on a visible display, display awake/not locked (`CGSessionCopyCurrentDictionary`, `CGDisplayIsAsleep`), user idle time (`CGEventSourceSecondsSinceLastEventType`), screen-recording or screen-share active, user toggle.
- `speedMultiplier` (0.25-4, default 1.0) scales all durations; typing WPM separate; a global cap on per-action added latency (e.g. <= 1.5 s per move, <= 8 s per typed string; beyond that, chunk-speed up or paste).
- Pipelining: plan the next action's timeline while the previous one is posting; start the screenshot/AX capture the moment the last event is posted, not after a fixed delay (Anthropic demo waits 2 s [V]).
- User takeover: abort the timeline on any real hardware event (event tap on `.hidSystemState` events whose `eventSourceUnixProcessID` is not ours / `userData` is not our marker) and set suppression interval to 0. Cancel must be < 1 frame.

### 6.5 Testing
- Planner is pure: golden snapshots per (seed, request); invariant tests: endpoint exactness, monotone timestamps, max inter-event gap, per-frame displacement within physiological speed (< ~10,000 px/s), peak-velocity fraction in [0.3, 0.5], overshoot frequency over 10k seeds within [0.10, 0.30] for D > 600, IKI mean/SD within tolerance of target for 10k chars (assert distribution statistics, not timing of real code; per repo docs tests must not time code).
- Inject `Clock` and `RandomSource` protocols (Peekaboo's `TypingCadenceRandomSource` is a model); the Scheduler tests run on a virtual clock.
- Poster contract tests with a fake sink asserting deltas sum to displacement, clickState sequence, key down/up pairing (no stuck keys on cancel: always flush key-ups and mouse-up).
- Cross-language parity: ship JSON golden vectors generated by Swift and replay in C#/Rust tests.

### 6.6 Parameter table (initial defaults, to calibrate)
| Item | Default | Range | Source |
|---|---|---|---|
| Fitts a / b | 0.12 s / 0.15 s/bit | 0.08-0.2 / 0.12-0.22 | Card 1978, MacKenzie [R]; agent-tuned |
| Peak velocity position | 0.40 | 0.30-0.50 | behaviourforge 0.26 [R]; min-jerk 0.5 [R] |
| Overshoot P / size | 0.2 / 2-6% | 0-0.3 | Peekaboo [V] |
| Tremor amp | 0.35 px | 0.2-0.5 | Peekaboo [V] |
| Click dwell median/p90 | 90 / 165 ms | 50-250 | behaviourforge [R] |
| Double-click gap | 60-160 ms | < OS interval | [K] |
| Frame cadence | 8.3 or 16.7 ms | display-derived | [K] |
| Typing WPM | 55 | 35-95 | Aalto 51.6 SD 20 [V] |
| IKI lognormal sigma | 0.40 | 0.30-0.50 | Peekaboo 0.35 [V]; Aalto skew [V] |
| Key dwell | N(110, 25) ms | 60-200 | Aalto 116.25 SD 23.88 [V] |
| After-space factor | 1.3 | 1.2-1.4 | Aalto word-initiation [V]; Peekaboo 1.35 [V] |
| Word-end pause | P 0.15, 250-700 ms | | [K] |
| Typo rate | 1.5% of keystrokes (opt-in) | 0-3% | Aalto [V] |

### 6.7 Risks and open questions
- The Aalto and SapiMouse data are from typing-test and lab tasks on web/desktop; free composition and different devices (trackpad) differ. Calibrate against our own opt-in telemetry later.
- Some datasets (Aalto, Balabit) are non-commercial/research-only: use published summary statistics, not raw data, and do not ship fitted parameter files from restricted data without checking terms. MIME's licence is Apache-2.0 but its training data terms vary.
- ML generators (DMTG, MIME) are framed around evading bot detectors; avoiding them also avoids that framing. Our rationale (predictable behavior, app compatibility, user comfort, auditability) should be explicit in the product docs, and the agent's input should stay identifiable via a source marker.
- Unverified in this session: Plamondon parameter ranges, Windows double-click default, Raw Input/uinput provenance details, browser-use/Skyvern internals, Playwright humanize plugins. Each is flagged [K] or [R] above.
