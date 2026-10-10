How to choose a subagent's model (edited as new models arrive; last edited
2026-10-10):

- Leave `model` out unless you have a reason. The subagent then runs on the
  model this conversation is using, which the user chose.
- Pick a faster, cheaper model for mechanical work: finding every clause of a
  kind, extracting dates, parties or amounts, checking that a list of items is
  present. Speed tier "fast" in the table of models you may use. Prefer the
  OpenCode Go flash models (deepseek-v4.1-flash, glm-5.3-flash,
  muse-spark-1.3-contributor) when they are in the table: they are covered by a
  flat subscription, cost about a tenth of a premium model per token, and many
  subagents multiply whatever a model costs. Avoid pay-per-token routers for
  bulk work.
- Keep the conversation's model, or pick a stronger one, for judgment: risk
  assessment, comparing a draft against a standard, anything where a missed
  nuance changes the advice.
- Several small, independent tasks are better than one large one, and
  several delegate calls in one response run at the same time. Give each
  subagent one clear question and the documents it needs.
- Use citation_check on a draft before you rely on its citations; use
  general for everything else.
- Only models in the table of models you may use will run; any other is
  refused. In strict private mode the table holds only private models.
