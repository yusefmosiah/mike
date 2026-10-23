import XCTest
@testable import MikeSpeechPlugin

/// The plugin side of docs/voice-chat-contract.md: event payloads, the
/// configuration's defaults and parsing, and the helpers around them.
final class VoiceContractTests: XCTestCase {
    func testConfigDefaultsMatchTheContract() {
        let config = VoiceConfig()
        XCTAssertEqual(config.vadThreshold, 0.5)
        XCTAssertEqual(config.pauseMs, 500)
        XCTAssertEqual(config.smartTurnThreshold, 0.6, accuracy: 1e-6)
        XCTAssertEqual(config.maxSilenceMs, 3000)
        XCTAssertEqual(config.continueMs, 3000)
        XCTAssertEqual(config.bargeInSpeechMs, 300)
        XCTAssertEqual(config.holdSpeechMs, 700)
        XCTAssertEqual(config.bargeInVadThreshold, 0.7, accuracy: 1e-6)
        XCTAssertEqual(config.bargeInWords, 2)
        XCTAssertEqual(config.falseStartMs, 1500)
        XCTAssertEqual(config.maxTurnMs, 60_000)
        XCTAssertEqual(config.speakerThreshold, 0.35, accuracy: 1e-6)
        XCTAssertEqual(config.campplusThreshold, 0.39, accuracy: 1e-6)
        XCTAssertEqual(config.speakerModel, .wespeaker)
        XCTAssertEqual(VoiceConfig(nil), .defaults)
        XCTAssertEqual(VoiceConfig([:]), .defaults)
    }

    func testConfigTakesEveryFieldAndIgnoresWhatItCannotUse() {
        let config = VoiceConfig([
            "vadThreshold": 0.6, "pauseMs": 300, "smartTurnThreshold": 0.7, "maxSilenceMs": 2500,
            "bargeInSpeechMs": 400, "bargeInWords": 3, "falseStartMs": 1200, "maxTurnMs": 30_000,
            "continueMs": 0, "holdSpeechMs": 900, "bargeInVadThreshold": 0.8,
            "speakerThreshold": 0.45, "campplusThreshold": 0.6, "speakerModel": "both",
        ])
        XCTAssertEqual(config.continueMs, 0, "0 turns continuing off")
        XCTAssertEqual(config.holdSpeechMs, 900)
        XCTAssertEqual(config.bargeInVadThreshold, 0.8, accuracy: 1e-6)
        XCTAssertEqual(config.speakerThreshold, 0.45, accuracy: 1e-6)
        XCTAssertEqual(config.campplusThreshold, 0.6, accuracy: 1e-6)
        XCTAssertEqual(config.speakerModel, .both)
        XCTAssertNotNil(SpeakerFusion.bundled, "the joined space ships with the plugin")
        XCTAssertEqual(config.speakerRule, SpeakerRule(decider: .both, thresholds: [.wespeaker: 0.45, .campplus: 0.6], fusion: SpeakerFusion.bundled))
        XCTAssertNil(VoiceConfig().speakerRule.fusion, "only Both uses it")
        XCTAssertEqual(VoiceConfig(["speakerModel": "campplus"]).speakerModel, .campplus)
        XCTAssertNil(VoiceConfig(["speakerModel": "off"]).speakerModel, "off checks nothing")
        XCTAssertEqual(VoiceConfig(["speakerModel": "ecapa"]).speakerModel, .wespeaker, "an unknown model keeps the default")
        XCTAssertEqual(VoiceConfig(["speakerThreshold": 0]).speakerThreshold, 0.35)
        XCTAssertEqual(VoiceConfig(["speakerThreshold": 1]).speakerThreshold, 0.35)
        XCTAssertEqual(config.vadThreshold, 0.6, accuracy: 1e-6)
        XCTAssertEqual(config.pauseMs, 300)
        XCTAssertEqual(config.smartTurnThreshold, 0.7, accuracy: 1e-6)
        XCTAssertEqual(config.maxSilenceMs, 2500)
        XCTAssertEqual(config.bargeInSpeechMs, 400)
        XCTAssertEqual(config.bargeInWords, 3)
        XCTAssertEqual(config.falseStartMs, 1200)
        XCTAssertEqual(config.maxTurnMs, 30_000)

        let bad = VoiceConfig([
            "vadThreshold": 1.5, "pauseMs": "300", "smartTurnThreshold": true, "maxSilenceMs": -1,
            "bargeInWords": 2.6, "maxTurnMs": Double.nan, "unknown": 1,
        ])
        XCTAssertEqual(bad.vadThreshold, 0.5)
        XCTAssertEqual(bad.pauseMs, 500)
        XCTAssertEqual(bad.smartTurnThreshold, 0.6, accuracy: 1e-6, "a boolean is not a number")
        XCTAssertEqual(bad.maxSilenceMs, 3000)
        XCTAssertEqual(bad.bargeInWords, 3, "rounded")
        XCTAssertEqual(bad.maxTurnMs, 60_000)
    }

