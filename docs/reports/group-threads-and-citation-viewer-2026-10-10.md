# Group threads and the in-app citation viewer (research, 2026-10-10)

The owner asked two questions:

1. Mission 5 allows one turn at a time per thread. How could several of our
   users take part in one thread at once, like a group chat? And which VM would
   that thread run in?
2. Web citations currently open the live page in a new tab, which is jarring.
   Should they expand in place and show the cited passage instead? And should
   we build an in-app viewer for every citation type (web pages, Markdown,
   code, diffs, HTML), given that many sites refuse to be framed? Where should
   the page be fetched from?

Nothing here is built yet. Statements about the code cite the file. Figures
from the web are listed under Sources.

---

## Part 1: Group threads

### What exists today

| Piece | Where | Behaviour |
| --- | --- | --- |
| Shared chats | `chat_access_grants` (owner, editor, viewer, by email), project and org roles, `can()` in `lib/permissions.ts` | Several people can open and write in one thread. |
| Authorship | `chat_messages.author_user_id` | Each message records who wrote it. |
| One turn per thread | `chat_turn_claims` / `claim_chat_turn` (`lib/turnClaims.ts`) | The lease lasts 90 s and is renewed every 30 s. A second sender gets 409 `turn_in_progress`. Chat, tabular and Word share the claim. |
| Watching a colleague's turn | `GET /chat/:id/turn/:turnId/stream`, `resumeAssistantTurn` (`frontend/src/app/lib/assistantTurns.ts`) | Anyone who can see the chat can attach to the live stream. |
| Stop | `chat.routes.ts` stop route | Only the person generating can stop (403 `turn_not_yours`). |
| Presence | `threadPresence`, `useThreadGenerating` (3 s poll) | Shows "X is generating". |
| Memory | `sharedAudience` in `lib/memory/prompt.ts` | A shared thread gets project memory, never personal memory. |
| Workstation | `resolveWorkstation(db, userId)`, `streaming.ts:552` | The VM is chosen **per sender**. |
| Python kernel | `kernels.acquire(conversationId, launcher)`, `streaming.ts` ~908; `KernelManager` in `lib/codemode/kernel/manager.ts` | The kernel is chosen **per conversation**. |

So the answer to "is it single threaded?" has two parts:

- **One AI turn at a time, by design.** Several people can be in the thread and
  watch, but while a turn runs nobody else can even post a message: posting
  and invoking the assistant are the same request, and that request needs the
  claim.
- **Several humans in one thread already works.** What is missing is posting
  without invoking, ordering, live updates for human messages, and a coherent
  place for the code to run.

### Finding: shared threads already break the Python kernel

The kernel is keyed by conversation, but the workstation is resolved per
sender. A `KernelLauncher`'s id is its ssh target, and `acquire` replaces a
kernel whose launcher changed (`manager.ts:117`). So when A and B take turns
in one thread:

1. A's turn starts a kernel in A's VM.
2. B's turn sees a different launcher id, shuts down A's live kernel, starts
   one in B's VM, and restores `~/.mike/kernels/<chat>.dill` from **B's** VM.
   That file holds B's last state, or nothing.
3. A's next turn does the same in reverse.

The result:

- Python state silently splits per person.
- The kernel restarts on every change of speaker.
- Files the assistant wrote in A's VM are invisible during B's turn.

The model is not told any of this. This is a defect in today's shared chats,
independent of the group-chat question.

**Interim fix (small):** key the kernel by chat plus workstation, so each
person's state persists instead of being thrown away. Add one line to the
system prompt when the thread is shared: "Python state and files belong to the
person who sent the message." This is honest, keeps authority clean, and
needs no new infrastructure. The real fix is the project VM below.

### The four design decisions

#### 1. Posting versus invoking

Separate the two:

- Anyone with `content.edit` can post a message at any time, with no claim.
- The assistant runs only when someone invokes it.

ChatGPT group chats let the model decide when to reply, with a mention-only
mode and @ChatGPT always working. For legal work, **explicit invocation**
(@Mike, or an "Ask Mike" send button) is the better default:

- each turn costs money and may edit documents;
- people discussing a draft should not trigger rewrites.

