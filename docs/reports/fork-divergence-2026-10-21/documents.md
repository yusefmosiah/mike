# Triage: documents and files

Range: `9a0a0a5b..main` vs `9a0a0a5b..upstream/main`. Paths: docx, documentModel, documents, uploads, citations, word-chat, tabular, diligence, workspace, vault, PDF, vision, word-addin, fixtures, frontend viewers.

## 1. Summary

Upstream has no docx object model, no image intake and no automated citation checking. It still edits Word files with the old substring engine (`docxTrackedChanges.ts`), and has only a flag for PDFs without a text layer. Our fork added most of the new capability in this area:

- **Word documents:** a package-preserving model that supports tracked-change editing, with a Word-authored test corpus.
- **Document model:** one block model for every file format.
- **Files in:** images and plain-text files.
- **Citations:** durable checking of the citations in a document, and an in-panel web reader.
- **Turns:** Word and review chats that survive a backend restart.
- **Workstation:** files synced into the workstation, plus a secrets vault.

Much of it is tied to the fork's agent runtime (Pi, turn claims, workstation VMs, `edit_document` tool schema). The self-contained parts are the docx library, the fixtures, the image pipeline and the citation verifier core. Upstream also moved the same files heavily since the fork: workspaces/orgs, playbooks, document search, web search, and a Word add-in rework. Expect rebases, not clean cherry-picks. Dep-bump fixes in the add-in (markdown-it, vite, launch-editor) are already in upstream, so they are not candidates.

## 2. Table

| Cluster | Bucket | Readiness | Maturity | Upstream conflict |
|---|---|---|---|---|
| A. DOCX model and tracked-change editing | MIXED | NEEDS-WORK | shipped+tested | high |
| B. DOCX corpus fixtures and oracles | ADDITIVE | READY | shipped+tested | low |
| C. Document model for all formats | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| D. Images in (vision) | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| E. Plain-text uploads | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| F. Document citation checking | ADDITIVE | NEEDS-WORK | shipped+tested | med |
| G. Web citation reader and snapshots | ADDITIVE | NEEDS-WORK | shipped+tested | high |
| H. Durable Word and review-chat turns | MIXED | FORK-ONLY (for now) | shipped+tested | high |
| I. PDF OCR and hybrid retrieval | ADDITIVE | NEEDS-WORK | experimental | med |
| J. Workspace sync into the workstation | ADDITIVE | FORK-ONLY | shipped+tested | low |
| K. Secrets vault | ADDITIVE | FORK-ONLY | shipped+tested | low |
| L. Diligence / sandboxed execute_code | ADDITIVE | FORK-ONLY | incomplete (unmounted) | low |
| M. Word add-in fork changes | MIXED | FORK-ONLY | shipped+tested | high |

## 3. Clusters

### A. DOCX model and tracked-change editing (Missions 1a, 1b, 1c)

- **Bucket:** MIXED.
- **What changed:**
  - New `backend/src/lib/docx/` (about 5,900 lines): package zip preservation, XML source mapping, style and numbering resolution, a block AST (`view.ts`), and segmented reads by section.
  - Edits address blocks by id and change only the runs they cover. Operations are replace, insert, delete, format, insert_row and delete_row, plus new links and footnotes.
  - Accept and reject work by revision id. `gate.ts` plus linter checks refuse to save a document that fails to load or adds lint errors.
  - Block ids carry across versions (`document_versions.block_ids`), and `document_edits.w_ids` records every revision an edit created.
  - It removes upstream's `applyTrackedEdits` and `resolveTrackedChange`. The `edit_document`, `read_document` and `find_in_document` schemas and the system prompt were rewritten around it.
  - Why: the earlier synthetic-only tests passed while real Word files were corrupted (`fixtures/docx/README.md`).
- **Key commits:**
  - c79c4470 feat(docx): document AST, segmented reading, and Word-authored test corpus (mission 1a)
  - ff470742 feat(docx): tracked-change editing on the document model (mission 1b)
  - 4f0f1867 feat(docx): formatting, new links and footnotes, table rows, edits inside insertions, and block ids across versions
  - e679250b fix(docx): keep zip entries exact on save; section reads include sub-clauses
  - 60efb70f feat(tools): add get_diff self-verification tool and OpenXML invariant linter
- **Key paths:**
  - `backend/src/lib/docx/**`
  - `backend/src/modules/documents/documents.edits.ts`, `documents.blockIds.ts`
  - `chat/engine/tools/documentOps.ts`, `toolDispatcher.ts`, `toolSchemas.ts`
  - `backend/src/lib/docxLinter.ts`
  - migrations 20261007_03 and 20261007_04
