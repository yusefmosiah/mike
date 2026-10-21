import CoreML
import XCTest
@testable import MikeSpeechPlugin

/// Learning the person's voice and judging speech against it, on synthetic
/// embeddings: a voice is a random direction per model, its turns that
/// direction plus noise.
final class SpeakerProfileTests: XCTestCase {
    private struct Voices {
        private var seed: UInt64

        init(seed: UInt64) { self.seed = seed }

        mutating func next() -> Float {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Float(Int64(bitPattern: seed >> 11) % 2001 - 1000) / 1000
        }

        /// A voice as both models hear it.
        mutating func voice() -> SpeakerEmbeddings {
            Dictionary(uniqueKeysWithValues: SpeakerModelKind.allCases.map { kind in
                (kind, (0..<kind.dimensions).map { _ in next() })
            })
        }

        /// A turn in `voice`: about 0.9 alike to it, 0.8 to its other turns.
        mutating func turn(_ voice: SpeakerEmbeddings, noise: Float = 0.5) -> SpeakerEmbeddings {
            voice.mapValues { vector in vector.map { $0 + noise * next() } }
        }
    }

    private let rule = SpeakerRule()

    private func learned(_ voices: inout Voices, _ person: SpeakerEmbeddings, rule: SpeakerRule? = nil) -> SpeakerProfile {
        var profile = SpeakerProfile()
        for _ in 0..<SpeakerProfile.enrolTurns { _ = profile.learn(voices.turn(person), audioMs: 2000, rule: rule ?? self.rule) }
        return profile
    }

    func testTheVoiceIsLearnedFromThreeAlikeTurnsOfAtLeastOneAndAHalfSecondsInBothModels() {
        var voices = Voices(seed: 1)
        let person = voices.voice()
        var profile = SpeakerProfile()
        XCTAssertFalse(profile.learn(voices.turn(person), audioMs: 1400, rule: rule), "too short to learn from")
        XCTAssertTrue(profile.learn(voices.turn(person), audioMs: 2000, rule: rule))
        XCTAssertTrue(profile.learn(voices.turn(person), audioMs: 2000, rule: rule))
        XCTAssertFalse(profile.learned)
        XCTAssertTrue(profile.learn(voices.turn(person), audioMs: 2000, rule: rule))
        XCTAssertTrue(profile.learned)
        XCTAssertEqual(profile.centroid(.wespeaker)?.count, 256)
        XCTAssertEqual(profile.centroid(.campplus)?.count, 192)
        XCTAssertTrue(profile.candidates.isEmpty)
    }

    func testAnotherVoiceAmongTheFirstTurnsIsOutvoted() {
        var voices = Voices(seed: 2)
        let person = voices.voice()
        let television = voices.voice()
        var profile = SpeakerProfile()
        _ = profile.learn(voices.turn(television), audioMs: 3000, rule: rule)
        _ = profile.learn(voices.turn(person), audioMs: 3000, rule: rule)
        _ = profile.learn(voices.turn(television), audioMs: 3000, rule: rule)
        XCTAssertFalse(profile.learned, "two alike turns are not enough")
        _ = profile.learn(voices.turn(person), audioMs: 3000, rule: rule)
        _ = profile.learn(voices.turn(person), audioMs: 3000, rule: rule)
        XCTAssertTrue(profile.learned)
        XCTAssertEqual(profile.check(voices.turn(person), audioMs: 2000, rule: rule).outcome, .match)
        XCTAssertEqual(profile.check(voices.turn(television), audioMs: 2000, rule: rule).outcome, .mismatch)
    }

    func testOnlyTheLastSixLearningTurnsAreKept() {
        var voices = Voices(seed: 3)
        var profile = SpeakerProfile()
        for _ in 0..<8 { _ = profile.learn(voices.turn(voices.voice()), audioMs: 2000, rule: rule) }
        XCTAssertFalse(profile.learned)
        XCTAssertEqual(profile.candidates.count, SpeakerProfile.maxCandidates)
    }

    func testSpeechIsNotJudgedBeforeTheVoiceIsLearnedOrWhenTooShort() {
        var voices = Voices(seed: 4)
        let person = voices.voice()
        XCTAssertEqual(SpeakerProfile().check(voices.voice(), audioMs: 5000, rule: rule), .unknown)
        let profile = learned(&voices, person)
        let stranger = voices.voice()
        let short = profile.check(stranger, audioMs: 900, rule: rule)
        XCTAssertEqual(short.outcome, .unknown)
        XCTAssertEqual(short.similarities.count, 2, "scores are still given, for the log")
        XCTAssertEqual(profile.check([.wespeaker: [1, 2, 3]], audioMs: 5000, rule: rule).outcome, .unknown, "a malformed embedding")
        let verdict = profile.check(stranger, audioMs: 1000, rule: rule)
        XCTAssertEqual(verdict.outcome, .mismatch)
        XCTAssertLessThan(verdict.margin ?? 0, 0)
    }

