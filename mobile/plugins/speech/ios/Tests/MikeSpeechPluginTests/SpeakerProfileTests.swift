import XCTest
@testable import MikeSpeechPlugin

/// Learning the person's voice and judging speech against it, on synthetic
/// embeddings: a voice is a random direction, its turns that direction plus noise.
final class SpeakerProfileTests: XCTestCase {
    private struct Voices {
        private var seed: UInt64

        init(seed: UInt64) { self.seed = seed }

        mutating func next() -> Float {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Float(Int64(bitPattern: seed >> 11) % 2001 - 1000) / 1000
        }

        mutating func voice() -> [Float] { (0..<SpeakerProfile.dimensions).map { _ in next() } }

        /// A turn in `voice`: about 0.9 alike to it, 0.8 to its other turns.
        mutating func turn(_ voice: [Float]) -> [Float] { voice.map { $0 + 0.5 * next() } }
    }

    private let threshold: Float = 0.35

    func testTheVoiceIsLearnedFromThreeAlikeTurnsOfAtLeastOneAndAHalfSeconds() {
        var voices = Voices(seed: 1)
        let person = voices.voice()
        var profile = SpeakerProfile()
        XCTAssertFalse(profile.learn(voices.turn(person), audioMs: 1400, threshold: threshold), "too short to learn from")
        XCTAssertTrue(profile.learn(voices.turn(person), audioMs: 2000, threshold: threshold))
        XCTAssertTrue(profile.learn(voices.turn(person), audioMs: 2000, threshold: threshold))
        XCTAssertFalse(profile.learned)
        XCTAssertTrue(profile.learn(voices.turn(person), audioMs: 2000, threshold: threshold))
        XCTAssertTrue(profile.learned)
        XCTAssertTrue(profile.candidates.isEmpty)
    }

    func testAnotherVoiceAmongTheFirstTurnsIsOutvoted() {
        var voices = Voices(seed: 2)
        let person = voices.voice()
        let television = voices.voice()
        var profile = SpeakerProfile()
        _ = profile.learn(voices.turn(television), audioMs: 3000, threshold: threshold)
        _ = profile.learn(voices.turn(person), audioMs: 3000, threshold: threshold)
        _ = profile.learn(voices.turn(television), audioMs: 3000, threshold: threshold)
        XCTAssertFalse(profile.learned, "two alike turns are not enough")
        _ = profile.learn(voices.turn(person), audioMs: 3000, threshold: threshold)
        _ = profile.learn(voices.turn(person), audioMs: 3000, threshold: threshold)
        XCTAssertTrue(profile.learned)
        guard case .match = profile.check(voices.turn(person), audioMs: 2000, threshold: threshold) else {
            return XCTFail("the person's voice was learned")
        }
        guard case .mismatch = profile.check(voices.turn(television), audioMs: 2000, threshold: threshold) else {
            return XCTFail("the television's was not")
        }
    }

    func testOnlyTheLastSixLearningTurnsAreKept() {
        var voices = Voices(seed: 3)
        var profile = SpeakerProfile()
        for _ in 0..<8 { _ = profile.learn(voices.turn(voices.voice()), audioMs: 2000, threshold: threshold) }
        XCTAssertFalse(profile.learned)
        XCTAssertEqual(profile.candidates.count, SpeakerProfile.maxCandidates)
    }

    func testSpeechIsNotJudgedBeforeTheVoiceIsLearnedOrWhenTooShortOrWhenOff() {
        var voices = Voices(seed: 4)
        let person = voices.voice()
        var profile = SpeakerProfile()
        XCTAssertEqual(profile.check(voices.voice(), audioMs: 5000, threshold: threshold), .unknown)
        for _ in 0..<3 { _ = profile.learn(voices.turn(person), audioMs: 2000, threshold: threshold) }
        let stranger = voices.voice()
        XCTAssertEqual(profile.check(stranger, audioMs: 900, threshold: threshold), .unknown)
        XCTAssertEqual(profile.check(stranger, audioMs: 5000, threshold: 0), .unknown)
        XCTAssertEqual(profile.check([1, 2, 3], audioMs: 5000, threshold: threshold), .unknown, "a malformed embedding")
        guard case let .mismatch(similarity) = profile.check(stranger, audioMs: 1000, threshold: threshold) else {
            return XCTFail("a stranger at a second of speech")
        }
        XCTAssertLessThan(similarity, threshold)
    }

    func testALearnedVoiceAdaptsOnlyFromCloseMatches() {
        var voices = Voices(seed: 5)
        let person = voices.voice()
        var profile = SpeakerProfile()
        for _ in 0..<3 { _ = profile.learn(voices.turn(person), audioMs: 2000, threshold: threshold) }
        let learned = profile.centroid
        XCTAssertFalse(profile.learn(voices.voice(), audioMs: 2000, threshold: threshold), "a stranger teaches nothing")
        XCTAssertEqual(profile.centroid, learned)
        XCTAssertFalse(profile.learn(voices.turn(person), audioMs: 1000, threshold: threshold), "nor a short turn")
        XCTAssertTrue(profile.learn(voices.turn(person), audioMs: 2000, threshold: threshold))
        XCTAssertNotEqual(profile.centroid, learned)
        let length = profile.centroid!.reduce(0) { $0 + $1 * $1 }.squareRoot()
        XCTAssertEqual(length, 1, accuracy: 1e-4)
    }

    func testCosineAndNormalisationRejectUnusableVectors() {
        let zero = [Float](repeating: 0, count: SpeakerProfile.dimensions)
        var unit = zero
        unit[0] = 1
        XCTAssertNil(SpeakerProfile.normalised(zero))
        XCTAssertNil(SpeakerProfile.normalised([1, 0]))
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
        let person = voices.voice()
        var profile = SpeakerProfile()
        for _ in 0..<3 { _ = profile.learn(voices.turn(person), audioMs: 2000, threshold: threshold) }
        SpeakerStore.save(profile, to: url)
        XCTAssertEqual(SpeakerStore.load(from: url), profile)
        try Data("not json".utf8).write(to: url)
        XCTAssertEqual(SpeakerStore.load(from: url), SpeakerProfile(), "a damaged file is forgotten")
        SpeakerStore.remove(at: url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
