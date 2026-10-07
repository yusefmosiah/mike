---
definition_version: 4

readiness: drafted

review:
  reviewer: none
  frozen_ref: none
  verdict: none
  evidence_ref: none

start:
  captured_at: "2026-10-06T22:00:00Z"
  source:
    canonical_ref: e5d6bc8f4f3780f2d90d3d5fba40e0dd1dca2d8a
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard e5d6bc8

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
  status: pending
  slice: none
  source_ref: e5d6bc8f4f3780f2d90d3d5fba40e0dd1dca2d8a
  deploy_identity: local-docker-compose
  candidate:
    id: none
    state: none
    ref: none
    base: none
    digest: none
    scope: []
  conjecture:
    id: c-mobile-mdm-security
    claim: >-
      Capacitor native shell running over WireGuard VPN with biometric unlock satisfies
      law firm mobile information security requirements without full React Native rewrite.
    test: Security audit verifies local SQLite is encrypted, app blurs on background, and OS backups exclude matter files.
    edge: resource
    delta_o: Device security audit checklist on iOS test simulator.
    scope_if_supported: Mobile deployment layer.
    status: proposed
    evidence_refs: []
  decision:
    what: Use Capacitor wrapper for shared React codebase and distribute via internal enterprise MDM.
    kind: architecture
    status: settled
    evidence_ref: private-ai-briefing
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Dependent on Station 7.
    main_uncertainty: Mobile microphone audio format compatibility with local STT proxy.
    next_observation: Testing Capacitor voice recording plugin against /audio/transcriptions.
  blocker_or_risk: Blocked on completion of Station 7.
  next_action: Await Station 7 completion.

receipts: []
---

# Station 8: Native Mobile Client & Deep Ingestion OCR

Packages the platform for mobile devices via Capacitor with biometric authentication and deep OCR ingestion.
