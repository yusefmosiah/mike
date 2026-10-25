import XCTest
@testable import MikeSpeechPlugin

final class ClauseQueueTests: XCTestCase {
    /// Prepares the next clause and schedules it as `chunks` chunks of `size`
    /// samples straight after what is already on the timeline (no lead, so
    /// the first clause starts at sample 0).
    private func prepareNext(_ queue: inout ClauseQueue, chunks: Int = 2, size: Int = 1920, played: Int = 0) -> Int? {
        guard let clause = queue.nextToPrepare() else { return nil }
        let token = queue.token
        for _ in 0..<chunks {
            let at = queue.placement(playedSample: played, lead: 0)
            XCTAssertTrue(queue.scheduled(clauseId: clause.id, startSample: at, count: size, token: token))
        }
        queue.prepared(clauseId: clause.id, token: token)
        return clause.id
    }

    func testAcceptsOnlyTheCurrentTurnsIncreasingClauses() {
        var queue = ClauseQueue()
        XCTAssertFalse(queue.accept(turnId: "t1", clauseId: 0, text: "a"), "no answer begun")
        queue.begin(turnId: "t1")
        XCTAssertTrue(queue.accept(turnId: "t1", clauseId: 0, text: "a"))
        XCTAssertFalse(queue.accept(turnId: "t0", clauseId: 1, text: "stale turn"))
        XCTAssertFalse(queue.accept(turnId: "t1", clauseId: 0, text: "repeat"))
        XCTAssertFalse(queue.accept(turnId: "t1", clauseId: -1, text: "negative"))
        XCTAssertTrue(queue.accept(turnId: "t1", clauseId: 3, text: "gaps are fine"))
        XCTAssertTrue(queue.end(turnId: "t1"))
        XCTAssertFalse(queue.accept(turnId: "t1", clauseId: 4, text: "after the end"))
        XCTAssertFalse(queue.end(turnId: "t0"))
    }

    func testPreparesExactlyOneClauseAhead() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        for id in 0..<3 { queue.accept(turnId: "t1", clauseId: id, text: "clause \(id)") }

        let first = queue.nextToPrepare()
        XCTAssertEqual(first?.id, 0)
        XCTAssertNil(queue.nextToPrepare(), "one synthesis at a time")
        let token = queue.token
        queue.scheduled(clauseId: 0, startSample: 0, count: 2400, token: token)
        queue.prepared(clauseId: 0, token: token)
        XCTAssertNil(queue.nextToPrepare(), "clause 0 is ready but not yet heard")

