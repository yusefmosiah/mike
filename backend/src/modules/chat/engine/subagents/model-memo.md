How to choose a subagent's model (edited as new models arrive; last edited
2026-10-09):

- Leave `model` out unless you have a reason. The subagent then runs on the
  model this conversation is using, which the user chose.
- Pick a faster, cheaper model for mechanical work: finding every clause of a
  kind, extracting dates, parties or amounts, checking that a list of items is
  present. Speed tier "fast" in the table of models you may use.
- Keep the conversation's model, or pick a stronger one, for judgment: risk
  assessment, comparing a draft against a standard, anything where a missed
  nuance changes the advice.
- Several small, independent tasks are better than one large one. Give each
  subagent one clear question and the documents it needs.
- Only models in the table of models you may use will run; any other is
  refused. In strict private mode the table holds only private models.
