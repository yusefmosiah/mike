"""``docs``: the conversation's documents as Python objects.

Every document, whatever its format (Word, PDF, spreadsheet, slides, Markdown),
arrives in one common reading model (goals/mission-14-document-model.md): a
flat list of blocks, each with a stable ``id``, a ``kind`` (heading, paragraph,
list_item, table, code, quote, note, figure), its ``text``, and where it came
from (``page``, ``source``). Nothing reaches the conversation until it is
printed, so explore the way you would explore a codebase::

    docs                                  # what is here
    d = docs["doc-3"]                     # or docs.find("market report")
    d.outline()                           # headings with ids, clause numbers and section sizes
    print(d.section("12"))                # a section by clause number, heading text or id
    print(d["p884":"p901"])               # a range of blocks, each line with its [id]
    docs.grep(r"DGX Spark.*\\$\\d")         # every document: where a pattern occurs
    docs.search("termination for convenience")   # passages ranked by relevance
    d.tables[0].df                        # a table as a pandas DataFrame
    d.quote("p886", "the firm's archive") # checked verbatim; a quote for the citation block

Documents load from the host the first time they are touched, and stay
loaded (by version) for the rest of the conversation. The ids are the ones
``read_document`` and ``edit_document`` take.
"""

from __future__ import annotations

import difflib
import math
import re
from collections import Counter
from typing import Any, Iterable, Iterator

from . import repl

_listing: list[dict[str, Any]] | None = None
_loaded: dict[tuple[str, str | None], "Document"] = {}

_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_STOP = frozenset(
    "a an and are as at be been but by for from has have in into is it its of on or that the their this to was "
    "were which will with shall may any all such".split()
)


def new_cell() -> None:
    """Called before each cell: the document list is read afresh, so an edit shows."""
    global _listing
    _listing = None


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _host(data: dict[str, Any]) -> Any:
    import json

    reply = repl.host_request_sync({"type": "documents", **data})
    if reply.get("ok") is False:
        raise LookupError(str(reply.get("error") or "the documents request failed"))
    content = reply.get("content")
    return json.loads(content) if isinstance(content, str) else content


def _tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP]


# --------------------------------------------------------------------------
# Blocks


class Block:
    """One block. ``str(block)`` is its line as you would read it, with its id."""

    __slots__ = ("doc", "index", "id", "kind", "level", "label", "text", "rows", "page", "source", "ocr", "inferred",
                 "language")

    def __init__(self, doc: "Document", index: int, data: dict[str, Any]) -> None:
        self.doc = doc
        self.index = index
        self.id: str = data["id"]
        self.kind: str = data["kind"]
        self.level: int | None = data.get("level")
        self.label: str | None = data.get("label")
        self.text: str = data.get("text") or ""
        self.rows: list[list[str]] | None = data.get("rows")
        self.page: int | None = data.get("page")
        self.source: str | None = data.get("source")
        self.ocr: bool = bool(data.get("ocr"))
        self.inferred: bool = bool(data.get("inferred"))
        self.language: str | None = data.get("language")

    def line(self) -> str:
        flags = []
        if self.ocr:
            flags.append("OCR")
        if self.inferred and self.kind == "heading":
            flags.append("inferred heading")
        tag = f"[{self.id}{' · ' + ', '.join(flags) if flags else ''}]"
        if self.kind == "heading":
            head = "#" * min(self.level or 1, 6)
            return f"{tag} {head} {self.label + ' ' if self.label and not self.text.startswith(self.label) else ''}{self.text}"
        if self.kind == "list_item":
            indent = "  " * max(0, (self.level or 1) - 1)
            mark = self.label or "•"
            if self.text.startswith(mark) or (not self.label and re.match(r"[•●▪◦‣∙·–—-]\s", self.text)):
                return f"{tag} {indent}{self.text}"
            return f"{tag} {indent}{mark} {self.text}"
        if self.kind == "table":
            return f"{tag} table, {len(self.rows or [])} rows\n" + _render_rows(self.rows or [])
        if self.kind == "code":
            return f"{tag} ```{self.language or ''}\n{self.text}\n```"
        if self.kind == "quote":
            return f"{tag} > {self.text}"
        if self.kind == "note":
            return f"{tag} note{' ' + self.label if self.label else ''}: {self.text}"
        label = f"{self.label} " if self.label and not self.text.startswith(self.label) else ""
        return f"{tag} {label}{self.text}"

    def __str__(self) -> str:
        return self.line()

    def __repr__(self) -> str:
        preview = _norm(self.text)[:60]
        return f"<{self.kind} {self.id}{' p.' + str(self.page) if self.page else ''}: {preview!r}>"

    @property
    def section(self) -> "Section | None":
        """The section this block sits in (its nearest heading)."""
        return self.doc._section_of(self.index)


