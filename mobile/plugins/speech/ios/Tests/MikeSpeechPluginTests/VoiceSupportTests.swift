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
}
