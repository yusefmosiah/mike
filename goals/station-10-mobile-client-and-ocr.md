---
definition_version: 4
readiness: intent
---

# Station 10: Ingestion OCR/Retrieval & Native Mobile Client

> **Incomplete — retained intent, not implementation authorization.** This file
> holds two distinct outcomes: the original Phase 6 ingestion/OCR/retrieval
> half, and original Phase 7 native mobile. Neither is established as accepted in
> the reviewed record. Invalid mobile-build/retrieval recipes have been removed;
> source behavior is distinguished from missing product acceptance below. See
> [`TRIAGE.md`](TRIAGE.md) §3. [`STATUS.md`](STATUS.md) is the authoritative
> agenda; promotion is an owner course decision, not an assistant default.

## Retained goals (desired)

1. **Ingestion/OCR/retrieval** (original Phase 6): scanned-PDF OCR fallback so
   legacy scans are readable, extracted text chunked into `document_chunks`
   and retrieved through hybrid search (trigram + keyword today; pgvector only
   when infrastructure supports it), with extraction provenance and no silent
   blank pages.
2. **Native mobile** (original Phase 7): an enterprise iOS/Android client
   (Capacitor) distributed only through firm MDM inside the WireGuard VPN —
   biometric unlock, immediate background blur, OS-backup exclusion, and no
   confidential matter text in push notifications. Public store distribution is
   excluded. Phone-browser/Tailscale access is a separate, immediate usability
   track, not deferred with native mobile.

## Constraints to preserve

- No confidential matter text in push payloads; detail appears only behind the
  biometric gate.
- The app window blurs immediately on backgrounding (a native cover is needed
  for the app-switcher snapshot race).
- Matter content does not live on the device; the shell caches session material
  and non-secret settings only. Session tokens belong in Keychain/Keystore,
  never in `@capacitor/preferences`.
- OCR must never contact a CDN (vendored language data ships in-repo); a page
  that cannot be read keeps an explicit pending marker, never a silent empty
  page.

## Source implemented (inspected 2026-10-07)

Ingestion/OCR/retrieval:

- `lib/pdfText.ts` runs real tesseract.js OCR with vendored `tessdata` (no
  CDN), conservative scan detection, per-page markers (" — OCR", " — scanned
  image, OCR pending"), a 30 s per-page timeout with worker suspension, and
  `needsOcr` surfaced to the `document.precompute_text` job.
- `modules/retrieval/` implements chunking, `indexVersionChunks`
  (delete/insert of `document_chunks`) and `searchChunks` (trigram + keyword
  RPCs with reciprocal-rank fusion in-module).

Native mobile:

- `mobile/` is a scaffold only: `capacitor.config.ts`, `package.json`,
  `.gitignore` and a README policy guide. No `ios/`/`android/` native projects;
  no install, build, sync, simulator or device run has been performed.
  Biometric unlock, blur, backup exclusion, push and deep links are documented
  hook points, not code.

## Observed limits (dated audit observations, not runtime claims)

- OCR stops after 10 pages per document (`OCR_MAX_PAGES_PER_DOCUMENT = 10`);
  further scanned pages keep the pending marker.
- The retrieval module has no production callers: nothing in the ingestion path
  calls `indexVersionChunks`, chat wiring is explicitly deferred in the module,
  and no pgvector implementation exists. Dormant, not deleted.
- Unit tests exist (`lib/pdfText.test.ts`, `pdfText.integration.test.ts`,
  `modules/retrieval/__tests__/hybridRetrieval.test.ts`); they pin module
  behavior, not ingestion/retrieval acceptance.
- The README records that the frontend is not statically exportable as-is
  (static export forbids server-dependent Next features the frontend currently
  uses) and that the alternative is a Capacitor `server.url` pointing at the
  firm-hosted app inside the VPN. This is an open architecture decision — do
  not enable the static export by default.

## Unresolved acceptance outcomes

- Ingestion/OCR: full-scan coverage beyond the 10-page cap (or an explicit
  product decision); real scanned legacy PDFs accepted; OCR text indexed into
  `document_chunks` from the real ingestion path and retrieved from chat with
  provenance retained; pgvector only when infrastructure supports it.
- Mobile: the export-vs-server-origin decision; generated native projects;
  device security proof (biometric lock, blur/native cover, backup exclusion,
  neutral push payloads); MDM/VPN distribution and a real-device run.

## Mapping

- Original Phase 6 ingestion half + original Phase 7 → this station
  (`TRIAGE.md` crosswalk). STATUS: "Original Phase 7: native mobile/MDM
  remains a scaffold/later track. Immediate phone-browser/Tailscale usability
  is separate and not deferred with it."
- TRIAGE outcomes: "OCR/chunk ingestion/retrieval" and "Native mobile".
- Proposed course D: scaled ingestion/retrieval and native mobile as separate
  later outcomes.