def _render_rows(rows: list[list[str]], limit: int = 60) -> str:
    shown = rows[:limit]
    lines = [" | ".join(_norm(c) for c in row) for row in shown]
    if len(rows) > limit:
        lines.append(f"… {len(rows) - limit} more rows (use .rows or .df)")
    return "\n".join(lines)


class Blocks(list):
    """A run of blocks. Printing it shows each with its id, and page markers for paged documents."""

    def __str__(self) -> str:
        out: list[str] = []
        page = None
        for block in self:
            if block.page is not None and block.page != page and block.doc.paged:
                page = block.page
                out.append(f"[{'Slide' if block.doc.format == 'presentation' else 'Page'} {page}]")
            out.append(block.line())
        return "\n".join(out)

    def __repr__(self) -> str:
        if not self:
            return "<no blocks>"
        return f"<{len(self)} blocks {self[0].id}…{self[-1].id}, {sum(len(b.text) for b in self):,} chars>"

    @property
    def text(self) -> str:
        """The plain text, blocks separated by blank lines."""
        return "\n\n".join(b.text for b in self)


class Table:
    """A table block: ``rows`` of display text, ``df`` as a pandas DataFrame."""

    def __init__(self, block: Block) -> None:
        self.block = block
        self.id = block.id
        self.rows: list[list[str]] = block.rows or []

    @property
    def df(self) -> Any:
        """A DataFrame; the first row becomes the header when it looks like one."""
        import pandas as pd

        rows = self.rows
        if not rows:
            return pd.DataFrame()
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        head = rows[0]
        if len(rows) > 1 and all(h.strip() for h in head) and len(set(head)) == len(head):
            return pd.DataFrame(rows[1:], columns=head)
        return pd.DataFrame(rows)

    def cell(self, row: int, col: int) -> str:
        """1-based, as the table is shown."""
        return self.rows[row - 1][col - 1]

    def address(self, row: int, col: int) -> str | None:
        """The spreadsheet address (e.g. "B7") of a cell, when the table is a sheet."""
        origin = _sheet_origin(self.block.source)
        if origin is None:
            return None
        col0, row0 = origin
        return f"{_col_letters(col0 + col - 1)}{row0 + row - 1}"

    def __str__(self) -> str:
        return self.block.line()

    def __repr__(self) -> str:
        return f"<table {self.id}: {len(self.rows)} rows × {max((len(r) for r in self.rows), default=0)} columns>"


