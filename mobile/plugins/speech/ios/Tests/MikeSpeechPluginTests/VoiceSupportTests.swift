import XCTest
@testable import MikeSpeechPlugin

final class VoiceSupportTests: XCTestCase {
    func testPrewarmIsSkippedInLowPowerModeAndWhenHot() {
        XCTAssertTrue(PrewarmGate.allows(lowPowerMode: false, thermalState: .nominal))
        XCTAssertTrue(PrewarmGate.allows(lowPowerMode: false, thermalState: .fair))
        XCTAssertFalse(PrewarmGate.allows(lowPowerMode: true, thermalState: .nominal))
        XCTAssertFalse(PrewarmGate.allows(lowPowerMode: false, thermalState: .serious))
        XCTAssertFalse(PrewarmGate.allows(lowPowerMode: false, thermalState: .critical))
    }

    func testVoiceUsageIsRememberedNatively() throws {
        let suite = "VoiceSupportTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertFalse(VoiceUsage.hasBeenUsed(defaults))
        XCTAssertTrue(VoiceUsage.wantsSpeaker(defaults))
        VoiceUsage.markUsed(speaker: false, defaults)
        XCTAssertTrue(VoiceUsage.hasBeenUsed(defaults))
        XCTAssertFalse(VoiceUsage.wantsSpeaker(defaults))
    }

    #if canImport(FluidAudio) && canImport(PhononTTS)
    func testLateModelsAreTakenOnceAndTheEouWaitsForAGapBetweenTurns() {
        let late = LateModels(started: .now, expecting: ["eou", "smart turn", "speaker"])
        XCTAssertFalse(late.hasArrivals)
        XCTAssertEqual(late.pending, ["eou", "smart turn", "speaker"])
        late.deliver(.eou(nil), name: "eou")
        late.deliver(.smartTurn(nil), name: "smart turn")
        XCTAssertEqual(late.pending, ["speaker"])
        XCTAssertEqual(late.take(eouAllowed: false).count, 1, "the smart turn result only")
        XCTAssertTrue(late.hasArrivals, "the EOU is held")
        XCTAssertEqual(late.take(eouAllowed: true).count, 1)
        XCTAssertFalse(late.hasArrivals)
        XCTAssertTrue(late.take(eouAllowed: true).isEmpty)
    }
    #endif

    // MARK: - Loading once

    private actor Counter {
        private(set) var count = 0
        func bump() -> Int { count += 1; return count }
    }

    func testConcurrentCallersShareOneLoad() async throws {
        let flight = SingleFlight()
        let counter = Counter()
        let results = try await withThrowingTaskGroup(of: Int.self) { group in
            for _ in 0..<5 {
                group.addTask {
                    try await flight.value("phonon") {
                        let n = await counter.bump()
                        try await Task.sleep(for: .milliseconds(100))
                        return n
                    }
                }
            }
            return try await group.reduce(into: [Int]()) { $0.append($1) }
        }
        let loads = await counter.count
        XCTAssertEqual(loads, 1)
        XCTAssertEqual(results, [1, 1, 1, 1, 1])
        // A later caller gets the kept result.
        let later = try await flight.value("phonon") { await counter.bump() }
        XCTAssertEqual(later, 1)
        let other = try await flight.value("fluid") { await counter.bump() }
        XCTAssertEqual(other, 2)
    }

    func testAFailedLoadIsForgottenAndTriedAgain() async throws {
        struct Boom: Error {}
        let flight = SingleFlight()
        let counter = Counter()
        do {
            _ = try await flight.value("eou") { _ = await counter.bump(); throw Boom() } as Int
            XCTFail("should have thrown")
        } catch is Boom {}
        let second = try await flight.value("eou") { await counter.bump() }
        XCTAssertEqual(second, 2)
    }

    func testForgettingAllLoadsAgain() async throws {
        let flight = SingleFlight()
        let counter = Counter()
        _ = try await flight.value("vad") { await counter.bump() }
        await flight.forgetAll()
        let again = try await flight.value("vad") { await counter.bump() }
        XCTAssertEqual(again, 2)
    }

    private final class Messages: @unchecked Sendable {
        private let lock = NSLock()
        private var seconds: [Int] = []
        func add(_ value: Int) { lock.lock(); seconds.append(value); lock.unlock() }
        var all: [Int] { lock.lock(); defer { lock.unlock() }; return seconds }
    }

    func testASlowLoadIsLoggedOnceAndNotCancelled() async throws {
        let messages = Messages()
        let result = try await LoadWatchdog.run(after: .milliseconds(50), onSlow: { messages.add($0) }) {
            try await Task.sleep(for: .milliseconds(300))
            return "loaded"
        }
        XCTAssertEqual(result, "loaded")
        XCTAssertEqual(messages.all.count, 1)
    }

    func testAFastLoadIsNotLogged() async throws {
        let messages = Messages()
        _ = try await LoadWatchdog.run(after: .milliseconds(200), onSlow: { messages.add($0) }) { 1 }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertTrue(messages.all.isEmpty)
    }
}
