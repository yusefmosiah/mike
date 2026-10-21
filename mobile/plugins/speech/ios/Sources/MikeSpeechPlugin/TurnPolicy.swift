import Foundation

/// Endpointing, barge-in and false starts for voice mode, as a pure value
/// driven by timestamped events (docs/voice-chat.md, "Listening" and "Echo
/// and barge-in"). It owns no audio and no models: the engine feeds it what
/// the models saw and carries out what it decides, and tests replay recorded
/// or synthetic event traces through it.
///
/// Time is milliseconds of microphone audio since voice mode started (the
/// 16 kHz sample count), so a trace replays identically however fast it is fed.
struct TurnPolicy {
    enum Input: Equatable {
        /// One Silero VAD frame covering `startMs..<endMs` (256 ms in FluidAudio 0.17.7).
        case vad(probability: Float, startMs: Int, endMs: Int)
        /// The EOU stream's whole text since the last commit (lower case, no punctuation).
        case partial(text: String)
        /// The EOU model emitted `<EOU>` at `atMs`: a candidate end, never an end on its own.
        case eou(atMs: Int)
        /// Smart Turn's answer to `runSmartTurn` (nil: it could not run).
        case smartTurn(requestId: Int, probability: Float?)
        /// The clock moved (sent with every microphone buffer).
        case tick(nowMs: Int)
        /// The final pass produced `text` and `turn` was sent: the answer is awaited.
        case turnCommitted(turnId: String, text: String = "")
        /// The final pass found nothing to send (a cough, a door): back to listening.
        case turnDiscarded
        /// A clause of `turnId`'s answer started playing.
        case clausePlaying(turnId: String, text: String)
        /// `turnId`'s answer finished playing, or was cancelled by the web app.
        case answerEnded(turnId: String)
    }

    enum CommitReason: String, Equatable {
        case smartTurn
        case maxSilence
        case maxTurn
    }

    struct Commit: Equatable {
        /// The utterance as VAD bounds it (the engine pads it for the final pass).
        let startMs: Int
        let endMs: Int
        /// When the decision was made, for `endOfSpeechToCommit`.
        let decidedAtMs: Int
        let reason: CommitReason
    }

    enum Decision: Equatable {
        case state(VoiceState)
        /// The person's live words for this turn (sent as `partial`).
        case partial(String)
        /// Run Smart Turn once on the turn's audio `fromMs..<toMs` (the engine
        /// keeps the last 8 s) and answer with `.smartTurn(requestId:)`.
        case runSmartTurn(requestId: Int, fromMs: Int, toMs: Int)
        /// The turn is over: run the final pass and send `turn`. The engine
        /// also clears the EOU stream's text, as the policy now has.
        case commit(Commit)
        /// The person spoke over `turnId`'s answer: stop it and keep listening.
        case bargeIn(turnId: String)
        /// Forget the EOU stream's text: nothing in it can matter any more (no
        /// turn is open and no speech run is live), or it has grown past
        /// `maxHeldWords` outside the person's turn. Keeps memory bounded over
        /// a long conversation of echo and background speech.
        case clearTranscript
        /// Speech while the answer plays, words not yet confirmed: hold playback.
        case pausePlayback
        /// No words came within `falseStartMs`: carry on speaking.
        case resumePlayback
    }

    private enum Phase: Equatable {
        case listening
        /// The person has the floor: speaking, pausing, or being checked for an end.
        case userTurn
        /// Committed; the final pass is running.
        case finalizing
        case thinking(turnId: String)
        case speaking(turnId: String)
    }

    let config: VoiceConfig
    /// Outside the person's turn the transcript is cleared beyond this.
    static let maxHeldWords = 200
    private(set) var state: VoiceState = .listening
    private var phase: Phase = .listening
    private var nowMs = 0

    // VAD with hysteresis: speech at the threshold, silence only below
    // threshold − 0.15 (Silero's own offset).
    private(set) var inSpeech = false
    private var runOnsetMs: Int?
    private var lastSpeechEndMs = 0
    private var silenceStartMs: Int?

    // The EOU text since the last commit, as words.
    private var words: [String] = []

    // The person's turn.
    private var utteranceStartMs: Int?
    private var utteranceBaseline = 0
    private var lastPartialSent = ""
    private var endCheckOpen = false
    private var eouPending = false
    private var nextRequestId = 0
    private var pendingRequest: Int?

    // Speech over the assistant.
    private var runBaseline = 0
    private var clauseKeys: Set<String> = []
    private var previousClauseKeys: Set<String> = []
    /// The words of the turn being answered: the EOU stream's last ones
    /// arrive after the commit and must not count as a barge-in.
    private var committedKeys: Set<String> = []
    private var paused = false
    private var falseStartSpent = false
    /// What the last barge-in heard, for the engine's log.
    private(set) var lastBargeIn: (speechMs: Int, foreignWords: Int, text: String)?

