# Mission 15: Images in, for the models that can see

Owner direction, 2026-10-10: "we should handle images properly (model picker
and system must know which are vision capable; do we need to resize them
before uploading to models? Best practices…)". This is phase I0 of the
[file and image intake report](../docs/reports/file-intake-2026-10-10.md),
which holds the research and the numbers.

## Shape

- **Delivery is inline.** An image attached to a message goes into that user
  message as an image part, in the same request. It is not a document handle
  for `read_document`. Looking at a project image that was not attached to
  the current message is a later "view image" tool (phase I3).
- **Storage is shared.** Images upload through the existing upload flow and
  become documents, so access checks, the project file list and reuse all
  work unchanged. Images skip the PDF rendition and the text extraction.
- **Cleaned once, on the way in.** sharp decodes only JPEG, PNG, WebP and GIF,
  with a pixel cap. It applies the EXIF orientation, flattens transparency
  onto white, converts to 8-bit sRGB, takes the first frame of an animation,
  strips every piece of metadata, and caps the long edge at 3072 px. The
  stored file is the cleaned one; the original never leaves upload
  quarantine.
- **Sized per model at send time.** The size depends on the model family:
  - Claude: 28 px patches, 1568 px or 2576 px long edge, with a token cap.
  - Qwen: 32 px grid, about 1.3 MP for photos.
  - Gemma 4: 48 px grid.
  - Unknown families: a conservative 1568 px and about 1.2 MP.
- **One answer to "can it see?".** `modelSupportsVision` in the backend
  decides:
  - configured models per their `supportsVision`;
  - the OpenCode Go allowlist;
  - direct Claude, Gemini and GPT models;
  - false otherwise.

  The frontend asks the backend instead of keeping its own list.
- **Refuse, don't drop.**
  - A turn whose newest message attaches an image, with a model that cannot
    see, is refused with `400 model_cannot_see_images`.
  - The composer blocks it first and points to the models marked
    "Sees images" in the picker.
  - Older images in the history reach a text-only model as a placeholder;
    the stored image never changes.

## Acceptance

1. A JPEG with EXIF rotation and GPS uploads. The stored file is upright and
   has no metadata. A 30 MP PNG is stored at most 3072 px on the long edge.
   An SVG renamed `.png` is refused.
2. A chat turn on a vision model carries the image as an image part, sized
   to that model's grid. A text-only model refuses the same turn before
   anything is sent.
3. The picker shows "Sees images" for vision models. The composer explains
   and blocks an image sent to a text-only model, pointing to the models
   marked "Sees images".
4. Phala's Qwen3.8-27B and Gemma 4 26B-A4B are declared `supportsVision` on
   staging. A photo sent to Gemma 4 is described correctly.
5. Backend, frontend and architecture tests pass. The backend Docker image
   builds with sharp.

## Receipt (2026-10-10, built, not accepted)

Built on `feat/vision-input`:

- **Backend:**
  - `lib/images.ts`: sharp with every loader blocked except the JPEG, PNG,
    WebP and GIF buffer loaders; cleaning; per-model resizing.
  - `imageSizingFor` and `modelSeesImages`, the latter from the runtime's own
    catalog via `modelSeesImagesOnPi`, which the turn also uses.
  - Upload processing cleans images and stores the cleaned bytes;
    `unsupported_image` and `image_too_large` are terminal.
  - `engine/attachedImages.ts`: image parts in the message, and the refusal,
    wired into the chat and project-chat preparation.
  - `read_document` and `docs` answer that an image is not text.
  - `POST /models/vision`; `"image"` added to `SourceDocumentType`.
- **Frontend:**
  - Images accepted where files attach to chats and projects, not in tabular
    reviews or workflow assets.
  - `useModelVision`; "Sees images" in the picker.
  - The composer's block and explanation; `/nr` notes still send.
  - `ImageView` in both document panels; an image file-type icon.

Verification run:

- `npm test --prefix backend`: `263 passed | 13 skipped` files,
  `4547 passed | 102 skipped` tests.
  - New: `images.test.ts` (13), `attachedImages.test.ts` (5),
    `vision.test.ts` (3).
  - Plus two upload-processing cases and a chat-route refusal case.
- `npm run build --prefix backend`: passed.
- `npm run test:coverage --prefix frontend`: `278 passed` files,
  `2375 passed` tests, no threshold errors.
- `npm run lint --prefix frontend`: 0 errors. The one warning in a touched
  file is pre-existing (`DocTable.tsx:3280`).
- `npm run typecheck --prefix frontend` and
  `npm run typecheck --prefix word-addin`: passed.
- `docker build -f backend/Dockerfile .`: built. Inside it,
  `require('sharp')` decoded a PNG with the loader allowlist on
  (`sharp ok arm64 png 4`). The lockfile carries `@img/sharp-linux-x64` for
  the staging host.

Staging, for acceptance 4 (2026-10-10, owner's permission):

- `/var/lib/mike-staging/backend.env` was backed up, then `jq` added
  `"supportsVision": true` to the two Phala entries in that file and in the
  compose `.env` it produces. The edit printed only ids and flags:

  ```text
  {"id":"phala/qwen3.8-27b-uncensored","supportsVision":true}
  {"id":"phala/glm-5.3","supportsVision":null}
  {"id":"phala/glm-5.3-flash","supportsVision":null}
  {"id":"phala/gemma-4-26b-a4b-uncensored","supportsVision":true}
  ```

- `mike-staging compose up -d backend`, then `modelSeesImages` in the running
  container:

  ```text
  phala/qwen3.8-27b-uncensored true
  phala/gemma-4-26b-a4b-uncensored true
  phala/glm-5.3 false
  ```

- A throwaway script in the container generated a 1800×1200 JPEG (red left
  half, blue right half), sized it with `imageForModel(imageSizingFor(id))`
  and sent it with pi's `completeSimple`. It asked for the colour of each
  half. The script was then deleted. Gemma 4:

  ```text
  sent image/jpeg 1344x912 17764 bytes
  catalog input: text,image
  stop: stop
  answer: The left half is red and the right half is blue.
  ```

  Qwen3.8-27B: `sent image/jpeg 1376x928 18491 bytes`, same answer.

  This exercised the sizing, the pi catalog and Phala's image input. It did
  not go through an upload and a chat turn in the web app, because that
  needs a signed-in staging account.

Not yet done:

- Acceptance 4 end to end: upload a real photo in the staging web app and
  ask Gemma 4 about it.
- Ollama vision (probe `/api/show`).
- OpenRouter models outside pi's catalog stay text-only.
- Image parts are stored base64 in Pi Durable's transcript, about 1 to 3 MB
  each; watch its size.
