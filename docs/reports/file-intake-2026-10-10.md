# File and image intake: research and proposal

Date: 2026-10-10. Status: research and proposal; nothing here is built.

The owner asked how Mike should handle images properly, with the model picker
and the system knowing which models can see, and with best practice on
resizing. The same question covers plain text, Markdown and the long tail of
file formats (ebooks, archives, HTML and others), with security in mind.

Context that shapes the answer:

- Firms run Mike on their own premises, mostly on local GPUs with Phala as a
  fallback, and handle privileged documents.
- Individuals run it on a spare laptop (`desktop-node-scope-2026-10-10.md`,
  section 2.6), where data science matters.

The research used two parallel literature searches plus a read of Mike's
code. Labels:

- **[V]** vendor documentation or model card;
- **[3P]** a third party's measurement or report;
- **[U]** unverified, including our own arithmetic or judgement.

## The short answer

1. **Vision is half built.** The model layer carries image parts, each model
   has a `supportsVision` flag that fails closed, and the runtime substitutes
   text for a model that cannot see. But nothing produces an image: uploads
   take only PDF and Office files, no tool returns one, and the model picker
   does not know which models see.
2. **Resize on our side, always.** Different models want different sizes
   (Claude 1568 or 2576 px, Qwen in 32 px steps, Gemma 4 in 48 px steps).
   Several reject oversized images rather than shrinking them. Phala's
   server-side limits are not ours to set. So:
   - store one cleaned, capped copy of each image;
   - derive a per-model copy at send time, snapped to the model's grid;
   - keep only the last few screenshots in a long agent loop.
3. **Clean every image the same way.** Decode with sharp/libvips restricted to
   JPEG, PNG, WebP and GIF; cap pixels; apply the EXIF orientation; flatten
   transparency onto white; convert to 8-bit sRGB; strip all metadata (GPS
   included). Never rasterise SVG.
4. **Refuse, don't drop.** A turn with an image and a text-only model is
   refused before sending, naming models that can see. Images already in a
   thread's history become a text placeholder for a text-only model; the
   stored image is never changed.
5. **The long tail splits three ways:**
   - *Text-like formats* parse safely in the backend after limits and
     cleaning: text, Markdown, code, CSV, JSON, YAML, XML with its DTD
     refused, notebooks, HTML, email.
   - *Container and office formats* convert in a disposable sandbox: RTF,
     OpenDocument, iWork, EPUB, MOBI, archives.
   - *Data files whose readers can execute code* never parse in the backend.
     They go raw to the workstation VM, opened only with safe readers.
     Pickle-class files are not opened at all.
6. **No converter is a security boundary.** MarkItDown says so itself, and
   Tika moved parsing into forked processes. Mike owns one pipeline: sniff,
   limit, scan, convert in a sandbox, clean, index. Each format is an adapter
   behind it.
7. **One gap exists today.** LibreOffice already runs as a plain subprocess
   of the backend (`backend/src/lib/convert.ts`), with only a timeout. It
   should move into the sandbox with everything else.

## 1. Where Mike is today

| Area | State | Where |
|---|---|---|
| Upload types | Eight extensions, checked by name only: pdf, docx, doc, xlsx, xlsm, xls, pptx, ppt | `backend/src/lib/documentTypes.ts`, `backend/src/modules/uploads/uploads.manifest.ts:210`, `frontend/src/app/lib/documentUploadValidation.ts` |
| Content sniffing | None at upload; `read_document` only logs magic bytes when debugging | `backend/src/modules/chat/engine/tools/documentOps.ts:2057` |
| Batch size | 2 GB per upload batch | `uploads.manifest.ts` |
| Converters | In process: pdfjs, SheetJS, mammoth/docx reader. LibreOffice as a subprocess with a timeout and SIGKILL. Markdown and plain-text readers exist (Mission 14) but uploads don't route to them | `backend/src/lib/convert.ts`, `backend/src/lib/documentModel/` |
| Image parts | Types, runtime and fallback exist; nothing produces them | `backend/src/lib/llm/types.ts:41`, `backend/src/lib/llm/pi/runtime.mts:850` |
| Vision flag | `supportsVision` per configured model, false when omitted; an OpenCode Go allowlist | `backend/src/lib/llm/models.ts:159,217`, `docs/configured-models.md` |
| Picker | Shows no capability | frontend model picker |
| Workstation | pandas, polars, DuckDB, pyarrow, matplotlib, openpyxl, pdfplumber, pypdf, python-docx, lxml, bs4 | `infra/workstation/guest.nix` |