- **Upstream readiness: NEEDS-WORK.**
  - The library itself is self-contained and well tested.
  - Landing it means replacing upstream's edit engine and tool schemas. Both sides rewrote `documentOps.ts` and `toolDispatcher.ts` (ours +1,347/-263 lines, upstream +410/-283), and upstream's `docxTrackedChanges.ts` still exists with a small change.
  - Best route: land the library and a flagged new engine behind the existing tool, then switch over.
  - The three corpus oracle tests are slow (60 s budget each).
- **Dependencies:** B for tests. The tool wiring depends on the fork's tool layer; the block-id migration depends on `documents.versions`.
- **Upstream overlap:** none equivalent. Upstream's `DocxView` (EigenPal) and `resolveEdit` still use the old engine.
- **Maturity:** shipped+tested. `goals/TRIAGE.md` still lists real long-document acceptance as open: generator markdown leakage, footnote markers in table cells, and fidelity.

### B. DOCX corpus fixtures and oracles

- **Bucket:** ADDITIVE.
- **What changed:**
  - `backend/src/__tests__/fixtures/docx/` (5.5 MB, SHA256SUMS-pinned) holds Word-authored files from Open-XML-PowerTools (MIT): the RP revision set with Accepted and Rejected twins, and feature files for footnotes, fields, text boxes, TOC and moves.
  - It also holds five public legal documents (UK OGL v3, US federal public domain).
  - `__tests__/helpers/trackedChangesOracle.ts` and `lib/docx/__tests__/*oracle*` check accept/reject against Word's own output.
- **Key commits:** c79c4470 (corpus added), ff470742 (oracle), ea2aa21e test(docx): give the corpus oracle tests a 60 s per-test budget.
- **Upstream readiness: READY** as a standalone test-assets PR. Licence notes are already in the README. The size (5.5 MB of binaries) is the only question for maintainers.
- **Dependencies:** none (useful only once A or an equivalent exists).
- **Upstream overlap:** none.
- **Maturity:** shipped+tested.

### C. One document model for every format

- **Bucket:** ADDITIVE.
- **What changed:**
  - `lib/documentModel/` converts Word, PDF, Markdown, text, spreadsheets and slides into one flat block model (id, kind, level, clause label, text, rows, page, source, ocr, inferred), cached per version.
  - PDF structure is rebuilt from pdf.js lines (headers dropped, headings inferred, bookmarks trusted).
  - Code-mode Python reads the turn's documents as `docs` (outline, sections, grep, BM25, tables as DataFrames, `quote()`) through `codemode/kernel/mike_kernel/docs.py`.
- **Key commit:** 06e90f5f feat(chat): one document model for every format, read from Python as docs.
- **Key paths:** `backend/src/lib/documentModel/**`, `lib/pdfText.ts`, `lib/codemode/kernel/mike_kernel/docs.py`.
- **Upstream readiness: NEEDS-WORK.** The converters are separable. The Python `docs` binding needs the code-mode kernel and workstation. `pdfText.ts` was changed by both sides (upstream +143 lines for text-layer detection).
- **Dependencies:** A (for docx), the code-mode kernel (Python side).
- **Maturity:** shipped+tested.

### D. Images in (vision)

- **Bucket:** ADDITIVE.
- **What changed:**
  - Upstream has no image support (no `sharp`, no image types).
  - `lib/images.ts` cleans each upload once: JPEG, PNG, WebP and GIF only, with a pixel cap, EXIF rotation, flatten, sRGB, a 3072 px cap and all metadata stripped. Only the cleaned copy is stored.
  - At send time images are resized per model family (`chat/engine/attachedImages.ts`).
  - `POST /models/vision` tells the picker which models see ("Sees images"). A turn with an image and a text-only model is refused with 400 `model_cannot_see_images`. Older images become a text placeholder.
  - The web app has an `ImageView`.
- **Key commits:** 096578b3 feat(vision): images in, for the models that can see.
- **Key paths:**
  - `backend/src/lib/images.ts`
  - `modules/uploads/uploads.processing.ts`
  - `modules/chat/engine/attachedImages.ts`
  - `lib/llm/models.ts`, `lib/llm/pi/runtime.mts`
  - `frontend/.../shared/views/ImageView.tsx`
  - `docs/reports/file-intake-2026-10-10.md`
  - `goals/mission-15-vision.md`
