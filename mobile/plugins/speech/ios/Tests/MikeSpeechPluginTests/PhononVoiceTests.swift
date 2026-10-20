import XCTest
@testable import MikeSpeechPlugin

final class PhononVoiceTests: XCTestCase {
    func testWavHasA44ByteHeaderAndSixteenBitMonoSamples() {
        let data = PhononVoice.wav(samples: [0, 1, -1, 2, -2], sampleRate: 24_000)
        XCTAssertEqual(data.count, 44 + 5 * 2)
        XCTAssertEqual(String(decoding: data[0..<4], as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: data[8..<16], as: UTF8.self), "WAVEfmt ")
        XCTAssertEqual(String(decoding: data[36..<40], as: UTF8.self), "data")
        func le32(_ at: Int) -> Int { (0..<4).reduce(0) { $0 | Int(data[at + $1]) << (8 * $1) } }
        func le16(_ at: Int) -> Int { Int(data[at]) | Int(data[at + 1]) << 8 }
        XCTAssertEqual(le32(4), 36 + 10)
        XCTAssertEqual(le16(20), 1)
        XCTAssertEqual(le16(22), 1)
        XCTAssertEqual(le32(24), 24_000)
        XCTAssertEqual(le32(28), 48_000)
        XCTAssertEqual(le16(34), 16)
        XCTAssertEqual(le32(40), 10)
        // 0, full scale, negative full scale, then the two out-of-range samples clamped.
        XCTAssertEqual(Int16(bitPattern: UInt16(le16(44))), 0)
        XCTAssertEqual(Int16(bitPattern: UInt16(le16(46))), 32767)
        XCTAssertEqual(Int16(bitPattern: UInt16(le16(48))), -32767)
        XCTAssertEqual(Int16(bitPattern: UInt16(le16(50))), 32767)
        XCTAssertEqual(Int16(bitPattern: UInt16(le16(52))), -32767)
    }

    func testServesTheModelFromOnePinnedCommit() async {
        let url = PhononVoice.modelBaseURL.absoluteString
        XCTAssertTrue(url.hasPrefix("https://huggingface.co/mosiah/phonon-31m-en-coreml/resolve/"))
        XCTAssertNotNil(url.range(of: "/resolve/[0-9a-f]{40}/$", options: .regularExpression))
        let status = await PhononVoice.status()
        XCTAssertNotEqual(status.state, "installing")
        XCTAssertEqual(status.payload["engine"] as? String, "phonon")
    }

    func testRefusesEmptyTextAndTextBeforeTheModelIsInstalled() async {
        do {
            _ = try await PhononVoice.render(text: "  ", voice: nil)
            XCTFail("empty text must fail")
        } catch PhononVoice.Failure.empty {}
        catch { XCTFail("wrong failure \(error)") }
        do {
            _ = try await PhononVoice.render(text: "Hello.", voice: nil)
            XCTFail("an uninstalled model must fail")
        } catch PhononVoice.Failure.notInstalled {}
        catch { XCTFail("wrong failure \(error)") }
    }
}