pi-ai itself silently ignores an image sent to a non-vision model [V]. Mike's
runtime already avoids that by substituting the fallback text, which is the
right base.

## 2. Images

### 2.1 Knowing which models see

Resolve `supportsVision` in this order:

1. **Admin declaration** in the model config. This is today's
   `MIKE_MODEL_CONFIG_JSON` `supportsVision`, and it stays primary: vLLM does
   not report vision on `/v1/models` [U, none found], and on-premises firms
   mostly run vLLM or SGLang.
2. **A runtime probe** where the server offers one: Ollama's `/api/show`
   `capabilities: ["vision"]`, and llama.cpp's `/props` `modalities` and
   `/v1/models` `input_modalities` [V].
3. **A catalogue** for hosted models: models.dev `modalities.input`, or
   OpenRouter `architecture.input_modalities` [V].
4. **Otherwise false.**

Record which of the four decided, so a wrong value can be traced.

OpenCode Go's own page confirms image input only for DeepSeek V4 Flash
Vision Exp. models.dev lists the underlying GLM-5.3-Flash, Kimi K3, MiniMax
M3 and DeepSeek V4.1 Flash as taking images on other providers [V/3P]. Our
allowlist (`OPENCODE_GO_VISION_MODEL_IDS`) should be checked by a probe
before the picker advertises it.

**In the interface** (`docs/design-system.md` rules: plain text, not a pill):

- The picker says "Sees images" under each model that can.
- With an image attached and a text-only model chosen, the send button is
  disabled. An inline message names the model and offers the vision models
  in this deployment. A text-only model is never chosen silently.
- The backend refuses the same turn (`400 model_cannot_see_images`) in case
  the client is stale.
- **History:** after a switch to a text-only model, earlier images are sent
  as a placeholder (name, size, and a cached description if one exists).
  The stored image is never altered. Open WebUI's bug is the warning here:
  it blocks every follow-up in such a thread (issue #20129) [3P].
- A later option: "describe with a vision model" writes the cached
  description, so a text-only model can continue with the content.

### 2.2 Resizing

Resize client-side, meaning in Mike before the provider sees the image:

- **Anthropic** says to resize before upload, for latency and exact
  coordinates. It *rejects* oversized computer-use tool-result images
  rather than shrinking them [V].
- **OpenAI** rejects above 30,000 patches [V].
- **Qwen3.8-27B's checkpoint** accepts up to about 16.8 MP (about 16,000
  tokens) per image unless the server caps it. That is a VRAM and latency
  risk [V]. One community vLLM build failed above about 2 MP [3P].
- **Phala's** server settings are not ours to change.

Snapping to the model's own grid makes its internal resample a no-op, so
token counts and coordinates are exact.

**Two steps:**

1. **At intake, once per image** (attachment or tool output):
   - Sniff the magic bytes. Allow JPEG, PNG, WebP and GIF. Allow HEIC only if
     the decoder is installed (sharp's prebuilt binaries leave HEVC out for
     patent reasons [3P]).
   - Cap the raw file at 20 MB.
   - Clean it as in 2.3.
   - Store a canonical copy capped at a 3072 px long edge [U heuristic]:
     PNG for screenshots, pages and diagrams; JPEG at quality 90 with 4:4:4
     chroma for photos.
   - Record the hash, the dimensions, a `kind` (photo, screenshot, page,
     diagram) and a thumbnail.
2. **At send, once per image and model, cached by both:** resize in one
   step from the canonical copy, never from an already-compressed
   derivative.

