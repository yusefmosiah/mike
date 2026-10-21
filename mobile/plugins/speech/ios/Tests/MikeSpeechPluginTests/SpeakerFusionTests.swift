import XCTest
@testable import MikeSpeechPlugin

/// The joined WeSpeaker and CAM++ space behind the "Both" check.
final class SpeakerFusionTests: XCTestCase {
    private struct Reference: Decodable {
        let wespeaker: [Float]
        let campplus: [Float]
        let fused: [Float]
    }

    private func reference() throws -> Reference {
        let url = Bundle.module.resourceURL!.appendingPathComponent("Fixtures/speaker-fusion-reference.json")
        return try JSONDecoder().decode(Reference.self, from: Data(contentsOf: url))
    }

    func testTheBundledHeadProjectsAsItWasTrained() throws {
        let fusion = try XCTUnwrap(SpeakerFusion.bundled)
        XCTAssertEqual(fusion.outputs, 150)
        let clip = try reference()
        let fused = try XCTUnwrap(fusion.project([.wespeaker: clip.wespeaker, .campplus: clip.campplus]))
        XCTAssertEqual(fused.count, 150)
        for (index, expected) in clip.fused.enumerated() {
            XCTAssertEqual(fused[index], expected, accuracy: 1e-4, "output \(index)")
        }
        XCTAssertNil(fusion.project([.wespeaker: clip.wespeaker]), "both models are needed")
        XCTAssertNil(fusion.project([.wespeaker: clip.wespeaker, .campplus: [1, 2, 3]]))
    }

    func testADamagedHeadIsRejected() throws {
        let url = try XCTUnwrap(SpeakerFusion.bundledURL())
        let data = try Data(contentsOf: url)
        XCTAssertThrowsError(try SpeakerFusion(data: data.dropLast(4)), "short")
        XCTAssertThrowsError(try SpeakerFusion(data: data + Data([0, 0, 0, 0])), "long")
        var wrongMagic = data
        wrongMagic[0] = UInt8(ascii: "X")
        XCTAssertThrowsError(try SpeakerFusion(data: wrongMagic))
        var wrongVersion = data
        wrongVersion[4] = 2
        XCTAssertThrowsError(try SpeakerFusion(data: wrongVersion))
    }

    func testBothDecidesInTheJoinedSpaceAndFallsBackToTheAverage() throws {
        let fusion = try XCTUnwrap(SpeakerFusion.bundled)
        let clip = try reference()
        let voice: SpeakerEmbeddings = [.wespeaker: clip.wespeaker, .campplus: clip.campplus]
        var profile = SpeakerProfile()
        for _ in 0..<SpeakerProfile.enrolTurns { _ = profile.learn(voice, audioMs: 2000, rule: SpeakerRule()) }
        XCTAssertTrue(profile.learned)
        let rule = SpeakerRule(decider: .both, fusion: fusion)
        let same = profile.check(voice, audioMs: 2000, rule: rule)
        XCTAssertEqual(same.outcome, .match)
        XCTAssertEqual(try XCTUnwrap(same.margin), 1 - rule.fusedThreshold, accuracy: 1e-4, "one voice scores 1 in the joined space")
        // A voice with every number reversed scores -1 there.
        let opposite = voice.mapValues { $0.map { -$0 } }
        XCTAssertEqual(profile.check(opposite, audioMs: 2000, rule: rule).outcome, .mismatch)
        // Without CAM++ the joined space cannot be used: WeSpeaker's margin decides.
        let only: SpeakerEmbeddings = [.wespeaker: clip.wespeaker]
        let fallback = profile.check(only, audioMs: 2000, rule: rule)
        XCTAssertEqual(try XCTUnwrap(fallback.margin), 1 - rule.threshold(.wespeaker), accuracy: 1e-4)
    }
}
