import XCTest
@testable import MikeSpeechPlugin

/// Replays synthetic event traces through the turn policy: VAD frames of
/// 256 ms (FluidAudio's Silero block), EOU partials and candidates, Smart Turn
/// answers and the clock, as the engine would feed them.
private struct Trace {
    static let frame = 256
    var policy: TurnPolicy
    var now = 0
    var log: [TurnPolicy.Decision] = []

    init(_ config: VoiceConfig = .defaults) {
        policy = TurnPolicy(config: config)
    }

    @discardableResult
    mutating func feed(_ input: TurnPolicy.Input) -> [TurnPolicy.Decision] {
        let out = policy.handle(input)
        log += out
        return out
    }

    /// `count` VAD frames at `probability`, each followed by a clock tick.
    @discardableResult
    mutating func frames(_ probability: Float, _ count: Int) -> [TurnPolicy.Decision] {
        var out: [TurnPolicy.Decision] = []
        for _ in 0..<count {
            let start = now
            now += Self.frame
            out += feed(.vad(probability: probability, startMs: start, endMs: now))
            out += feed(.tick(nowMs: now))
        }
        return out
    }

    @discardableResult mutating func speech(_ count: Int) -> [TurnPolicy.Decision] { frames(0.9, count) }
    @discardableResult mutating func silence(_ count: Int) -> [TurnPolicy.Decision] { frames(0.05, count) }

    /// Clock ticks of 10 ms (no VAD frame) up to `ms`.
    @discardableResult
    mutating func tick(until ms: Int) -> [TurnPolicy.Decision] {
        var out: [TurnPolicy.Decision] = []
        while now < ms {
            now = min(ms, now + 10)
            out += feed(.tick(nowMs: now))
        }
        return out
    }

    @discardableResult mutating func partial(_ text: String) -> [TurnPolicy.Decision] { feed(.partial(text: text)) }

    static func smartTurnRequests(_ decisions: [TurnPolicy.Decision]) -> [(id: Int, from: Int, to: Int)] {
        decisions.compactMap { if case let .runSmartTurn(id, from, to) = $0 { return (id, from, to) } else { return nil } }
    }

    static func commits(_ decisions: [TurnPolicy.Decision]) -> [TurnPolicy.Commit] {
        decisions.compactMap { if case let .commit(commit) = $0 { return commit } else { return nil } }
    }

    static func states(_ decisions: [TurnPolicy.Decision]) -> [VoiceState] {
        decisions.compactMap { if case let .state(state) = $0 { return state } else { return nil } }
    }

    /// Speaks one turn, has it committed and answered as `turnId`.
    mutating func committedTurn(_ turnId: String) {
        speech(4)
        partial("what does clause four say")
        let out = silence(1)
        guard let request = Self.smartTurnRequests(out).first else { return }
        feed(.smartTurn(requestId: request.id, probability: 0.9))
        feed(.turnCommitted(turnId: turnId))
    }
}

final class TurnPolicyTests: XCTestCase {
    // MARK: - End of turn

