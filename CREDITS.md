# Open-source credits

Mike is built with the work of open-source maintainers and contributors. Thank
you for making these projects available and for the care that goes into them.

This page highlights the projects behind Mike's document tools, applications,
infrastructure, and development workflow, including optional local integrations.

## Documents and spreadsheets

| Project | How Mike uses it |
| --- | --- |
| [LibreOffice](https://www.libreoffice.org/) | Server-side office-document conversion, including PDF renditions. |
| [libreoffice-convert](https://github.com/elwerene/libreoffice-convert) | Node.js integration with LibreOffice's conversion tools. |
| [PDF.js](https://github.com/mozilla/pdf.js) | PDF viewing in the browser and PDF text extraction on the backend through `pdfjs-dist`. |
| [Tesseract.js](https://github.com/naptha/tesseract.js) and [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) | Local OCR of scanned PDF pages, with the English model vendored in `backend/assets/tessdata/`. |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) | Rasterising PDF pages for OCR through PDF.js's Node canvas backend. |
| [EigenPal DOCX Editor](https://github.com/eigenpal/docx-editor) | Browser-based Word document viewing and editing through `@docx-editor.dev/core`, `@docx-editor.dev/react`, and the packaged fonts. |
| [Mammoth](https://github.com/mwilliamson/mammoth.js) | Extracting content from Word documents. |
| [docx](https://github.com/dolanmiu/docx) | Creating Word documents. |
| [FortuneSheet](https://github.com/ruilisi/fortune-sheet) | Interactive spreadsheet viewing and editing. |
| [LuckyExcel](https://github.com/dream-num/Luckyexcel) | Importing Excel workbooks into the spreadsheet viewer. |
| [SheetJS Community Edition](https://git.sheetjs.com/sheetjs/sheetjs) | Reading and processing spreadsheet data on the backend. |
| [ExcelJS](https://github.com/exceljs/exceljs) | Building Excel workbook exports. |
| [JSZip](https://github.com/Stuk/jszip) | Reading and writing ZIP-based document packages. |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | Parsing document XML. |

## Application and interface

| Project | How Mike uses it |
| --- | --- |
| [Node.js](https://nodejs.org/) | JavaScript runtime for the backend and application tooling. |
| [TypeScript](https://www.typescriptlang.org/) | Typed application code across the web app, backend, and Word add-in. |
| [React](https://react.dev/) | User interfaces for the web app and Word add-in. |
| [Next.js](https://nextjs.org/) | Web application framework. |
| [Express](https://expressjs.com/) | Backend HTTP API. |
| [Tailwind CSS](https://tailwindcss.com/) | Shared styling and design tokens. |
| [shadcn/ui](https://ui.shadcn.com/) and [Radix Primitives](https://www.radix-ui.com/primitives) | Reusable interface components and accessible interactions. |
| [Lucide](https://lucide.dev/) | Interface icons. |
| [Tiptap](https://github.com/ueberdosis/tiptap) and [ProseMirror](https://prosemirror.net/) | Rich-text editing in the web app and Word add-in. |
| [react-markdown](https://github.com/remarkjs/react-markdown), [remark](https://github.com/remarkjs/remark), and [rehype](https://github.com/rehypejs/rehype) | Rendering Markdown, tables, and formatted assistant responses. |
| [Marked](https://github.com/markedjs/marked) | Markdown parsing. |
| [KaTeX](https://katex.org/) | Mathematical notation. |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Sanitizing HTML content. |
| [Recharts](https://recharts.org/) | Charts and data visualization. |

## AI, data, and infrastructure

| Project | How Mike uses it |
| --- | --- |
| [AI SDK](https://github.com/vercel/ai) | Language-model integrations, streaming, and tool calls. |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Connections to MCP tools and servers. |
| [Ollama](https://github.com/ollama/ollama) | Optional local language-model inference. |
| [Fluid Speech Mini](https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-coreml) by FluidVoice, built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra | On-device dictation in the iPhone app, bundled unmodified apart from one file renamed for the loader ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). |
| [FluidAudio](https://github.com/FluidInference/FluidAudio) | Running Fluid Speech Mini, Silero VAD and Parakeet EOU on the iPhone with Core ML (Apache-2.0). |
| [Phonon 31m](https://huggingface.co/gradium/phonon-31m-en) by Gradium, built on Kyutai's Pocket TTS, with the voices of [phonon-voices](https://huggingface.co/gradium/phonon-voices) | Reading answers aloud in the browser (downloaded from Hugging Face after consent, pinned to a commit) and in the iPhone app (the release's Core ML build, downloaded after the person chooses it from a public mirror, [mosiah/phonon-31m-en-coreml](https://huggingface.co/mosiah/phonon-31m-en-coreml); its licence text is Apache-2.0, kept with the mirrored files) ([Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)). |
| [Silero VAD](https://github.com/snakers4/silero-vad) by Silero, as FluidInference's Core ML conversion [silero-vad-coreml](https://huggingface.co/FluidInference/silero-vad-coreml) (v6.2.1) | Hearing speech and silence in the iPhone app's hands-free voice mode, downloaded when the person turns voice mode on, pinned to a commit ([MIT](https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE)). |
| [Parakeet realtime EOU 120M](https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1) by NVIDIA, as FluidInference's Core ML conversion [parakeet-realtime-eou-120m-coreml](https://huggingface.co/FluidInference/parakeet-realtime-eou-120m-coreml) (320 ms) | Live words and end-of-utterance candidates in the iPhone app's voice mode, run through FluidAudio's streaming components, downloaded when voice mode is turned on, pinned to a commit ([NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/)). |
| [Smart Turn v3.2](https://github.com/pipecat-ai/smart-turn) by Daily (Pipecat), as aufklarer's Core ML port [Smart-Turn-v3.2-CoreML](https://huggingface.co/aufklarer/Smart-Turn-v3.2-CoreML) | Confirming that a pause ends the person's turn in the iPhone app's voice mode, downloaded when voice mode is turned on, pinned to a commit; its licence text is kept with the downloaded files ([BSD-2-Clause](https://github.com/pipecat-ai/smart-turn/blob/main/LICENSE)). |
| [xn-ptts](https://github.com/gradium-ai/xn-ptts) and its npm package [`phonon-tts`](https://www.npmjs.com/package/phonon-tts) by Gradium (0.4.0) | Running Phonon in the browser (WebAssembly and WebGPU) and on the iPhone (Swift package `ptts`, Core ML) (MIT OR Apache-2.0). |
| [Zod](https://github.com/colinhacks/zod) | Runtime schema validation. |
| [PostgreSQL](https://www.postgresql.org/) | Persistent application data. |
| [Supabase Auth (GoTrue)](https://github.com/supabase/auth) and [auth-js](https://github.com/supabase/supabase-js/tree/master/packages/core/auth-js) | The authentication server and its client library. |
| [PostgREST](https://github.com/PostgREST/postgrest) | REST access to PostgreSQL in the local stack. |
| [Redis](https://github.com/redis/redis), [BullMQ](https://github.com/taskforcesh/bullmq), and [ioredis](https://github.com/redis/ioredis) | Background queues and their Redis transport. |
| [RustFS](https://github.com/rustfs/rustfs) | S3-compatible object storage in the local stack. |
| [AWS SDK for JavaScript](https://github.com/aws/aws-sdk-js-v3) | Access to S3-compatible document storage. |
| [NGINX](https://github.com/nginx/nginx) | Gateway routing in the local stack. |
| [Mailpit](https://github.com/axllent/mailpit) | Capturing email during local development. |
| [Sentry JavaScript SDKs](https://github.com/getsentry/sentry-javascript) | Error reporting across the backend, web app, and Word add-in. |
| [Undici](https://github.com/nodejs/undici) | Backend HTTP requests. |

## Development and testing

| Project | How Mike uses it |
| --- | --- |
| [Vitest](https://vitest.dev/) | Unit and integration tests. |
| [Testing Library](https://testing-library.com/) and [jsdom](https://github.com/jsdom/jsdom) | Component and browser-DOM tests. |
| [Playwright](https://playwright.dev/) | Browser end-to-end tests. |
| [axe-core](https://github.com/dequelabs/axe-core) | Automated accessibility checks. |
| [SuperTest](https://github.com/ladjs/supertest) | HTTP API integration tests. |
| [Stryker](https://stryker-mutator.io/) | Mutation testing. |
| [Ladle](https://ladle.dev/) | Component catalog and isolated UI previews. |
| [ESLint](https://eslint.org/) and [Prettier](https://prettier.io/) | Code quality and formatting tools. |
| [Vite](https://vite.dev/), [webpack](https://webpack.js.org/), and [PostCSS](https://postcss.org/) | Development servers, bundling, and CSS processing. |
| [OpenNext](https://opennext.js.org/) | Cloudflare deployment support for the web app. |
| [Office Add-in tooling](https://github.com/OfficeDev/Office-Addin-Scripts) | Local development and debugging for the Word add-in. |

## Dependency details

We also thank the authors of the many supporting and transitive dependencies
that these projects rely on. This is a curated acknowledgment, rather than a
complete dependency inventory. Direct dependencies are recorded in the
[root](package.json), [frontend](frontend/package.json),
[backend](backend/package.json), and [Word add-in](word-addin/package.json)
package manifests; their lockfiles record resolved JavaScript dependencies.
The [Compose stack](docker-compose.yml) and application Dockerfiles also record
system and service dependencies.

Each third-party project retains its own license and copyright notices. Refer
to the license and notice files distributed with the versions in use. Please
keep this page current when adding or replacing a significant dependency.
