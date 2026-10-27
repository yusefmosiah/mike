# Media in assistant responses: research and design

Date: 2026-10-26. Status: research; nothing here is built.

**Not building now.** This is the design for a later change. No UI, wire
format, prompt or storage change in this document is implemented.

Path note: `AssistantMessage.tsx`, `ChatView.tsx`, `UserMessage.tsx` and
`ChatThread.tsx` are under `frontend/src/app/components/assistant/`;
`MarkdownContent.tsx` and `EventBlocks.tsx` under
`frontend/src/app/components/assistant/message/`; `ImageView.tsx` and
`MediaView.tsx` under `frontend/src/app/components/shared/views/`;
`streaming.ts`, `toolDispatcher.ts` and `contextBuilders.ts` under
`backend/src/modules/chat/engine/` (and `tools/` for the dispatcher). Other
files are named by file and line; grep the filename if its directory is not
shown.

## Summary

- **Media is a document.** Every image, audio or video item in an answer
  should refer to an existing document row (`document_id`, `version_id`,
  `filename`, `kind`), never to raw bytes, a data URL, a signed download URL,
  or a new "chat media" entity. That keeps one ACL, one version history, one
  `/file` route and one viewer for both the answer and the document panel.
- **One new event, one new tool.** Phase 1 adds a `media` entry to
  `AssistantEvent` and a `show_media` tool that emits it. The model already
  gets stable `doc-…` labels each turn (`contextBuilders.ts:517-545`); the
  server resolves the label, checks the type and access, and records the
  event.
