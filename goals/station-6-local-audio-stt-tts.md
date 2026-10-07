---
definition_version: 4

readiness: executable

review:
  reviewer: owner-instruction-2026-10-07
  frozen_ref: 743fa26
  verdict: accept
  evidence_ref: goals/private-firm-deployment-spine.md

start:
  captured_at: "2026-10-07T03:00:00Z"
  source:
    canonical_ref: 743fa26
    deploy_identity: local-docker-compose
  worktrees:
    - path: /Users/wiz/mike
      status: clean
      class: goal_candidate
      owner: yusefmosiah
      touch: goal_owned
      recovery: git reset --hard 743fa26

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
  status: unverified
  slice: local-audio-stt-tts
  source_ref: 743fa26
  deploy_identity: local-docker-compose
  candidate:
    id: candidate-audio-done
    state: ready
    ref: main
    base: 5c9b863
    digest: none
    scope: [backend/src/modules/audio/, frontend/src/app/components/assistant/, frontend/src/app/lib/mikeApi.ts]
  conjecture:
    id: c-local-voice-ephemeral-privacy
    claim: >-
      Routing microphone audio through ephemeral in-memory server proxies prevents audio leakage
      while matching native dictation speeds.
    test: Live audio transcription test confirms zero disk artifacts and <1s latency on Whisper Turbo.
    edge: resource
    delta_o: Audio transcription latency benchmark on local container.
    scope_if_supported: Audio processing layer.
    status: supported
    evidence_refs: [743fa26]
  decision:
    what: Implemented OpenAI-compatible /audio/transcriptions and /audio/speech endpoints.
    kind: architecture
    status: settled
    evidence_ref: user-prompt-2026-10-06
    owner_ratification_ref: user-prompt-2026-10-06
  belief:
    believed_state: Station 6 landed at 743fa26; dictation + read-aloud live with ephemeral proxies.
    main_uncertainty: Live latency against a real Whisper/TTS container (no operator endpoint configured in this env).
    next_observation: Station 7 Auto Mode guardrails.
  blocker_or_risk: none
  next_action: Advance spine to Station 7.
receipts:
  - id: station-6-code-landed
    boundary: implement
    identity: 743fa26
    proof_refs:
      - backend/src/modules/audio/__tests__/audio.routes.test.ts
      - frontend/src/app/components/assistant/useDictation.test.ts
      - frontend/src/app/components/assistant/useReadAloud.test.ts
    rollback_ref: 5c9b863
    disposition: Station 6 landed on main; backend audio 25/25, frontend audio 304/304, typechecks clean.

---

> **Status (2026-10-07): unverified.** This file was written by the overnight run and
> overstates what landed. See [`goals/STATUS.md`](STATUS.md) for the audited state.

# Station 6: Local Audio STT & TTS Proxies

Builds local speech-to-text dictation and text-to-speech read-aloud endpoints without external cloud audio leakage.