An automatic mode can come later as a per-thread setting.

#### 2. Ordering

In a group thread, messages form a **linear log** ordered by time. Today's
tree (`parent_message_id`, branches, `resolveLeaf`) works for one author.
With several authors, editing a message or regenerating a reply would fork the
conversation for everyone, which is confusing.

Recommendation: in group mode, disable edit-and-branch and regenerate. Offer
"Fork to a private chat" instead; the `/fork` route already exists. A message
posted while a turn runs goes in the log after the trigger and is answered by
the next turn.

#### 3. Concurrency

Keep **one AI turn at a time per thread**:

- Two simultaneous turns would edit the same documents, the same kernel and
  the same project state.
- The existing claim already handles this across replicas and surfaces.

Instead of 409, an invocation during a turn **queues**. When the current turn
ends, the next turn starts automatically. It sees every message posted
meanwhile and answers all pending mentions, addressing each person by name.

If people need parallel AI work, use **sub-threads**: start a thread from a
message, with its own turn lane, linked back. This is Slack's pattern; vendor
agents there reply in a thread per mention.

#### 4. Which VM runs it

| Option | Authority | Shared state | Verdict |
| --- | --- | --- | --- |
| Sender's VM (today) | Clean: your turn runs as you. | Splits per person (the finding above). | Acceptable for occasional sharing, with the interim fix. |
| Thread creator's VM | B's prompts drive code in A's VM, with A's files, credentials and connectors. This is the confused deputy problem. | Coherent. | **Reject.** |
| **Project (matter) VM** | Turns act "as the matter". The VM holds only matter material: no personal credentials, no personal connectors. Every action is attributed to the message's author. | Coherent: one kernel per thread, in the matter VM. | **Recommended for group threads.** |
| Throwaway VM per thread | Clean. | Lost when the thread idles. | Good for test accounts (temporary VMs already exist). |

**Why the project VM**

- It matches the owner's earlier decisions: every user has a VM, and a
  boutique firm's VMs fit on one machine.
