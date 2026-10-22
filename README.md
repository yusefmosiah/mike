# Mike

![Mike](docs/assets/link-image.jpg)

An open-source AI agent for knowledge work: research, analysis, writing and
documents. You can host it yourself, use it from the web, Word, an iPhone or
a Mac, and run it against the models you choose. That includes private and
attested ones.

This repository is a fork of
[open-legal-products/mike](https://github.com/open-legal-products/mike), an
open-source legal AI platform. We forked on 2026-10-07 and have since
diverged a long way. Legal work is still a strength: the legal workflows,
contract templates and US case-law tools are all here. But the assistant no
longer assumes you are a lawyer. For what changed, what we took from
upstream, and what we hope to contribute back, see
[How this fork differs from upstream](docs/reports/fork-divergence-2026-10-21.md).

The web app, the Word add-in and the API read the product's name from
[`packages/brand/brand.json`](packages/brand/README.md), so an install can
carry its own name.

## What it does

### Assistant

- **Chat over projects, folders and a document library.** Run reusable
  workflows and tabular reviews, and keep scoped memory.
- **Every model call runs on [Pi Durable](docs/backend-architecture.md) and
  pi-ai.** Turns are stored in Postgres:
  - An answer interrupted by a restart continues where it stopped.
  - Long threads compact their own context.
  - A conversation is a tree: edit a prompt, regenerate an answer, move
    between versions, or branch into a new thread.
- **Models come from several lanes** (see
  [Configured models](docs/configured-models.md)):
  - native Anthropic, Google and OpenAI APIs;
  - routers: OpenCode Go, OpenRouter and Vercel AI Gateway;
  - Ollama, and any OpenAI-compatible endpoint you declare.

  The picker groups models by provider and shows which ones can see images.
- **A strict private mode** keeps traffic to the endpoints the operator
  declares. Before every request on an attested lane, the gateway's hardware
  attestation is checked, and the receipt is kept in the audit log.
- **Shared threads.** Several people can work in one thread. A claim in the
  database lets only one answer generate at a time. Each prompt shows who
  wrote it, and `/nr` adds a note without asking for a reply.
- **Skills** use the standard `SKILL.md` format. Import them from GitHub or a
  zip, save one from a chat, and restore earlier versions.
- **Subagents and web search.** The assistant can hand work to subagents and
  search the web through pluggable providers. Web pages it cites open as a
  saved reader copy, with the quote highlighted.

### Documents

- **Word files are edited as real tracked changes** that Word can accept or
  reject:
  - Edits address paragraphs by a stable id and change only the runs they
    touch.
  - A document that would not open, or that adds lint errors, is not saved.
  - A corpus of Word-authored files checks the results against Word's own
    output.
- **One document model.** Word, PDF, Markdown, text, spreadsheets and slides
  are read into one block model. Scanned PDFs are read with local OCR.
- **Images and plain text.** Images reach the model only if it can see them.
  They are cleaned once, with metadata stripped and size capped. Text,
  Markdown and CSV files upload as themselves and have their own viewers.
- **Citation checking.** The assistant checks the citations in documents it
  drafts or edits. It finds each source, keeps a snapshot, matches the quote,
  and asks a second model whether the source supports the claim (see
  [Inline citations](docs/inline-citations.md)).
- **Word add-in.** Chats in the [Word add-in](word-addin/README.md) and in
  tabular reviews survive a backend restart, like the assistant's.

### Code and workstations

- **A workstation for each account** *(experimental; needs a Linux host with
  KVM)*:
  - Each account can have its own small VM.
  - A snapshot is taken every turn.
  - A logging proxy is the VM's only way out.
  - Your documents appear read-only under `~/mike`, and files come back as
    new documents or versions.
- **Code mode.** The assistant works in Python, in the account's workstation.
  Its one tool runs a code cell, the cell calls the assistant's other tools
  as functions, and variables persist between cells. An account without a
  workstation has no tools: the assistant answers from the conversation.
- **A secrets [vault](docs/vault.md)** lets the assistant use a credential
  without the model, the VM or the backend ever holding it.

### Voice and apps

- **Dictation and read-aloud.** Dictate into the composer, and have any
  answer read aloud. Both work through a server speech endpoint, in the
  browser, or on the device. A personal
  [vocabulary](docs/dictation-vocabulary.md) spells names right.
- **[iPhone and Android apps](mobile/README.md)** *(experimental, unsigned)*
  wrap the web app. They add on-device dictation (Fluid Speech Mini) and
  read-aloud (Phonon). On phones, project chats show the chat first, with
  files and documents in slide-over panels.
- **Hands-free [voice mode](docs/voice-chat.md) on iPhone** *(in progress)*:
  - Talk and listen; it knows when you have finished a turn.
  - You can interrupt it.
  - It learns your voice and ignores other voices.
  - It is still being tuned and not yet verified on a device.
- **A [Mac app](docs/mac-app.md)** wraps the hosted web app with menus and
  shortcuts. It is upstream's app without its "Start on this Mac" mode, which
  runs the whole stack inside the app.

### What is not yet finished

Status markers are in [`goals/STATUS.md`](goals/STATUS.md). Most work since
2026-10-10 is deployed to staging but not yet accepted by the owner. Voice
mode, the phone apps, code mode and workstations are the least mature parts.

## Quick start

The included Docker Compose stack runs the app, Postgres, GoTrue, RustFS
object storage and local email capture. It needs no managed infrastructure.

1. Copy the local environment templates:

   ```bash
   cp .env.example .env
   cp backend/.env.example backend/.env
   ```

2. In `backend/.env`, set `DOWNLOAD_SIGNING_SECRET` and
   `USER_API_KEYS_ENCRYPTION_SECRET` to separate values. Generate each one
   with:

   ```bash
   openssl rand -hex 32
   ```

3. Add a model key to `backend/.env`, unless you plan to use Ollama only.
   It can be an Anthropic, Gemini or OpenAI key, or a router key
   (`OPENCODE_API_KEY`, `OPENROUTER_API_KEY` or `AI_GATEWAY_API_KEY`).

4. Start the stack:

   ```bash
   docker compose up --build
   ```

5. Open [http://localhost:3000](http://localhost:3000) and create an account.
   New accounts go straight to the assistant.

The bundled credentials and infrastructure are for local development only.
[Local development](docs/local-development.md) covers service endpoints,
authentication, Ollama and first-run setup. The backend talks to Postgres
directly (`DATABASE_URL`) and signs people in through GoTrue. There is no
PostgREST or Supabase gateway.

### Telemetry

By default the app sends scrubbed error reports to the project's Sentry.
They contain no document content, user identities or request data. To opt
out, set `SENTRY_DISABLED=true`. To use your own Sentry, set `SENTRY_DSN`.
The [observability guide](docs/observability.md) gives the exact policy and
per-runtime variables, and the [Sentry data audit](docs/sentry-data-audit.md)
lists what is sent.

## Repository

| Path | Purpose |
| --- | --- |
| `frontend/` | Next.js web application |
| `backend/` | Express API, document processing, database access and model calls |
| `word-addin/` | Microsoft Word task-pane add-in (beta) |
| `mobile/` | iPhone and Android apps (Capacitor) and the on-device speech plugin |
| `desktop/` | Mac app (Electron) |
| `packages/` | Shared code: `brand` (the product name), `contracts` (wire types), `pdf-text-order` |
| `skills/` | Skills kept in the repository |
| `infra/` | NixOS hosting: staging, workstation VMs, the vault, egress |
| `e2e/` | Playwright tests for the web app |
| `backend/schema.sql` | Complete schema for fresh databases |
| `backend/migrations/` | Dated migrations for existing deployments |
| `docker-compose.yml` | Local application and infrastructure stack |
| `docs/` | Development, deployment, testing and feature guides |
| `goals/` | Missions, status and project accounting |

## Documentation

- [Documentation index](docs/README.md)
- [How this fork differs from upstream](docs/reports/fork-divergence-2026-10-21.md)
- [Local development](docs/local-development.md)
- [Manual and production deployment](docs/deployment.md)
- [Backend architecture](docs/backend-architecture.md)
- [Design system](docs/design-system.md)
- [Configured models](docs/configured-models.md) and [model costs](docs/model-costs.md)
- [Resuming interrupted answers](docs/resume-interrupted-answers.md)
- [Inline citations](docs/inline-citations.md)
- [Secrets vault](docs/vault.md)
- [Voice chat](docs/voice-chat.md) and [its contract](docs/voice-chat-contract.md)
- [Mac app](docs/mac-app.md) and [phone apps](mobile/README.md)
- [Microsoft Word add-in](word-addin/README.md)
- [MCP connectors](docs/connectors.md)
- [Scoped memory](docs/memory.md)
- [CourtListener integration](docs/courtlistener.md)
- [Google Drive](docs/google-drive.md) and [Gmail and Calendar](docs/google-workspace.md)
- [Tamper-evident exports](docs/tamper-evident-exports.md)
- [Preset contract templates and publisher credits](docs/preset-templates.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Safe local testing](docs/safe-local-testing.md)
- [End-to-end testing and CI](docs/e2e-ci.md)
- [Contributing](CONTRIBUTING.md)
- [Open-source credits](CREDITS.md)
- [Security policy](SECURITY.md)

## System workflows

The system assistant and tabular-review workflows are maintained upstream, in
the
[`Open-Legal-Products/mike-workflows`](https://github.com/Open-Legal-Products/mike-workflows)
repository. [Contributing](CONTRIBUTING.md#mike-workflows) explains how
they are packaged and synchronised with this application.

## Gmail and Google Calendar

Gmail and Calendar are separate, optional connections in **Settings →
Connectors**:

- Google sign-in never connects them automatically.
- Each service can use any permitted Google account, including one that
  differs from your sign-in account.
- Read access is the default. Write permissions need a separate consent.
- You approve the exact contents of every send, edit or delete before it
  happens.

[Gmail and Google Calendar](docs/google-workspace.md) covers setup, the
technical approach, limits and manual acceptance tests.

## License

[GNU Affero General Public License v3.0](LICENSE), like upstream. The bundled
[public contract templates](docs/preset-templates.md#maintaining-the-catalog)
keep their publishers' separate licenses and notices. Third-party models and
datasets used by the speech features are listed in [CREDITS.md](CREDITS.md).
