# Mission 14: One document model for every format, and `docs` in Python

Owner direction, 2026-10-10. A staging thread ("Review it all", five long
documents) showed the problem. The model spent four tool rounds splitting
one concatenated `fetch_documents` string and chasing continuation ids
before it could start reviewing. The owner asked: "think about it from your
perspective: what would be a good interface if you were in this Python
environment doing advanced knowledge work?", then: "coerce documents into
the same AST kind of format… really research it, scope it out, and do a
rich, deep, comprehensive version."

## What the assistant wants, as the user of the interface

When a turn starts, every document is an object in Python and nothing has
entered the context. The prompt shows a map: ids, filenames, formats. The
work goes outline → search → read exact slices. Everything carries ids, so
what is read can be quoted, cited and edited without retyping positions.

```python
docs                               # the documents this conversation can read
d = docs["doc-3"]                  # or docs.find("market report")
d.outline()                        # headings with ids and clause numbers, and section sizes
print(d.section("12"))             # one section, by clause number or heading text
print(d["p884":"p901"])            # a block range, each line with its [id]
d.blocks                           # every block: .id .kind .level .label .text .page
docs.grep(r"DGX Spark.*\$\d")      # every document: (doc, block, label, context)
docs.search("termination for convenience")   # ranked passages across documents
d.tables[0].df                     # a table as a pandas DataFrame
d.quote("p886", "the firm's archive")        # verifies the words verbatim; returns a citation quote
```

## Two layers

1. **The common reading model** (this mission). A document is a flat list
   of blocks. Each block has:
   - `id`: stable for the version;
   - `kind`: heading, paragraph, list_item, table, code, quote, note, figure
     or page_break;
   - `level` for headings and list depth;
   - `label`, the clause or list number as displayed (e.g. `12.3(b)`);
   - `text`;
   - `rows`, for tables;
   - provenance: `page` for PDFs and slides, `source` (the docx block id,
     the Markdown line range, the sheet range), `ocr` when the text came
     from OCR, and `inferred` when structure was guessed (a PDF heading
     recognised by its type size).

   Reading, outline, search, slicing and citation all work on this model.
2. **The native layer** stays where editing happens:
   - docx: the Mission 1a AST and `edit_document`, keyed by the same block
     ids the common model uses;
   - Markdown and text: source lines;
   - PDF: read-only (to change one, write a new document).

   The common model never pretends a PDF is editable.

Prior art, for shape rather than as dependencies:
- **Pandoc AST**: a typed block/inline tree with attributes on blocks.
- **Unstructured.io elements**: Title, NarrativeText, ListItem, Table, with
  `page_number`, `parent_id` and hashed ids.
- **Docling's `DoclingDocument`**: one Pydantic model for PDF, Office, HTML
  and Markdown, with body content separated from headers and footers,
  bounding boxes and page provenance, and lossless JSON.

Mike's model takes the flat element list with provenance (Unstructured,
Docling). The tree comes from heading levels, computed rather than stored,
which keeps slicing by id trivial.

## Per format

| Format | Ids | Structure | Fidelity |
|---|---|---|---|
| docx | Mission 1a block ids (`p12`, `t3`) | Headings from outline levels and styles; clause labels from numbering; tables with cells; footnotes and endnotes as `note` blocks | Exact; the same ids `read_document` and `edit_document` use |
| Markdown, text | `m<line>` (first source line) | ATX and Setext headings, ordered and bulleted lists with depth, fenced code, block quotes, pipe tables, paragraphs | Exact for Markdown; for plain text, paragraphs only |
| PDF | `p<page>.<n>` | Lines from pdf.js in reading order (the same XY-cut ordering citation highlighting uses), joined into paragraphs by line spacing. Headings inferred from type size against the page's body text, marked `inferred`. Bookmarks (the PDF outline), when present, are taken as headings and not marked inferred. Scanned pages carry the existing OCR marker. | Good for digital PDFs; headings are a guess |
| Spreadsheet | `s<n>` per sheet | One table block per sheet, rows of display values (`cell.w`), with the sheet name as a heading | Exact values; formulas never shown |
| PowerPoint | `s<slide>.<n>` | Each slide's title as a level-1 heading, other text frames as paragraphs, speaker notes as `note` blocks | Good |