| Model | Photos | Screenshots and pages | Note |
|---|---|---|---|
| Claude 4.7 and later | 1568 px long edge | 2576 px and 4784 tokens | Tokens = ceil(w/28)·ceil(h/28) [V]. Use Anthropic's published `resizedSize()`, since the token cap usually binds before the edge |
| Claude, older | 1568 px and 1568 tokens | same | |
| OpenAI GPT-5.4 to 6 | `detail: high`, 2048 px and 2,500 patches | `original` for dense pages and computer use | Tokens = 32 px patches × 1.2 [V] |
| Gemini 3 | `media_resolution: high` (1120 tokens) | `medium` for documents; `ultra_high` for computer use | Fixed tokens per image [V] |
| Qwen3.x (local or Phala) | 1,280 tokens (1.31 MP) | 2,560 to 3,072 tokens (2.6 to 3.1 MP) | 32 px per token; snap to multiples of 32. Also set the server's `max_pixels` on firm GPUs [V/U] |
| Gemma 4 26B-A4B | 280 to 560 budget | 1120 budget (about 2.6 MP) | Sides divisible by 48 [3P via HF docs] |
| DeepSeek V4.1 Flash | about 1300×1300 area | same; larger is wasted | 1024 tokens maximum. **Images only in user messages** [V] |
| GLM-5.3-Flash, MiniMax M3 | 1568 px, about 1.2 MP | same | No published limits; measure `usage` [U] |

**Request-level rules:**

- Above 20 images in one Claude request, every image must be at most
  2000 px per side [V].
- At 15 or more images, DeepSeek caps each at 4096 px [V].
- Agent loops resend history, so keep only the last 3 to 5 screenshots as
  images and the rest as placeholders [U]. Anthropic's 32 MB request cap
  binds before its count cap [V].
- Number multiple images ("Image 1:", "Image 2:") [V].
- Place text before or after images per model. Anthropic and Gemma prefer
  images first; Gemini and OpenRouter prefer text first [V].