    func testEachDeciderUsesItsOwnModelsAndThresholds() throws {
        var voices = Voices(seed: 7)
        let person = voices.voice()
        let profile = learned(&voices, person)
        // The person as WeSpeaker hears them; a stranger as CAM++ does.
        let mixed: SpeakerEmbeddings = [.wespeaker: voices.turn(person)[.wespeaker]!, .campplus: voices.voice()[.campplus]!]
        func verdict(_ decider: SpeakerDecider) -> SpeakerProfile.Verdict {
            profile.check(mixed, audioMs: 2000, rule: SpeakerRule(decider: decider))
        }
        XCTAssertEqual(verdict(.wespeaker).outcome, .match)
        XCTAssertEqual(verdict(.campplus).outcome, .mismatch)
        let wespeaker = try XCTUnwrap(verdict(.wespeaker).similarities[.wespeaker])
        let campplus = try XCTUnwrap(verdict(.wespeaker).similarities[.campplus])
        let both = try XCTUnwrap(verdict(.both).margin)
        XCTAssertEqual(both, ((wespeaker - 0.35) + (campplus - 0.55)) / 2, accuracy: 1e-5, "the mean of the two margins")
        let only: SpeakerEmbeddings = [.wespeaker: mixed[.wespeaker]!]
        XCTAssertEqual(profile.check(only, audioMs: 2000, rule: SpeakerRule(decider: .both)).outcome, .match, "a missing model is left out")
        XCTAssertEqual(profile.check(only, audioMs: 2000, rule: SpeakerRule(decider: .campplus)).outcome, .unknown)
    }

    func testALearnedVoiceAdaptsOnlyFromCloseMatches() {
        var voices = Voices(seed: 5)
        let person = voices.voice()
        var profile = learned(&voices, person)
        let before = profile.centroid(.wespeaker)
        XCTAssertFalse(profile.learn(voices.voice(), audioMs: 2000, rule: rule), "a stranger teaches nothing")
        XCTAssertEqual(profile.centroid(.wespeaker), before)
        XCTAssertFalse(profile.learn(voices.turn(person), audioMs: 1000, rule: rule), "nor a short turn")
        XCTAssertTrue(profile.learn(voices.turn(person), audioMs: 2000, rule: rule))
        XCTAssertNotEqual(profile.centroid(.wespeaker), before)
        let length = profile.centroid(.wespeaker)!.reduce(0) { $0 + $1 * $1 }.squareRoot()
        XCTAssertEqual(length, 1, accuracy: 1e-4)
    }

    func testAModelMissingWhenTheVoiceWasLearnedStartsFromALaterMatch() {
        var voices = Voices(seed: 8)
        let person = voices.voice()
        var profile = SpeakerProfile()
        for _ in 0..<3 { _ = profile.learn(voices.turn(person).filter { $0.key == .wespeaker }, audioMs: 2000, rule: rule) }
        XCTAssertNil(profile.centroid(.campplus))
        XCTAssertTrue(profile.learn(voices.turn(person, noise: 0.2), audioMs: 2000, rule: rule))
        XCTAssertEqual(profile.centroid(.campplus)?.count, 192)
    }

    func testCosineAndNormalisationRejectUnusableVectors() {
        let zero = [Float](repeating: 0, count: 256)
        var unit = zero
        unit[0] = 1
        XCTAssertNil(SpeakerProfile.normalised(zero))
        XCTAssertNil(SpeakerProfile.normalised([1, 0], kind: .wespeaker))
        XCTAssertNil(SpeakerProfile.cosine(unit, [1, 0]), "different lengths")
        var nan = unit
        nan[1] = .nan
        XCTAssertNil(SpeakerProfile.cosine(unit, nan))
        XCTAssertEqual(SpeakerProfile.cosine(unit, unit.map { $0 * 3 }) ?? 0, 1, accuracy: 1e-6)
    }

    func testTheProfileIsSavedLoadedAndRemoved() throws {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "speaker-\(UUID().uuidString)/speaker.json", directoryHint: .notDirectory)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        XCTAssertEqual(SpeakerStore.load(from: url), SpeakerProfile(), "nothing saved is an empty profile")
        var voices = Voices(seed: 6)
        let profile = learned(&voices, voices.voice())
        SpeakerStore.save(profile, to: url)
        XCTAssertEqual(SpeakerStore.load(from: url), profile)
        try Data(#"{"version":1,"centroid":[1]}"#.utf8).write(to: url)
        XCTAssertEqual(SpeakerStore.load(from: url), SpeakerProfile(), "an older profile is learned again")
        try Data("not json".utf8).write(to: url)
        XCTAssertEqual(SpeakerStore.load(from: url), SpeakerProfile(), "a damaged file is forgotten")
        SpeakerStore.remove(at: url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testCamPlusFeaturesHaveEachBinsMeanRemoved() throws {
        let features = try MLMultiArray(shape: [1, 3, 2], dataType: .float32)
        let values: [Float] = [1, 10, 2, 20, 6, 60]  // frames × bins
        for (index, value) in values.enumerated() { features[index] = NSNumber(value: value) }
        try SpeakerEmbedder.removeMean(features)
        let out = (0..<6).map { features[$0].floatValue }
        XCTAssertEqual(out, [-2, -20, -1, -10, 3, 30])
        XCTAssertThrowsError(try SpeakerEmbedder.removeMean(try MLMultiArray(shape: [3, 2], dataType: .float32)))
    }
}
