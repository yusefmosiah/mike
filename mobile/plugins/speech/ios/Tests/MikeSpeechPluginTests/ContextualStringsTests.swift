import XCTest
@testable import MikeSpeechPlugin

final class ContextualStringsTests: XCTestCase {
    func testNothingSentIsEmpty() {
        XCTAssertEqual(OnDeviceSpeech.contextualStrings(nil), [])
        XCTAssertEqual(OnDeviceSpeech.contextualStrings([]), [])
    }

    func testTrimsDropsBlanksAndRepeatsAndKeepsOrder() {
        let terms = OnDeviceSpeech.contextualStrings(["  Ximena Achterberg ", "", "  ", "ximena achterberg", "Okonkwo-Lindqvist"])
        XCTAssertEqual(terms, ["Ximena Achterberg", "Okonkwo-Lindqvist"])
    }

    func testDropsTermsOverSixtyFourCharacters() {
        let long = String(repeating: "a", count: 65)
        let fits = String(repeating: "b", count: 64)
        XCTAssertEqual(OnDeviceSpeech.contextualStrings([long, fits]), [fits])
    }

    func testKeepsAtMostOneHundredTheFirstOnes() {
        let many = (0..<150).map { "Term \($0)" }
        let terms = OnDeviceSpeech.contextualStrings(many)
        XCTAssertEqual(terms.count, 100)
        XCTAssertEqual(terms.first, "Term 0")
        XCTAssertEqual(terms.last, "Term 99")
    }
}
