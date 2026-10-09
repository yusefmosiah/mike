-- Migration date: 2026-10-09
-- Description: Let a user choose the model that judges Auto Mode tool calls.
--
-- Null keeps the default: the on-route classifier on the conversation's own
-- model. "openrouter-decisions/<catalog id>" names an OpenRouter decision
-- model (lib/guardrails/decisions.ts). Idempotent.
alter table if exists public.user_profiles
  add column if not exists auto_mode_decision_model text;