    init(config: VoiceConfig = .defaults) {
        self.config = config
    }

    private var silenceThreshold: Float { max(0.01, config.vadThreshold - 0.15) }

    /// The turn whose answer is pending or playing, if any.
    var answerTurnId: String? {
        switch phase {
        case let .thinking(turnId), let .speaking(turnId): return turnId
        default: return nil
        }
    }

    mutating func handle(_ input: Input) -> [Decision] {
        var out: [Decision] = []
        switch input {
        case let .vad(probability, startMs, endMs):
            nowMs = max(nowMs, endMs)
            if probability >= config.vadThreshold {
                silenceStartMs = nil
                lastSpeechEndMs = endMs
                if !inSpeech {
                    inSpeech = true
                    speechStarted(at: startMs, &out)
                }
            } else if probability < silenceThreshold {
                if inSpeech {
                    inSpeech = false
                    silenceStartMs = startMs
                    if phase == .userTurn, eouPending { openEndCheck(&out) }
                }
            } else if inSpeech {
                lastSpeechEndMs = endMs
            }
            evaluate(&out)
            trimTranscript(&out)
        case let .partial(text):
            let updated = text.split(whereSeparator: \.isWhitespace).map(String.init)
            guard updated != words else { break }
            words = updated
            if phase == .userTurn { sendPartial(&out) }
            evaluate(&out)
            trimTranscript(&out)
        case let .eou(atMs):
            nowMs = max(nowMs, atMs)
            guard phase == .userTurn else { break }
            if inSpeech { eouPending = true } else { openEndCheck(&out) }
        case let .smartTurn(requestId, probability):
            guard phase == .userTurn, pendingRequest == requestId else { break }
            pendingRequest = nil
            guard !inSpeech, let silence = silenceStartMs else { break }
            if let probability, probability >= config.smartTurnThreshold {
                commit(.smartTurn, endMs: silence, &out)
            }
        case let .tick(now):
            nowMs = max(nowMs, now)
            evaluate(&out)
        case let .turnCommitted(turnId, text):
            guard phase == .finalizing else { break }
            phase = .thinking(turnId: turnId)
            clauseKeys = []
            previousClauseKeys = []
            committedKeys = Set(VoiceWords.normalised(text))
            releasePause(&out)
            setState(.thinking, &out)
            evaluate(&out)
        case .turnDiscarded:
            guard phase == .finalizing else { break }
            returnToListening(&out)
        case let .clausePlaying(turnId, text):
            guard answerTurnId == turnId else { break }
            previousClauseKeys = clauseKeys
            clauseKeys = Set(VoiceWords.normalised(text))
            if case .thinking = phase {
                phase = .speaking(turnId: turnId)
                setState(.speaking, &out)
            }
        case let .answerEnded(turnId):
            guard answerTurnId == turnId else { break }
            clauseKeys = []
            previousClauseKeys = []
            committedKeys = []
            // A held answer must not leave the player paused for the next one.
            releasePause(&out)
            returnToListening(&out)
        }
        return out
    }

    // MARK: - The person's turn

    private mutating func speechStarted(at startMs: Int, _ out: inout [Decision]) {
        runOnsetMs = startMs
        runBaseline = words.count
        falseStartSpent = false
        switch phase {
        case .listening:
            beginUtterance(at: startMs, baseline: words.count, &out)
        case .userTurn:
            // Speech resumed: whatever check was open is moot.
            endCheckOpen = false
            eouPending = false
            pendingRequest = nil
            setState(.userSpeaking, &out)
        case .finalizing, .thinking, .speaking:
            break
        }
    }

    private mutating func beginUtterance(at startMs: Int, baseline: Int, _ out: inout [Decision]) {
        phase = .userTurn
        utteranceStartMs = startMs
        utteranceBaseline = min(baseline, words.count)
        lastPartialSent = ""
        endCheckOpen = false
        eouPending = false
        pendingRequest = nil
        setState(.userSpeaking, &out)
        sendPartial(&out)
    }

    private mutating func returnToListening(_ out: inout [Decision]) {
        phase = .listening
        // Someone already speaking when the answer ends has the floor.
        if inSpeech, let onset = runOnsetMs {
            beginUtterance(at: onset, baseline: runBaseline, &out)
        } else {
            setState(.listening, &out)
        }
    }

    private mutating func openEndCheck(_ out: inout [Decision]) {
        guard phase == .userTurn, !endCheckOpen, !inSpeech, let start = utteranceStartMs else { return }
        endCheckOpen = true
        eouPending = false
        nextRequestId += 1
        pendingRequest = nextRequestId
        setState(.confirmingEnd, &out)
        out.append(.runSmartTurn(requestId: nextRequestId, fromMs: start, toMs: nowMs))
    }

