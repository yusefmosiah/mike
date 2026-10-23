import XCTest
@testable import MikeSpeechPlugin

final class VoicePreparationTests: XCTestCase {
    private func makeDefaults() throws -> (UserDefaults, () -> Void) {
        let suite = "VoicePreparationTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        return (defaults, { defaults.removePersistentDomain(forName: suite) })
    }

    func testTheSignatureNamesTheVersionTheBuildAndTheSystem() {
        let bundle = Bundle(for: Self.self)
        let signature = VoicePreparation.signature(bundle: bundle, system: "Version 27.1 (Build 24A1)")
        XCTAssertTrue(signature.hasSuffix("/Version 27.1 (Build 24A1)"))
        XCTAssertNotEqual(signature, VoicePreparation.signature(bundle: bundle, system: "Version 27.2 (Build 24B1)"))
    }

    func testAChangedBuildOrSystemOrNothingStoredNeedsPreparing() {
        XCTAssertTrue(VoicePreparation.needsPreparation(stored: nil, current: "1.4+12/ios27.1"))
        XCTAssertFalse(VoicePreparation.needsPreparation(stored: "1.4+12/ios27.1", current: "1.4+12/ios27.1"))
        XCTAssertTrue(VoicePreparation.needsPreparation(stored: "1.4+12/ios27.1", current: "1.4+13/ios27.1"), "a new build")
        XCTAssertTrue(VoicePreparation.needsPreparation(stored: "1.4+12/ios27.1", current: "1.5+12/ios27.1"), "a new version")
        XCTAssertTrue(VoicePreparation.needsPreparation(stored: "1.4+12/ios27.1", current: "1.4+12/ios27.2"), "a new system")
    }

    func testPreparedMeansEveryModelIsReady() {
        let all: Set<String> = ["vad", "smart-turn", "eou", "fluid-mini", "phonon", "speaker"]
        XCTAssertTrue(VoicePreparation.isComplete(ready: all, wantsSpeaker: true))
        XCTAssertFalse(VoicePreparation.isComplete(ready: all.subtracting(["speaker"]), wantsSpeaker: true))
        XCTAssertTrue(VoicePreparation.isComplete(ready: all.subtracting(["speaker"]), wantsSpeaker: false))
        XCTAssertFalse(VoicePreparation.isComplete(ready: all.subtracting(["eou"]), wantsSpeaker: false))
    }

    func testTheFirstPreparationIsRememberedForTheBuild() throws {
        let (defaults, cleanup) = try makeDefaults()
        defer { cleanup() }
        let first = VoicePreparation(defaults: defaults, signature: "1.0+1/a")
        XCTAssertTrue(first.snapshot.firstTime)
        XCTAssertTrue(first.needsFirstPreparation)
        for name in ["vad", "smart-turn", "eou", "fluid-mini"] { first.markReady(name) }
        XCTAssertTrue(first.snapshot.firstTime, "not until everything is ready")
        first.markReady("phonon")
        first.markReady("speaker")
        XCTAssertFalse(first.snapshot.firstTime)
        XCTAssertEqual(first.snapshot.ready, ["eou", "fluid-mini", "phonon", "smart-turn", "speaker", "vad"])
        // The next launch of this build is not a first time; an update is.
        XCTAssertFalse(VoicePreparation(defaults: defaults, signature: "1.0+1/a").snapshot.firstTime)
        XCTAssertTrue(VoicePreparation(defaults: defaults, signature: "1.0+2/a").snapshot.firstTime)
    }

    func testPreparingLastsWhileAnyActivityIsOpenAndEachEndsOnce() throws {
        let (defaults, cleanup) = try makeDefaults()
        defer { cleanup() }
        let preparation = VoicePreparation(defaults: defaults, signature: "s")
        XCTAssertFalse(preparation.snapshot.preparing)
        let one = preparation.begin(wantsSpeaker: true)
        let two = preparation.begin(wantsSpeaker: true)
        XCTAssertTrue(preparation.snapshot.preparing)
        one.end()
        one.end()
        XCTAssertTrue(preparation.snapshot.preparing, "the second is still open")
        two.end()
        XCTAssertFalse(preparation.snapshot.preparing)
    }

    func testAskingNotForTheSpeakerCompletesWithoutIt() throws {
        let (defaults, cleanup) = try makeDefaults()
        defer { cleanup() }
        let preparation = VoicePreparation(defaults: defaults, signature: "s")
        let activity = preparation.begin(wantsSpeaker: false)
        for name in ["vad", "smart-turn", "eou", "fluid-mini", "phonon"] { preparation.markReady(name) }
        activity.end()
        XCTAssertFalse(preparation.snapshot.firstTime)
    }

    func testASlowLoadMeansColdCachesEvenForAPreparedBuild() throws {
        let (defaults, cleanup) = try makeDefaults()
        defer { cleanup() }
        defaults.set("s", forKey: VoicePreparation.preparedKey)
        let preparation = VoicePreparation(defaults: defaults, signature: "s")
        XCTAssertFalse(preparation.snapshot.firstTime)
        preparation.noteLoad("eou", ms: 1_139)
        XCTAssertFalse(preparation.snapshot.firstTime, "a warm load")
        preparation.noteLoad("speaker", ms: 75_445)
        XCTAssertTrue(preparation.snapshot.firstTime)
        XCTAssertNil(defaults.string(forKey: VoicePreparation.preparedKey), "so the next launch prepares again")
    }

    func testUnloadedModelsAreNoLongerReady() throws {
        let (defaults, cleanup) = try makeDefaults()
        defer { cleanup() }
        let preparation = VoicePreparation(defaults: defaults, signature: "s")
        preparation.markReady("vad")
        preparation.markReady("eou")
        preparation.markUnloaded(["vad"])
        XCTAssertEqual(preparation.snapshot.ready, ["eou"])
    }

    func testListenersHearOnlyRealChangesUntilRemoved() throws {
        let (defaults, cleanup) = try makeDefaults()
        defer { cleanup() }
        let preparation = VoicePreparation(defaults: defaults, signature: "s")
        let heard = Heard()
        let token = preparation.observe { heard.add($0) }
        let activity = preparation.begin(wantsSpeaker: true)
        preparation.markReady("vad")
        preparation.markReady("vad")
        activity.end()
        XCTAssertEqual(heard.all.map(\.preparing), [true, true, false])
        XCTAssertEqual(heard.all.last?.ready, ["vad"])
        preparation.remove(token)
        preparation.markReady("eou")
        XCTAssertEqual(heard.all.count, 3)
    }

    private final class Heard: @unchecked Sendable {
        private let lock = NSLock()
        private var snapshots: [VoicePreparation.Snapshot] = []
        func add(_ snapshot: VoicePreparation.Snapshot) {
            lock.lock()
            snapshots.append(snapshot)
            lock.unlock()
        }
        var all: [VoicePreparation.Snapshot] {
            lock.lock()
            defer { lock.unlock() }
            return snapshots
        }
    }
}