**When downscaling hurts:** OCR accuracy tracks resolution closely while
scene recognition barely changes [3P]. For small print, crop and zoom rather
than raising the whole image's resolution. That means a zoom tool returning
a full-resolution region (Anthropic's `zoom`) [V].

### 2.3 Hygiene and security

- **Decoder:** sharp on libvips.
  - Set `VIPS_BLOCK_UNTRUSTED=1`. Block every loader, then allow only the
    JPEG, PNG, WebP and GIF buffer loaders.
  - Set `limitInputPixels` to 100 MP [U number] and keep
    `failOn: 'warning'`. Never set `unlimited`.
  - Set `pages: 1`, so animated images give their first frame, as Anthropic
    does. Kimi bills animated input as video; OpenAI refuses animated
    GIFs [V].
  - Decode in a worker with a memory cap. Upgrade sharp on every libwebp
    or libheif advisory. libwebp's CVE-2023-4863 was exploited in the wild,
    and libvips had a TIFF overflow in 2026 [3P].
- **Orientation:** apply EXIF orientation (`autoOrient`) before encoding.
  sharp strips the orientation tag along with everything else [V].
- **Metadata:** never call `keepMetadata` or `withMetadata`.
  - The default strips EXIF, XMP, IPTC and the ICC profile, and converts to
    sRGB [V].
  - Anthropic and OpenAI say they ignore metadata [V], so this is about
    what we store and export: GPS in a photo of a client's office is the
    leak.
  - Never keep the unstripped original.
- **Transparency:** flatten onto white. vLLM defaults to white too [V].
  Otherwise transparent pixels often arrive black.
- **Colour:** convert CMYK and 16-bit images to 8-bit sRGB.
- **SVG:** never rasterise an untrusted SVG. librsvg and CairoSVG have had
  XXE, SSRF and denial-of-service bugs [3P]. Treat SVG as text (Open WebUI)
  or refuse it as an image (Kimi).
- **Prompt injection in images:**
  - OWASP lists hidden instructions in images as unsolved [V].
  - Trail of Bits showed images that reveal injected text only after
    downscaling, and exfiltrated data through Gemini CLI [3P]. Their advice
    is to show the user exactly what the model saw.
  - Mitigations:
    - a "what the model saw" preview;
    - text from images treated as untrusted (as document text already is);
    - approval for sending, writing and network actions once image content
      is in play;
    - text read from an image never becomes a tool argument without
      approval.

### 2.4 Screenshots and tool results

- Tools that return images (browser and computer use, rendered PDF pages,
  matplotlib charts from `run_python`) return them as tool-result images.
  For DeepSeek, which accepts images only in user messages, they are
  re-sent as a user message [V].
- Keep the scale factor with each screenshot and map the model's
  coordinates back. The coordinate space is per model: pixels of the sent
  image for Claude, a normalised 0–999 or 0–1000 grid for Gemini [V],
  unknown for Qwen [U].
- Recommended screens for computer use (Anthropic): 1024×768 or 1280×720
  for desktops, 1280×800 or 1366×768 for web apps, nothing above
  1920×1080 [V].

### 2.5 Pages of documents as images

- Anthropic's PDF support sends each page as both text and an image.
  OpenAI's does the same on vision models. OpenAI does not extract images
  embedded in non-PDF files, so convert those to PDF first [V].
- Mike's rule [U]:
  - *Text only:* born-digital pages with a good text layer.
  - *Page image plus text:* scans, pages whose figures, charts or tables
    matter, pages where extraction looks garbled, or when the user or agent
    asks to look.
  - *Cap:* about 20 page images per request.
- Render by pixel budget, not DPI. US Letter at 150 DPI is 1275×1650:
  about 2,700 Claude tokens and 2,080 Qwen tokens [U arithmetic]. Use 200 to
  300 DPI crops for small print. Keep the page number and box so citations
  map back.

### 2.6 What each model record should carry

Beyond `supportsVision`, each model's record should carry:

- how the vision value was decided (admin, probe, catalogue);
- images allowed in tool results, and in which message roles;
- maximum images per request, and the many-image threshold with its
  smaller edge;
- maximum bytes per image and per request;
- maximum long edge, pixels and tokens;
- accepted formats;
- the token formula: patches with a size and grid, fixed budgets, or fixed;
- whether we must resize (`client-required`) or the server shrinks or
  rejects;
- OpenAI's `detail` and Gemini's `media_resolution` defaults;
- image placement;
- coordinate space;
- for self-hosted models, the server's actual `max_pixels` and images per
  prompt.

Every number keeps its source URL and the date checked. The research report's
`ModelVisionConfig` sketch is a good starting shape.

## 3. The long tail

### 3.1 The pipeline (one, for every format)

1. **Receive** into quarantine under a random name, with a hard byte cap.
   Never use the user's filename on disk (OWASP).
2. **Sniff:** compare extension, declared type and magic bytes. Use
   `file-type` (MIT) for binary formats and content probes for text
   formats, which `file-type` cannot detect.
   - A mismatch means refuse or re-route.
   - A polyglot is parsed only as its strictest type.
   - Run the sniffer with a size cap and timeout. Its maintainers call
     malformed-input robustness "best-effort" [V].
   - Check inside containers: `vbaProject.bin` in Office files (`file-type`
     reports a `.docm` as `.docx`), DRM markers in ebooks.
3. **Limits**, measured after decompression: total bytes, expansion ratio,
   entry count, nesting depth, pages, rows, tokens.
4. **Scan:** ClamAV as a separate daemon (GPL-2, out of process). Treat
   "limits exceeded" as quarantine, not clean. Offer an ICAP hook for firms
   with their own gateway; no open-source content-disarm engine is
   mature [3P].
5. **Convert in a sandbox:** a disposable VM or gVisor sandbox per job.
   - No network, a read-only input, scratch on tmpfs, non-root, seccomp.
   - CPU, memory, time, process and file-size limits.
   - Destroyed after the job.
   - Output crosses back as JSON blocks only, checked against a schema.
   - Use a separate converter VM, not the user's workstation, so a hostile
     file cannot reach their other files [U].
6. **Normalise and clean:**
   - Unicode NFC.
   - Strip Unicode tag characters (U+E0000–E007F, "ASCII smuggling"),
     keeping flag emoji.
   - Flag zero-width characters and bidi overrides (Trojan Source); drop
     hidden HTML.
   - Cap line and block sizes.
   - Record provenance: source, member path, converter version.
7. **Index:** blocks with stable ids for citations, derived from content and
   member path so a re-upload gets the same ids. Register the raw file for
   the workstation. Record a verdict the interface shows: `ok`, `warnings`,
   `quarantined`, or `refused: drm | encrypted | pickle | …`.

### 3.2 Formats by family

| Family | Extractor | Runs in | Main risks | The agent sees |
|---|---|---|---|---|
| Text, Markdown, code, LaTeX as text | Mike's own (Mission 14 readers) | Backend | Encoding, invisible Unicode, giant lines, bidi | Blocks; code as line ranges |
| CSV/TSV | A preview parser in the backend; DuckDB in the VM | Backend for preview, VM for the rest | Size; formula injection when *we* export | Schema, row count, first rows; the full file in the workstation |
| JSON, YAML, XML | `JSON.parse`; a safe-schema YAML loader; XML refused if it has `<!DOCTYPE` or `<!ENTITY` | Backend | Billion laughs, XXE, deep nesting, YAML tags | Small files as blocks; large ones as a schema plus the workstation |
| Notebooks (.ipynb) | `JSON.parse`, never executed | Backend | HTML/JS in outputs, base64 blobs | One block per cell; output HTML/JS dropped; images through 2.3 |
| HTML, .mhtml | jsdom (no scripts or subresources) + Readability + DOMPurify + turndown | Backend worker with timeout, or VM | Scripts, tracking, hidden-text injection, `srcdoc` | Markdown blocks; hidden text removed and noted |
| Email (.eml, .mbox) | PostalMime (mailparser is in maintenance mode) | Backend; VM for large mbox | Attachment recursion, spoofed headers, remote images | Headers, body, attachment list; attachments re-enter step 1 |
| Outlook .msg, winmail.dat | `@kenjiuno/msgreader` (Apache-2.0); tnefparse (LGPL-3) | VM | Parser bugs, embedded OLE | As email |
| RTF, ODT/ODS/ODP, iWork | LibreOffice headless (MPL-2.0; includes libetonyek for iWork), pandoc, or Docling | VM | XXE, macros, external templates, LibreOffice CVEs in 2026 | The existing document model |
| .docm/.xlsm | Parse only | VM | VBA, DDE, external links | As DOCX/XLSX, flagged "macro-enabled"; macros never run |
| EPUB, FB2 | Docling, pandoc, or unzip + XHTML | VM | Zip handling, XXE, EPUB3 scripts (`srcdoc` XSS in readers, 2026) | Chapters as sections in spine order |
| MOBI/AZW3 | Calibre `ebook-convert` (GPL-3, run as a separate program) | VM | Parser bugs, DRM | As EPUB |
| Archives | libarchive or language zip/tar in the VM | VM | Bombs, path traversal, links, nesting, encryption | A listing; the user picks members to add |
| Data files | See 3.4 | VM only | Code execution on load | Schema and sample in context; the file in the workstation |
| Audio and video | faster-whisper or whisper.cpp (MIT); ffmpeg sandboxed | VM | ffmpeg parser bugs, playlist file reads | A timestamped transcript; speakers unverified |

**Specific rules worth stating:**

- **XML:**
  - Refuse any `<!DOCTYPE` or `<!ENTITY` before parsing. Office, ODF and
    EPUB parts never need one, and EPUB forbids external entities [V].
  - Do not trust a Node XML parser's defaults. `fast-xml-parser` had four
    entity-expansion CVEs in 2026 (use 5.10.1 or later, or
    `processEntities: false`), and libxmljs2 is unmaintained [3P].
  - In Python, use `defusedxml`.
- **HTML:**
  - Remove comments and anything a person would not see (`display:none`,
    `hidden`, `aria-hidden`, off-screen, zero-size text, `data-*`
    attributes) before extracting text. Hidden text is the injection
    channel; `data-*` attributes are the most common cloak (19.8%, Unit 42
    via CSA) [3P].
  - Never fetch remote resources.
  - If the interface ever previews original HTML: a sandboxed iframe on a
    separate origin with a CSP, and never `allow-scripts` together with
    `allow-same-origin`.
- **Email:**
  - Remote images become links, never fetched. EchoLeak (CVE-2025-32711)
    exfiltrated through exactly that path [3P].
  - From and Reply-To are claims, not facts.
  - One recursion budget is shared between email attachments and archive
    members.
- **Ebooks:**
  - Never strip DRM: 17 U.S.C. §1201 [V]. Detect it and refuse with a
    clear message.
  - EPUB markers: `META-INF/license.lcpl` (Readium LCP); `rights.xml`
    (Adobe); `encryption.xml` covering non-font content.
  - MOBI markers: the encryption byte at PalmDOC offset 12.
  - Kindle KFX detection is unconfirmed, so refuse anything that would
    need decrypting.
- **Our own exports:** when Mike writes CSV or XLSX, prefix cells starting
  with `=`, `+`, `-`, `@`, tab or CR with a quote (OWASP CSV injection).

### 3.3 Archives

There is no consensus among products:

- Gmail scans inside archives and blocks risky content [V].
- Claude.ai does not list ZIP as an upload type [V].
- ChatGPT reportedly unpacks archives in its sandbox, inconsistently [3P].
- OWASP advises against accepting ZIP at all [V].

Recommendation: **list, then let the user choose** which members enter the
project. Extraction happens in the converter VM, never the backend:

- **Bombs:**
  - Ratio at most 100:1 and a total budget (1 to 2 GB) [U defaults].
  - Count bytes while reading, since declared sizes lie.
  - Refuse overlapping entries: Fifield's non-recursive bomb (10 MB to
    281 TB) beats depth limits. CPython fixed it in CVE-2024-0450 [3P].