- **Upstream readiness: NEEDS-WORK.**
  - Image cleaning, sizing and the viewer are self-contained.
  - The model-capability flag and the image-part delivery live in the Pi runtime and the llm layer (upstream still uses its own `aiSdk.ts`), so they need porting to upstream's provider layer.
  - The upload-session migration (see E) must be rebased.
  - Staging still needs `supportsVision` declared for two Phala models.
- **Dependencies:** `lib/llm` (Pi runtime) for delivery; the model catalog.
- **Upstream overlap:** none.
- **Maturity:** shipped+tested. The research report's further phases (HEIC, "view image" tool, description cache) are not built.

### E. Plain-text uploads

- **Bucket:** ADDITIVE.
- **What changed:** `.txt`, `.md` and `.csv` upload, store and display as themselves. The backend checks UTF-8 and no NUL bytes, and strips the BOM, CRs and Unicode tag characters. The web app gets a `TextView` plain-text viewer.
- **Key commits:** ec855a58 feat(documents): plain-text documents (.txt, .md, .csv).
- **Key paths:** `lib/textFiles.ts`, `lib/documentTypes.ts`, migration 20261010_11 (rewrites the file-type checks and `create_upload_session`), `frontend/.../views/TextView.tsx`, `lib/documentUploadValidation.ts`.
- **Upstream readiness: NEEDS-WORK.** Upstream changed uploads for workspaces and orgs (f7a8f0d8), so the migration must be re-cut against their `create_upload_session`. Combine with D into one "file intake" PR.
- **Dependencies:** none beyond D's migration.
- **Maturity:** shipped+tested.

### F. Document citation checking (Mission 6)

- **Bucket:** ADDITIVE.
- **What changed:**
  - New `modules/citations/` (about 2,200 lines) checks the citations inside documents the assistant drafted or edited. Replies are trusted.
  - A durable job extracts the citations, locates each source (URL, CourtListener, or web search), stores a hashed snapshot, quote-matches it, and has a separate judge model quote its evidence.
  - Verdicts: not-found, contradicted, quote-mismatch, unsupported, verified, unverifiable.
  - Every fetch is audited and honours the project egress policy.
  - A `check_citations` tool, `/citation-checks` routes, an automatic check after edits or on open, and "Checking citations…" status in the UI.
  - `docxReadingText` makes list numbers count as text. OCR noise is tolerated.
- **Key commits:**
  - 62338aa5 feat(citations): durable citation verification as checker tasks (Mission 6)
  - d9e2dae8 feat(citations): check the citations in documents, not replies
  - 4fba2674 feat(citations): check a document's citations automatically
  - ffbcf4af fix(citations): grade quotes against the text with list numbers
  - 889473cc fix(citations): accept real evidence through OCR noise
  - 893203b3 feat(chat): cite inline at the claim (chat area; design in `docs/inline-citations.md`)
- **Upstream readiness: NEEDS-WORK.**
  - It depends on the job queue (`citations.verify`), the verification-task tables (migrations 20261010_03 and 20261010_05), and on A for block anchors in .docx.
  - It also uses CourtListener and the fork's `lib/search`; upstream now has `lib/webSearch`.
  - It is a clean new module, so conflicts are mostly in `app.ts`, `schema.sql`, `jobs/registry.ts` and the tool files.
  - A live probe graded five of five citations correctly.
- **Dependencies:** A (docx anchors), the job queue, the tool layer.
- **Upstream overlap:** none for verification. Upstream has no citation checking.
- **Maturity:** shipped+tested. The owner has not formally accepted it (`goals/STATUS.md`).

### G. Web citation reader and snapshots

- **Bucket:** ADDITIVE.
- **What changed:**
  - A web citation opens a saved copy of the page in the document panel, rendered as Markdown with the quote highlighted, with "Open original" linking to the live page.
  - `fetch_web_page` also returns Readability + Turndown Markdown, and pages are stored in `citation_snapshots.reader_markdown`.
  - `GET /chat/:chatId/web-pages/:snapshotId` serves a snapshot only if that chat cites it. The web app gets a `WebPageView`.
- **Key commits:** a9953af3 feat(citations): open web citations in a reader view in the panel, da27c5d8 feat(citations): clickable web citations, 24d4e562 fix(citations): do not check a copy of a source on its own.
- **Key paths:** `lib/search/reader.ts`, `lib/citationSnapshots.ts`, migration 20261012_01, `frontend/.../views/WebPageView.tsx`, `chat.routes.ts`.
- **Upstream readiness: NEEDS-WORK.** It is built on the fork's `lib/search` engine. Upstream added a different web search (#661, `lib/webSearch`, with its own `pageReader.ts`), so the reader would need to be re-pointed at theirs. It also needs the fork's inline citation format. The idea (a saved reader copy, access-limited to the cited chat) is portable.
- **Dependencies:** F's snapshot store, inline-citation changes in chat.
- **Maturity:** shipped+tested.