    func testEveryEventEncodesAsTheContractSays() {
        func json(_ event: VoiceEvent) -> NSDictionary { event.payload as NSDictionary }
        XCTAssertEqual(json(.install(fraction: 0.25)), ["type": "install", "fraction": 0.25])
        XCTAssertEqual(json(.install(fraction: 1.2)), ["type": "install", "fraction": 1.0])
        XCTAssertEqual(json(.state(.listening)), ["type": "state", "state": "listening"])
        XCTAssertEqual(json(.state(.userSpeaking)), ["type": "state", "state": "user-speaking"])
        XCTAssertEqual(json(.state(.confirmingEnd)), ["type": "state", "state": "confirming-end"])
        XCTAssertEqual(json(.state(.thinking)), ["type": "state", "state": "thinking"])
        XCTAssertEqual(json(.state(.speaking)), ["type": "state", "state": "speaking"])
        XCTAssertEqual(json(.partial(text: "the lease")), ["type": "partial", "text": "the lease"])
        XCTAssertEqual(json(.turn(turnId: "t1", text: "The lease.", audioMs: 1200)),
                       ["type": "turn", "turnId": "t1", "text": "The lease.", "audioMs": 1200])
        XCTAssertEqual(json(.turn(turnId: "t2", text: "The lease, and the keys.", audioMs: 4000, continues: "t1")),
                       ["type": "turn", "turnId": "t2", "text": "The lease, and the keys.", "audioMs": 4000, "continues": "t1"])
        XCTAssertEqual(json(.bargeIn(turnId: "t1")), ["type": "bargeIn", "turnId": "t1"])
        XCTAssertEqual(json(.ignored(.otherVoice)), ["type": "ignored", "reason": "other-voice"])
        XCTAssertEqual(json(.clauseStarted(turnId: "t1", clauseId: 0)), ["type": "clauseStarted", "turnId": "t1", "clauseId": 0])
        XCTAssertEqual(json(.clausePlayed(turnId: "t1", clauseId: 2)), ["type": "clausePlayed", "turnId": "t1", "clauseId": 2])
        XCTAssertEqual(json(.interrupted(turnId: "t1", clauseId: 3, fraction: 0.4)),
                       ["type": "interrupted", "turnId": "t1", "clauseId": 3, "fraction": 0.4])
        XCTAssertEqual(json(.interrupted(turnId: "t1", clauseId: 3, fraction: -0.1))["fraction"] as? Double, 0)
        XCTAssertEqual(json(.answerFinished(turnId: "t1")), ["type": "answerFinished", "turnId": "t1"])
        XCTAssertEqual(json(.ended(.stopped)), ["type": "ended", "reason": "stopped"])
        XCTAssertEqual(json(.ended(.interruption)), ["type": "ended", "reason": "interruption"])
        XCTAssertEqual(json(.ended(.route)), ["type": "ended", "reason": "route"])
        XCTAssertEqual(json(.ended(.error)), ["type": "ended", "reason": "error"])
        XCTAssertEqual(json(.metrics(turnId: "t1", stages: ["finalPass": 23.456, "commitToFirstAudio": 410])),
                       ["type": "metrics", "turnId": "t1", "stages": ["finalPass": 23.5, "commitToFirstAudio": 410.0]])
        XCTAssertEqual(VoiceEvent.listenerName, "voiceEvent")
    }

    func testPayloadsSurviveJsonSerialisation() throws {
        let events: [VoiceEvent] = [
            .install(fraction: 0.5), .state(.speaking), .partial(text: "x"), .turn(turnId: "t", text: "x", audioMs: 1),
            .bargeIn(turnId: "t"), .clauseStarted(turnId: "t", clauseId: 0), .clausePlayed(turnId: "t", clauseId: 0),
            .interrupted(turnId: "t", clauseId: 0, fraction: 0.5), .answerFinished(turnId: "t"), .ended(.stopped),
            .metrics(turnId: "t", stages: ["finalPass": 1]),
            .preparation(.init(preparing: true, firstTime: true, ready: ["vad", "phonon"])),
        ]
        for event in events {
            XCTAssertTrue(JSONSerialization.isValidJSONObject(event.payload), "\(event)")
            _ = try JSONSerialization.data(withJSONObject: event.payload)
        }
    }