- **Paths:** never write archive names to disk. Members get random names,
  and the original path is kept as metadata.
- **Links:** skip symlink, hardlink and device entries. node-tar had four
  link-escape CVEs in 2026 [3P].
- **Depth:** 2 to 3 levels. Entries: at most 1,000 to 10,000.
- **Names:** refuse control characters, backslashes and colons.
- **Encrypted entries:** refused, or a password asked for.

### 3.4 Data-science files

These go to the workstation only. The backend stores the bytes and
metadata and parses nothing:

| Format | Safe reader | Notes |
|---|---|---|
| Parquet, Arrow/Feather | DuckDB (MIT) or pyarrow 14.0.1 or later | pyarrow had a deserialisation RCE (CVE-2023-47248), and Java parquet-avro another (CVE-2025-30065) [3P]. Lock DuckDB down: `enable_external_access=false` or `allowed_directories`, memory, thread and temp limits, `lock_configuration`, no extension autoload [V] |
| SQLite | `sqlite3` read-only | SQLite's own advice for untrusted files: `trusted_schema=0`, defensive mode, `quick_check`, `mmap_size=0` [V] |
| SPSS, Stata, SAS | pyreadstat (Apache-2.0) | ReadStat has fuzzing-found memory bugs, so sandboxed and capped [3P] |
| HDF5 | h5py | Heap overflows through 1.14.6 (CVE-2025-6516); external storage can read local files, so refuse files that use it [3P/U] |
| .npy/.npz | NumPy with `allow_pickle=False` (the default) | A pickle error means "unsupported", not a retry [V] |
| .rds/.RData | R 4.4.0 or later, sandboxed, or refuse | CVE-2024-27322 ran code on load [V] |
| pickle, joblib, PyTorch `.pt` | **Not opened** | Loading runs code [V]. Scanners are bypassed (picklescan CVEs in 2025), and `torch.load(weights_only=True)` was bypassable before 2.6 [3P]. Show metadata only; suggest safetensors, CSV or Parquet |