        XCTAssertEqual(queue.advance(playedSample: 0), [.started(clauseId: 0)])
        XCTAssertEqual(queue.nextToPrepare()?.id, 1, "clause 0 playing: prepare clause 1")
        queue.scheduled(clauseId: 1, startSample: 2400, count: 2400, token: token)
        queue.prepared(clauseId: 1, token: token)
        XCTAssertNil(queue.nextToPrepare(), "clause 1 is the one ahead")
        XCTAssertEqual(queue.advance(playedSample: 2400), [.played(clauseId: 0), .started(clauseId: 1)])
        XCTAssertEqual(queue.nextToPrepare()?.id, 2)
    }

    func testEventsFollowThePlayedSampleClockAndFinishAfterTheEnd() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "first")
        _ = prepareNext(&queue)  // 0..<3840
        XCTAssertEqual(queue.advance(playedSample: 100), [.started(clauseId: 0)])
        queue.accept(turnId: "t1", clauseId: 1, text: "second")
        _ = prepareNext(&queue, played: 100)  // 3840..<7680
        XCTAssertEqual(queue.advance(playedSample: 3839), [])
        XCTAssertEqual(queue.advance(playedSample: 3840), [.played(clauseId: 0), .started(clauseId: 1)])
        XCTAssertEqual(queue.advance(playedSample: 7680), [.played(clauseId: 1)], "no finish before voiceEndAnswer")
        queue.end(turnId: "t1")
        XCTAssertEqual(queue.advance(playedSample: 7680), [.finished])
        XCTAssertEqual(queue.advance(playedSample: 9000), [], "finished once")
    }

    func testAClauseStillBeingSynthesisedIsNotPlayedWhenItsChunksRunOut() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "long clause")
        let token = queue.token
        _ = queue.nextToPrepare()
        queue.scheduled(clauseId: 0, startSample: 0, count: 1920, token: token)
        XCTAssertEqual(queue.advance(playedSample: 5000), [.started(clauseId: 0)], "an underrun is not the end")
        queue.scheduled(clauseId: 0, startSample: queue.placement(playedSample: 5000, lead: 720), count: 1920, token: token)
        queue.prepared(clauseId: 0, token: token)
        XCTAssertEqual(queue.advance(playedSample: 5720 + 1920), [.played(clauseId: 0)])
    }

    func testPlacementFollowsTheTimelineOrJumpsAheadAfterAnUnderrun() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "a")
        _ = queue.nextToPrepare()
        XCTAssertEqual(queue.placement(playedSample: 0, lead: 720), 720)
        queue.scheduled(clauseId: 0, startSample: 720, count: 1920, token: queue.token)
        XCTAssertEqual(queue.placement(playedSample: 1000, lead: 720), 2640, "straight after the last chunk")
        XCTAssertEqual(queue.placement(playedSample: 10_000, lead: 720), 10_720, "ahead of the play position")
    }

    func testInterruptReportsTheShareOfTheClausesSamplesPlayed() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "a")
        queue.accept(turnId: "t1", clauseId: 1, text: "b")
        _ = prepareNext(&queue, chunks: 2, size: 2000)  // 0..<4000
        _ = queue.advance(playedSample: 720)
        _ = prepareNext(&queue, chunks: 4, size: 1000, played: 720)  // 4000..<8000
        _ = queue.advance(playedSample: 4720)
        let interruption = queue.interrupt(playedSample: 5000)
        XCTAssertEqual(interruption, ClauseQueue.Interruption(clauseId: 1, fraction: 0.25))
        XCTAssertNil(queue.turnId)
    }

    func testInterruptCountsSamplesNotTimelineSpanAcrossAnUnderrunGap() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "a")
        let token = queue.token
        _ = queue.nextToPrepare()
        queue.scheduled(clauseId: 0, startSample: 0, count: 1000, token: token)
        queue.scheduled(clauseId: 0, startSample: 5000, count: 1000, token: token)  // after a gap
        queue.prepared(clauseId: 0, token: token)
        _ = queue.advance(playedSample: 0)
        XCTAssertEqual(queue.interrupt(playedSample: 5500), ClauseQueue.Interruption(clauseId: 0, fraction: 0.75))
    }

    func testInterruptBetweenClausesNamesTheNextAtZero() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "a")
        _ = prepareNext(&queue)  // 0..<3840
        _ = queue.advance(playedSample: 720)
        _ = queue.advance(playedSample: 4560)
        queue.accept(turnId: "t1", clauseId: 1, text: "b")
        XCTAssertEqual(queue.interrupt(playedSample: 6000), ClauseQueue.Interruption(clauseId: 1, fraction: 0))
    }

    func testInterruptAfterEverythingPlayedNamesTheLastClauseWhole() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "a")
        _ = prepareNext(&queue)
        _ = queue.advance(playedSample: 720)
        _ = queue.advance(playedSample: 10_000)
        XCTAssertEqual(queue.interrupt(playedSample: 10_000), ClauseQueue.Interruption(clauseId: 0, fraction: 1))
    }

    func testInterruptBeforeAnythingPlayedReportsNothing() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "a")
        _ = prepareNext(&queue)
        XCTAssertNil(queue.interrupt(playedSample: 0))
        var empty = ClauseQueue()
        XCTAssertNil(empty.interrupt(playedSample: 0))
    }

    func testTheTurnTokenDropsStaleWorkOnEveryPath() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "a")
        let clause = queue.nextToPrepare()!
        let old = queue.token

        // Barge-in / cancel.
        _ = queue.interrupt(playedSample: 0)
        XCTAssertFalse(queue.isCurrent(old))
        XCTAssertFalse(queue.scheduled(clauseId: clause.id, startSample: 0, count: 100, token: old))

        // A new answer reusing clause ids.
        queue.begin(turnId: "t2")
        queue.accept(turnId: "t2", clauseId: 0, text: "new")
        _ = queue.nextToPrepare()
        XCTAssertFalse(queue.scheduled(clauseId: 0, startSample: 0, count: 100, token: old), "t1's synthesis cannot land in t2")
        queue.prepared(clauseId: 0, token: old)
        XCTAssertNil(queue.nextToPrepare(), "a stale 'prepared' does not unlock the next clause")

        // Plain clear (stop).
        let current = queue.token
        queue.clear()
        XCTAssertFalse(queue.isCurrent(current))

        // A new begin while another answer was running.
        queue.begin(turnId: "t3")
        let t3 = queue.token
        queue.begin(turnId: "t4")
        XCTAssertFalse(queue.isCurrent(t3))
    }

    func testRewindPreparesUnheardClausesAgainWithoutRepeatingStarted() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "a")
        queue.accept(turnId: "t1", clauseId: 1, text: "b")
        _ = prepareNext(&queue)  // 0..<3840
        _ = queue.advance(playedSample: 720)
        _ = prepareNext(&queue, played: 720)  // 3840..<7680
        _ = queue.advance(playedSample: 4560)  // 0 played, 1 started
        let before = queue.token
        queue.rewind()
        XCTAssertFalse(queue.isCurrent(before))
        XCTAssertEqual(queue.timelineEnd, 0)
        XCTAssertEqual(queue.turnId, "t1")
        XCTAssertEqual(queue.nextToPrepare()?.id, 1, "clause 1 is spoken again from its start")
        let token = queue.token
        queue.scheduled(clauseId: 1, startSample: 720, count: 1000, token: token)
        queue.prepared(clauseId: 1, token: token)
        XCTAssertEqual(queue.advance(playedSample: 720), [], "started was already sent")
        XCTAssertEqual(queue.advance(playedSample: 1720), [.played(clauseId: 1)])
    }

    func testAClauseWithNoAudioCountsAsPlayedInItsTurn() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "a")
        queue.accept(turnId: "t1", clauseId: 1, text: "")
        _ = prepareNext(&queue)  // 0..<3840
        _ = queue.advance(playedSample: 720)
        let failed = queue.nextToPrepare()!
        queue.prepared(clauseId: failed.id, token: queue.token)
        XCTAssertEqual(queue.advance(playedSample: 1000), [], "not before clause 0 is heard")
        queue.end(turnId: "t1")
        XCTAssertEqual(queue.advance(playedSample: 4560), [.played(clauseId: 0), .started(clauseId: 1), .played(clauseId: 1), .finished])
    }

    func testEndingAnAnswerWithNoClausesFinishesAtOnce() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.end(turnId: "t1")
        XCTAssertEqual(queue.advance(playedSample: 0), [.finished])
        XCTAssertFalse(queue.anythingStarted)
    }

    func testFadesRampTheSeams() {
        var chunk = [Float](repeating: 1, count: 1920)
        Fade.fadeIn(&chunk)
        XCTAssertEqual(chunk[0], 0)
        XCTAssertLessThan(chunk[60], 1)
        XCTAssertEqual(chunk[Fade.samples], 1)
        Fade.fadeOut(&chunk)
        XCTAssertEqual(chunk[1919], 0)
        XCTAssertEqual(chunk[1919 - Fade.samples], 1)
        var short: [Float] = [1, 1]
        Fade.fadeIn(&short)
        Fade.fadeOut(&short)
        XCTAssertEqual(short, [0, 0])
        var empty: [Float] = []
        Fade.fadeIn(&empty)
        XCTAssertEqual(empty, [])
    }

    func testAStepPlayingGivesWayToTheAnswer() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "Reading the lease.", step: true)
        XCTAssertEqual(queue.nextToPrepare(), ClauseQueue.Clause(id: 0, text: "Reading the lease.", step: true))
        let token = queue.token
        queue.scheduled(clauseId: 0, startSample: 0, count: 4800, token: token)
        queue.prepared(clauseId: 0, token: token)
        XCTAssertEqual(queue.advance(playedSample: 100), [.started(clauseId: 0)])
        XCTAssertTrue(queue.hasUnplayedStep)
        XCTAssertTrue(queue.isStep(0))

        let yielded = queue.yieldSteps(playedSample: 1200)
        XCTAssertEqual(
            yielded,
            ClauseQueue.Yield(
                ended: [.init(clauseId: 0, wasStarted: true)],
                playing: .init(clauseId: 0, playedSamples: 1200),
                stopsPlayback: true))
        XCTAssertFalse(queue.hasUnplayedStep)

        // The engine stops the player, rewinds, and keeps the faded tail's room clear.
        queue.rewind()
        queue.reserveTimeline(until: 9000)
        queue.accept(turnId: "t1", clauseId: 1, text: "Ninety days.")
        XCTAssertEqual(queue.nextToPrepare()?.id, 1)
        XCTAssertEqual(queue.placement(playedSample: 0, lead: 720), 9000)
        XCTAssertNil(queue.yieldSteps(playedSample: 0), "nothing left to give way")
    }

    func testStepsNotYetHeardAreDroppedWithoutStoppingPlayback() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "Reading.", step: true)
        queue.accept(turnId: "t1", clauseId: 1, text: "Counting.", step: true)
        let yielded = queue.yieldSteps(playedSample: 0)
        XCTAssertEqual(
            yielded,
            ClauseQueue.Yield(
                ended: [.init(clauseId: 0, wasStarted: false), .init(clauseId: 1, wasStarted: false)],
                playing: nil,
                stopsPlayback: false))
        // Ended steps count as played: an answer clause after them is next, and the end follows it.
        queue.accept(turnId: "t1", clauseId: 2, text: "The answer.")
        queue.end(turnId: "t1")
        XCTAssertEqual(queue.nextToPrepare()?.id, 2)
        let token = queue.token
        queue.scheduled(clauseId: 2, startSample: 0, count: 100, token: token)
        queue.prepared(clauseId: 2, token: token)
        XCTAssertEqual(queue.advance(playedSample: 100), [.started(clauseId: 2), .played(clauseId: 2), .finished])
    }

    func testAStepInSynthesisStopsIt() {
        var queue = ClauseQueue()
        queue.begin(turnId: "t1")
        queue.accept(turnId: "t1", clauseId: 0, text: "Reading.", step: true)
        _ = queue.nextToPrepare()
        XCTAssertEqual(queue.yieldSteps(playedSample: 0)?.stopsPlayback, true)
        // The synthesis's late chunks are refused.
        XCTAssertFalse(queue.scheduled(clauseId: 0, startSample: 0, count: 100, token: queue.token))
    }
}
