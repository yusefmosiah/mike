# Dictation vocabulary

Design for recognising proper nouns in dictation. Status: approved for
implementation (step 1).

## Evidence

A spike with fictional legal names ("Okonkwo-Lindqvist", "Szczepański
Holdings", "Ximena Achterberg", "Thibodeaux & Nakamura LLP",
"Vasquez-Oyelaran"), spoken by four macOS voices and transcribed by Fluid
Speech Mini: the names were right in 1 of 32 places without help ("Conquo
Lindqvist", "Zamina Akterberg"). A post-transcription matcher (Double
Metaphone codes plus normalised edit distance over 1–4-word windows) fixed 22
of 32 at score ≥ 0.8 and 28 of 32 at score ≥ 0.7, with no false corrections
across 42 ordinary sentences, including near misses ("Kingsley Holdings",
"Lindsay Oyelaran", "Vasquez filed"). The first false correction appeared at
0.55. FluidAudio's CTC vocabulary boosting fixed about 20 of 32 but needs a
second 99 MB model and rewrote unrelated words; it is step 2, not now.

## Step 1 (this change)

### The list lives in the Mike account

- Each user has a dictation vocabulary: a list of terms (a phrase of 1–4
  words, at most 64 characters; at most 500 terms), stored server-side with
  the user's other settings so it follows them across the phone, the browser
  and the Mac app. Find where per-user settings already live (the
  personalisation or profile settings) and follow that pattern: a migration
  per AGENTS.md if a new column or table is needed, `schema.sql` updated, a
  module service and routes (`GET` and `PUT` for the whole list), validation
  with explicit 4xx errors, and calls in `frontend/src/app/lib/mikeApi.ts`.
- Terms are matter and party names: never log them, and keep them out of
  analytics and error reports.

### Settings → Voice

- A "Vocabulary" section: add a term, remove a term, the list sorted
  alphabetically, an empty state, a short explanation ("Names and terms
  dictation should spell exactly"). Follow `docs/design-system.md` and the
  existing Settings → Voice layout; update its loading state.
- Shown on every surface that offers dictation.

### Automatic terms

At record time the web app adds, to the user's list, names from what the
person is working in, when available on the page: the project's name, the
chat's title, the file names of the chat's or project's documents (without
extensions; split on separators so "Smith v Jones - SPA.docx" yields
"Smith v Jones"), and the names of people the chat or project is shared
with. Automatic terms need at least 6 characters, are capped at 200, and
come after the user's own terms. Do not fetch anything new for this: use what
the page already has.

### Correcting the transcript

- A pure function in `frontend/src/app/lib/voice/` applies the vocabulary to
  any engine's transcript: Double Metaphone (the MIT `double-metaphone`
  package) plus normalised Levenshtein. Normalise by stripping diacritics,
  `&` → "and" and lower-casing for comparison only, and write the term as the
  user spelled it. Slide windows of the term's word count ± 1. Score =
  0.6 × phonetic similarity (best of primary/secondary codes) + 0.4 ×
  character similarity. Accept when score ≥ 0.7, phonetic ≥ 0.7 and
  character ≥ 0.5. Reject windows that start or end with a stopword, skip
  spans already exactly right, resolve overlaps greedily by score, keep the
  surrounding punctuation, and for automatic terms require windows of at
  least 6 characters.
- Applied in `transcribeRecording` (`engines.ts`) after every engine.
- Tests: the spike's fixtures as unit cases (baseline transcripts in, names
  out), the 42 ordinary sentences unchanged, threshold edges, punctuation and
  casing kept.

### Apple's recognizer

Pass up to 100 terms (user's first) to the iPhone plugin's `transcribe` as
`vocabulary`, and set `contextualStrings` on `SFSpeechRecognitionRequest`
and `AnalysisContext.contextualStrings` on iOS 26 `SpeechAnalyzer` in
`OnDeviceSpeech.swift`. The Fluid Speech Mini path ignores `vocabulary` for
now. An older app build ignores the extra option; the web-side correction
still applies.

## Step 2 (later, only if real dictation still misses names)

FluidAudio's CTC keyword spotting with Parakeet CTC 110M on the iPhone, used
only to detect which terms were heard (`ctcTokenEvaluateCandidates`), with
the replacement done by the matcher above.

## Not changing

The speech models, recording, the backend `/audio` routes, the Word add-in.
