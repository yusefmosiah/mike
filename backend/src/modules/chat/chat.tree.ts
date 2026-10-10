// chat tree — message-tree primitives for branching conversations.
//
// chat_messages forms a tree: every message points at the message it answers
// via `parent_message_id` (null only for the first message of a chat). Rows
// are immutable once persisted — edits and regenerations INSERT siblings and
// move the caller's leaf pointer (chat_leaf_state) instead of updating
// existing content.
//
// These functions are the service layer behind the branching endpoints and
// the transcript read path. They take an explicit database client (`db`) plus
// request-derived primitives and return plain values. Read helpers fail open
// (log + empty/fallback result) so a transient DB error degrades a transcript
// rather than 500ing it; `setLeaf` is the one write and surfaces its error.
import { type Db } from "../../lib/db";

// The columns every tree consumer needs. `select *` would also ship citations
// and memory bookkeeping that no caller here reads.
const TREE_COLUMNS =
  "id, role, content, files, workflow, parent_message_id, created_at";

// Ceilings that keep a malformed tree from turning into unbounded work:
// 500 ancestors per path walk and 2000 rows scanned per chat.
const MAX_PATH_DEPTH = 500;
const MAX_CHAT_ROWS = 2000;

export type TreeRow = {
  id: string;
  role: string;
  content: unknown;
  files: unknown;
  workflow: unknown;
  parent_message_id: string | null;
  created_at: string;
};

export type MessageSiblingInfo = { index: number; total: number };

// Chronological order with a stable tiebreak: created_at can collide when a
// turn writes two rows close together, and sibling order must be identical
// across requests.
function compareRows(a: TreeRow, b: TreeRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Walk parent links from `leafId` to the root and return the rows root-first
 * (the order a transcript renders in). Rows the walk cannot reach are ignored:
 * an unknown or null leaf yields [], and a cyclic parent chain stops at the
 * first repeated id instead of looping forever. Depth is capped at
 * MAX_PATH_DEPTH ancestors.
 */
export function walkPathFromRows(
  rows: TreeRow[],
  leafId: string | null,
): TreeRow[] {
  if (!leafId) return [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path: TreeRow[] = [];
  const visited = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor && path.length < MAX_PATH_DEPTH && !visited.has(cursor)) {
    const row = byId.get(cursor);
    if (!row) break;
    visited.add(cursor);
    path.push(row);
    cursor = row.parent_message_id;
  }
  path.reverse();
  return path;
}

/**
 * The leaf a reader lands on when they open `messageId`: the newest message in
 * its subtree (itself when it has no replies). A child is always newer than its
 * parent, so the newest descendant has no replies of its own, and it is where
 * that branch was last continued. Opening a prompt version therefore shows its
 * answers, not a prompt hanging without one.
 */
export function newestLeafUnder(rows: TreeRow[], messageId: string): string {
  const children = new Map<string, TreeRow[]>();
  for (const row of rows) {
    if (!row.parent_message_id) continue;
    const list = children.get(row.parent_message_id);
    if (list) list.push(row);
    else children.set(row.parent_message_id, [row]);
  }
  let newest = rows.find((row) => row.id === messageId);
  if (!newest) return messageId;
  const visited = new Set<string>([messageId]);
  const stack = [...(children.get(messageId) ?? [])];
  while (stack.length > 0 && visited.size < MAX_CHAT_ROWS) {
    const row = stack.pop()!;
    if (visited.has(row.id)) continue;
    visited.add(row.id);
    if (compareRows(newest, row) < 0) newest = row;
    stack.push(...(children.get(row.id) ?? []));
  }
  return newest.id;
}

/** The ids on an already-walked path, for O(1) "is this message active" checks. */
export function activePathIds(rows: TreeRow[]): Set<string> {
  return new Set(rows.map((row) => row.id));
}

/**
 * Newest message in `rows` (created_at, id tiebreak) — the default leaf of a
 * chat that has no leaf-state row yet.
 */
export function latestMessageId(rows: TreeRow[]): string | null {
  let latest: TreeRow | null = null;
  for (const row of rows) {
    if (!latest || compareRows(latest, row) < 0) latest = row;
  }
  return latest ? latest.id : null;
}

/**
 * Group rows by parent and expose each message's 1-based position among its
 * siblings, so the client can render "‹ 2/3 ›" without re-deriving the tree.
 * Only ids in `ids` are indexed when provided (the active path), but totals
 * still count every persisted sibling — abandoned branches included.
 */
export function buildSiblingsIndex(
  rows: TreeRow[],
  ids?: Iterable<string>,
): Record<string, MessageSiblingInfo> {
  const groups = new Map<string | null, TreeRow[]>();
  for (const row of rows) {
    const siblings = groups.get(row.parent_message_id);
    if (siblings) siblings.push(row);
    else groups.set(row.parent_message_id, [row]);
  }
  const wanted = ids ? new Set(ids) : null;
  const index: Record<string, MessageSiblingInfo> = {};
  for (const siblings of groups.values()) {
    siblings.sort(compareRows);
    siblings.forEach((row, position) => {
      if (wanted && !wanted.has(row.id)) return;
      index[row.id] = { index: position + 1, total: siblings.length };
    });
  }
  return index;
}

/**
 * The caller's leaf for a chat: their leaf-state row, else the chat's newest
 * message, else null. Never throws — a leaf-state read failure falls back to
 * the newest message rather than failing the request that asked.
 *
 * A stored leaf resolves to the newest message under it, as opening a message
 * does (newestLeafUnder). It is a tip when stored; it gains replies when
 * someone else carries that branch on in a shared thread
 * (goals/mission-5-firm-thread-handoff.md), and the reader then sees, and
 * sends after, the continuation rather than the branch as they left it.
 */
export async function resolveLeaf(
  db: Db,
  chatId: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("chat_leaf_state")
    .select("leaf_message_id")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[chat/tree] failed to read leaf state", chatId, error);
  } else if (data?.leaf_message_id) {
    return newestLeafUnder(await chatRows(db, chatId), data.leaf_message_id as string);
  }

  const { data: latest, error: latestError } = await db
    .from("chat_messages")
    .select("id")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (latestError) {
    console.error("[chat/tree] failed to read latest message", chatId, latestError);
    return null;
  }
  return (latest?.[0]?.id as string | undefined) ?? null;
}