**How data reaches the agent** (as ChatGPT and Claude.ai do [V]):

- A compact schema-and-head block in context.
- The raw file in the workstation at a stable path, analysed with
  pandas, polars or DuckDB.
- Citations to sheet or table and row range.

Spreadsheets already follow this pattern in Mike for display. The new piece
is getting the raw bytes into the workstation.

### 3.5 Audio and video

Local transcription is a reasonable on-premises default in 2026:

- faster-whisper or whisper.cpp (MIT; CPU, with GPU when present);
- NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0) as a fast GPU option;
- Voxtral Mini 3B (Apache-2.0, about 9.5 GB of GPU memory).

All are compatible with Mike's AGPL [V]. ffmpeg runs only in the sandbox,
with an explicit `-protocol_whitelist` that excludes `file`, because
playlists can reference local files [V].

### 3.6 Licences

Mike is AGPL-3:

- GPL-3 and AGPL-3 combine.
- GPL tools run as separate programs (Calibre, ClamAV, pandoc, which is
  GPL-2 *or later*) are separate works under the GPL FAQ [V].
- GPL-2-*only* code would be the conflict.
- Use `@kenjiuno/msgreader` (Apache-2.0) in Node rather than linking
  `extract-msg` (GPL-3).
- `jschardet` (LGPL-2.1) is workable.

