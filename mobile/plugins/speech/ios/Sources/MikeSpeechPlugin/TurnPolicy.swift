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
        /// The answer to `checkSpeaker`: whether the speech is in the person's
        /// voice (true too when the check could not run).
        case speakerChecked(requestId: Int, match: Bool)
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
        /// The sent turn this one continues: `startMs` is that turn's start,
        /// so the final pass hears both, and `turn` replaces it.
        var continues: String? = nil
    }

    enum Decision: Equatable {
        case state(VoiceState)
        /// The person's live words for this turn (sent as `partial`).
        case partial(String)
        /// Run Smart Turn once on the turn's audio `fromMs..<toMs` (the engine
        /// keeps the last 8 s) and answer with `.smartTurn(requestId:)`.
        case runSmartTurn(requestId: Int, fromMs: Int, toMs: Int)
        /// Speech over the answer has the words for a barge-in: check that
        /// `fromMs..<toMs` is in the person's voice (the engine widens a short
        /// window to the last 1.5 s) and answer with `.speakerChecked`.
        /// Playback is held meanwhile.
        case checkSpeaker(requestId: Int, fromMs: Int, toMs: Int)
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
    /// Without echo cancellation a barge-in needs at least this many words.
    static let uncancelledBargeInWords = 3
    private static let answerRunLimit = 4000
    /// Set by the engine: false when the microphone has no echo cancellation
    /// (a Mac where it cannot start). The answer is then heard as it plays,
    /// so its words and fragments of them never count, sound alone does not
    /// hold playback, and more words are needed to barge in.
    var echoCancelled = true
    /// Set by the engine once the person's voice is learned: a barge-in is
    /// first checked against it, so a TV or another person cannot cut the
    /// answer off.
    var checksSpeaker = false
    /// After speech is found to be another voice, the next check waits this long.
    static let speakerRecheckMs = 1000
    /// After Smart Turn says "not done", it is asked again after this much more silence.
    static let smartTurnRecheckMs = 750
    /// Recognised sounds that are not words to barge in with (a cough or wind
    /// comes out of the EOU stream as these, or as single letters).
    static let fillers: Set<String> = ["uh", "um", "umm", "uhm", "uhh", "mm", "mmm", "hmm", "hm", "mhm", "ah", "ahh", "oh", "er", "eh", "huh", "ha"]
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
    /// Smart Turn said "not done": not asked again before this.
    private var nextEndCheckMs = 0
    private var eouPending = false
    /// The turn the person is continuing, if they took the floor back right
    /// after it was sent; its bounds while it is being finalised and answered.
    private var continuing: (turnId: String, startMs: Int)?
    private var committedBounds: (startMs: Int, endMs: Int)?
    private var answeredTurn: (turnId: String, startMs: Int, endMs: Int)?
    private var nextRequestId = 0
    private var pendingRequest: Int?

    // Speech over the assistant.
    private var runBaseline = 0
    private var clauseKeys: Set<String> = []
    private var previousClauseKeys: Set<String> = []
    /// The words of the turn being answered: the EOU stream's last ones
    /// arrive after the commit and must not count as a barge-in.
    private var committedKeys: Set<String> = []
    /// Every clause of the answer so far, as keys and run together (EOU
    /// fragments of echo like "chann" are pieces of these).
    private var answerKeys: Set<String> = []
    private var answerRun = ""
    private var paused = false
    private var falseStartSpent = false
    private var pendingSpeakerCheck: (id: Int, onset: Int, speechMs: Int)?
    private var nextSpeakerCheckMs = 0
    /// Another voice was heard over this answer: sound alone no longer holds
    /// playback (it would stutter through a whole TV programme).
    private var otherVoiceHeard = false
    /// What the last barge-in heard, for the engine's log.
    private(set) var lastBargeIn: (speechMs: Int, foreignWords: Int, text: String)?

    init(config: VoiceConfig = .defaults) {
        self.config = config
    }

    private var silenceThreshold: Float { max(0.01, config.vadThreshold - 0.15) }

    /// Speech starts here: higher while the answer is awaited or playing.
    private var onsetThreshold: Float {
        answerTurnId == nil ? config.vadThreshold : max(config.vadThreshold, config.bargeInVadThreshold)
    }

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
            if probability >= (inSpeech ? config.vadThreshold : onsetThreshold) {
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
            } else {
                // Not done (or no answer): ask again if the silence goes on.
                endCheckOpen = false
                nextEndCheckMs = nowMs + Self.smartTurnRecheckMs
            }
        case let .speakerChecked(requestId, match):
            guard let pending = pendingSpeakerCheck, pending.id == requestId else { break }
            pendingSpeakerCheck = nil
            guard let turnId = answerTurnId else { break }
            if match {
                bargeIn(turnId: turnId, onset: pending.onset, speechMs: pending.speechMs, &out)
            } else {
                // Its words are spent; speech still going counts afresh from here.
                otherVoiceHeard = true
                runBaseline = words.count
                runOnsetMs = inSpeech ? nowMs : nil
                falseStartSpent = true
                nextSpeakerCheckMs = nowMs + Self.speakerRecheckMs
                releasePause(&out)
            }
        case let .tick(now):
            nowMs = max(nowMs, now)
            evaluate(&out)
        case let .turnCommitted(turnId, text):
            guard phase == .finalizing else { break }
            phase = .thinking(turnId: turnId)
            answeredTurn = committedBounds.map { (turnId, $0.startMs, $0.endMs) }
            committedBounds = nil
            clauseKeys = []
            previousClauseKeys = []
            committedKeys = Set(VoiceWords.normalised(text))
            forgetAnswer()
            releasePause(&out)
            setState(.thinking, &out)
            evaluate(&out)
        case .turnDiscarded:
            guard phase == .finalizing else { break }
            committedBounds = nil
            returnToListening(&out)
        case let .clausePlaying(turnId, text):
            guard answerTurnId == turnId else { break }
            previousClauseKeys = clauseKeys
            let keys = VoiceWords.normalised(text)
            clauseKeys = Set(keys)
            answerKeys.formUnion(keys)
            answerRun = String((answerRun + keys.joined()).suffix(Self.answerRunLimit))
            if case .thinking = phase {
                phase = .speaking(turnId: turnId)
                setState(.speaking, &out)
            }
        case let .answerEnded(turnId):
            guard answerTurnId == turnId else { break }
            clauseKeys = []
            previousClauseKeys = []
            committedKeys = []
            forgetAnswer()
            answeredTurn = nil
            // A held answer must not leave the player paused for the next one.
            releasePause(&out)
            // Without echo cancellation, sound still going is the answer's own tail.
            if !echoCancelled { runOnsetMs = nil }
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
            nextEndCheckMs = 0
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
        nextEndCheckMs = 0
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
        guard phase == .userTurn, !endCheckOpen, !inSpeech, nowMs >= nextEndCheckMs, let start = utteranceStartMs else { return }
        endCheckOpen = true
        eouPending = false
        nextRequestId += 1
        pendingRequest = nextRequestId
        setState(.confirmingEnd, &out)
        out.append(.runSmartTurn(requestId: nextRequestId, fromMs: start, toMs: nowMs))
    }

    private mutating func commit(_ reason: CommitReason, endMs: Int, _ out: inout [Decision]) {
        guard let start = utteranceStartMs else { return }
        out.append(.commit(Commit(startMs: start, endMs: max(start, endMs), decidedAtMs: nowMs, reason: reason,
                                  continues: continuing?.turnId)))
        committedBounds = (start, max(start, endMs))
        continuing = nil
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
            guard key.count > 1, !Self.fillers.contains(key), !clauseKeys.contains(key), !previousClauseKeys.contains(key),
                  !committedKeys.contains(key) else { return count }
            if !echoCancelled, answerKeys.contains(key) || answerRun.contains(key) { return count }
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
            // Once a hold has come to nothing, sound going on (wind, traffic)
            // has had longer to throw up stray words: one more is needed.
            let needed = (echoCancelled ? config.bargeInWords : max(config.bargeInWords, Self.uncancelledBargeInWords))
                + (falseStartSpent ? 1 : 0)
            if enoughSpeech, foreignWordCount >= needed {
                guard checksSpeaker else {
                    bargeIn(turnId: turnId, onset: onset, speechMs: speechMs, &out)
                    return
                }
                guard pendingSpeakerCheck == nil, nowMs >= nextSpeakerCheckMs else { return }
                nextRequestId += 1
                pendingSpeakerCheck = (nextRequestId, onset, speechMs)
                if !paused, case .speaking = phase {
                    paused = true
                    out.append(.pausePlayback)
                }
                out.append(.checkSpeaker(requestId: nextRequestId, fromMs: onset, toMs: nowMs))
                return
            }
            if speechMs >= config.holdSpeechMs, inSpeech, !paused, !falseStartSpent, echoCancelled, !otherVoiceHeard, case .speaking = phase {
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

    private mutating func bargeIn(turnId: String, onset: Int, speechMs: Int, _ out: inout [Decision]) {
        lastBargeIn = (speechMs, foreignWordCount, words.dropFirst(runBaseline).joined(separator: " "))
        paused = false
        out.append(.bargeIn(turnId: turnId))
        clauseKeys = []
        previousClauseKeys = []
        committedKeys = []
        forgetAnswer()
        phase = .listening
        // Taking the floor back right after the turn was sent: the turn was
        // cut too soon. Hear it again from its start and send it whole.
        if let answered = answeredTurn, answered.turnId == turnId, config.continueMs > 0,
           onset - answered.endMs <= config.continueMs {
            continuing = (turnId, answered.startMs)
        }
        answeredTurn = nil
        beginUtterance(at: continuing?.startMs ?? onset, baseline: runBaseline, &out)
        // A run that already ended goes straight to its pause check.
        evaluate(&out)
    }

    /// Forgets everything about the answer that was playing or awaited.
    private mutating func forgetAnswer() {
        answerKeys = []
        answerRun = ""
        pendingSpeakerCheck = nil
        nextSpeakerCheckMs = 0
        otherVoiceHeard = false
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
