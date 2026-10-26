# Billable time and a personal usage signature

October 26, 2026. Two research passes, each at least three rounds deep. The
notes, with sources linked and dated, are in
[`billable-time-2026-10-26/`](billable-time-2026-10-26/):

| Notes | Covers |
|---|---|
| [`billable-time.md`](billable-time-2026-10-26/billable-time.md) | Passive time capture products, phone sessions, billing ethics (ABA 512 and state bars), monitoring law |
| [`behavior-signature.md`](billable-time-2026-10-26/behavior-signature.md) | Personal logging prior art, mouse and keystroke dynamics without content, macOS capture, security |

The notes mark each claim as verified (the primary source was read),
reported (secondhand) or from memory. Several primary pages refused to load,
among them the ABA's PDF of Opinion 512 and Clio's site. Treat every vendor
figure for recovered hours as a marketing claim: no independent study
compares passive time capture with manual entry.

## What we want

- **An accurate billable-hours function.** Time is captured from real work,
  assigned to a client and matter, and drafted as entries with narratives
  that the lawyer approves.
- **The central case is the phone.** A lawyer sends one prompt, or several
  over five or ten minutes, and reads the results. That session becomes a
  time entry.
- **A personal usage signature,** kept as data the user owns, in the spirit of
  Stephen Wolfram's personal analytics. It also gives the computer-use
  humanizer its numbers.
- **No keylogger.** No keystroke content is ever stored.

## What the research found

**The market has moved toward this, and AI work is the new frontier.**

- **Laurel** (formerly Time by Ping) captures email, documents, meetings,
  calls and web activity and assigns them to matters. On October 13, 2026,
  Legora and Laurel announced that each task done in Legora becomes a
  reviewable time entry. Laurel's "Work Studio" separates human work from AI
  work, which is the closest thing to what we want.
- **Intapp Time** (May and August 2026) predicts work codes from the
  narrative, enforces client billing guidelines, and now treats activity in
  AI tools as work.
- **Smokeball AutoTime** drafts entries nightly from Word and Outlook.
  **Clio** is semi-passive: Outlook, OneDrive, and calls made in its own app.
- **Local-first tools:** Timing, Memtime and Timely keep the data on the
  machine or capture "no keystrokes, no screenshots".

We have an edge none of them has: inside our app we know exactly which
matter, document and chat the work belongs to, so that time needs no guessing.

**The ethics are settled for hourly billing, and open on AI-drafted
entries.**

- **ABA Formal Opinion 512 (July 2024)** lets an hourly lawyer bill the time
  actually spent, including writing prompts and reviewing AI output. Not
  billable:
  - time the AI saved;
  - time spent learning a tool;
  - the AI's own running time, as if a person had worked it.

  A flat fee can become unreasonable when AI makes the work much faster.
  Charges for the tools themselves need a disclosed basis.
- **State bars agree:** Texas 705, Florida 24-1 and California's 2026
  guidance.
- **AI-drafted entries:** no opinion yet addresses time entries drafted by AI.
- **Client billing guidelines:** of 1,054 sets surveyed in September 2026, 20
  mention AI, and one (Zscaler) requires the entry to note AI use.
- **Firms watching their own lawyers:** New York's electronic-monitoring law
  requires written notice and acknowledgment, and in the EU expect a data
  protection impact assessment and, in Germany, the works council.

**No maintained tool records input timing without content.**

- **Wolfram** logged more than 100 million raw keystrokes, which is the
  keylogger we're avoiding. One finding: about 7% of his keystrokes were
  backspaces.
- **Selfspy's** `--no-text` mode kept timing without letters, but it was last
  updated in 2019.
- **ActivityWatch** (MPL-2.0, v0.14.1, October 2026, runs on macOS) is
  maintained, but counts only keypresses per time span.
- **Mouse data identifies a person only in aggregate.** A single reach says
  little; on the Balabit dataset, 10–20 actions still give about an 18.8%
  error rate. A profile needs hundreds of reaches. The telling features are:
  - the shape of the speed profile;
  - curvature;
  - sub-moves and overshoot;
  - the pause before a click.
- **Typing timing** without the letters is enough for:
  - recognising a person from free text (about 8–10% error at 100–200 key
    pairs);
  - Parkinson's and fatigue research, from hold times alone.
- **macOS blocks keyboard event taps in password fields** (Secure Input).
  Those spans should be recorded as "keyboard not visible", not as idle.

## The design

### Three ledgers, never mixed

1. **Activity:** spans of human work, each carrying its evidence:
   - which app;
   - which window or document;
   - whether input was active or idle;
   - which matter, from our app's context.
2. **Agent runs:** what the agent did, for how long, and at what cost. These
   are never converted into billable hours by default.
3. **Time entries:** what the lawyer approved, each with its matter, hours,
   task code and narrative, and a link back to the activity behind it.