This is not legal advice.

## 4. Data science for personal mode

The workstation already covers the core: pandas, polars, DuckDB, pyarrow,
matplotlib and openpyxl.

**Packages to add,** all permissively licensed:

- scipy, scikit-learn, statsmodels;
- seaborn, or plotly for interactive charts;
- pyreadstat for SPSS, Stata and SAS;
- h5py;
- sympy;
- `nbformat`, to read and write notebooks;
- R 4.4 or later, if the cousin uses it (R is GPL-2 or later, run as a
  separate program).

**Two features matter more than packages:**

1. **Charts the model can see.** A matplotlib chart returned as a
   tool-result image, through section 2, lets the agent check its own plot.
   This makes vision a prerequisite for data science too.
2. **Data files reach the workstation raw** (3.4). A student's CSV or
   Parquet file should be queryable, not pasted into context.

## 5. Phases

| Phase | Builds | Done when |
|---|---|---|
| I0. Vision | Image intake and cleaning (2.3); per-model derivation (2.2); `supportsVision` resolution with source; picker label; refuse before send and in the backend; history placeholders; Phala's two models declared | A photo is described by Gemma 4 26B-A4B; the same turn on GLM 5.3 is refused naming a vision model; GPS is absent from the stored file; a 30 MP image is resized to the model's grid |
| I1. Pipeline skeleton | Quarantine, sniffing, limits, verdicts, text cleaning, refusal messages | A renamed executable is refused; a tag-character payload is stripped and flagged |
| I2. Text-like formats | txt, md, code, JSON, YAML, XML (no DTD), CSV/TSV, ipynb | Each yields cited blocks; a billion-laughs XML is refused |
| I3. Tool images | `run_python` charts and rendered PDF pages as tool-result images; zoom; last-K screenshots | The agent reads its own chart and corrects an axis label |
| I4. Converter sandbox | Disposable VM per job; LibreOffice moved into it | `.doc` and `.ppt` convert there with no network; a hung conversion is killed and reported |
| I5. HTML and email | Hidden-text stripping; .eml, .mbox, .msg, TNEF | A page with hidden instructions arrives without them, flagged |
| I6. Data files | Raw bytes into the workstation; Parquet, SQLite, Stata/SPSS/SAS, .npy; pickle refused | "Plot column x from this Parquet" works without the file entering context |
| I7. Office-adjacent and ebooks | RTF, ODF, FB2, EPUB with DRM refusal, iWork, then MOBI | A DRM'd EPUB is refused with a clear reason |
| I8. Archives | List and choose; bomb and path defences | A Fifield bomb and a zip-slip archive are both refused |
| I9. Audio and video | Local transcription | A recorded meeting becomes a cited transcript |

I0 and I3 together are the vision work the desktop scope calls V0. I1 should
come before any new format. I4 also closes the existing LibreOffice gap.

## 6. Decisions for the owner

1. **Converter sandbox:** a disposable microVM per job (strongest; it reuses
   the workstation tooling), or gVisor (lighter; one more component).
2. **Malware scanning:** ship ClamAV in the on-premises install by default,
   or only an ICAP hook to the firm's own scanner.
3. **Archives:** list-and-choose (recommended), or refuse until there's a
   need.
4. **Image defaults:** the 3072 px canonical cap and the last-5-screenshots
   window are judgement calls to check on our own pages.

## Unknown or unverified

- Whether vLLM or SGLang can report vision capability, and which server
  flag sets Qwen's `max_pixels` on each.
- Gemma 4's image limits and budget setting in vLLM/SGLang.
- How Phala serves Qwen3.8's vision projector.
- Image limits for GLM-5.3-Flash and MiniMax M3.
- Whether OpenCode Go accepts images for the models in our allowlist.
- OpenAI's recommended computer-use screenshot size.
- Qwen's GUI coordinate convention.
- Whether firms expect ClamAV or ICAP.
- Kindle KFX DRM detection.
- Docling's quality on .msg and iWork files.
- Xberg's maturity (the Rust successor to Kreuzberg, with Node bindings).
- No controlled study of 150 vs 200 DPI at a fixed token budget, or JPEG
  4:4:4 vs PNG for screenshot OCR. Both should be measured on our own
  pages.