/**
 * Point the caller at `leafId`. Upsert because a user has at most one leaf per
 * chat (PK chat_id + user_id). Errors are surfaced: a silently dropped leaf
 * move would leave the client rendering the branch it just left.
 */
export async function setLeaf(
  db: Db,
  chatId: string,
  userId: string,
  leafId: string,
): Promise<void> {
  const { error } = await db.from("chat_leaf_state").upsert(
    {
      chat_id: chatId,
      user_id: userId,
      leaf_message_id: leafId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "chat_id,user_id" },
  );
  if (error) {
    console.error("[chat/tree] failed to set leaf", chatId, leafId, error);
    throw new Error(`Failed to move chat leaf: ${error.message ?? "unknown error"}`);
  }
}

/** Every row of a chat, oldest first, up to the scan ceiling. Fails open to []. */
export async function chatRows(db: Db, chatId: string): Promise<TreeRow[]> {
  const { data, error } = await db
    .from("chat_messages")
    .select(TREE_COLUMNS)
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(MAX_CHAT_ROWS);
  if (error) {
    console.error("[chat/tree] failed to load chat rows", chatId, error);
    return [];
  }
  return (data ?? []) as TreeRow[];
}

/**
 * The active transcript for a leaf: rows root-first, following parent links.
 * Rows on sibling branches are excluded by construction.
 */
export async function walkActivePath(
  db: Db,
  chatId: string,
  leafId: string | null,
): Promise<TreeRow[]> {
  if (!leafId) return [];
  return walkPathFromRows(await chatRows(db, chatId), leafId);
}

/**
 * Direct children of a message (or of the root when `parentId` is null),
 * oldest first.
 */
export async function childrenOf(
  db: Db,
  chatId: string,
  parentId: string | null,
): Promise<TreeRow[]> {
  const base = db.from("chat_messages").select(TREE_COLUMNS).eq("chat_id", chatId);
  const filtered =
    parentId === null
      ? base.is("parent_message_id", null)
      : base.eq("parent_message_id", parentId);
  const { data, error } = await filtered
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    console.error("[chat/tree] failed to load children", chatId, parentId, error);
    return [];
  }
  return (data ?? []) as TreeRow[];
}

/**
 * Every message that shares `messageId`'s parent (itself included), oldest
 * first. Empty when the message is not in the chat.
 */
export async function siblingsOf(
  db: Db,
  chatId: string,
  messageId: string,
): Promise<TreeRow[]> {
  const { data, error } = await db
    .from("chat_messages")
    .select("parent_message_id")
    .eq("chat_id", chatId)
    .eq("id", messageId)
    .maybeSingle();
  if (error || !data) {
    if (error) {
      console.error("[chat/tree] failed to load message", chatId, messageId, error);
    }
    return [];
  }
  return childrenOf(
    db,
    chatId,
    (data.parent_message_id as string | null) ?? null,
  );
}

/**
 * The stored prompt a re-answer names (`link_only_to_message_id`): a user
 * message of this chat whose content is still what the client sent. A
 * regenerate or an edited version re-streams it instead of inserting a copy,
 * so the new answer lands beside the old one. Where the reader's leaf sits does
 * not matter; the answer's reservation moves the leaf onto itself.
 */
export async function linkedPrompt(
  db: Db,
  chatId: string,
  messageId: string,
  content: unknown,
): Promise<{ id: string; parentMessageId: string | null } | null> {
  const { data, error } = await db
    .from("chat_messages")
    .select("role, content, parent_message_id")
    .eq("chat_id", chatId)
    .eq("id", messageId)
    .maybeSingle();
  if (error) {
    console.error("[chat/tree] failed to load linked prompt", chatId, messageId, error);
    return null;
  }
  if (data?.role !== "user") return null;
  if (JSON.stringify(data.content) !== JSON.stringify(content ?? null)) return null;
  return { id: messageId, parentMessageId: (data.parent_message_id as string | null) ?? null };
}