def _col_letters(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _sheet_origin(source: str | None) -> tuple[int, int] | None:
    match = re.search(r"!([A-Z]+)(\d+)", source or "")
    if not match:
        return None
    col = 0
    for ch in match.group(1):
        col = col * 26 + (ord(ch) - 64)
    return col - 1, int(match.group(2))


# --------------------------------------------------------------------------
# Sections and search hits


class Section:
    """A heading and everything under it until the next heading at its level or above."""

    def __init__(self, doc: "Document", start: int, end: int) -> None:
        self.doc = doc
        self.start = start
        self.end = end
        self.heading: Block = doc.blocks[start]

    @property
    def id(self) -> str:
        return self.heading.id

    @property
    def title(self) -> str:
        return self.heading.text

    @property
    def label(self) -> str | None:
        return self.heading.label

    @property
    def level(self) -> int:
        return self.heading.level or 1

    @property
    def blocks(self) -> Blocks:
        return Blocks(self.doc.blocks[self.start:self.end])

    @property
    def text(self) -> str:
        return self.blocks.text

    @property
    def chars(self) -> int:
        return sum(len(b.text) for b in self.blocks)

    @property
    def subsections(self) -> list["Section"]:
        return [s for s in self.doc.sections_all if s.start > self.start and s.end <= self.end
                and s.level == min((t.level for t in self.doc.sections_all
                                    if t.start > self.start and t.end <= self.end), default=0)]

    def __str__(self) -> str:
        return str(self.blocks)

    def __repr__(self) -> str:
        return f"<section {self.id} {self.label + ' ' if self.label else ''}{self.title!r}: {len(self.blocks)} blocks, {self.chars:,} chars>"


class Hit:
    """Where a search matched: the document, the block, and the context around it."""

    def __init__(self, block: Block, start: int, end: int, context: int, score: float | None = None) -> None:
        self.block = block
        self.doc = block.doc
        self.start = start
        self.end = end
        self.score = score
        text = block.text
        lo, hi = max(0, start - context), min(len(text), end + context)
        self.context = ("…" if lo else "") + _norm(text[lo:hi]) + ("…" if hi < len(text) else "")
        self.match = text[start:end]

    def __str__(self) -> str:
        where = [self.doc.id, f"[{self.block.id}]"]
        if self.block.page:
            where.append(f"p.{self.block.page}")
        section = self.block.section
        if section is not None and section.heading is not self.block:
            where.append(f"§ {(section.label + ' ') if section.label else ''}{_norm(section.title)[:50]}")
        score = f" ({self.score:.2f})" if self.score is not None else ""
        return f"{' '.join(where)}{score}: {self.context}"

    def __repr__(self) -> str:
        return f"<hit {self.doc.id} {self.block.id}: {self.context[:60]!r}>"


class Hits(list):
    """Search results. Printing shows one per line; ``by_document()`` counts them."""

    def __str__(self) -> str:
        if not self:
            return "no matches"
        return "\n".join(str(h) for h in self)

    def __repr__(self) -> str:
        return f"<{len(self)} hits in {len({h.doc.id for h in self})} documents>"

    def by_document(self) -> dict[str, int]:
        return dict(Counter(h.doc.id for h in self))

    @property
    def blocks(self) -> Blocks:
        seen: dict[tuple[str, str], Block] = {}
        for h in self:
            seen.setdefault((h.doc.id, h.block.id), h.block)
        return Blocks(seen.values())


def _find(blocks: Iterable[Block], pattern: str, regex: bool, case: bool, context: int, limit: int) -> Hits:
    flags = 0 if case else re.IGNORECASE
    if regex:
        compiled = re.compile(pattern, flags)
    else:
        # Literal, but whitespace-tolerant: "Section 4.2" finds "Section   4.2".
        compiled = re.compile(r"\s+".join(re.escape(part) for part in pattern.split()), flags)
    hits = Hits()
    for block in blocks:
        for match in compiled.finditer(block.text):
            if match.end() == match.start():
                continue
            hits.append(Hit(block, match.start(), match.end(), context))
            if len(hits) >= limit:
                return hits
    return hits


# --------------------------------------------------------------------------
# Documents


class Outline(list):
    def __str__(self) -> str:
        if not self:
            return "no headings (use .blocks, .find or .page)"
        out = []
        for section in self:
            indent = "  " * (section.level - 1)
            flag = " (inferred)" if section.heading.inferred else ""
            label = f"{section.label} " if section.label and not section.title.startswith(section.label) else ""
            page = f" p.{section.heading.page}" if section.heading.page else ""
            out.append(f"{indent}[{section.id}] {label}{_norm(section.title)[:100]}{page} — {section.chars:,} chars{flag}")
        return "\n".join(out)

    def __repr__(self) -> str:
        return str(self)


class Document:
    """One document as blocks. Index it by block id, or slice it by ids or positions."""

    def __init__(self, data: dict[str, Any]) -> None:
        self.id: str = data["doc_id"]
        self.filename: str = data.get("filename") or self.id
        self.version_id: str | None = data.get("version_id")
        self.format: str = data.get("format") or "text"
        self.pages: int | None = data.get("pages")
        self.warnings: list[str] = list(data.get("warnings") or [])
        self.blocks: Blocks = Blocks(Block(self, i, b) for i, b in enumerate(data.get("blocks") or []))
        self._by_id = {b.id: b for b in self.blocks}
        self._sections: list[Section] | None = None
        self._section_index: list[int] | None = None
        self._bm25: tuple[list[Counter[str]], list[int], Counter[str]] | None = None

    # -- shape ---------------------------------------------------------------

    @property
    def paged(self) -> bool:
        return self.format in ("pdf", "presentation")

    @property
    def chars(self) -> int:
        return sum(len(b.text) for b in self.blocks)

    def __len__(self) -> int:
        return len(self.blocks)

    def __iter__(self) -> Iterator[Block]:
        return iter(self.blocks)

    def __repr__(self) -> str:
        heads = len(self.headings)
        paged = f", {self.pages} {'slides' if self.format == 'presentation' else 'pages'}" if self.pages else ""
        return (f"<{self.id} {self.filename!r}: {self.format}{paged}, {len(self.blocks):,} blocks, "
                f"{self.chars:,} chars, {heads} headings>")

    def __str__(self) -> str:
        lines = [repr(self)]
        lines += [f"  note: {w}" for w in self.warnings]
        return "\n".join(lines)

    # -- addressing ----------------------------------------------------------

    def _index(self, key: str | int | None, default: int) -> int:
        if key is None:
            return default
        if isinstance(key, int):
            return key if key >= 0 else len(self.blocks) + key
        block = self._by_id.get(key)
        if block is None:
            raise KeyError(self._missing(key))
        return block.index

    def _missing(self, key: str) -> str:
        close = difflib.get_close_matches(key, list(self._by_id), n=3)
        return f"No block {key!r} in {self.id}." + (f" Did you mean {', '.join(close)}?" if close else "")

    def __getitem__(self, key: str | int | slice) -> Any:
        """``d["p12"]`` is one block; ``d["p12":"p20"]`` includes both ends; ``d[0:10]`` is by position."""
        if isinstance(key, slice):
            by_id = isinstance(key.start, str) or isinstance(key.stop, str)
            start = self._index(key.start, 0)
            stop = self._index(key.stop, len(self.blocks) - 1 if by_id else len(self.blocks))
            if by_id:
                stop += 1  # an id range names its last block
            return Blocks(self.blocks[start:stop:key.step])
        if isinstance(key, int):
            return self.blocks[key]
        block = self._by_id.get(key)
        if block is None:
            raise KeyError(self._missing(key))
        return block

    def get(self, block_id: str) -> Block | None:
        return self._by_id.get(block_id)

    def around(self, block_id: str, before: int = 2, after: int = 2) -> Blocks:
        """A block with its neighbours."""
        i = self._index(block_id, 0)
        return Blocks(self.blocks[max(0, i - before):i + after + 1])

    def page(self, number: int) -> Blocks:
        """The blocks on one page (PDF) or slide (presentation)."""
        return Blocks(b for b in self.blocks if b.page == number)

    @property
    def text(self) -> str:
        """Plain text of the whole document; for a range, ``d["p12":"p20"].text``."""
        return self.blocks.text

    # -- structure -----------------------------------------------------------

    @property
    def headings(self) -> Blocks:
        return Blocks(b for b in self.blocks if b.kind == "heading")

    @property
    def sections_all(self) -> list[Section]:
        if self._sections is None:
            heads = [b for b in self.blocks if b.kind == "heading"]
            sections = []
            for n, head in enumerate(heads):
                end = len(self.blocks)
                for later in heads[n + 1:]:
                    if (later.level or 1) <= (head.level or 1):
                        end = later.index
                        break
                sections.append(Section(self, head.index, end))
            # Each block's innermost section: later (deeper) starts overwrite.
            owner: list[int] = [-1] * len(self.blocks)
            for n, section in enumerate(sections):
                for i in range(section.start, section.end):
                    owner[i] = n
            self._sections = sections
            self._section_index = owner
        return self._sections

    @property
    def sections(self) -> list[Section]:
        """The top-level sections."""
        if not self.sections_all:
            return []
        top = min(s.level for s in self.sections_all)
        return [s for s in self.sections_all if s.level == top]

    def _section_of(self, index: int) -> Section | None:
        sections = self.sections_all
        owner = self._section_index or []
        n = owner[index] if 0 <= index < len(owner) else -1
        return sections[n] if n >= 0 else None

    def outline(self, depth: int = 3) -> Outline:
        """Headings to ``depth`` levels below the top, with ids, clause numbers and section sizes."""
        if not self.sections_all:
            return Outline()
        top = min(s.level for s in self.sections_all)
        return Outline(s for s in self.sections_all if s.level < top + depth)

    def section(self, query: str) -> Section:
        """A section by clause number ("12", "12.3"), heading id, or heading text."""
        q = _norm(query).lower().rstrip(".")
        sections = self.sections_all
        for s in sections:
            if s.id == query:
                return s
        for s in sections:
            label = (s.label or "").lower().rstrip(".")
            title = _norm(s.title).lower()
            if label and label == q:
                return s
            if re.match(rf"^(section|article|clause|part|schedule|§)?\s*{re.escape(q)}(\b|[.)\s])", title):
                return s
        for s in sections:
            if q and q in _norm(s.title).lower():
                return s
        titles = [_norm(s.title) for s in sections]
        close = difflib.get_close_matches(query, titles, n=3, cutoff=0.4)
        raise KeyError(f"No section {query!r} in {self.id}." + (f" Close: {'; '.join(close)}." if close else
                                                               " See .outline()."))

    @property
    def tables(self) -> list[Table]:
        return [Table(b) for b in self.blocks if b.kind == "table"]

    # -- search --------------------------------------------------------------

    def find(self, pattern: str, regex: bool = False, case: bool = False, context: int = 80,
             limit: int = 50) -> Hits:
        """Where ``pattern`` occurs. Literal and whitespace-tolerant unless ``regex=True``."""
        return _find(self.blocks, pattern, regex, case, context, limit)

    def grep(self, pattern: str, case: bool = False, context: int = 80, limit: int = 50) -> Hits:
        """``find`` with a regular expression."""
        return self.find(pattern, regex=True, case=case, context=context, limit=limit)

    def _index_bm25(self) -> tuple[list[Counter[str]], list[int], Counter[str]]:
        if self._bm25 is None:
            terms: list[Counter[str]] = []
            lengths: list[int] = []
            df: Counter[str] = Counter()
            for block in self.blocks:
                section = block.section
                words = _tokens(block.text)
                if section is not None and section.heading is not block:
                    # A paragraph is about its heading even when it never repeats it.
                    words += _tokens(section.title)
                counts = Counter(words)
                terms.append(counts)
                lengths.append(len(words))
                df.update(counts.keys())
            self._bm25 = (terms, lengths, df)
        return self._bm25

    def search(self, query: str, k: int = 10, context: int = 120) -> Hits:
        """Passages ranked by relevance to ``query`` (BM25 over blocks, weighted by section headings)."""
        return _search([self], query, k, context)

    # -- citation ------------------------------------------------------------

    def quote(self, block_id: str, text: str) -> dict[str, Any]:
        """Check ``text`` is verbatim in a block (or runs on into the next ones) and return it as a citation quote.

        Raises ValueError, naming the closest passage, when the words are not there.
        """
        i = self._index(block_id, 0)
        wanted = _norm(text)
        for span in (1, 2, 3):
            run = self.blocks[i:i + span]
            joined = _norm(" ".join(b.text for b in run))
            if wanted.lower() in joined.lower():
                start = joined.lower().index(wanted.lower())
                exact = joined[start:start + len(wanted)]
                block = run[0]
                if block.kind == "table" and self.format == "spreadsheet":
                    return self._cell_quote(block, exact)
                quote: dict[str, Any] = {"quote": exact}
                pages = sorted({b.page for b in run if b.page is not None})
                if pages and self.format == "pdf":
                    quote = {"page": pages[0] if len(pages) == 1 else f"{pages[0]}-{pages[-1]}", "quote": exact}
                return quote
        block = self.blocks[i]
        matcher = difflib.SequenceMatcher(None, block.text.lower(), wanted.lower())
        match = matcher.find_longest_match(0, len(block.text), 0, len(wanted))
        near = block.text[max(0, match.a - 40):match.a + match.size + 40]
        raise ValueError(f"Not verbatim in [{block.id}]. Closest: …{_norm(near)}…")

    def _cell_quote(self, block: Block, value: str) -> dict[str, Any]:
        table = Table(block)
        for r, row in enumerate(table.rows, start=1):
            for c, cell in enumerate(row, start=1):
                if value.lower() in _norm(cell).lower():
                    sheet = (block.source or "").split("!")[0]
                    return {"sheet": sheet, "cell": table.address(r, c), "quote": _norm(cell)}
        return {"quote": value}


def _search(documents: list[Document], query: str, k: int, context: int) -> Hits:
    words = _tokens(query)
    if not words:
        return Hits()
    phrase = _norm(query).lower()
    scored: list[tuple[float, Document, int]] = []
    total_blocks = sum(len(d.blocks) for d in documents) or 1
    df: Counter[str] = Counter()
    indexes = []
    for d in documents:
        terms, lengths, ddf = d._index_bm25()
        indexes.append((d, terms, lengths))
        df.update(ddf)
    avg = (sum(sum(lengths) for _, _, lengths in indexes) / total_blocks) or 1.0
    k1, b = 1.2, 0.75
    for d, terms, lengths in indexes:
        for i, counts in enumerate(terms):
            score = 0.0
            for w in words:
                tf = counts.get(w, 0)
                if not tf:
                    continue
                idf = math.log(1 + (total_blocks - df[w] + 0.5) / (df[w] + 0.5))
                score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * lengths[i] / avg))
            if score and len(words) > 1 and phrase in d.blocks[i].text.lower():
                score *= 1.5
            if score:
                scored.append((score, d, i))
    scored.sort(key=lambda item: -item[0])
    hits = Hits()
    for score, d, i in scored[:k]:
        block = d.blocks[i]
        low = block.text.lower()
        positions = [low.find(w) for w in words if low.find(w) >= 0]
        start = min(positions) if positions else 0
        hits.append(Hit(block, start, start, context, score))
    return hits