**Not yet:** HTML and web snapshots go with the reader view (citation
viewer work). Legacy .doc/.ppt are read through their PDF conversion, as
today. Evaluating Docling/Marker-class PDF layout models is a separate,
evidence-first step: published benchmarks disagree and none covers legal
PDFs, so the plan is to run candidates on the firm's real PDFs (tables,
clause numbering, redlines) and score them before adopting one.

## Where it runs and how it travels

- **Conversion runs on the backend**, not in the VM. The backend already
  parses docx and PDF, enforces who can read what, and keys per-version
  data. Documents are never copied into anyone's VM, which matters more
  now that a shared thread runs in its starter's VM.
- **Models are cached per document version** in memory: the last 64,
  keyed by version id.
- **The kernel asks the host** with a new host request,
  `{"type": "documents", "op": "list" | "load", "doc_id"}`. The host
  answers only for documents in the turn's document store, so the same
  access rules apply as for `read_document`. A load emits the same
  `doc_read` lines in the transcript as a read does.
- **The kernel caches loaded models** by version and lists documents
  afresh each cell, so a document edited mid-conversation is re-read at
  its new version.

## Search

- `grep`: regex or literal, case-insensitive by default, over block text.
  It returns hits with document, block id, label, page and context.
- `search`: BM25 over blocks in pure Python (no index service). Each block
  is weighted with its section's heading words, so a query about "limitation
  of liability" finds the paragraphs under that heading even when they never
  repeat it.
- Both run in the kernel over models already loaded. The first call loads
  every listed document.

## Citations

`d.quote(block_id, text)` checks the text appears verbatim (whitespace
collapsed) in that block. It returns the quote in the shape the citation
block uses: `{"page", "quote"}`, with the page from provenance, or the
block id for docx. On a mismatch it raises, naming the closest passage. This
turns "print the exact passages before citing" from advice into a check.

## Security and honesty

- Document text is untrusted. It reaches the model only through cell
  output, which already carries the injection check (`run_python` is an
  external-content tool).
- The transcript's "Read <file>" line appears when a model loads, never
  silently.
- Inline Word-add-in documents (request-scoped text) stay out of `docs`.
  They are read with `read_document`, as `find_in_document` already requires.

## Acceptance

- Unit tests for each converter: docx, Markdown, text, PDF, spreadsheet,
  presentation.
- A kernel test for the `docs` API end to end over the host channel.
- An engine test that a `documents` host request serves only the turn's
  documents and records a read.
- The owner reviews it on staging with the same five-document project.

## Receipt, 2026-10-10 (not yet reviewed)

Built as above. `.text` is a property everywhere (document, section, block
range), so no call style is wrong. The code-mode prompt gains a
"DOCUMENTS IN PYTHON" section and points away from splitting
`fetch_documents` output.

Commands run from `backend/`:

- `npx vitest run src/lib/documentModel src/lib/codemode src/modules/chat/engine/__tests__/streamingDocuments.test.ts`: converters (Markdown, text, docx corpus, a generated three-page PDF with bookmarks and running headers, OCR placeholders, xlsx, pptx), the kernel `docs` API, and the engine's documents host request; all pass.
- `npx tsc --noEmit -p .`: clean.
- `npm test`: 4513 passed, 3 failed, all timeouts while the machine's load average was 63–94 (other work's VM and Playwright). Rerun alone: `blockIds`, `edit.corpus` and `sentryTestRoute` pass; `migrationLedger` passes with `--testTimeout 180000` (20/20). The architecture test passes (9/9).
- `git diff --check`: clean.

Not yet done: the owner's staging review with the five-document project.
