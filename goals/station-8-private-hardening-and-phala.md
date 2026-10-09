---
definition_version: 4
readiness: intent
---

# Station 8: Private Deployment Hardening & Phala TEE Lane

> **Incomplete — retained intent, not implementation authorization.** Original
> roadmap Phase 5. No station acceptance is established in the reviewed record.
> The stale review header and invalid acceptance recipes have been removed;
> source implementation and its limits are distinguished below. See
> [`TRIAGE.md`](TRIAGE.md) §3. [`STATUS.md`](STATUS.md) is the
> authoritative agenda; this scope may be promoted only after its authority,
> real starting state, acceptance and landing requirements are reconciled — an
> owner course decision, not an assistant default.

## Retained goal (desired)

Make privacy an enforceable deployment mode, not a UI claim: under
`STRICT_PRIVATE_MODE=true`, no privileged prompt or document token reaches an
unverified external endpoint; hosted providers, telemetry and unapproved
egress are refused fail-closed; confidential inference runs on
operator-controlled lanes (Phala CVM, local DGX Spark vLLM), with cryptographic
verification for any lane claimed as attested and a content-free audit receipt.
The original milestone is a private demo — a live matter workflow on private inference with a
usable UI, verified citations and honest attestation claims. Mobile and RLM are
not prerequisites for that demo.

## Constraints to preserve

- Fail closed: if attestation verification fails, the request fails
  immediately; never fall back to public cloud.
- Receipts and audit rows carry identity fields only — never prompt, response
  or system text.
- Zero prompt/document tokens to unverified external endpoints.
- Under strict mode, LLM/audio operator hosts are private/loopback or
  explicitly allowlisted (`PRIVATE_MODE_ALLOWED_EGRESS_HOSTS`).
- Excluded: developing custom hardware TEE microcode.

## Source implemented (inspected 2026-10-07)

- Boot gate (`lib/privateMode.ts`, wired in `app.ts`): literal `"true"` opt-in,
  requires `SENTRY_DISABLED=true`, forbids hosted cloud-provider credentials in
  the environment; startup fails otherwise.
- Request-time model allow-gate (`assertModelAllowed`) at the shared streaming
  resolution choke point and other model callers; the catalog refuses
  OpenRouter and Vercel with `private_mode_disabled`.
- Purpose-based egress policy (`lib/egress.ts`): `llm`/`audio` reach only
  private/loopback hosts or the allowlist; search-purpose checks delegate to
  the search gate (`lib/search/egress.ts`), which `fetchPage` uses. Backend
  Sentry is disabled under strict mode.
- Attestation plumbing (`lib/llm/attestation/`): the verifier GETs
  `{verifierUrl}/attestation`, parses JSON, and exact-string-compares the
  reported `measurement` against the pinned `expectedMeasurement`; unpinned
  declarations are rejected. It never throws; the transport fails the request
  loudly with no fallback lane. Content-free receipts (process-local ring, cap
  1000) are drained by the chat/project-chat/word-chat routes into
  `inference.attested` audit rows via `recordChatTurn`.

## Observed limits (dated audit observations, not runtime claims)

- Attestation is measurement string checking only — no quote parsing,
  signature verification, nonce freshness or TLS binding to the inference
  endpoint, so nothing proves the machine that served the request is the one
  the verifier described. It must not be described as cryptographic
  verification; cryptographic tampering rejection has not been proved.
- Strict mode does not yet gate search provider API calls, CourtListener,
  Google Workspace, MCP, the GitHub workflow catalog download, or frontend
  Sentry (backend Sentry is gated).
- No dedicated `inference_receipts` table exists. The `inference.attested`
  audit-event plumbing does exist and is the receipt path; absence of the
  table does not mean no receipt plumbing.
- No real Phala CVM or DGX endpoint has been exercised from this environment.
  Configured OpenAI-compatible endpoints exist, but owned-compute inference,
  TLS/trust configuration, limits and performance are unproved. The old file's
  sub-500 ms handshake claim was never measured and is removed.
- Unit tests exist at `lib/llm/attestation/__tests__/attestation.test.ts`,
  `__tests__/integration/strictPrivateMode.test.ts` and `lib/egress.test.ts`;
  they pin mocked source behavior, which is not station acceptance.

## Unresolved acceptance outcomes

- Real Phala CVM (or DGX-attested) endpoint passes with a pinned measurement,
  and quote/signature/nonce/TLS tampering fails closed — the gate before any
  "attested" claim.
- Deployed segmented-environment run proves enforcement of each remaining
  boundary above (settings alone do not), including operator-host allowlisting.
- Private demo: live matter workflow, private inference, usable UI, verified
  citations, owner-observed.

## Mapping

- Original Phase 5 → this station (`TRIAGE.md` numbering crosswalk; STATUS
  "Original Phase 5 / Station 8").
- TRIAGE outcomes: "Strict private mode and external boundaries", "Phala
  attestation and inference receipts", "DGX/local model and speech serving",
  "Private demo milestone".
- Proposed course C: private-demo/trust foundation (private inference/egress/
  telemetry enforcement, real DGX/Phala endpoints, cryptographic attestation if
  claimed, trustworthy audit, crash/restore proof). Privacy, RBAC and actor
  boundaries apply throughout; owner controls outbound access.