- **Know the tool boundary.** The engine is code-mode only: a tool call runs
  inside `run_python`, so a media block lands at a tool-call boundary (and
  before the cell's step line), not mid-paragraph, and a no-workstation chat
  has no tools. The inline `<media doc="…"/>` directive is the alternative
  if either matters; see section 3.
- **Render outside the step card.** A new `MediaBlock` should be a top-level
  group in `AssistantMessage`, next to prose, not inside `PreResponseWrapper`
  where it is collapsed as soon as another prose block arrives
  (`frontend/src/shared/ui/PreResponseWrapperUI.tsx:34-48`).
- **Images dominate the UI.** One image: full-width figure with a capped
  height. Several consecutive images: a simple two-column grid. Video and
  audio: native players, never a clickable wrapper around the controls.
  Clicking "Open in viewer" (or an image) opens the existing document tab for
  the same document and version.
- **The panel gets the same list.** Add `media` events to
  `chatPanelDocuments` (`frontend/src/app/lib/chatPanelDocuments.ts:17-54`)
  so opening the document panel gathers media shown in earlier responses,
  as it already gathers created and edited documents. The "Open Documents"
  picker already lists project files on its own.
- **Defer the carousel and lightbox.** The viewer is already the full-size
  surface, focus-managed (`ChatView.tsx:501-520`), and no carousel or
  lightbox primitive exists. A second way to page through images buys little
  for a lot of focus, swipe and reduced-motion work.

## 1. Where media can mount

### What the assistant message renders today

`AssistantMessage` receives the message's `AssistantEvent[]` and walks it in
order (`frontend/src/app/components/assistant/AssistantMessage.tsx:397-436`).
It groups consecutive **non-content** events into a `PreResponseWrapper`
("Completed in N steps") and renders each **content** event as Markdown:

- content event → `<MarkdownContent text={processedTexts[g.index]} … />`
  (`AssistantMessage.tsx:996-1015`);
- every other event → `renderEvent`, which returns a typed block for
  reasoning, tool calls, `doc_read`, `doc_find`, `doc_created`,
  `doc_edited`, `doc_replicated`, web sources, subagents, code cells and so
  on (`AssistantMessage.tsx:479-985`).

`MarkdownContent` is `react-markdown` with `remark-gfm`, `remark-math` and
`rehype-katex` (`frontend/src/app/components/assistant/message/MarkdownContent.tsx:68-76`). It overrides `pre`,
tables, headings, code, links, blockquotes and `hr`
(`frontend/src/app/components/assistant/message/MarkdownContent.tsx:77-321`), but there is **no `img`, `video` or `audio`
override**. Therefore:

- A model-authored `![alt](https://…)` is rendered as a plain `<img>` by
  `react-markdown` and will load the remote URL. There is no allowlist and no
  document identity. `urlTransform` is only widened for internal `us-case-…`
  links (`frontend/src/app/components/assistant/message/MarkdownContent.tsx:70-73`).
- `<video>` / `<audio>` in model text are not rendered: no `rehype-raw` is
  configured.
- Media is currently visible only after a click into the document panel, or
  not at all.

### Existing media surfaces

| Surface | What renders today | Evidence |
| --- | --- | --- |
| Created document | A small "Created `<file>`" step card inside the (collapsible) step list, plus a download card below the answer. Neither previews an image, video or audio. | `AssistantMessage.tsx:607-630`, `1267-1322`; `EventBlocks.tsx:201-240`, `335-400` |
| User attachment | A filename chip in the user message. Clicking opens the document panel. No thumbnail. | `UserMessage.tsx:275-310`; `ChatThread.tsx:827-839` |
| Document viewer | The only actual media display. `DocumentContent` chooses `ImageView` for images and `MediaView` for audio/video. | `frontend/src/app/components/shared/DocumentContent.tsx:167-171`, `353-394` |
| Image viewer | Fetches the file with `authenticatedFetch`, makes a blob URL, shows `<img className="max-h-full max-w-full object-contain">`. | `shared/views/ImageView.tsx:20-66` |
| Audio/video viewer | Native `<video controls playsInline preload="metadata">` / `<audio controls preload="metadata">`, reading `/file` with byte ranges. | `shared/views/MediaView.tsx:21-69`; `backend/src/modules/documents/documents.routes.ts:118-160` |

Other facts that constrain the surface:

- The chat column is `max-w-4xl` (`ChatThread.tsx:234`), so "full width" is
  roughly 830 px on desktop before the panel opens.
- The document panel is a tab strip; a tab is one document, keyed by
  `document_id` (`AssistantSidePanel.tsx:58-60`, `93-107`). There is no
  gallery or contact-sheet view.
- `chatPanelDocuments` collects only `doc_created`, `doc_edited` and
  `doc_replicated` across the thread, oldest first, latest version per
  document (`frontend/src/app/lib/chatPanelDocuments.ts:17-54`).
  `openPanel` opens every missing one as a tab (`ChatView.tsx:422-471`).
  Attachments are not in this list unless the assistant also created or
  edited them.
- The document model has no addressable figures inside a PDF, DOCX or PPTX.
  `SourceSubdocument` has only `type: "html"` (`packages/contracts/index.d.ts:45-51`),
  and `read_document` shows embedded images as `{image}` tokens
  (`backend/src/modules/chat/engine/prompts.ts:94`). "Show page 3 of this
  PDF as an image" is therefore not a media document today.
- A computer-use screenshot is a model-facing image part, not a stored
  document (`backend/src/modules/chat/engine/tools/toolSchemas.ts:1142`).
  It cannot be shown through this path until it is saved with
  `save_to_mike`; keep that out of phase 1.

### Where a media node slots in

The clean insertion point is the group switch at
`AssistantMessage.tsx:996`, not `renderEvent`:

1. Extend `EventGroup` (`AssistantMessage.tsx:401-407`) with
   `{ kind: "media"; events: MediaEvent[]; indices: number[] }`.
2. While walking events (`AssistantMessage.tsx:408-436`), a `media` event
   ends the current `pre` group and joins the previous `media` group when
   the previous group is also media; a `content` event ends a media group.
3. Render that group with a new `MediaBlock` in the same map as content
   (`AssistantMessage.tsx:996-1015`), passing `onOpenDocument` (already a
   prop, `AssistantMessage.tsx:88-93`).

Why not `renderEvent`? `renderEvent` output lives inside
`PreResponseWrapper`, whose body is hidden once a later content event makes
the wrapper minimize (`frontend/src/shared/ui/PreResponseWrapperUI.tsx:34-48`). A chart that
disappears behind "Completed in 3 steps" is not "in the response body".
The same reason is why media should not be modelled as another
`doc_created` step.

One dedupe rule is needed: `save_to_mike` already emits a `doc_created`
event for every saved file (`toolDispatcher.ts:382-440`), so a `media` event
for the same document would otherwise produce a "Created" step, a download
card, and an inline preview for one image. When a `media` event and a
`doc_created` event in the same message name the same `document_id`, render
the media block once and keep the open/download actions on it; do not draw
the created card again.

## 2. UI forms

### Images

| Form | Fit | Cost | Verdict |
| --- | --- | --- | --- |
| Single full-width figure, capped height, caption below | Charts, screenshots, one photo; scannable in a 4xl column | One component and CSS | **Recommended** |
| Two-column grid for consecutive images, one column on phones | Several images from one request ("compare these") | Small grouping logic; no new primitive | **Recommended** for adjacent image events |
| Carousel with arrow-key and swipe cycling | Many images in one block | New primitive, roving focus, swipe scope, announcements, conflict with the panel's own swipe | Defer |
| Click-to-lightbox with zoom | Examining one image without opening the panel | New dialog/zoom UI; duplicates the viewer | Defer; open the existing viewer instead |

Details that fit the existing code:

- Use `getDocumentFileUrl(documentId, versionId)`
  (`frontend/src/app/lib/mikeApi.ts:2333-2338`) for the URL, not the
  event's `download_url` (a signed download token). The route is
  authenticated by the session cookie and supports `?version_id=`
  (`backend/src/modules/documents/documents.routes.ts:118-160`).
- Prefer the `authenticatedFetch` → blob path that `ImageView` already uses
  (`ImageView.tsx:28-34`): it sends `credentials: "include"`, dispatches the
  session-invalidated event on 401, aborts on unmount and revokes the blob
  URL. Extract that fetch into a small hook shared by `ImageView` and the
  inline image so the two do not drift.
- For a grid, use `object-contain` on a neutral surface, not `object-cover`.
  Media here are charts, screenshots and documents; cropping the axes off a
  chart is worse than uneven tile heights.
- Do not implement thumbnails by fetching and shrinking the full image in
  the browser. There is no thumbnail rendition today: uploads are cleaned
  and capped (`backend/src/lib/images.ts:79-120`) but no derivative is
  stored, and `ImageView` fetches the full `/file`. Use `loading="lazy"` and
  a capped CSS height for phase 1; a server-side thumbnail is a later
  optimisation.
- Animated GIFs are not animated: cleaning keeps the first frame
  (`backend/src/lib/images.ts:7`, `102`). Say "image", not "animation", in
  captions or accept the static first frame.

### Video

- **Inline native player is the boring fit.** `MediaView` already uses
  `<video controls playsInline preload="metadata">` (`MediaView.tsx:44-55`);
  reuse those attributes. `playsInline` matters on iOS; `preload="metadata"`
  avoids downloading the whole file.
- **Poster + lightbox** needs a poster frame. No thumbnail/poster generator
  exists; `MediaView` sets no `poster`, and the only `video poster`
  reference in the backend is publication bundling of an author-written
  attribute (`backend/src/modules/publications/publications.bundle.ts:204`). Defer until there is a real
  poster pipeline.
- Never autoplay. A video that starts itself violates the design system's
  calm-surface intent and creates an audio-control accessibility problem.
- Put the filename/caption and a separate "Open in viewer" action above or
  below the player. **Do not wrap a `<video>` in a button**: its controls
  are interactive descendants and the nesting is invalid.

### Audio

- Native `<audio controls preload="metadata">` with the filename above it,
  matching `MediaView.tsx:57-64`.
- No custom waveform in phase 1. The existing `ReadAloudPlayer` is a
  text-to-speech transport, not a file player (`ReadAloudPlayer.tsx:1-80`);
  reusing it would imply wrong behavior.
- No autoplay; start only on the person's play action.
- A separate "Open in viewer" action, same as video.

### Accessibility

`docs/design-system.md` has **no media-specific section**. The applicable
rules are the baseline (`docs/design-system.md:296-325`) and the fit-content
rules (`docs/design-system.md:160-184`), plus the primitive-selection rule that
forbids adding a UI dependency for something an existing primitive covers
(`docs/design-system.md:274-294`). Apply them as follows.

- **Focus management.** Clicking an image or "Open in viewer" follows the
  existing panel path; the panel already moves focus into itself and returns
  it to the opener on close (`ChatView.tsx:501-520`). No extra focus code is
  needed for the inline control. If a lightbox is ever added, use
  `ModalUI`, which owns the focus trap, Escape, initial focus and focus
  restore (`frontend/src/shared/ui/ModalUI.tsx:66-124`, `144-145`).
- **Keyboard.** Make the image tile a real `<button type="button">`; Enter
  and Space then work without a key handler. Keep a separate action for
  video/audio so native controls keep their own keyboard behavior. If a
  carousel is added later, copy the roving-tabindex arrow pattern from
  `frontend/src/app/components/shared/DocumentTabBar.tsx:206-259`, not a new one.
- **Swipe.** Only a carousel/lightbox needs it. The existing helper
  `watchHorizontalSwipe` (`frontend/src/app/lib/horizontalSwipe.ts:1-90`)
  is touch-only, respects vertical scrolling and names surfaces with
  `data-swipe-scope`. A lightbox inside the chat must use its own scope so
  it does not fight the document panel's swipe (`ChatView.tsx:479-490`).
- **Reduced motion.** Phase 1 introduces no animation or autoplay. If a
  hover scale or lightbox transition is added, guard it with
  `prefers-reduced-motion`; the only current rules are for specific
  animations (`frontend/src/app/globals.css:662-675`), and `AppSidebar`
  checks the media query directly (`frontend/src/app/components/shared/AppSidebar.tsx:127`).
- **Names and descriptions.** Give the image button an accessible name such
  as "Open chart.png in the document viewer". If a visible `<figcaption>`
  describes the image, set the image's `alt=""` and let the caption carry
  the description; otherwise give the image a short `alt`. Do not repeat the
  same sentence as both alt and caption. Decorative icons stay
  `aria-hidden`.
- **Failure.** Match the existing viewers' `role="alert"` copy ("The image
  could not be loaded.", `ImageView.tsx:58-61`; "The video could not be
  played.", `MediaView.tsx:38-43`). A shared-chat reader without document
  access must see a neutral placeholder, not a broken image icon.
- **Captions and transcripts.** Native players do not provide captions.
  Prerecorded video has no caption track today, and audio/video documents
  have no extracted text (`backend/src/modules/chat/engine/tools/documentOps.ts:62-64`). Do not invent a
  transcript from the model; treat captions as an open question.

## 3. Message wire format

### Today's mechanism

**Yes, the engine can emit non-text blocks, but only server code decides
which ones.** An assistant message is an `AssistantEvent[]`, not a string;
text is one variant and every document/web/code/subagent block is another.
A tool result is a model-facing JSON string; the tool's UI block is a
separate typed event the server writes and records.

- The wire contract for an assistant message is `AssistantEvent[]`
  (`packages/contracts/index.d.ts:481-616`). Text is one variant,
  `{ type: "content"; text: string }` (`:585`); every non-text block is
  another variant (`doc_read`, `doc_created`, `doc_edited`, `web_search`,
  `code_cell`, `subagent`, …).
- The model itself cannot emit arbitrary event types. It streams
  `content`/`reasoning` text and tool calls; the server decides which events
  or citations a tool call or a directive produces. This is a deliberate
  boundary, not an accident. The precedent for model-authored inline syntax
  that the server turns into a richer control is the `<cite>` tag
  (`docs/inline-citations.md:26-50`;
  `backend/src/modules/chat/engine/citations.inline.ts:1-120`).
- A tool's UI event is a side effect of the tool branch. `toolDispatcher`
  writes an SSE frame with `write(...)` and returns a typed list
  (`tools/toolDispatcher.ts:337-355`, `382-440`, `2547-2560`); `streaming.ts`
  copies those lists into `events` with `record(...)`
  (`streaming.ts:1386-1392`, `1640-1700`). The tool result the model sees is
  separate JSON; for `doc_created`, `registerGeneratedDocument` strips the
  signed `download_url` before returning it to the model
  (`toolDispatcher.ts:437-449`).
- `flushText` stores accumulated visible text as a `content` event and the
  live stream sends `content_delta` frames (`streaming.ts:890`, `938-941`).
  Events and text therefore interleave in the persisted array.
- Persistence is the assistant row's `content` JSONB array: the client maps
  `Array.isArray(m.content)` to `events` (`frontend/src/app/lib/mikeApi.ts:2419-2447`), and
  `chat.turn.ts` persists `stripTransientAssistantEvents(events)`
  (`backend/src/modules/chat/chat.turn.ts:399-401`). `stripTransientAssistantEvents` only drops
  `case_opinions` (`contextBuilders.ts:788-790`), so a new event type needs
  no migration.
- Every event type must be classified in
  `COMPLETES_TEXTLESS_TURN`, a `satisfies Record<AssistantEvent["type"], boolean>`
  map (`contextBuilders.ts:792-828`). Adding a type without classifying it
  fails the type check, deliberately.
- The live client is not generic. `assistantTurnStream.ts` has an explicit
  `if (data.type === …)` chain; an unknown frame falls through and is never
  pushed (`frontend/src/app/lib/assistantTurnStream.ts:552-1600`). A new event must get a handler
  or it will appear only after a reload from persisted JSON.
- `CALL_ID_EXEMPT` and `withFrameCallId` attach the tool call id to events
  (`frontend/src/app/lib/assistantTurnStream.ts:169-179`, `530-536`); `SURFACED_CHILD_EVENTS` /
  `SURFACED_CHILD_FRAMES` decide whether a subagent's events reach the parent
  (`streaming.ts:162-176`).

### Proposed `media` event

One event per media item. Consecutive image events are grouped by the
renderer, not by the wire.

```ts
export type MediaEvent = {
  type: "media";
  /** The tool call that produced it, like doc_created. */
  call_id?: string;
  document_id: string;
  version_id: string | null;
  version_number: number | null;
  filename: string;
  kind: "image" | "audio" | "video";
  /** Visible caption; a short description of the media. */
  caption?: string;
};
```

Why these fields:

- `document_id` + version: the same identity the viewer uses. The client
  constructs `/api/single-documents/:id/file?version_id=…`; no URL or token
  is stored in the transcript.
- `kind`: derived on the server from the document's file type
  (`backend/src/lib/documentTypes.ts:1-68`), not guessed on the client from
  a filename. The viewer still resolves audio vs video from the filename
  (`frontend/src/app/lib/documentViewType.ts:72-114`), but the inline
  renderer can pick a player without a second parse.
- `filename`: shown and used for the accessible name; the server takes it
  from the document index, not from model-supplied text.
- No `doc-…` label: labels are internal (`prompts.ts:103-104`) and the
  persisted event has no use for one.
- No `download_url`: it is a signed token, and downloads belong to the
  viewer.

### Emitting it (recommended: a `show_media` tool)

Add one function schema to `TOOLS` (`tools/toolSchemas.ts:503`):

```json
{
  "name": "show_media",
  "parameters": {
    "type": "object",
    "properties": {
      "doc_id": { "type": "string", "description": "Chat-local document id from the available documents list." },
      "caption": { "type": "string", "description": "Short visible caption. For an image, describe what it shows." }
    },
    "required": ["doc_id"]
  }
}
```

Dispatcher branch behavior:

1. `resolveDocLabel(doc_id, docStore, docIndex)` (`backend/src/modules/chat/engine/types.ts:108-123`);
   refuse an unknown label.
2. Read `docStore.get(label)` and `docIndex[label]`; require a document id,
   filename and file type.
3. Accept only `isImageFileType`, `isAudioFileType` or `isVideoFileType`
   (`backend/src/lib/documentTypes.ts:39-67`). For anything else, return a tool error
   telling the model to use the document card instead.
4. Trim and clamp `caption`; prefer a model-written caption for an image
   and fall back to the filename. Take `document_id`, `version_id`,
   `version_number`, `filename` from the index. `registerGeneratedDocument`
   already updates the index when `save_to_mike` creates a file, so showing
   a file saved earlier in the same turn works (`toolDispatcher.ts:382-440`).
5. Write the `media` frame and push a `media` event into a list returned by
   `runToolCalls`; `streaming.ts` records that list into `events`.
6. The model-facing tool result is only `{ "shown": "<filename>" }` or
   `{ "error": "…" }`. No URL, no path, no document UUID.

Why a tool rather than a Markdown URL:

- The document store is the access check. A URL in prose can bypass the
  model's document vocabulary and can point at a remote tracker.
- Audio and video have no Markdown syntax; a tool covers all three kinds.
- The event is the persistence and panel-aggregation hook. A URL in text
  would require scraping prose to recover document identity.
- A tool is the established mechanism for non-text blocks (`doc_created`,
  `doc_read`, `doc_edited`), so there is one place to validate.

Known limitation: the engine is code-mode only; the model sees `run_python`
alone and a conversation without a workstation has no tools at all
(`streaming.ts:640-644`, `684-687`). `show_media` therefore will not exist
in a no-workstation chat. A media event raised from inside a cell is also
recorded while the cell runs, before the cell's own `code_cell` event is
written when the cell ends (`streaming.ts:1369-1377`), so a chart can appear
above the step line that produced it; the model can place media between
prose rounds, but not inside a single cell's prose. See "Alternatives" and
the open questions.

### Alternatives considered

| Option | Why not (as the primary) |
| --- | --- |
| **Markdown image with `/api/single-documents/:id/file`** | No audio/video; couples persisted text to an HTTP path and API base; no document identity for the panel; a model could paste a remote URL; no server-side validation of the document. Would also need the model to know UUIDs. |
| **Message-level `media: []` field, like user `files`** | Easy, but loses ordering relative to prose; the requirement is media inside the body, not a gallery at the end. The event array already exists. |
| **Enrich `doc_created` only** | Works for files just saved by `save_to_mike`, and gives an immediate partial win, but cannot show an existing image, an attachment, or a file created in an earlier turn; "Created" is also the wrong label for "show". |
| **Inline `<media doc="…"/>` directive, parsed server-side** | Better placement inside a paragraph and works without a workstation, but adds a second streaming parser: hold back `<media` prefixes, parse on close, flush content at each tag, drop malformed tags. The `<cite>` pipeline is the precedent (`backend/src/modules/chat/engine/citations.inline.ts`), not a small change. This is the right phase-2 option if either limitation above matters. |

A **first slice** that does not touch the wire format is possible: render
`doc_created` events with a `document_id` whose filename is an
image/audio/video as a preview in the existing download-card area
(`AssistantMessage.tsx:1267-1322`). It reuses the same `MediaBlock` and
gives `save_to_mike` output a preview, but it is not the full feature and
should not be mistaken for it.

### Touch points for the recommended event

| Layer | Change |
| --- | --- |
| `packages/contracts/index.d.ts` | Add `MediaEvent` to `AssistantEvent` (union at `:481`). |
| `backend/.../tools/toolSchemas.ts` | Add `show_media` to `TOOLS` (`:503`); code mode picks it up through `pythonToolSpecs` (`backend/src/lib/codemode/python.ts:79-88`). |
| `backend/.../tools/toolDispatcher.ts` | Validation and emission beside `registerGeneratedDocument` (`:382-440`); include the list in the return (`:2547-2560`). |
| `backend/.../streaming.ts` | Destructure and `record` the list beside the other doc event loops (`:1640-1700`); decide child surfacing (`SURFACED_CHILD_EVENTS`, `:162-176`). |
| `backend/.../contextBuilders.ts` | Add `media: true` to `COMPLETES_TEXTLESS_TURN` (`:795-828`); a media-only answer is meaningful. |
| `frontend/.../shared/types.ts` | Add the type to the explicit `AssistantEvent` union (`:253-398`); do not rely on the wire merge. |
| `frontend/.../lib/assistantTurnStream.ts` | Add a `data.type === "media"` handler; unknown frames are dropped (`:552-1600`). |
| `frontend/.../assistant/AssistantMessage.tsx` | Media group in `EventGroup` (`:401-407`), grouping (`:408-436`), render (`:996-1015`). |
| `frontend/.../assistant/message/MediaBlock.tsx` | New component; image figure/grid, native players, `onOpenDocument`. |
| `frontend/.../lib/chatPanelDocuments.ts` | Add `media` events to the thread's document list (`:17-54`). |
| `backend/.../engine/prompts.ts` | Response-formatting and tool-use rules; see below. |
| `frontend/.../message/MarkdownContent.tsx` | Companion hardening: stop remote Markdown images from loading; see below. |

Prompt additions:

- "To show an image, audio or video document in your answer, call
  `show_media` with its document id at the point where it belongs. Write the
  prose around it; do not paste a URL, a data URL, a Markdown image or an
  HTML media tag."
- "A media block is a reference to a document the person can open; it is not
  proof you have seen or heard it. Describe only media you have seen
  (images attached to this message) or made. Never invent a caption for a
  project image you have not read."
- "Use `show_media` for media the person wants to see, not for every
  document you save. To show a chart or image you made in code, save it with
  `save_to_mike` first; `show_media` shows documents, not workstation files."

Markdown hardening: since `react-markdown` currently renders any `https:`
image in model text, add an `img` override that renders non-document images
as a link (or plain text) instead of loading them. The supported path for
media becomes the event. This also prevents tracking pixels and other
third-party requests from the prose surface. If same-origin
`/api/single-documents/...` images are allowed in Markdown, parse the id and
route clicks to `onOpenDocument`; even then, do not let them mutate the
panel list—events do that.

## 4. Correspondence with the document viewer

The viewer and the inline block should be two views of **one row**, not two
representations of the same bytes. This is also the owner's stated
preference: all media stays reachable in the document viewer, and the
inline block is a shortcut to that same row rather than a second gallery.

- **Same identity.** The viewer's tab id is the document id
  (`AssistantSidePanel.tsx:58-60`); the media event carries the same id. The
  panel's `PanelDocument.type` already has `"image"` and `"media"`
  (`packages/contracts/index.d.ts:3-14`; `frontend/src/app/components/shared/types.ts:157-162`), and
  `DocumentContent` already routes those to `ImageView` / `MediaView`
  (`frontend/src/app/components/shared/DocumentContent.tsx:167-171`, `353-394`), and the projects panel
  mounts the same component (`frontend/src/app/components/projects/ProjectDocumentPanels.tsx:170`). No new viewer
  code.
- **Same bytes.** Both should use
  `getDocumentFileUrl(documentId, versionId)` (`frontend/src/app/lib/mikeApi.ts:2333-2338`) and
  the authenticated `/single-documents/:id/file` route
  (`backend/src/modules/documents/documents.routes.ts:118-160`). Do not use the signed `download_url`.
- **Same open path.** A media block calls the existing `onOpenDocument`
  prop (`AssistantMessage.tsx:88-93`) → `ChatView.openDocument`
  (`ChatView.tsx:857-884`) → version resolution
  (`frontend/src/app/components/assistant/panelDocumentVersion.ts:44-80`) → `upsertTab` with
  `kind: "document"`. User attachment chips take the same route through
  `handleAttachedDocumentClick` (`ChatView.tsx:886-900`), and created
  document cards, download cards and `doc_read` blocks all use
  `onOpenDocument` (`ChatThread.tsx:827-839`). Nothing media-specific is
  needed.
- **Version semantics.** Pin `version_id` in the event, as citations and
  `doc_created` do. The inline image then keeps showing the version that
  was in the answer; the panel tab opens that same version because
  `resolvePanelDocumentVersionResult` prefers the supplied version
  (`frontend/src/app/components/assistant/panelDocumentVersion.ts:49-78`). `openPanel`'s aggregation, by contrast,
  passes the version recorded by the latest event in the thread
  (`chatPanelDocuments.ts` stores the latest seen; `ChatView.tsx:422-471`),
  which can be newer than the version this answer pinned. That is the same
  fidelity rule citations use; if the product wants "always latest", omit
  `version_id` in the event and accept that old answers change when media is
  replaced.
- **One tab per document.** Tab ids are document ids; a version change
  replaces the tab's document object (`AssistantSidePanel.tsx:62-84`). An
  inline media block therefore cannot open a second tab for the same
  document at a different version; the panel switches that tab to the
  requested version. This is desirable and should be stated in tests.
- **Aggregation.** Add `media` events to `chatPanelDocuments`
  (`chatPanelDocuments.ts:17-54`). Then opening the document panel collects
  media shown in earlier responses, exactly like created and edited
  documents today; the existing "Open Documents" picker already lists
  project files, including media. If the person also wants uploaded media in
  that auto-opened list, add image/audio/video `MessageFile`s from
  `message.files`; the files already carry `document_id` and version
  (`frontend/src/app/components/shared/types.ts:467-473`) and the user-message chip already opens them
  (`ChatThread.tsx:827-839`).
- **Access.** The `/file` route and the panel resolution both check
  document access. A chat can be shared without its documents
  (`ChatView.tsx:582-625`), so an inline block may fail to load for a
  recipient. Show a neutral "Media not available" placeholder and let the
  existing `reportUnresolvedDocument` explanation run on click; do not
  render a broken-image icon. Metadata (filename/caption) is part of the
  shared message just as citation quotes are; bytes remain protected.
- **Not a new entity.** A chat media item should not copy bytes into a chat
  table, and should not be a separate "attachment view" type. For a user
  attachment it names the attachment's existing document; for generated
  media it names the generated document. This keeps download, publish,
  versioning, project membership and deletion working through the existing
  document facade.

## 5. Recommendation and build order

1. **Contracts + backend event.** Add `MediaEvent` to `AssistantEvent`;
   add the `media` classification; add the `show_media` tool, validation and
   event recording; add the prompt rules.
2. **Frontend render.** Add the union member and SSE handler; split the
   event grouping at media; add `MediaBlock` with:
   - one image: full-width `<figure>`, `max-height` around 28rem,
     `object-contain`, caption, click/“Open in viewer” → `onOpenDocument`;
   - adjacent images: two-column grid on wide screens, one column on
     phones, same tile behavior;
   - video: native player with `controls playsInline preload="metadata"`,
     filename/caption and a separate open action;
   - audio: filename + native player + separate open action;
   - failed load: `role="alert"` placeholder, no broken image.
3. **Panel aggregation.** Add `media` events to `chatPanelDocuments`; decide
   whether media attachments join them. Keep the latest version per
   document and the existing dedupe/order semantics.
4. **Hardening.** Add the Markdown `img` override that refuses remote
   images; test that a model-authored `![x](https://…)` cannot load a third
   party.
5. **Tests.**
   - Dispatcher: unknown label, non-media document, image/audio/video
     kinds, filename/version from the index, no signed URL in the event or
     the model result.
   - Streaming/persistence: a media-only turn is not treated as an empty
     response; the event survives `stripTransientAssistantEvents` and a
     reload.
   - Frontend stream: a live `media` frame appears before reload.
   - `AssistantMessage`: media renders outside a collapsed
     `PreResponseWrapper`; grouping of adjacent images; click passes the
     exact document id and version to `onOpenDocument`; audio/video use
     native controls; failure placeholder.
   - `chatPanelDocuments`: media events from every message, latest version,
     dedupe by document id.
   - Shared chat: failed `/file` shows the placeholder and the existing
     "Document not shared" explanation on click.
   - Accessibility checks: image control has an accessible name, keyboard
     activation opens the panel, focus returns to the opener, no autoplay.

Acceptance in one sentence: a response can show a document-backed image,
audio or video inline at the point the model chose; clicking it opens the
same document and version in the existing viewer; a reload reproduces it;
the document panel can list media from earlier responses; and no media
bytes, signed URLs or untrusted remote images enter the message wire.

## Open questions

1. **Tool vs inline tag.** Is the no-workstation gap acceptable? If not, the
   `<media doc="…"/>` directive (phase 2 above) is the only path that works
   in every chat and places media mid-paragraph without a tool round trip.
2. **Version pinning.** Pin the version shown in the answer (recommended,
   matches citations) or always open the latest? The panel's tab id is the
   document id, so the two views cannot both be open at different versions.
3. **Attachments in the panel list.** Should `chatPanelDocuments` include
   image/audio/video files the person attached, or only media the assistant
   showed? "All media" argues for attachments; it also adds every upload to
   the auto-open tab list.
4. **Tab volume.** `openPanel` opens every missing document as a tab
   (`ChatView.tsx:422-471`). A media-rich chat could open a dozen tabs.
   Cap the auto-open, or add a media list rather than tabs?
5. **Carousel/lightbox.** Is the viewer enough as the only full-size
   surface? If not, the lightbox should be a `ModalUI` variant with arrow
   keys, a roving tab stop and `watchHorizontalSwipe`; it is a separate
   accessibility project.
6. **Captions/transcripts.** Video and audio have no caption tracks and no
   extracted text. Do we add caption upload/generation, or explicitly ship
   without captions?
7. **Thumbnails and posters.** Full images and first-frame video are
   acceptable for a handful of items. If the grid grows, a stored thumbnail
   rendition (and a video poster) is the next performance change; neither
   exists today.
8. **Model vision of project media.** `show_media` presents a document; it
   does not let the model see it. Project images that were not attached are
   still unreadable by the model (`goals/mission-15-vision.md:11-13`). A
   future "view image" tool is separate and should be required before the
   model describes such an image.
