-- Migration date: 2026-10-20
-- Description: Record what a person heard of a spoken assistant answer.
--
-- In hands-free voice chat the person can interrupt an answer while it is
-- being read aloud. The full answer stays in `content` (the record, and what
-- the screen shows); `spoken_text` is the part that was read out before the
-- interruption and `interrupted_at` is when the interruption was recorded.
-- The next turn's model history replays an interrupted answer as its spoken
-- text, so the model knows what the person actually heard. Both columns are
-- nullable: an answer that was never interrupted has neither. Idempotent.
alter table if exists public.chat_messages
  add column if not exists spoken_text text;
alter table if exists public.chat_messages
  add column if not exists interrupted_at timestamptz;