    private mutating func commit(_ reason: CommitReason, endMs: Int, _ out: inout [Decision]) {
        guard let start = utteranceStartMs else { return }
        out.append(.commit(Commit(startMs: start, endMs: max(start, endMs), decidedAtMs: nowMs, reason: reason)))
        phase = .finalizing
        utteranceStartMs = nil
        endCheckOpen = false
        eouPending = false
        pendingRequest = nil
        lastPartialSent = ""
        // The engine clears the EOU stream's text with the commit.
        words = []
        utteranceBaseline = 0
        runBaseline = 0
        // The committed speech is not a barge-in candidate (its last words can
        // still arrive from the EOU stream after the commit); speech that runs
        // on past a cut (maxTurn) counts as a new run from here.
        runOnsetMs = inSpeech ? nowMs : nil
        if state != .confirmingEnd { setState(.confirmingEnd, &out) }
    }

    private mutating func sendPartial(_ out: inout [Decision]) {
        let text = words.dropFirst(utteranceBaseline).joined(separator: " ")
        guard text != lastPartialSent else { return }
        lastPartialSent = text
        out.append(.partial(text))
    }

    // MARK: - Timers and barge-in

    private mutating func evaluate(_ out: inout [Decision]) {
        switch phase {
        case .userTurn:
            guard let start = utteranceStartMs else { return }
            if nowMs - start >= config.maxTurnMs {
                commit(.maxTurn, endMs: inSpeech ? nowMs : (silenceStartMs ?? nowMs), &out)
            } else if !inSpeech, let silence = silenceStartMs {
                if nowMs - silence >= config.maxSilenceMs {
                    commit(.maxSilence, endMs: silence, &out)
                } else if nowMs - silence >= config.pauseMs {
                    openEndCheck(&out)
                }
            }
        case let .thinking(turnId), let .speaking(turnId):
            evaluateBargeIn(turnId: turnId, &out)
        case .listening, .finalizing:
            break
        }
    }

    /// Words of the current speech run that the assistant is not saying: they
    /// are not in the clause playing, nor in the one before it (its echo can
    /// still be arriving through the EOU stream's half-second of lag), nor in
    /// the person's own turn being answered (its last words lag the commit).
    private var foreignWordCount: Int {
        words.dropFirst(runBaseline).reduce(0) { count, word in
            let key = VoiceWords.normalised(word).joined()
            guard !key.isEmpty, !clauseKeys.contains(key), !previousClauseKeys.contains(key),
                  !committedKeys.contains(key) else { return count }
            return count + 1
        }
    }

    private mutating func evaluateBargeIn(turnId: String, _ out: inout [Decision]) {
        guard let onset = runOnsetMs else { return }
        let sinceOnset = nowMs - onset
        // Words lag the audio, so a run that has just ended still counts until
        // the false-start window closes.
        let runLive = inSpeech || sinceOnset < config.falseStartMs
        if runLive {
            let speechMs = (inSpeech ? lastSpeechEndMs : (silenceStartMs ?? lastSpeechEndMs)) - onset
            let enoughSpeech = speechMs >= config.bargeInSpeechMs
            if enoughSpeech, foreignWordCount >= config.bargeInWords {
                lastBargeIn = (speechMs, foreignWordCount, words.dropFirst(runBaseline).joined(separator: " "))
                paused = false
                out.append(.bargeIn(turnId: turnId))
                clauseKeys = []
                previousClauseKeys = []
                committedKeys = []
                phase = .listening
                beginUtterance(at: onset, baseline: runBaseline, &out)
                // A run that already ended goes straight to its pause check.
                evaluate(&out)
                return
            }
            if enoughSpeech, inSpeech, !paused, !falseStartSpent, case .speaking = phase {
                paused = true
                out.append(.pausePlayback)
            }
        }
        if paused, sinceOnset >= config.falseStartMs {
            paused = false
            falseStartSpent = true
            out.append(.resumePlayback)
        }
    }

    private mutating func releasePause(_ out: inout [Decision]) {
        guard paused else { return }
        paused = false
        out.append(.resumePlayback)
    }

    private mutating func trimTranscript(_ out: inout [Decision]) {
        guard !words.isEmpty else { return }
        switch phase {
        case .userTurn, .finalizing:
            return  // bounded by maxTurnMs and cleared at the commit
        case .listening, .thinking, .speaking:
            let runLive = inSpeech || (runOnsetMs.map { nowMs - $0 < config.falseStartMs } ?? false)
            guard !runLive || words.count > Self.maxHeldWords else { return }
        }
        words = []
        runBaseline = 0
        utteranceBaseline = 0
        out.append(.clearTranscript)
    }

    private mutating func setState(_ next: VoiceState, _ out: inout [Decision]) {
        guard next != state else { return }
        state = next
        out.append(.state(next))
    }
}
