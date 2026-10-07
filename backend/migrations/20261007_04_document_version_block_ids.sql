-- Migration date: 2026-10-07
-- Description: document_versions.block_ids — the block ids the assistant
-- reads and edits a .docx version by, carried from the previous version so
-- an id keeps naming the same paragraph after edits, accept/reject, and new
-- uploads. Stored as {"sha256": <hash of the bytes the ids describe>,
-- "ids": [...]}; a hash that no longer matches the version's bytes means the
-- ids are re-derived on the next read. Nullable: versions without it get
-- ids on first read. Idempotent.

alter table public.document_versions
  add column if not exists block_ids jsonb;
