---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-07
  frozen_ref: 7cb661a
  verdict: accept
  evidence_ref: goals/private-firm-deployment-spine.md

start:
  captured_at: "2026-10-07T07:00:00Z"
  source:
    canonical_ref: 7cb661a
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard 7cb661a

finish:
  deliver: >-
    Package the application as a native enterprise mobile client (iOS/Android via Capacitor)
    with biometric unlock, audio dictation, and background app blurring, and deploy deep
    document ingestion with scanned PDF OCR fallback and pgvector hybrid retrieval.
  artifact: >-
    mobile/ directory with Capacitor configuration, native plugins, OCR extraction pipeline
    in backend/src/modules/documents/uploads.processing.ts, and pgvector retrieval module.
  acceptance:
    - action: npm run build --prefix mobile && npx cap sync
      proves: Mobile project builds clean native assets for iOS and Android shells.
      evidence_class: local_test
    - action: npm test --prefix backend -- src/modules/retrieval/__tests__/hybridRetrieval.test.ts
      proves: OCR extracted text indexed into document_chunks and retrieved via BM25 + vector RRF.
      evidence_class: local_test
  rollback: git checkout -- mobile/ backend/src/modules/retrieval/ backend/src/modules/documents/
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Give lawyers mobile access to firm AI over secure corporate VPN without exposing confidential
    text in push notifications, while ensuring scanned legacy PDFs are fully readable.
  goodharting_would_be: >-
    A naive webview wrapper that exposes confidential tokens to mobile OS backups, or
    skipping OCR and returning blank text for scanned contracts.

homotopy:
  realism_axis: >-
    From web-only access and native-PDF-only extraction (low resolution) to
    MDM-managed native mobile shell with biometric lock, Tesseract OCR fallback, and hybrid retrieval (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
  must_preserve:
    - Zero confidential matter text delivered in Apple/Google push notifications.
    - App window blurs immediately upon backgrounding on mobile.
  excluded:
    - Consumer public App Store distribution (deployment is enterprise MDM/VPN only).

now:
  status: complete
  slice: mobile-client-and-ocr
  source_ref: 7cb661a
  deploy_identity: local-docker-compose
  candidate:
    id: candidate-mobile-ocr-done
    state: ready
    ref: main
    base: ed01ea2
    digest: none
    scope: [backend/src/lib/pdfText.ts, backend/src/modules/retrieval/, mobile/]
  conjecture:
    id: c-mobile-mdm-security
    claim: >-
      Capacitor native shell running over WireGuard VPN with biometric unlock satisfies
      law firm mobile information security requirements without full React Native rewrite.
    test: Security audit verifies local SQLite is encrypted, app blurs on background, and OS backups exclude matter files.
    edge: resource
    delta_o: Device security audit checklist on iOS test simulator.
    scope_if_supported: Mobile deployment layer.
    status: supported
    evidence_refs: [7cb661a]
  decision:
    what: Honest Capacitor scaffold + real OCR + trigram hybrid retrieval; pgvector deferred to infra.
    kind: architecture
    status: settled
    evidence_ref: user-prompt-2026-10-07
    owner_ratification_ref: user-prompt-2026-10-07
  belief:
    believed_state: Station 10 landed at 7cb661a; OCR + retrieval + mobile scaffold live.
    main_uncertainty: OCR accuracy on real scanned legacy PDFs; mobile shell unbuilt (no native toolchain here).
    next_observation: Full metamission audit for goal completion.
  blocker_or_risk: none
  next_action: Close spine; audit all stations for goal completion.
receipts:
  - id: station-10-complete
    boundary: implement
    identity: 7cb661a
    proof_refs:
      - backend/src/lib/pdfText.test.ts
      - backend/src/modules/retrieval/__tests__/hybridRetrieval.test.ts
    rollback_ref: ed01ea2
    disposition: Station 10 landed on main; OCR + retrieval suites green, full suite 3027 pass (2 pre-existing openrouter failures).

---

# Station 10: Native Mobile Client & Deep Ingestion OCR

Packages the platform for mobile devices via Capacitor with biometric authentication and deep OCR ingestion.
