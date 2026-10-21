import CoreML
import XCTest
@testable import MikeSpeechPlugin

final class VoiceModelsTests: XCTestCase {
    // MARK: - Smart Turn input

    func testSmartTurnWindowIsTheLastEightSecondsRightAligned() {
        XCTAssertEqual(SmartTurn.windowSamples, 8 * 16_000)
        let short = SmartTurn.window([Float](repeating: 0.5, count: 16_000))
        XCTAssertEqual(short.count, 128_000)
        XCTAssertEqual(short[0], 0, "zeros at the front")
        XCTAssertEqual(short[128_000 - 16_001], 0)
        XCTAssertEqual(short[128_000 - 16_000], 0.5, "most recent audio last")
        XCTAssertEqual(short.last, 0.5)

        let long = SmartTurn.window((0..<200_000).map { Float($0) })
        XCTAssertEqual(long.count, 128_000)
        XCTAssertEqual(long.first, 72_000, "only the last 8 s are kept")
        XCTAssertEqual(long.last, 199_999)

        XCTAssertEqual(SmartTurn.window([Float]()), [Float](repeating: 0, count: 128_000))
    }

    func testSmartTurnInputIsOneByOneHundredTwentyEightThousandFloats() throws {
        let input = try SmartTurn.input([1, 2, 3])
        XCTAssertEqual(input.shape, [1, 128_000])
        XCTAssertEqual(input.dataType, .float32)
        XCTAssertEqual(input[127_997].floatValue, 1)
        XCTAssertEqual(input[127_999].floatValue, 3)
        XCTAssertEqual(input[0].floatValue, 0)
    }

    // MARK: - Audio kept for the final pass

    func testSampleRingAddressesByAbsoluteIndexAndForgetsTheOldest() {
        var ring = SampleRing(capacity: 100)
        ring.append((0..<80).map(Float.init))
        XCTAssertEqual(ring.slice(from: 10, to: 13), [10, 11, 12])
        ring.append((80..<200).map(Float.init))
        XCTAssertEqual(ring.end, 200)
        XCTAssertEqual(ring.slice(from: 0, to: 5), [], "older than the capacity")
        XCTAssertEqual(ring.slice(from: 150, to: 153), [150, 151, 152])
        XCTAssertEqual(ring.slice(from: 95, to: 102), [100, 101], "clamped to what is held")
        XCTAssertEqual(ring.slice(from: 198, to: 400), [198, 199])
        XCTAssertEqual(ring.slice(from: 300, to: 400), [])
    }

    func testUtteranceBoundsPadTheVadBoundsAndStayInsideTheAudio() {
        XCTAssertEqual(UtteranceBounds.samples(startMs: 1000, endMs: 2000, available: 100_000), 12_800..<36_800)
        XCTAssertEqual(UtteranceBounds.samples(startMs: 100, endMs: 2000, available: 33_000), 0..<33_000)
        XCTAssertEqual(UtteranceBounds.samples(startMs: 5000, endMs: 6000, available: 10_000).count, 0)
    }

    // MARK: - Downloads

    func testEveryModelIsPinnedToOneCommitOfItsUpstreamRepository() {
        let expected = [
            VoiceModelName.vad: "FluidInference/silero-vad-coreml",
            .eou: "FluidInference/parakeet-realtime-eou-120m-coreml",
            .smartTurn: "aufklarer/Smart-Turn-v3.2-CoreML",
            .speaker: "FluidInference/speaker-diarization-coreml",
        ]
        XCTAssertEqual(VoiceModels.downloaded.count, 4)
        for model in VoiceModels.downloaded {
            XCTAssertEqual(model.repository, expected[model.name])
            XCTAssertNotNil(model.revision.range(of: "^[0-9a-f]{40}$", options: .regularExpression))
            for file in model.files {
                XCTAssertNotNil(file.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression), file.path)
                XCTAssertGreaterThan(file.size, 0)
                let url = model.url(for: file).absoluteString
                XCTAssertTrue(url.hasPrefix("https://huggingface.co/\(model.repository)/resolve/\(model.revision)/"), url)
            }
        }
        XCTAssertTrue(VoiceModels.eou.url(for: VoiceModels.eou.files[0]).absoluteString.contains("/resolve/\(VoiceModels.eou.revision)/320ms/"))
        XCTAssertTrue(VoiceModels.vad.files.allSatisfy { $0.path.hasPrefix(VoiceModels.vadFile + "/") })
        XCTAssertTrue(VoiceModels.smartTurn.files.contains { $0.path == "smart_turn.mlmodelc/weights/weight.bin" })
        XCTAssertEqual(VoiceModels.eou.totalBytes, 224_238_270)
        XCTAssertTrue(VoiceModels.speaker.files.allSatisfy { $0.path.hasPrefix(SpeakerEmbedder.modelFile + "/") })
        XCTAssertEqual(VoiceModels.speaker.totalBytes, 7_954_144)
    }

    func testFilesAreKeptOnlyWhenSizeAndHashMatch() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("voice-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("file.bin")
        try Data("hello".utf8).write(to: url)
        let hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        XCTAssertTrue(try VoiceModels.matches(url, .init(path: "file.bin", size: 5, sha256: hello)))
        XCTAssertFalse(try VoiceModels.matches(url, .init(path: "file.bin", size: 6, sha256: hello)))
        XCTAssertFalse(try VoiceModels.matches(url, .init(path: "file.bin", size: 5, sha256: String(repeating: "0", count: 64))))
        XCTAssertFalse(try VoiceModels.matches(directory.appendingPathComponent("missing"), .init(path: "missing", size: 5, sha256: hello)))
    }

    func testModelsLiveInApplicationSupportNotTheBundle() {
        XCTAssertTrue(VoiceModels.root.path.contains("Application Support/MikeVoice/models"))
        XCTAssertEqual(VoiceModels.vad.directory.lastPathComponent, "vad")
        XCTAssertEqual(VoiceModels.smartTurn.directory.lastPathComponent, "smart-turn")
    }

    func testStaleStagingFoldersOfOtherCommitsAreDeleted() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: VoiceModels.root, withIntermediateDirectories: true)
        let model = VoiceModels.smartTurn
        let current = VoiceModels.root.appendingPathComponent(VoiceModels.stagingName(model))
        let stale = VoiceModels.root.appendingPathComponent("\(model.name.rawValue).partial-0123456789ab")
        let other = VoiceModels.root.appendingPathComponent("vad.partial-0123456789ab")
        for url in [current, stale, other] { try fm.createDirectory(at: url, withIntermediateDirectories: true) }
        defer { for url in [current, stale, other] { try? fm.removeItem(at: url) } }
        XCTAssertEqual(VoiceModels.stagingName(model), "smart-turn.partial-75f069717f50")
        VoiceModels.removeStaleStaging(model)
        XCTAssertTrue(fm.fileExists(atPath: current.path), "the current commit's partial download is kept to resume")
        XCTAssertFalse(fm.fileExists(atPath: stale.path))
        XCTAssertTrue(fm.fileExists(atPath: other.path), "another model's staging is not touched")
    }

    func testRemoveDeletesEveryDownloadedVoiceModel() async throws {
        let fm = FileManager.default
        let marker = VoiceModels.vad.directory.appendingPathComponent("marker")
        try fm.createDirectory(at: VoiceModels.vad.directory, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: marker)
        await VoiceMode.remove()
        XCTAssertFalse(fm.fileExists(atPath: VoiceModels.root.path))
        let status = await VoiceMode.status()
        XCTAssertTrue(status.missing.contains("vad"))
        XCTAssertFalse(status.available)
    }
}