    func testSmartTurnAtThresholdCommitsTheVadBoundedUtterance() {
        var trace = Trace()
        let onset = trace.speech(1)
        XCTAssertEqual(Trace.states(onset), [.userSpeaking])
        trace.speech(3)
        XCTAssertEqual(trace.partial("hello there"), [.partial("hello there")])
        let pause = trace.silence(1)
        XCTAssertEqual(Trace.states(pause), [.confirmingEnd])
        let requests = Trace.smartTurnRequests(pause)
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.from, 0)
        XCTAssertEqual(requests.first?.to, 1280)
        let decided = trace.feed(.smartTurn(requestId: requests[0].id, probability: 0.5))
        XCTAssertEqual(Trace.commits(decided), [TurnPolicy.Commit(startMs: 0, endMs: 1024, decidedAtMs: 1280, reason: .smartTurn)])
    }

    func testBelowTheThresholdKeepsListeningUntilMaxSilence() {
        var trace = Trace()
        trace.speech(4)
        let pause = trace.silence(1)
        let request = Trace.smartTurnRequests(pause)[0]
        XCTAssertTrue(trace.feed(.smartTurn(requestId: request.id, probability: 0.49)).isEmpty)
        // 2000 ms of silence counted from where speech stopped (1024 ms).
        let waiting = trace.silence(7)  // up to 3072: 2048 ms of silence
        XCTAssertEqual(Trace.commits(waiting), [TurnPolicy.Commit(startMs: 0, endMs: 1024, decidedAtMs: 3072, reason: .maxSilence)])
        XCTAssertTrue(Trace.smartTurnRequests(waiting).isEmpty, "one Smart Turn run per pause")
    }

    func testWithoutSmartTurnTheTurnStillEndsAtMaxSilence() {
        var trace = Trace()
        trace.speech(2)
        let pause = trace.silence(1)
        trace.feed(.smartTurn(requestId: Trace.smartTurnRequests(pause)[0].id, probability: nil))
        let out = trace.tick(until: 512 + 2000)
        XCTAssertEqual(Trace.commits(out).first?.reason, .maxSilence)
        XCTAssertEqual(Trace.commits(out).first?.decidedAtMs, 2512)
    }

    func testSpeechResumingAfterAPauseCancelsTheCheckAndIgnoresItsLateAnswer() {
        var trace = Trace()
        trace.speech(3)
        let pause = trace.silence(1)
        let first = Trace.smartTurnRequests(pause)[0]
        let resumed = trace.speech(2)
        XCTAssertEqual(Trace.states(resumed), [.userSpeaking])
        XCTAssertTrue(trace.feed(.smartTurn(requestId: first.id, probability: 0.99)).isEmpty, "a stale answer must not end the turn")
        let second = Trace.smartTurnRequests(trace.silence(1))
        XCTAssertEqual(second.count, 1)
        XCTAssertGreaterThan(second[0].id, first.id)
        XCTAssertEqual(second[0].from, 0, "the check covers the whole turn so far")
        let commit = Trace.commits(trace.feed(.smartTurn(requestId: second[0].id, probability: 0.8)))
        XCTAssertEqual(commit.first?.startMs, 0)
        XCTAssertEqual(commit.first?.endMs, 1536)
    }

    func testEouDuringSpeechOpensTheCheckAtTheFirstSilentFrameEvenBeforePauseMs() {
        var config = VoiceConfig.defaults
        config.pauseMs = 1000
        var trace = Trace(config)
        trace.speech(3)
        // Without a candidate the first silent frame does not open the check.
        var control = Trace(config)
        control.speech(3)
        XCTAssertTrue(Trace.smartTurnRequests(control.silence(1)).isEmpty)

        XCTAssertTrue(trace.feed(.eou(atMs: 700)).isEmpty, "<EOU> while VAD hears speech only waits")
        let pause = trace.silence(1)
        XCTAssertEqual(Trace.smartTurnRequests(pause).count, 1)
        XCTAssertEqual(Trace.states(pause), [.confirmingEnd])
    }

    func testEouInSilenceOpensTheCheckAtOnceAndOnlyOncePerPause() {
        var config = VoiceConfig.defaults
        config.pauseMs = 1000
        var trace = Trace(config)
        trace.speech(3)
        XCTAssertTrue(Trace.smartTurnRequests(trace.silence(1)).isEmpty)
        let candidate = trace.feed(.eou(atMs: trace.now))
        XCTAssertEqual(Trace.smartTurnRequests(candidate).count, 1)
        XCTAssertTrue(trace.feed(.eou(atMs: trace.now + 20)).isEmpty)
        XCTAssertTrue(Trace.smartTurnRequests(trace.silence(3)).isEmpty, "the pause itself does not run it again")
    }

    func testEouOutsideThePersonsTurnIsIgnored() {
        var trace = Trace()
        XCTAssertTrue(trace.feed(.eou(atMs: 100)).isEmpty)
        trace.committedTurn("t1")
        XCTAssertTrue(trace.feed(.eou(atMs: trace.now)).isEmpty)
    }

    func testALongTurnIsCutAtMaxTurnMs() {
        var config = VoiceConfig.defaults
        config.maxTurnMs = 3000
        var trace = Trace(config)
        let out = trace.speech(12)
        let commits = Trace.commits(out)
        XCTAssertEqual(commits.count, 1)
        XCTAssertEqual(commits[0].reason, .maxTurn)
        XCTAssertEqual(commits[0].startMs, 0)
        XCTAssertEqual(commits[0].endMs, 3072, "cut where the audio is, the person still speaking")
    }

    func testHysteresisKeepsSpeechThroughADipAboveThresholdMinusOffset() {
        var trace = Trace()
        trace.speech(2)
        XCTAssertTrue(trace.frames(0.4, 3).isEmpty, "0.4 is above 0.5 - 0.15: still speech")
        XCTAssertTrue(trace.policy.inSpeech)
        let low = trace.frames(0.3, 1)
        XCTAssertFalse(trace.policy.inSpeech)
        XCTAssertEqual(Trace.smartTurnRequests(low).count, 1)
    }

    func testNoiseBelowThresholdNeverStartsATurn() {
        var trace = Trace()
        XCTAssertTrue(trace.frames(0.45, 20).isEmpty)
        XCTAssertEqual(trace.policy.state, .listening)
    }

    func testPartialsCarryOnlyThisTurnsWordsAndStopAtCommit() {
        var trace = Trace()
        // Words decoded before speech began (a TV) are not this turn's: they
        // are cleared from the EOU stream at once.
        XCTAssertEqual(trace.partial("and now the weather"), [.clearTranscript])
        trace.speech(1)
        let shown = trace.partial("is the lease signed")
        XCTAssertEqual(shown, [.partial("is the lease signed")])
        let pause = trace.silence(1)
        trace.feed(.smartTurn(requestId: Trace.smartTurnRequests(pause)[0].id, probability: 0.9))
        // After the commit the engine clears the EOU text; nothing is shown while thinking.
        trace.feed(.turnCommitted(turnId: "t1"))
        XCTAssertFalse(trace.partial("echo of the answer").contains { if case .partial = $0 { return true } else { return false } })
    }

    func testCommitThenFinalPassResultDrivesThinkingOrBackToListening() {
        var trace = Trace()
        trace.speech(2)
        let pause = trace.silence(1)
        trace.feed(.smartTurn(requestId: Trace.smartTurnRequests(pause)[0].id, probability: 0.9))
        XCTAssertEqual(trace.policy.state, .confirmingEnd)
        XCTAssertEqual(Trace.states(trace.feed(.turnDiscarded)), [.listening])

        trace.speech(2)
        let again = trace.silence(1)
        trace.feed(.smartTurn(requestId: Trace.smartTurnRequests(again)[0].id, probability: 0.9))
        XCTAssertEqual(Trace.states(trace.feed(.turnCommitted(turnId: "t2"))), [.thinking])
        XCTAssertEqual(trace.policy.answerTurnId, "t2")
    }

    func testTheCommittedTurnsLateWordsAreNotABargeIn() {
        var trace = Trace()
        trace.speech(4)
        let pause = trace.silence(1)
        trace.feed(.smartTurn(requestId: Trace.smartTurnRequests(pause)[0].id, probability: 0.9))
        trace.feed(.turnCommitted(turnId: "t1"))
        // The EOU stream's last words of that turn arrive after the commit:
        // no barge-in, and they are cleared so the next speech cannot count them.
        XCTAssertEqual(trace.partial("the rent"), [.clearTranscript])
        XCTAssertEqual(trace.policy.answerTurnId, "t1")
        XCTAssertTrue(trace.speech(2).isEmpty, "speech alone, without words, does not barge in")
    }

    func testTheCommittedTurnsLateWordsInABreathDuringTheFinalPassAreNotABargeIn() {
        var trace = Trace()
        trace.speech(4)
        trace.partial("i'm gonna try interrupting")
        let pause = trace.silence(1)
        trace.feed(.smartTurn(requestId: Trace.smartTurnRequests(pause)[0].id, probability: 0.9))
        // A breath long enough to count as speech, and the EOU stream's last
        // words of the committed turn arriving inside it.
        trace.speech(2)
        trace.partial("you next")
        trace.silence(1)
        let committed = trace.feed(.turnCommitted(turnId: "t1", text: "I'm gonna try interrupting you next."))
        XCTAssertFalse(committed.contains(.bargeIn(turnId: "t1")))
        XCTAssertEqual(trace.policy.answerTurnId, "t1")
    }

    func testTheCommittedTurnsLateWordsInABreathWhileThinkingAreNotABargeIn() {
        var trace = Trace()
        trace.speech(4)
        let pause = trace.silence(1)
        trace.feed(.smartTurn(requestId: Trace.smartTurnRequests(pause)[0].id, probability: 0.9))
        trace.feed(.turnCommitted(turnId: "t1", text: "Um, what happened?"))
        trace.speech(1)
        trace.partial("what happened")
        let out = trace.speech(1) + trace.silence(2)
        XCTAssertFalse(out.contains(.bargeIn(turnId: "t1")))
        XCTAssertEqual(trace.policy.answerTurnId, "t1")
    }

    func testNewWordsStillBargeInAfterTheCommittedTurnsLateWords() {
        var trace = Trace()
        trace.speech(4)
        let pause = trace.silence(1)
        trace.feed(.smartTurn(requestId: Trace.smartTurnRequests(pause)[0].id, probability: 0.9))
        trace.feed(.turnCommitted(turnId: "t1", text: "Um, what happened?"))
        trace.speech(1)
        trace.partial("what happened")
        XCTAssertFalse(trace.speech(1).contains(.bargeIn(turnId: "t1")))
        let out = trace.partial("what happened wait stop")
        XCTAssertEqual(out.first, .bargeIn(turnId: "t1"))
    }

    func testNoTimersRunWhileTheFinalPassIsRunning() {
        var trace = Trace()
        trace.speech(2)
        let pause = trace.silence(1)
        trace.feed(.smartTurn(requestId: Trace.smartTurnRequests(pause)[0].id, probability: 0.9))
        let waiting = trace.silence(20)
        XCTAssertTrue(Trace.commits(waiting).isEmpty)
        XCTAssertTrue(Trace.smartTurnRequests(waiting).isEmpty)
    }

    // MARK: - Answer playing

    func testFirstClauseMovesThinkingToSpeakingAndAnswerEndReturnsToListening() {
        var trace = Trace()
        trace.committedTurn("t1")
        XCTAssertTrue(trace.feed(.clausePlaying(turnId: "other", text: "x")).isEmpty)
        XCTAssertEqual(Trace.states(trace.feed(.clausePlaying(turnId: "t1", text: "Clause four says the rent is due."))), [.speaking])
        XCTAssertTrue(trace.feed(.clausePlaying(turnId: "t1", text: "On the first of the month.")).isEmpty)
        XCTAssertTrue(trace.feed(.answerEnded(turnId: "other")).isEmpty)
        XCTAssertEqual(Trace.states(trace.feed(.answerEnded(turnId: "t1"))), [.listening])
        XCTAssertNil(trace.policy.answerTurnId)
    }

    func testEndOfAnswerWhileThePersonIsSpeakingGivesThemTheFloor() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "Clause four says the rent is due."))
        trace.speech(1)  // too short for a barge-in
        let out = trace.feed(.answerEnded(turnId: "t1"))
        XCTAssertEqual(Trace.states(out), [.userSpeaking])
    }

    // MARK: - Barge-in

    func testBargeInWhileThinkingNeedsSpeechAndWords() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.speech(1)
        XCTAssertTrue(trace.partial("wait no").isEmpty, "256 ms of speech is under bargeInSpeechMs")
        let out = trace.speech(1)
        XCTAssertEqual(out.first, .bargeIn(turnId: "t1"))
        XCTAssertTrue(out.contains(.state(.userSpeaking)))
        XCTAssertTrue(out.contains(.partial("wait no")))
        XCTAssertFalse(out.contains(.pausePlayback), "nothing plays while thinking")
        XCTAssertNil(trace.policy.answerTurnId)
    }

    func testEchoOfTheClausePlayingDoesNotBargeInButHoldsPlayback() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "The lease ends on the thirtieth of May."))
        trace.speech(1)
        trace.partial("the lease ends on")
        let held = trace.speech(1)
        XCTAssertEqual(held, [.pausePlayback], "speech without foreign words holds playback")
        XCTAssertTrue(trace.speech(1).isEmpty)
        let out = trace.partial("the lease ends on wait hold")
        XCTAssertEqual(out.first, .bargeIn(turnId: "t1"))
    }

    func testOneForeignWordIsNotEnough() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "The lease ends in May."))
        trace.speech(3)
        let out = trace.partial("the lease ends sorry")
        XCTAssertFalse(out.contains(.bargeIn(turnId: "t1")))
    }

    func testEchoOfThePreviousClauseStillArrivingIsNotForeign() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "Clause four covers repairs,"))
        trace.feed(.clausePlaying(turnId: "t1", text: "and the landlord pays."))
        trace.speech(3)
        let out = trace.partial("covers repairs and the landlord")
        XCTAssertFalse(out.contains(.bargeIn(turnId: "t1")))
    }

    func testNormalisedComparisonMatchesCaseAndPunctuation() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "It's the TENANT'S duty, per §4."))
        trace.speech(3)
        let out = trace.partial("its the tenants duty")
        XCTAssertFalse(out.contains(.bargeIn(turnId: "t1")))
    }

    func testABackchannelTooShortToCountNeverBargesIn() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "The rent is due monthly."))
        trace.speech(1)
        trace.partial("mm hmm")
        let out = trace.silence(8)
        XCTAssertFalse(out.contains(.bargeIn(turnId: "t1")))
        XCTAssertFalse(out.contains(.pausePlayback))
    }

    func testFalseStartPausesThenResumesAfterFalseStartMs() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "The deposit is returned within ten days."))
        let onset = trace.now
        trace.speech(1)
        XCTAssertEqual(trace.speech(1), [.pausePlayback])
        trace.silence(1)
        let resumed = trace.tick(until: onset + 1500)
        XCTAssertEqual(resumed, [.resumePlayback])
        XCTAssertEqual(trace.policy.state, .speaking)
        // Words arriving after the window do not barge in for that run.
        XCTAssertEqual(trace.partial("cough cough"), [.clearTranscript])
    }

    func testFalseStartPausesOnlyOncePerRun() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "The deposit is returned within ten days."))
        let out = trace.speech(10)
        XCTAssertEqual(out.filter { $0 == .pausePlayback }.count, 1)
        XCTAssertEqual(out.filter { $0 == .resumePlayback }.count, 1)
    }

    func testWordsArrivingJustAfterAShortRunStillBargeIn() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "The deposit is returned within ten days."))
        trace.speech(2)
        trace.silence(1)
        // The EOU stream's words lag the audio by about half a second.
        let out = trace.partial("stop please")
        XCTAssertEqual(out.first, .bargeIn(turnId: "t1"))
        XCTAssertTrue(out.contains(.state(.userSpeaking)) || out.contains(.state(.confirmingEnd)))
        // The run already ended, so its pause check follows straight away.
        XCTAssertEqual(Trace.smartTurnRequests(out).count, 1)
    }

    func testAfterBargeInTheNewWordsBecomeTheNextTurn() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "The lease ends in May."))
        let onset = trace.now
        trace.speech(2)
        trace.partial("no I meant the other lease")
        let pause = trace.silence(1)
        let request = Trace.smartTurnRequests(pause)[0]
        let commit = Trace.commits(trace.feed(.smartTurn(requestId: request.id, probability: 0.9)))
        XCTAssertEqual(commit.first?.startMs, onset, "the turn starts where the barge-in speech did")
        XCTAssertEqual(trace.policy.state, .confirmingEnd)
        // A clause of the old answer arriving now changes nothing.
        XCTAssertTrue(trace.feed(.clausePlaying(turnId: "t1", text: "x")).isEmpty)
    }

    func testZeroWordsConfigBargesInOnSpeechAlone() {
        var config = VoiceConfig.defaults
        config.bargeInWords = 0
        var trace = Trace(config)
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "Hello."))
        trace.speech(1)
        XCTAssertEqual(trace.speech(1).first, .bargeIn(turnId: "t1"))
    }

    // MARK: - Held playback and the transcript's size

    func testAnAnswerEndingWhilePlaybackIsHeldResumesThePlayer() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "The deposit is returned within ten days."))
        trace.speech(1)
        XCTAssertEqual(trace.speech(1), [.pausePlayback])
        let ended = trace.feed(.answerEnded(turnId: "t1"))
        XCTAssertEqual(ended.first, .resumePlayback, "the next answer must not start on a paused player")
        XCTAssertTrue(ended.contains(.state(.userSpeaking)))
        // The next answer plays normally: no stale resume or pause.
        let pause = trace.silence(1)
        let request = Trace.smartTurnRequests(pause)[0]
        trace.feed(.smartTurn(requestId: request.id, probability: 0.9))
        let next = trace.feed(.turnCommitted(turnId: "t2"))
        XCTAssertFalse(next.contains(.resumePlayback))
        XCTAssertEqual(Trace.states(trace.feed(.clausePlaying(turnId: "t2", text: "Yes."))), [.speaking])
    }

    func testABargeInClearsTheHoldWithoutAResume() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "The lease ends in May."))
        trace.speech(2)
        let out = trace.partial("wait stop")
        XCTAssertEqual(out.first, .bargeIn(turnId: "t1"))
        XCTAssertFalse(out.contains(.resumePlayback), "the engine stops the player instead")
        XCTAssertTrue(trace.tick(until: trace.now + 3000).allSatisfy { $0 != .resumePlayback })
    }

    func testTheTranscriptIsBoundedDuringALongLiveRunOutsideTheTurn() {
        var trace = Trace()
        trace.committedTurn("t1")
        trace.feed(.clausePlaying(turnId: "t1", text: "the the the"))
        trace.speech(1)
        let many = Array(repeating: "the", count: TurnPolicy.maxHeldWords + 1).joined(separator: " ")
        XCTAssertEqual(trace.partial(many), [.clearTranscript])
        let few = Array(repeating: "the", count: 10).joined(separator: " ")
        XCTAssertTrue(trace.partial(few).isEmpty, "a live run keeps its words below the bound")
    }

    func testTheTranscriptIsNeverClearedDuringThePersonsTurn() {
        var trace = Trace()
        trace.speech(1)
        let many = Array(repeating: "word", count: TurnPolicy.maxHeldWords + 50).joined(separator: " ")
        let out = trace.partial(many)
        XCTAssertFalse(out.contains(.clearTranscript))
        XCTAssertEqual(out.count, 1)
    }
}