Keeping agent runs separate is what lets us follow Opinion 512. It also lets
a firm show a client exactly where human time ended and machine work began.

### Phone sessions (the central case)

- **Counted:**
  - composing time, from the first keystroke or the start of dictation to
    send;
  - reading time, while an answer is on screen and being scrolled, capped
    per answer at a reasonable reading speed for its length;
  - the waiting time between prompts, if the app stayed open and in front.
- **Not counted:** the agent's run time while the phone is locked or in
  another app.
- **Grouping:** prompts in the same chat or matter merge into one session
  across short gaps. Five to ten minutes is our proposal; no source sets a
  standard. Rounding to the billing increment (usually 0.1 hour) happens once
  per entry, not per prompt.
- **Matter:** the chat's project, so it's known rather than guessed.
- **Narrative:** drafted from what was asked and what came back, describing
  the lawyer's task. For example: "Reviewed analysis of indemnification
  carve-outs in Acme MSA; revised request regarding caps." AI is mentioned
  only where the client's guidelines require it.
- **Limits:** iOS doesn't let an app see calls or messages outside it, so the
  phone captures only work done in our app.

### The desktop

- **Idle time** comes from the system's seconds-since-last-input counter,
  which needs no Input Monitoring.
- **Context:**
  - the frontmost app and its window title or document path, through the
    Accessibility permission computer use already needs;
  - the calendar.
- **Matter attribution,** strongest evidence first:
  1. our app's own context;
  2. matter numbers in file paths and document-management metadata;
  3. email recipients' domains and calendar invitees;
  4. a model's classification with a confidence score.

  Anything below the confidence threshold goes to an "unassigned" tray rather
  than into a guess.
- **Excluded:** no keystrokes, no continuous screen recording, and no Input
  Monitoring for billable time.

### Review

- **Daily review:** each morning the lawyer sees yesterday's drafted entries
  on a timeline, beside the activity behind them. They approve, split, merge
  or reassign entries.
- **Guideline checks** run before approval: no block billing, one task per
  line, and task codes where the client uses them. Laurel and Intapp do the
  same.
- **Export:** approved entries go to the billing system, LEDES with UTBMS
  codes where needed.

### The personal signature (separate and opt-in)

The signature needs finer data than billable time does, so it's a separate,
opt-in capture on the desktop app with its own permission (Input
Monitoring):

- **Mouse:** every move event, summarised into reaches. Each reach records:
  - its distance;
  - the target's width (read from the element clicked, through
    Accessibility);
  - its duration;
  - its curvature, speed peak and overshoot;
  - the pause before the click;
  - the device: trackpad or mouse.
- **Keys:** only timing, with each key reduced to a finger zone and never
  identified. Running totals per pair of zones, hold times, bursts, pauses,
  and corrections.
- **Profile:** a small file of fitted parameters that the humanizer reads
  directly:
  - Fitts constants;
  - arc size and which side the arc leans;
  - overshoot rate;
  - click hold time;
  - typing speed by app;
  - pause rates.
- **Generative model, later:** worth adding only if it beats the parametric
  profile. The test is a classifier asked to tell real reaches from
  generated ones; near 50% means it's good.
- **Size:** keep the summaries, plus a rolling window of raw paths. The
  estimate is 2–4 MB a day compressed, which hasn't been measured.

**The profile is a credential.** Fraud systems such as BioCatch recognise
people by exactly these patterns, so a leaked profile plus a generator could
imitate you to them. It stays on the device:

- encrypted, with the key in the Keychain;
- never sent to the server, which keeps it out of reach of the agent there;
- with a pause hotkey, a list of apps never to log, and one-step deletion.

The humanizer reads the profile locally on the same machine.

## Order of work

1. **Phone sessions in our own app.**
   - Server: record composing, dictation and reading spans in the activity
     ledger.
   - Server: group spans into sessions and draft entries.
   - App: a review screen.

   This needs no new permissions and covers the central case.
2. **The agent-run ledger,** shown alongside, never as hours.
3. **Desktop activity** from idle time, the frontmost app and window titles,
   matter rules, and the unassigned tray.
4. **Billing export** and client-guideline checks.
5. **The opt-in personal signature** and its profile for the humanizer.

## Open questions

- **Session settings:** what gap separates sessions, and how much reading
  time per answer is reasonable? Our proposals need a lawyer's judgement, and
  ideally a firm's billing partner.
- **Agent-work charges:** should agent work ever appear on a bill, as a
  technology charge, or never? Opinion 512 allows a disclosed basis. Clients
  may object.
- **Counsel review:** whether a narrative drafted by AI and approved by the
  lawyer needs any disclosure. No bar has ruled on it yet.
- **Firm deployments:** before any firm rolls this out to its lawyers, its
  monitoring notices (New York, the EU) need writing.
