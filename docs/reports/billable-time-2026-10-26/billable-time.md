# Passive billable-time capture for lawyers: landscape, method, ethics, design (as of 2026-10-26)

Tags: **[V]** = I fetched and read the primary vendor/author page. **[R]** = secondhand (search summary, competitor or review blog, or a page I could not open). **[M]** = my own prior knowledge, not re-verified in this session.

Verification limits: several primary pages returned 403 or 404 (ABA Op. 512 PDF, clio.com pages, Smokeball AutoTime page, Florida Bar PDF, Apple docs). Every claim about those is [R] or [M]. Vendor accuracy numbers are marketing unless stated. I found no independent, controlled study of passive-vs-manual capture accuracy for lawyers (see section 4).

---

## 1. Products

### Summary table

| Product | Signals | Matter attribution | Narrative | Evidence / claims | Privacy posture |
|---|---|---|---|---|---|
| **Laurel** (formerly Time by Ping; founded 2016 per [LawNext directory](https://directory.lawnext.com/products/laurel/) [R]) | Email, documents, meetings, calls, web, "at the content level", i.e. reads what was worked on rather than which app was open ([Laurel blog](https://www.laurel.ai/blog/ai-timekeeping-software-law-firms) [V], vendor-authored) | Classifies "by client and matter"; mechanism not disclosed [V] | LLM-generated "compliant narratives"; point-of-entry rule/OCG checks [V] | Customer case study (Aprio): up to 30 min/day recovered, 4-11% profit lift, 2.88 more entries/day ([laurel.ai](https://www.laurel.ai/) [V]); vendor-only | No public LLMs, single-tenant AI, BYOK, SOC 2 Type II, ISO 42001, CCPA/GDPR/HIPAA, in-region storage [V, self-reported] |
| **Intapp Time** (SmartTime lineage is BigHand, a separate product, see below) | Email, calendars, virtual meetings, browsers, and as of the redesign "work activity from AI tools" ([Intapp blog, dated Aug 19 2026](https://www.intapp.com/blog/celeste-intapp-time-ai-time-entry/) [V]) | Not explained; Celeste "correlates activity to gaps in a timekeeper's day" [V] | AI suggests entries with "compliant narratives"; May 21 2026 release adds work-code (phase/task/activity) prediction from narrative + recency-weighted matter history, admin-set narrative rules (OCG, restricted terms, block billing) with one-click rewrites, a timeline view of AI-captured activity beside entries ([release](https://www.intapp.com/news/intapp-time-release-may-2026/) [V]) | "$12B incremental billings/yr" is Intapp's own claim; no accuracy benchmark [V] | "Stays within the platform", firm access policies; no retention/training detail [V] |
| **Clio** (Clio Duo, now "Manage AI") | Outlook email, OneDrive doc work, outbound calls via Clio mobile app ([LegalTime AI summary](https://www.legaltime.ai/blog/clio-passive-time-trackers-wisetime-mira-daytimed-timesentry) [R], competitor); suggests unlogged work on matter dashboard ([search results citing Clio Help](https://help.clio.com/hc/en-us/articles/41990965598491-AI-Features-in-Clio-Manage) [R]) | Native to matters in Clio | Suggested entries, AI refine/expand | Pricing conflicts across sources: $99-$149/user/mo; AI on Advanced/Complete [R] | Not stated |
| **Smokeball AutoTime** | Word, Outlook, Smokeball activity (matter admin, events, tasks, docs, emails, messages, memos); nightly rollup into entries; idle in Word deducted ([Smokeball support](https://support.smokeball.com/hc/en-gb/articles/5860708227863), [Above the Law sponsored](https://abovethelaw.com/?p=457006) [R]) | Matter is inherent (docs/emails filed to matter) | Rule-based, not generative per one review [R] | Vendor-stated only | n/a |
| **WiseTime** (now part of Anaqua [R]) | Background activity on a private timeline; active program, email metadata; app blacklists ([wisetime.com](https://wisetime.com/) [V], [Ajax comparison](https://joinajax.com/blog/best-ai-time-tracking-tools-for-lawyers) [R]) | Tags by matter ID in file name/email subject, synced from PMS; ML improves tagging [V][R] | AI invoice-ready descriptions, customizable, multilingual [V] | "One extra billable hour/week" testimonial only [V] | "100% private", user chooses what is sent; says "not spyware" [V]; ~$30-40/user/mo [R] |
| **Timing (Mac)** | Every app/document/website with full file path or URL; calls, meetings, calendar; idle detection ([timingapp.com](https://timingapp.com/) [V]) | Manual drag + rules (Option-drag creates a rule); AI groups activities; MCP lets agents file activities [V] | AI summaries of work [V] | none | Local-only unless cloud sync enabled; private tabs discarded; exclusion list [V]; $10/mo Pro, $168/yr Connect [V] |
| **Memtime** | Foreground window, file names, email subjects, tab titles, calls (VoIP), calendar; timeline in 5-6 min blocks ([memtime.com](https://memtime.com/) [V]) | None automatic; user builds entries from timeline; 100+ integrations [V] | None [V] | none | Fully local/offline, "cannot be used for employee monitoring" [V]; Mac/Win/Linux; $12-24/user/mo on long terms [R] |
| **Timely (Memory AI)** | "Every web and desktop app"; "no keystroke logging, no screenshots" ([timely.com](https://www.timely.com/) [V]) | AI auto-allocates to projects/clients; one-click approval [V] | Timesheet auto-complete | "100% accurate" and "lose 1 in 5 billable hours" are marketing [V] | Only user-approved entries shared; ISO 27001 claim [V] |
| **Chrometa** | Apps, documents, emails, websites; background | Manual categorization to client/matter before billing [R] | none | n/a | $19/user/mo [R] (Capterra) |
| **Toggl Track** | Desktop auto-tracker timeline (>10 s windows); idle prompt after set threshold (5/10 min) based on mouse/keyboard absence [R] | Manual / rules | none | n/a | Pricing unconfirmed [R] |
| **RescueTime** | App/site category time; no invoicing [R] | None | None | n/a | From $7/mo [R]. Productivity, not billing |
| **Billable-time specialists** | **Ajax**: reads on-screen text across apps (the only OCR-style tool), claims 92% matter prediction (self-claimed), screen content deleted after processing, SOC 2 II ([Ajax blog](https://joinajax.com/blog/best-ai-time-tracking-tools-for-lawyers) [V], vendor). **PointOne** (YC): email/docs/calls/web via integrations and metadata, no screen capture; layers on Aderant/Clio/Elite 3E [V, vendor]. **Billables AI**: API integrations (M365, Chrome, Zoom, Adobe), $47-169/user/mo [R]. **MIRA, Daytimed, TimeSentry, LegalTime AI, Lawgro MagicTime, Tempello**: Clio-connected passive tools [R]. **BigHand SmartTime**: email, meetings, Zoom, phone, docs, web [R]. **Actionstep Trace**: GA spring 2026 after acquiring Traced [R] | | | | |
| **Not found** | **Harvey, Filevine, PracticePanther, MyCase**: no 2026 AI time-capture launch found in my searches (absence of evidence only). | | | | |

### 2026 developments worth knowing
- **Legora + Laurel partnership, announced Oct 13 2026** ([LawSites](https://www.lawnext.com/2026/10/legora-and-laurel-partner-to-enable-automatic-time-capture-will-later-develop-measures-of-legoras-value-to-firms.html) [V]): every task a lawyer completes in Legora becomes a time entry with client, matter and description, which the lawyer reviews before it is recorded. Phase 2 will jointly measure Legora's value. Article does not say how human vs AI time is separated.
- **Laurel "Work Studio" (new)**: described on laurel.ai as "allocation of human and AI work" [V, one line, no detail]. This is the closest competitor signal for our "agent time recorded separately" requirement.
- **Intapp Time redesigned around Celeste agents (Aug 2026)** and now captures AI-tool activity as work activity [V]. Summer 2026 preview of agentic workflows [V].
- Vendors converge on: (a) capture from many sources, (b) LLM narrative, (c) OCG/block-billing validation at entry, (d) lawyer approves. Nobody publishes independent accuracy data.

### Matter-attribution techniques seen in the market
1. Matter number in file name, email subject, or path (WiseTime) [R].
2. Documents/emails already filed to a matter in a DMS/PMS (Smokeball, Clio, iManage/NetDocuments via MIRA) [R].
3. Recency-weighted matter history to predict codes (Intapp) [V].
4. Content-level semantic classification by LLM (Laurel, Ajax) [V, opaque].
5. User-authored rules with learning (Timing Option-drag rules; WiseTime ML) [V].
6. Gap-filling against calendar (Intapp "gaps in a timekeeper's day") [V].

Codes: LEDES/UTBMS: Laurel directory lists LEDES invoicing [R]; Intapp's release names phase/task/activity codes without naming UTBMS [V]. UTBMS is the standard code taxonomy (phase/task/activity) used in LEDES 1998B/XML [M].

---

## 2. Method details

**Idle detection.** Common practice is input-recency with a prompt: Toggl prompts after 5 or 10 min of no mouse/keyboard [R]; Smokeball deducts Word idle periods [R]; Timing detects Mac idleness [V]; thresholds are not published by most vendors. On macOS the standard approach is `CGEventSourceSecondsSinceLastEventType(.combinedSessionState, anyInput)`, which returns time since last input without event contents; my understanding is that it needs no Input Monitoring or Accessibility permission, unlike a CGEventTap [M, could not verify; test on target macOS versions]. Chromium uses this call for its idle API [R].

**Measuring input activity without content.** Keep only counters/timestamps: last-input time, per-minute "had input" booleans, optionally coarse event counts. Never install an event tap that reads key codes. Vendors that advertise this stance: Timely ("no keystroke logging, no screenshots") [V], MIRA (no screenshots/keystrokes) [R], WiseTime ("not spyware") [V].

**Window/document to matter mapping.** Signals ranked by reliability: (1) explicit app context (our own app, exact); (2) document in a DMS/filed to a matter; (3) matter number token in title/path/subject; (4) email participants/domains vs client-contact table; (5) calendar event with matter code or attendee match; (6) LLM classification over titles+snippets (Laurel, Ajax approach) with a confidence score; (7) recency prior (Intapp).

**Multitasking and switching.** Not documented by vendors. Reasonable standard: sample the foreground context every few seconds, slice time into per-context spans, merge spans of the same matter separated by short gaps, round at the entry level. Timelines at 5-6 min granularity (Memtime) [V]; legal billing increments are typically 0.1 h (6 min) [M]. Minimum increment rules come from client OCGs.

**Review workflow.** Universal: suggestions go to a private draft/timeline, the timekeeper edits and approves, then it flows to billing (Intapp timeline view [V], WiseTime private timeline [V], Timely one-click approval [V], Smokeball nightly entries [R]). Intapp pushes OCG validation into this step [V].

**Rounding.** Round up to 0.1 h per entry is common but OCG-controlled; Opinion 93-379 limits billing more time than actually spent [R]. Make rounding a per-client setting and show the raw minutes.

---

## 3. Ethics and rules

**ABA Formal Opinion 512 (July 29, 2024)** [R: the PDF returned 403; quotes via [Thomson Reuters](https://www.thomsonreuters.com/en/institute/articles/aba-formal-opinion-512) and [MSBA](https://www.msba.org/site/site/content/News-and-Publications/News/General-News/The%20_ABAs_Stance_on_AI_Formal_Opinion_512.aspx)]:
- "Lawyers who bill clients an hourly rate for time spent on a matter must bill for their actual time", including time spent using the AI tools. Billing = prompting + reviewing/verifying output.
- Efficiency may require lower fees; charging the same flat fee when AI makes the work much faster may be unreasonable under Rule 1.5.
- Do not bill for time spent learning a tool (unless client requested that tool).
- Before charging for tool use, explain the basis for the charge; disclosure preferably in writing (Rule 1.5(b)).
- Builds on Opinion 93-379: billing more hours than actually spent is not permitted.
- Overhead vs disbursement: secondary summaries say general AI features are overhead; matter-specific tool costs may be passed through at reasonable cost with agreement [R, inconsistent; verify in primary text].

**State guidance** (all [R]; verify primary texts):
- Florida Op. 24-1 (Board approved Jan 19 2024): tell client before charging actual AI cost; no billing for AI-saved time or double billing.
- Texas Op. 705 (Feb 2025): bill actual time using/refining/checking; no hourly charge for "saved" time; per-use expenses at cost.
- California State Bar 2026 guidance (replacing 2023; per [Wilson Elser, Q2 2026](https://www.wilsonelser.com/publications/california-state-bar-issues-2026-ethics-guidance-on-ai-use-in-legal-practice)): "Billing must reflect the actual time spent on a matter"; general AI subscriptions are overhead; matter-specific costs chargeable if fee agreement discloses, no markup without informed written consent.
- Also listed by secondary sources (details unverified): Pennsylvania/Philadelphia Joint 2024-200, NYC Bar 2024-5 (Aug 7 2024), DC 388, Oregon 2025-205, Alaska 2025-1, Virginia LEO 1901 (Nov 2025), Alabama 2026-01.
- **No bar opinion found that specifically addresses AI-generated (auto-drafted) time entries.** The governing rule is unchanged: the entry must be accurate and reviewed by the lawyer.

**Client guidelines.** A survey of 1,054 outside-counsel guidelines gathered Sept 15-16 2026 found 20 (about 2%) mention AI; 9 change AI billing; 2 refuse payment for time using/learning AI tools; 2 refuse AI subscriptions; 3 expect savings passed through ([Fulkerson Advisors](https://www.fulkersonadvisors.com/research/ai-in-outside-counsel-guidelines) [V]). Zscaler: "If a timekeeper uses generative AI for a discrete task, they should note that in their time entry" and "Any time and cost associated with AI-generated work product shall not be passed on" [V]. Block billing bans and task codes remain the common OCG constraints [R, Intapp enforces both [V]].

**Employee monitoring law** (for firms deploying passive capture):
- **New York Civil Rights Law 52-c** (effective May 7 2022): written notice at hire, acknowledged in writing/electronically, posted conspicuously; AG enforcement, $500/$1,000/$3,000 penalties ([Justia](https://law.justia.com/codes/new-york/cvr/article-5/52-c-2/), [Harris Beach](https://www.harrisbeachmurtha.com/insights/big-brother-hold-on-new-york-employers-must-advise-employees-and-prospective-employees-if-electronic-activities-will-be-monitored/) [R]). Covers phone/email/internet monitoring.
- Also: Connecticut and Delaware have monitoring-notice statutes [M]; California CCPA/CPRA covers employee personal data with notice-at-collection duties [M].
- **GDPR/EU**: lawful basis (consent weak in employment; legitimate interest typical), DPIA for systematic monitoring, Article 88 national rules; Germany BetrVG 87(1)(6) works-council co-determination, BDSG 26 [R]. CJEU C-34/21 on Art. 88 safeguards [M, unverified].
- Product implication: ship an employer notice template, per-user visibility (drafts private to timekeeper, as WiseTime/Memtime), and a "personal use excluded" control; do not give managers raw activity.

---

## 4. Research on time leakage and accuracy

- Clio 2017 Legal Trends Report: lawyers record about 2.3 billable hours in an 8-hour day [R via search summary; original not re-fetched]. Clio's later reports frame uncaptured time as small tasks (email, short calls) lost to end-of-day reconstruction [R].
- A claim that "firms lose 10-20% of billable time to manual entry" appears in a vendor article (PointOne) [R, unsourced]; "1 in 5 billable hours" on timely.com [V, marketing]. Treat both as unvalidated.
- 2024 report "2.9 hours per 8" and "74% automatable" only on a marketing page; unconfirmed [R].
- **Gap:** I found no independent audit or peer-reviewed comparison of passive vs manual capture for lawyers, and no neutral measurement of "recaptured hours." The strongest available evidence is vendor case studies (Laurel/Aprio 30 min/day) [V]. Recall-bias literature on time diaries exists in general psychology [M] but I did not locate a lawyer-specific study. Recommendation: instrument our own pilot (suggested-vs-accepted-vs-edited minutes per user) and publish that as evidence.

---

## 5. Mobile prompt sessions (scope addition)

**How to measure the human time on a phone.**
- Session start: first prompt composition event (focus in composer or start of dictation). Composition time = time from composer focus to send, minus idle gaps; for dictation use audio-active duration (we hold the mic session so it is exact). Count only the composer being focused and the app foregrounded; do not log text.
- Reading/review: while the response view is foreground, count time from response-complete to next interaction, capped; use scroll/visibility signals (viewport position changes, a 'response visible' flag, app foreground state via scenePhase). Cap un-interacted viewing per response at a bound proportional to response length (for example response word count / ~200-250 wpm + a verification allowance) so a phone left face-up does not bill; screen-lock or background ends the span.
- Session grouping: merge prompts and reviews into one session if the gap between human activity spans is under a threshold. Web analytics default is 30 min of inactivity ([GA4 sessions docs](https://developers.google.com/analytics/devguides/collection/ga4/sessions), [R]) but that is far too generous for billing; for billing I recommend a 5-10 min inactive gap (configurable) for merging within the same matter, and starting a new entry after that. Show the user the gap as non-billed. These numbers are my design proposal, not vendor-documented [M].
- Same-matter prompts across phone and Mac in one window should merge into one entry with device list.

**How existing products capture mobile.**
- Clio: outbound calls via Clio mobile app; manual log after calls [R].
- Laurel: wiki listing says it captures calls, mobile email, runs on iOS [R]; Intapp: mobile timers via Siri, background timers, offline sync [V].
- iOS does not let third-party apps observe native calls, messages, or foreground app, so automatic iPhone capture of those is unreliable; tools like Time Miner import carrier call/text logs after the fact [R]. Conclusion: on iOS, capture only what happens inside our app and calendar/call integrations the user opts into; do not promise system-wide mobile capture.

**Ethics for phone sessions.** Same rules as section 3: bill the lawyer's actual time prompting and reviewing; do not bill the model's run time or what the work would have taken by hand (Op. 512, Texas 705, Florida 24-1) [R]. Flat/fixed-fee matters: no hourly entry, but still record time for internal profitability. Disclosure belongs in the engagement letter, and any client OCG that requires AI notation in the entry (Zscaler example [V]) should be a per-client setting.

**Narrative guidance.**
- Describe the lawyer's task, not the tool, by default: "Analyze indemnification provisions in draft asset purchase agreement" (LawSites example [V]). Add "using AI-assisted review" only where an OCG/engagement requires it; make this a per-client template switch (Zscaler [V]).
- Avoid wording that implies the lawyer personally did hours of manual work.
- Keep to one task per line to satisfy block-billing bans; offer to split (Intapp does this [V]).
- Use verbs that reflect the human step actually measured: "Prepare instructions for", "Review and revise AI-generated draft of".

**Agent work: separate line or nothing?** Options:
1. *Not billed, tracked internally (recommended default).* Agent run time is not lawyer time; Op. 512 ties hourly billing to actual lawyer time [R]. Record it in a separate "agent ledger" for audit/cost analysis and for client disclosure if asked.
2. *Technology disbursement.* Allowed in some opinions only if disclosed in the fee agreement and passed through at cost with no markup (California, Texas, Florida, Op. 512 summaries [R]); many OCGs forbid it (Zscaler; 2 of 20 guidelines refuse subscriptions [V]). Offer it as an off-by-default per-client option, never as an hourly line.
3. Never show agent minutes with an hourly rate or timekeeper identity of a lawyer.
Legal advice should be confirmed with counsel before shipping defaults.

---

## 6. Design recommendation for our product

**Principle:** three separate ledgers, one review surface.
- `human_activity_spans`: who, device, matter (nullable), source, start/end, confidence, evidence-ref (ids, never content).
- `agent_runs`: agent, matter, start/end, tool calls, tokens/cost, initiating user. Never converted to billable hours.
- `time_entries`: drafts proposed from spans, approved by the timekeeper, with raw minutes, rounded minutes, UTBMS codes, narrative, status, and links to spans (audit trail).

**Signals, in our app (exact):** active matter/project, document id, chat/thread id, composer focus, dictation duration, response visibility and scroll position, tab visibility/app foreground, review actions (accept/reject/edit of AI output), file open/edit durations. All metadata; no keystroke content.

**Signals, on the Mac app (Accessibility / Screen Recording / Input Monitoring held for computer use):** the temptation is to reuse those permissions for capture. Recommend the minimum:
- Idle: seconds-since-last-input (no event tap) [M].
- Foreground app: `NSWorkspace` frontmost app (no permission). Window title and document path: via Accessibility (needs the permission); read title/path only, not text.
- Browser URL/title: Accessibility or extension; store host plus matter-token matches, hash the path unless needed.
- Calendar (EventKit, user-granted), email/DMS metadata through integrations rather than screen reading.
- Do NOT use Input Monitoring for time capture, and do not use Screen Recording continuously for capture (Ajax does and must defend deletion and SOC 2 [V]). If screen OCR is ever offered, make it opt-in per firm and process on-device.
- Keep a clear boundary: permissions requested for computer use must not silently power passive capture; separate consents and UI toggles.

**Attribution pipeline:** (1) in-app deterministic context wins; (2) DMS/filed-document and matter-token rules; (3) email domain/contacts and calendar; (4) LLM classifier over titles/subjects with top-3 matters and confidence; (5) recency prior. Below threshold goes to "unassigned" tray, never auto-posted. Learn from every correction (per-user rule suggestions like Timing's Option-drag rules [V]).

**Narrative generation:** build from structured features (matter, task type from app events, document names, meeting participants) rather than raw content; LLM produces one past-tense, single-task sentence; second pass validates against client OCG rules (block billing, restricted terms, vague terms), and proposes UTBMS codes with history weighting like Intapp [V]. Run the LLM under zero-retention terms; show the evidence behind each suggestion.

**Review UX:** daily timeline of spans + proposed entries (Intapp timeline pattern [V]); drafts private to the timekeeper; one-tap approve, split, merge, reassign; show raw vs rounded minutes; "why this matter" explanation; weekly nudge for unassigned time. A mobile card per phone session: "12 min on Smith v. Jones, prompt + review", confirm or edit.

**Governance:** firm admin settings for notice/acknowledgment (NY 52-c), exclusion list, retention (default delete raw spans after entry posting plus N days), no manager access to raw activity, per-client AI-disclosure template, audit log of edits.

**Pilot metrics:** suggested-vs-accepted minutes, edit distance of narratives, unassigned share, per-user hours recaptured vs a baseline month. This gives the independent-ish evidence the market lacks.

**Open items needing counsel or primary sources:** exact Op. 512 text on overhead; Florida/PA/DC/NYC billing language; GDPR works-council requirements per target country; whether any client OCG in our customer base bars AI-assisted entries.