### H. Durable Word and review-chat turns, turn claims

- **Bucket:** MIXED.
- **What changed:**
  - The Word and tabular generation loops moved out of the routes into `wordChat.turn.ts` and `tabular.turn.ts`, with `wordChat.prepare.ts` and a shared `turnResumers.ts`. They hand Pi a turn identity so an interrupted turn is resumed after a restart.
  - Both also take the Postgres turn claim (`409 turn_in_progress`). A shared reconnect policy (`turnReconnect`) re-attaches open clients, with `stream_incarnation` / `turn_restarted` frames.
  - Presence shows "X is generating" in review chats, and only the sender can stop a turn.
- **Key commits:** 4afe24c7 feat(chat): resume Word and review-chat turns after a restart, d3248115 feat(chat): tabular and Word chats take the database turn claim, a1259225 feat(turns): re-attach open clients to a turn resumed after a restart, 5d8746db feat(handoff): only the sender stops a turn; presence in review chats.
- **Key paths:** `modules/word-chat/**` (+1,524/-851), `modules/tabular/tabular.turn.ts`, `src/turnResumers.ts`, `lib/turnClaims.ts`.
- **Upstream readiness: FORK-ONLY (for now).** It requires the Pi durable runtime and the turn-claim table. Upstream changed the same routes (tabular playbooks and history, #645, #658, #683; word-chat boundary fixes #649) and added its own recovery work (#615 turn-scoped Retry, #532). A PR would be a rewrite of both. The ideas (claim before run, a single reconnect policy) could be an RFC.
- **Dependencies:** Pi loop, turn claims (chat-area cluster), `assistantTurnRuns`.
- **Maturity:** shipped+tested (resume, claim and Word e2e tests exist).

### I. PDF OCR and hybrid retrieval (Station 10)

- **Bucket:** ADDITIVE.
- **What changed:**
  - `pdfText.ts` detects scanned pages (image ops plus a character heuristic) and runs local OCR with tesseract.js, using a vendored 2.9 MB `eng.traineddata.gz` and per-page caps.
  - A `document_chunks` table with trigram and keyword RRF hybrid search exists as a service-only `retrieval` module with no routes.
- **Key commits:** 7cb661a9 feat(station-10): scanned PDF OCR, hybrid retrieval, mobile shell scaffold. The mobile Capacitor scaffold in the same commit is outside this area.
- **Upstream readiness: NEEDS-WORK.**
  - Upstream independently added text-layer detection and a flag (cf5fa985, 8e8cac43, f3fa62e6), added full-text document search (#645, migration 20261015_01), and edited `pdfText.ts` again.
  - OCR is the only new part.
  - Split it out as "OCR for scanned PDFs", rebased on their detector.
  - Retrieval is dormant and overlaps their search; leave it fork-only.
- **Dependencies:** none for OCR.
- **Maturity:** experimental. `goals/TRIAGE.md` says OCR and retrieval are partial.

### J. Workspace sync into the workstation (Mission 16)

- **Bucket:** ADDITIVE.
- **What changed:**
  - Once per turn, before the first `run_command`, the harness copies what the user can read into `~/mike/projects`, `library` and `templates` in the VM, read-only, and sends only changes.
  - `save_to_mike` is the way back: a workstation file becomes a new document or a new version, after a permission check and a magic-byte type check. Guests in shared threads get neither.
  - Version writes go through `documents.store.ts`.
- **Key commits:** 7ecc8972 feat(workspace): the user's documents under ~/mike in the workstation.
- **Key paths:** `modules/workspace/**`, `lib/workstation/files.ts`, `modules/documents/documents.store.ts`.
- **Upstream readiness: FORK-ONLY.** It needs the workstation VM stack, which upstream does not have. The `storeDocumentFile` facade and the type-vs-bytes check are the only portable parts.
- **Dependencies:** workstation VMs (Mission 13), code mode. Not related to upstream's "workspace" (organizations), which is a different feature with the same name; expect confusion.
- **Maturity:** shipped+tested.

### K. Secrets vault

- **Bucket:** ADDITIVE.
- **What changed:**
  - A host-side service (`infra/vault`, about 3,000 lines, no dependencies) holds credentials the assistant can use but never see.
  - The browser seals the value to the vault's key, so the backend relays ciphertext only.
  - The assistant gets a short-lived lease bound to its VM. The vault attaches the secret only for hosts fixed at storage time, scrubs echoes of the value in many encodings, and keeps leases read-only unless the user approves writes.
  - Chat tools: `vault_secrets`, `vault_request_secret`, `vault_lease`. A one-field credential request appears in the chat. Settings has a Vault page.
  - A multi-model security review hardened it (07df0783).
- **Key commits:** 6ddfbd17, 07df0783, 1372c32f, 4a9ed1d2 (a read lease can clone over git).
- **Key paths:** `infra/vault/**`, `backend/src/lib/vault/**`, `modules/vault/**`, `chat/engine/tools/vaultTools.ts`, `docs/vault.md`.
- **Upstream readiness: FORK-ONLY.** It assumes the node-a host, systemd, vsock sockets and the workstation VMs. Upstream has no VM layer.
- **Dependencies:** J's workstation, Mission 13 VMs.
- **Maturity:** shipped+tested. The threat model lists what is not covered (compromised host, a compromised browser while typing).

### L. Diligence / sandboxed execute_code (Station 9)

- **Bucket:** ADDITIVE.
- **What changed:** `modules/diligence` has an `rlm.deep_run` job (a bounded wave coordinator over project documents, `execute_code`-only toolset, copy-on-write memo) plus `lib/sandbox` (a vm-based `execute_code`).
- **Key commit:** b0e80cc7 feat(station-9): sandboxed code execution and 24/7 RLM diligence.
- **Upstream readiness: FORK-ONLY.** `app.ts` notes the router is not mounted, and the sandbox is disabled. `goals/TRIAGE.md` calls the RLM "not a true recursive engine". Superseded in practice by VM-based code mode.
- **Dependencies:** none live.
- **Maturity:** incomplete (dormant code).

### M. Word add-in fork changes

- **Bucket:** MIXED.
- **What changed:** modest relative to upstream's rework (86 files). Ours is the shared `turnReconnect`, a refusal message for 409 and other refusals (`api/refusal.ts`, 8ddbb798, e93fe8e8), model catalog grouping, brand name from one file, reconnect e2e, and scroll test fixes. There are no major document-handling changes.
- **Upstream readiness: FORK-ONLY.** These changes go with H and the brand package. Upstream's #532 already reworks error messaging and recovery in the add-in.
- **Dependencies:** H, the brand package.
- **Maturity:** shipped+tested.

## 4. PR candidates

1. **test: add a Word-authored DOCX fixture corpus and tracked-change oracle** (cluster B). Fixtures, `SHA256SUMS`, README with licences, and the accept/reject oracle helper. It is zero-risk and unblocks the next PR.
2. **feat(docx): package-preserving DOCX reader and block model** (cluster A, library only). Add `lib/docx` and `documentModel/fromDocx`, plus section reads and block ids, wired to `read_document` and `find_in_document`. Leave the edit engine for a follow-up behind a flag, since it replaces `applyTrackedEdits` and the `edit_document` schema.
3. **feat(uploads): image uploads for vision-capable models** (D, with E). Cleaning pipeline, per-model sizing, the `Sees images` flag and the refusal, `ImageView`, and plain-text uploads with the re-cut migration. Needs a port of delivery to upstream's provider layer.
4. **feat(citations): check the citations in a document** (F). Durable job and verdicts, judge, `check_citations` tool, status UI. Best after PR 2, so quotes anchor to block ids.
5. **feat(pdf): local OCR for scanned PDFs** (I, OCR part only). Rebase on upstream's text-layer detection and skip the retrieval module.

## 5. README digest

- Word (.docx) files are read into a block model and edited as real tracked changes that Word can accept or reject. Edits address paragraphs by stable id and change only the runs they touch, and a document that would not load or lints badly is not saved.
- Word, PDF, Markdown, text, spreadsheets and slides share one block model. Scanned PDFs are read with local OCR (no data leaves the machine).
- Images attach to chats and reach the model only if it can see. They are cleaned once (metadata stripped, size capped) and resized per model. Text files (.txt, .md, .csv) upload as themselves.
- The assistant checks the citations in documents it drafts or edits. It locates each source, stores a snapshot, matches the quote, and has a second model judge whether the source supports the claim. Web citations open a saved reader copy in the panel.
- Word and review chats survive a backend restart and share a per-thread turn claim, so only one answer generates at a time across replicas.
- Documents the user can read sync read-only into the workstation under `~/mike`, and files come back as new documents or versions.
- A host-side vault lets the assistant use a credential without any model, VM or the backend ever holding it. The browser seals the value, and requests go out through leases limited to the hosts the owner approved.
- Not live: the diligence (RLM) router is unmounted and hybrid retrieval has no routes.