class Documents:
    """The documents this conversation can read: ``docs["doc-0"]``, ``docs.find("lease")``, ``docs.grep(...)``."""

    def _listing(self) -> list[dict[str, Any]]:
        global _listing
        if _listing is None:
            _listing = list(_host({"op": "list"}) or [])
        return _listing

    def ids(self) -> list[str]:
        return [entry["doc_id"] for entry in self._listing()]

    def _load(self, entry: dict[str, Any]) -> Document:
        key = (entry["doc_id"], entry.get("version_id"))
        document = _loaded.get(key)
        if document is None:
            document = Document(_host({"op": "load", "doc_id": entry["doc_id"]}))
            _loaded[key] = document
        return document

    def __getitem__(self, key: str | int) -> Document:
        listing = self._listing()
        if isinstance(key, int):
            return self._load(listing[key])
        for entry in listing:
            if entry["doc_id"] == key:
                return self._load(entry)
        return self.find(key)

    def __iter__(self) -> Iterator[Document]:
        for entry in self._listing():
            yield self._load(entry)

    def __len__(self) -> int:
        return len(self._listing())

    def __contains__(self, key: object) -> bool:
        return key in self.ids()

    def find(self, name: str) -> Document:
        """The document whose filename best matches ``name``."""
        listing = self._listing()
        lowered = name.lower()
        for entry in listing:
            if lowered in (entry.get("filename") or "").lower():
                return self._load(entry)
        names = {entry.get("filename") or entry["doc_id"]: entry for entry in listing}
        close = difflib.get_close_matches(name, list(names), n=1, cutoff=0.3)
        if close:
            return self._load(names[close[0]])
        raise KeyError(f"No document matching {name!r}. Here: {', '.join(names)}")

    def load(self) -> list[Document]:
        """Load every document now."""
        return list(self)

    def grep(self, pattern: str, case: bool = False, context: int = 80, limit: int = 200,
             only: Iterable[str] | None = None) -> Hits:
        """Where a regular expression occurs, across every document (or ``only`` these ids)."""
        return self.find_text(pattern, regex=True, case=case, context=context, limit=limit, only=only)

    def find_text(self, pattern: str, regex: bool = False, case: bool = False, context: int = 80, limit: int = 200,
                  only: Iterable[str] | None = None) -> Hits:
        """Where text occurs across documents. Literal and whitespace-tolerant unless ``regex=True``."""
        chosen = set(only) if only is not None else None
        hits = Hits()
        for document in self:
            if chosen is not None and document.id not in chosen:
                continue
            hits.extend(document.find(pattern, regex=regex, case=case, context=context, limit=limit - len(hits)))
            if len(hits) >= limit:
                break
        return hits

    def search(self, query: str, k: int = 10, context: int = 120, only: Iterable[str] | None = None) -> Hits:
        """Passages ranked by relevance to ``query`` across documents (BM25, weighted by section headings)."""
        chosen = set(only) if only is not None else None
        return _search([d for d in self if chosen is None or d.id in chosen], query, k, context)

    def __repr__(self) -> str:
        listing = self._listing()
        if not listing:
            return "<no documents in this conversation>"
        lines = [f"{len(listing)} documents:"]
        for entry in listing:
            key = (entry["doc_id"], entry.get("version_id"))
            loaded = _loaded.get(key)
            size = f" — {loaded.format}, {len(loaded.blocks):,} blocks, {loaded.chars:,} chars" if loaded else ""
            lines.append(f"  {entry['doc_id']}  {entry.get('filename')}{size}")
        return "\n".join(lines)

    __str__ = __repr__


def install(ns: dict[str, Any]) -> None:
    ns["docs"] = Documents()
