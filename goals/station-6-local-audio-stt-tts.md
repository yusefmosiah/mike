---
definition_version: 4

readiness: drafted

review:
  reviewer: none
  frozen_ref: none
  verdict: none
  evidence_ref: none

start:
  captured_at: "2026-10-06T23:59:00Z"
  source:
    canonical_ref: 51fb62c64ee3e60dd66b885ad6c30f40ce72fae5
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard 51fb62c

finish:
  deliver: >-
    Provide local private audio speech-to-text dictation (STT/Whisper) and text-to-speech
    read-aloud (TTS) via OpenAI-compatible endpoints with UI composer mic capture and streaming playback.
  artifact: >-
    backend/src/modules/audio/ exposing POST /audio/transcriptions and POST /audio/speech,
    dictation controls in frontend ChatInput.tsx, and sentence playback in AssistantMessage.tsx.
  acceptance:
    - action: npm test --prefix backend -- src/modules/audio/__tests__/audio.routes.test.ts
      proves: Audio endpoints transcribe multipart audio and stream synthesized speech cleanly.
      evidence_class: local_test
    - action: curl -f -X POST http://localhost:3000/audio/transcriptions -F "file=@test.wav"
      proves: Audio proxy transcribes speech locally without external cloud telemetry.
      evidence_class: deployed_proof
  rollback: git checkout -- backend/src/modules/audio/ frontend/src/
  landing:
    required: true
    environment: local
    required_receipts: [pushed_commit, environment_identity, deployed_acceptance]

value:
  better_means: >-
    Enable private lawyer voice dictation and response read-aloud without leaking audio
    or transcripts to public cloud browser APIs.
  goodharting_would_be: >-
    Using unmanaged browser Web Speech APIs that secretly route client microphone audio
    to external OS cloud servers.

homotopy:
  realism_axis: >-
    From text-only keyboard interaction (low resolution) to
    ephemeral in-memory local STT and sentence-streamed local TTS proxies (high resolution).

boundaries:
  mutation_class: yellow
  authority_sources:
    - goals/private-firm-deployment-spine.md
  must_preserve:
    - Zero audio retention on disk (ephemeral memory buffer processing).
    - Dictation must populate the editable prompt box; never auto-submit.
  excluded:
    - Multi-speaker conversational diarization

now:
  status: pending
  slice: none
  source_ref: 51fb62c64ee3e60dd66b885ad6c30f40ce72fae5
  deploy_identity: local-docker-compose
  candidate:
    id: none
    state: none
    ref: none
    base: none
    digest: none
    scope: []
  conjecture:
    id: c-local-voice-ephemeral-privacy
    claim: >-
      Routing microphone audio through ephemeral in-memory server proxies prevents audio leakage
      while matching native dictation speeds.
    test: Live audio transcription test confirms zero disk artifacts and <1s latency on Whisper Turbo.
    edge: resource
    delta_o: Audio transcription latency benchmark on local container.
    scope_if_supported: Audio processing layer.
    status: proposed
    evidence_refs: []
  decision:
    what: Implement OpenAI-compatible /audio/transcriptions and /audio/speech endpoints.
    kind: architecture
    status: settled
    evidence_ref: user-prompt-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Dependent on Station 5.
    main_uncertainty: Riva vs Kokoro container packaging on local workstation.
    next_observation: Testing lightweight local TTS server container.
  blocker_or_risk: Blocked on completion of Station 5.
  next_action: Await Station 5 completion.

receipts: []
---

# Station 6: Local Audio STT & TTS Proxies

Builds local speech-to-text dictation and text-to-speech read-aloud endpoints without external cloud audio leakage.
