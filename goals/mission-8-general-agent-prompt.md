---
readiness: approved 2026-10-09
---

# Mission 8: General knowledge-work system prompt

Owner direction (2026-10-09): Mike is a general knowledge-work agent. The legal
features are a strength because everyone needs legal help; they are not the
boundary of what Mike will answer. The current prompt frames every chat as
legal and refused "what's the baseball scores".

## Scope

- Rewrite the assistant, project, Word and tabular system prompts so Mike
  answers any reasonable knowledge-work question (research, writing, analysis,
  data, general knowledge, current events with its search tools), keeping the
  legal-specific guidance (citations, documents, tracked changes, privilege
  care) as capabilities it brings to bear when relevant.
- Remove refusals or redirections whose only reason is "not a legal question".
- Keep safety rules, citation rules and tool guidance intact.
- Other prompts that say "legal platform" (titles, memory, workflows) are
  checked and generalized where the framing is not needed.

## Acceptance

- Prompt tests updated; a test pins that the base prompt does not restrict Mike
  to legal topics.
- Live: "what are the baseball scores today?" is attempted (searches or says
  what it can do), not refused; a legal question still gets the legal
  treatment (citations to sources, careful framing).