## Sources

- **Image limits:**
  - [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision), [coordinates](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates), [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)
  - [OpenAI images](https://developers.openai.com/api/docs/guides/images-vision), [PDF files](https://developers.openai.com/api/docs/guides/pdf-files)
  - [Gemini image understanding](https://ai.google.dev/gemini-api/docs/image-understanding), [media resolution](https://ai.google.dev/gemini-api/docs/media-resolution), [computer use](https://ai.google.dev/gemini-api/docs/computer-use)
  - [Qwen3.8-27B preprocessor](https://huggingface.co/Qwen/Qwen3.8-27B/raw/main/preprocessor_config.json), [Alibaba vision limits](https://www.alibabacloud.com/help/en/model-studio/vision)
  - [Gemma 4 vision](https://ai.google.dev/gemma/docs/capabilities/vision)
  - [DeepSeek vision](https://api-docs.deepseek.com/guides/vision), [Kimi vision](https://platform.kimi.ai/docs/guide/use-kimi-vision-model)
  - [vLLM multimodal inputs](https://docs.vllm.ai/en/latest/features/multimodal_inputs/), [SGLang server arguments](https://docs.sglang.io/advanced_features/server_arguments.html), [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- **Capability catalogues:**
  - [models.dev](https://github.com/sst/models.dev), [OpenRouter models API](https://openrouter.ai/docs/api-reference/models/get-models)
  - [LiteLLM vision](https://docs.litellm.ai/docs/completion/vision), [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)
  - [pi-ai README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md), [OpenCode Go](https://opencode.ai/docs/go.md)
  - [Open WebUI models](https://docs.openwebui.com/features/workspace/models/), [Open WebUI issue 20129](https://github.com/open-webui/open-webui/issues/20129)
  - [LibreChat config](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/config)
- **Image security:**
  - [sharp constructor](https://sharp.pixelplumbing.com/api-constructor), [output](https://sharp.pixelplumbing.com/api-output), [utilities](https://sharp.pixelplumbing.com/api-utility), [sharp HEIC issue](https://github.com/lovell/sharp/issues/4126)
  - [Trail of Bits image scaling](https://blog.trailofbits.com/2025/08/21/weaponizing-image-scaling-against-production-ai-systems/)
  - [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- **Formats and pipeline:**
  - [MarkItDown](https://github.com/microsoft/markitdown), [Docling](https://github.com/docling-project/docling), [Apache Tika](https://tika.apache.org/), [pandoc manual](https://pandoc.org/MANUAL.html)
  - [file-type](https://github.com/sindresorhus/file-type), [OWASP file upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [OWASP XXE](https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html), [EPUB 3.3](https://www.w3.org/TR/epub-33/)
  - [Readability](https://github.com/mozilla/readability), [DOMPurify](https://github.com/cure53/DOMPurify), [PostalMime](https://github.com/postalsys/postal-mime), [msgreader](https://github.com/HiraokaHyperTools/msgreader)
  - [Calibre FAQ](https://manual.calibre-ebook.com/faq.html), [17 U.S.C. §1201](https://www.law.cornell.edu/uscode/text/17/1201)
  - [Python zipfile](https://docs.python.org/3/library/zipfile.html), [tarfile](https://docs.python.org/3/library/tarfile.html), [Fifield zip bombs](https://www.usenix.org/conference/woot19/presentation/fifield)
  - [Securing DuckDB](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview.html), [SQLite security](https://www.sqlite.org/security.html), [NumPy load](https://numpy.org/doc/stable/reference/generated/numpy.load.html), [pickle](https://docs.python.org/3/library/pickle.html)
  - [R CVE-2024-27322 statement](https://blog.r-project.org/2024/05/10/statement-on-cve-2024-27322/)
  - [Unicode tag injection (Cisco)](https://blogs.cisco.com/ai/understanding-and-mitigating-unicode-tag-prompt-injection), [Trojan Source](https://trojansource.codes/), [EchoLeak](https://socprime.com/blog/cve-2025-32711-zero-click-ai-vulnerability/)
  - [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)
  - [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