- Group work belongs to a matter, and the matter already decides who can join
  (project roles). That is what "limited to our users" means in practice:
  only project or org members can be invited, with no link-joining (unlike
  ChatGPT's invite links).

**What the project VM needs**

- **Assignment.** Workstation assignments gain a `project_id`. Matter VMs come
  from the same pool used for temporary VMs (`poolVmFor`, `takeFreeVm`).
- **Lifecycle.** Snapshots belong to the project and are kept and deleted with
  it. An idle matter VM can be stopped, but not wiped, after a period.
- **Contents.** No owner ssh keys, git credentials or personal connectors.
  Matter documents are synced in as they are today.
- **Capacity.** Each active matter takes a pool VM. If the pool runs out, the
  turn fails with a clear message; it does not fall back to someone's
  personal VM.

### Other constraints

- **Prompt injection between people.** Every member's message is a prompt.
  Only `content.edit` may invoke (already true for sending), so viewers watch
  only. Content pasted by one member gets the same trust as content pasted by
  anyone; personal connectors being off is what limits the damage.
- **Model and cost.** Use one model per thread, set by the thread's owner.
  Each turn records who invoked it, for billing and audit; message authorship
  is already stored.
- **Memory.** Personal memory is already off (as in ChatGPT). Group threads
  should not *write* personal memory; project memory only.
- **Live updates.** Watching a turn works today, but the run registry is
  in-process (`getAssistantTurnRun`). A watcher must reach the replica
  running the turn. Staging has one replica; more replicas would need
  Postgres `LISTEN/NOTIFY` or a durable frame log. Human messages also need
  to appear live:
  - **cheapest start:** poll the thread path every few seconds, as presence
    already does;
  - **proper version:** one server-sent events channel per chat (message
    posted, turn queued, started and finished), fed by `NOTIFY`.
- **Surfaces.** Ship group mode in the web chat first. Tabular review chats
  and the Word add-in keep the current single-sender behaviour, sharing the
  same claim.
- **Document edits.** Serial turns already serialize AI edits. Concurrent
  human edits go through the existing version system.

### Phased plan

| Phase | Work | Size |
| --- | --- | --- |
| G0 | Kernel keyed by chat and workstation, plus the shared-thread prompt line, plus a test. | Small. |
| G1 | Post without invoking; @Mike or "Ask Mike" to invoke; queue instead of 409; linear log in group mode; live message updates by polling. | Medium. |
| G2 | Project workstation: assignment, lifecycle, no personal credentials; group threads run there. | Medium to large (infra plus backend). |
| G3 | Per-chat event stream; automatic-reply mode; sub-threads. | Medium. |

---

## Part 2: The in-app citation viewer

### What exists today

- **The citation.** `WebCitation` holds `{url, title, site, quotes[{quote,
  verification}]}`. Clicking it calls `openWebCitation`, which opens a new tab
  (`frontend/src/app/components/shared/types.ts:497`).
- **Fetching.** `fetchPage` (`backend/src/lib/search/engine.ts`) does the
  following:
  - fetches on the server, behind the SSRF guard;
  - identifies as `MikeLegalAssistant/1.0`;
  - strips the page to text and hashes it;
  - keeps the result in an **in-memory map of 2,000 entries**, which is lost
    on restart, has no owner, and keeps no HTML.
- **Durable snapshots.** The `citation_snapshots` table stores content plus
  sha256, readable by the service role only. Citation checks (Mission 6) use
  it.
- **Other citation types.** Document and case citations already open in the
  side panel (docx, pdf, spreadsheet). The frontend already depends on
  `react-markdown`, `dompurify` and `jsdom`.

### Why not frame the live page

- **Framing protection is common.** In 2026, 23% of the top 1,000 domains,
  37% of the top 100,000 and 30% of the top million sent `X-Frame-Options` or
  CSP `frame-ancestors` (SANS ISC). Most pages would frame. Enough would not
  that the viewer would break unpredictably.
- **Even a page that frames:**
  - may have changed since it was cited;
  - cannot have the quote highlighted from our side, because it is
    cross-origin;
  - sees the user's IP;
  - shows ads and paywalls;
  - is not the page the citation was checked against.
- **A proxy that strips the headers is worse.** It serves third-party HTML and
  JavaScript from our origin, which is cross-site scripting by construction.
  It breaks pages and invites terms-of-service trouble.

The right object is the **snapshot** we already fetched: the text the citation
was verified against.

### Recommended design: three layers over stored snapshots

**Layer 1: expand in place.** This fixes the jarring part.

- Clicking a web citation expands it inline and shows:
  - the quoted passage with about two paragraphs of context from the stored
    snapshot;
  - the verification result;
  - the site and the retrieval date.
- "Open page" uses a **Text Fragment** link (`url#:~:text=start,end`). The
  live page then scrolls to the quote and highlights it in Chrome, Edge,
  Safari (since 16.1) and Firefox (since 131). Where it is unsupported, the
  plain page opens.
- This needs no new infrastructure beyond persisting snapshots.

**Layer 2: reader view in the side panel.**

- "View saved page" opens the snapshot as a clean article in the side panel,
  scrolled to the quote with it highlighted.
- Extraction is Readability-style, to Markdown or sanitized HTML, rendered
  with `react-markdown` or DOMPurify on our origin.
- The same panel becomes the **unified citation viewer**, choosing a renderer
  by content kind:
  - Markdown preview (`react-markdown`, already present);
  - code with highlighting, and diffs (needs a highlighter; none is present,
    so that is a dependency decision);
  - documents and cases (existing panels).

**Layer 3: faithful view (later).**

- The original HTML appears in a sandboxed iframe served from a **separate
  cross-site origin** (for example `mikeusercontent.<domain>`), following
  Google's sandbox-domain guidance:
  - the `sandbox` attribute, without `allow-same-origin`;
  - no scripts in a static snapshot;
  - CSP `sandbox` sent as a response header (a `<meta>` tag cannot deliver
    it);
  - images proxied or removed.
- Alternatively, show a stored screenshot taken by a headless browser.

### Where the page is fetched from

The owner is right that the user should not have to care. The choice still
matters for reliability, privacy and content rights.

| Fetcher | Strengths | Weaknesses |
| --- | --- | --- |
| **Backend** (today) | Exists; SSRF guard; reproducible; one place to audit. | Datacenter IP is often blocked by bot walls; no JavaScript rendering. |
| **Headless Chromium in the workstation VM** | Renders JavaScript-heavy pages. A browser exploit stays inside the VM, not the backend. | Same datacenter IP. Chromium is not in `workstations.nix` today. Heavier. |
| **Hosted rendering** (e.g. Cloudflare Browser Rendering `/markdown`, `/screenshot`; $0.09 per browser-hour after 10 included on Workers Paid) | Trivial to adopt. | Sends every cited URL, and so the matter's research trail, to a third party. This conflicts with the attested-inference privacy posture. **Avoid**, or make it opt-in. |
| **The user's device** (Mac app or browser extension; a web page cannot fetch cross-origin) | Residential IP; the user's own subscriptions get past paywalls. | The snapshot may carry personal or session data. Storing paywalled content on the server raises licensing questions. |

**Recommendation**

1. Backend first.
2. Fall back to headless Chromium in the VM for pages that need JavaScript or
   block the backend.
3. Add device fetching through the Mac app later, for paywalled sources.

Every path writes to `citation_snapshots` with a `fetched_by` provenance field
and the hash.

### Storage, access and content rights

- **Persist web snapshots.** Write each fetch to `citation_snapshots`. Store
  `snapshot_id` and `content_sha256` on the citation, so the viewer shows
  exactly what was verified. Deduplicate by hash.
- **Access.** Serve snapshots through a route scoped to the chat, for example
  `GET /chat/:id/citations/:ref/snapshot`, gated by chat visibility, as the
  transcript is. Never expose the table directly.
- **Retention.** Keep snapshots while a chat or project references them;
  delete the unreferenced ones.
- **Content rights** (for the owner's review; this is not legal advice).
  Showing a short excerpt with attribution and a link is the conservative
  default for layer 1. A full saved copy (layer 2) should be visible only to
  the firm, labelled "Saved copy, retrieved <date>", and linked to the live
  page. Honour `noarchive` / `X-Robots-Tag` by showing the excerpt only.
- **Security.** Snapshot HTML is untrusted. Only sanitized text or Markdown
  renders on our origin; raw HTML only on the separate origin.

### Phased plan

| Phase | Work | Size |
| --- | --- | --- |
| C1 | Persist web snapshots; add `snapshot_id` to citations; expand in place with a Text Fragment "Open page". | Small to medium. |
| C2 | Reader view in the side panel; unified viewer for Markdown, code and diffs. | Medium. |
| C3 | Headless Chromium in the workstation VM as fetch fallback; screenshots. | Medium (infra). |
| C4 | Separate-origin faithful HTML; device fetch through the Mac app. | Large. |

---

## Decisions for the owner

1. **Group invocation.** Explicit (@Mike or "Ask Mike") as the default, with
   automatic replies as a later per-thread setting?
2. **Branching in group mode.** Disable edit-and-branch and regenerate, and
   offer "fork to private chat" instead?
3. **Matter VMs.** Run group threads in a per-project VM drawn from the pool?
   This sets pool capacity: one VM per active matter, plus one per person.
4. **G0 now.** Fix the kernel thrash in shared threads ahead of the rest?
5. **Hosted rendering.** Rule out third-party page-rendering services for
   privacy?
6. **Saved copies.** Show full saved copies to the firm, or excerpts only?
7. **Highlighter.** Accept a syntax-highlighting dependency for the code and
   diff viewer?

## Sources

- OpenAI, Group chats in ChatGPT: https://openai.com/index/group-chats-in-chatgpt/ and https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt
- SANS ISC, framing-protection headers 2023 to 2026: https://isc.sans.edu/diary/33068 and https://isc.sans.edu/diary/29698
- Firefox 131 release notes (text fragments): https://developer.mozilla.org/Firefox/Releases/131
- web.dev, Securely hosting user data in modern web applications: https://web.dev/articles/securely-hosting-user-data
- Cloudflare Browser Rendering pricing and endpoints: https://developers.cloudflare.com/browser-rendering/
- Slack group agent pattern (vendor docs): https://docs.leena.ai/docs/group-chat-agent-for-slack