    func testModelNamesAreTheContractsStrings() {
        XCTAssertEqual(VoiceModelName.allCases.map(\.rawValue), ["vad", "eou", "smart-turn", "speaker", "speaker-campplus", "phonon", "fluid-mini"])
    }

    func testStatusPayloadHasTheContractsFields() {
        let status = VoiceMode.Status(available: false, missing: ["vad", "phonon"], downloadBytes: 42, speakerLearned: true)
        XCTAssertEqual(status.payload as NSDictionary,
                       ["available": false, "missing": ["vad", "phonon"], "downloadBytes": 42, "speakerLearned": true,
                        "preparing": false, "firstTime": false, "ready": []])
        var preparing = status
        preparing.preparation = .init(preparing: true, firstTime: true, ready: ["vad"])
        XCTAssertEqual(preparing.payload["preparing"] as? Bool, true)
        XCTAssertEqual(preparing.payload["firstTime"] as? Bool, true)
        XCTAssertEqual(preparing.payload["ready"] as? [String], ["vad"])
        XCTAssertEqual(preparing.payload["available"] as? Bool, false, "the fields older builds read are unchanged")
    }

    func testPreparationEventCarriesTheSnapshot() {
        let event = VoiceEvent.preparation(.init(preparing: true, firstTime: false, ready: ["smart-turn", "vad"]))
        XCTAssertEqual(event.payload as NSDictionary,
                       ["type": "preparation", "preparing": true, "firstTime": false, "ready": ["smart-turn", "vad"]])
    }

    func testStatusNamesWhatIsMissingInContractOrder() async {
        let status = await VoiceMode.status()
        let order = VoiceModelName.allCases.map(\.rawValue)
        XCTAssertEqual(status.missing, order.filter(status.missing.contains))
        if !status.missing.isEmpty { XCTAssertFalse(status.available) }
        XCTAssertGreaterThanOrEqual(status.downloadBytes, 0)
    }

    func testWordsAreNormalisedForComparison() {
        XCTAssertEqual(VoiceWords.normalised("It's the TENANT'S duty, per §4."), ["its", "the", "tenants", "duty", "per", "4"])
        XCTAssertEqual(VoiceWords.normalised("Café — résumé"), ["cafe", "resume"])
        XCTAssertEqual(VoiceWords.normalised("  "), [])
        XCTAssertEqual(VoiceWords.normalised("don\u{2019}t stop"), ["dont", "stop"])
    }

    func testMaxTurnIsCappedAtTwoMinutes() {
        XCTAssertEqual(VoiceConfig(["maxTurnMs": 120_000]).maxTurnMs, 120_000)
        XCTAssertEqual(VoiceConfig(["maxTurnMs": 120_001]).maxTurnMs, 60_000, "over the cap keeps the default")
        XCTAssertEqual(VoiceConfig(["maxTurnMs": 600_000]).maxTurnMs, 60_000)
    }

    func testVoiceModeRejectionCodes() {
        XCTAssertEqual(OnDeviceSpeech.Failure.cancelled.code, "cancelled")
        XCTAssertEqual(OnDeviceSpeech.Failure.busy.code, "busy")
        XCTAssertEqual(PhononVoice.Failure.busy.code, "busy")
    }

    func testInstallProgressIsOrderedMonotoneAndEndsAtOne() {
        let relay = VoiceMode.ProgressRelay()
        let seen = Seen()
        relay.add { seen.add($0) }
        relay.report(0)
        relay.report(0.004)   // under a percent: skipped
        relay.report(0.5)
        relay.report(0.3)     // backwards: skipped
        relay.report(0.995)
        relay.report(1)
        relay.report(1)       // once
        XCTAssertEqual(seen.values, [0, 0.5, 0.995, 1])
        // A retry gets a new relay that starts from zero again.
        let retry = VoiceMode.ProgressRelay()
        let again = Seen()
        retry.add { again.add($0) }
        retry.report(0)
        XCTAssertEqual(again.values, [0])
    }

    func testStartGateAndDropCounter() {
        let gate = StartGate()
        let ticket = gate.current
        gate.bump()
        XCTAssertNotEqual(gate.current, ticket)
        let drops = DropCounter()
        drops.add(160)
        drops.add(40)
        XCTAssertEqual(drops.take(), 200)
        XCTAssertEqual(drops.take(), 0)
    }
}

private final class Seen: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [Double] = []
    func add(_ value: Double) { lock.lock(); list.append(value); lock.unlock() }
    var values: [Double] { lock.lock(); defer { lock.unlock() }; return list }
}
