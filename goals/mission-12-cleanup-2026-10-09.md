---
readiness: approved 2026-10-09
---

# Mission 12: Cleanup — tests, live reconnect, docs

Owner-approved overnight work (2026-10-09). Small, independent fixes that make
the suites trustworthy and the docs current.

## Scope

1. **React update-depth failure.** `e2e/assistant-streaming.spec.ts` (synthetic
   project) fails "Maximum update depth exceeded" on the first follow-up in long
   assistant and project conversations. Find the effect loop and fix it.
2. **DOCX corpus timeouts.** `edit.corpus.test.ts` and `package.corpus.test.ts`
   pass alone and time out under the full backend run. Make the default
   `npm test` reliable without hiding real slowness.
3. **Live reconnect after a restart.** An open chat panel, project chat, review
   chat or Word pane whose stream dies because the backend restarted should
   re-attach to the resumed turn when the server returns, not only on reload.
   Today the clients retry twice within ~1.2 s and give up.
4. **Local e2e models.** The e2e account has no configured model, so creating a
   tabular review shows "No models available". Give the local e2e setup a
   configured model without editing `backend/.env`.
5. **Docs.** STATUS.md (done first), `docs/backend-architecture.md` and any doc
   still describing pre-Pi or Supabase behaviour.

## Acceptance

- `npm run test:e2e:local` passes the streaming specs that failed; the tabular
  create spec passes.
- Full `npm test --prefix backend` passes at default concurrency, three runs.
- A client attached to a turn when the backend is killed and restarted shows
  the finished answer without a reload (unit test of the retry policy, plus a
  live kill/restart probe).
