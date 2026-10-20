import AVFoundation
import XCTest
@testable import MikeSpeechPlugin

#if canImport(FluidAudio)

/// Plays a clip into the live pipeline in real time, as a microphone would.
@available(iOS 18.0, *)
private final class ClipSource: LiveAudioSource, @unchecked Sendable {
    private let url: URL
    private let chunkSeconds: Double
    private var feeding: Task<Void, Never>?
    private(set) var stopped = false
    /// Resolves once the whole clip has been delivered.
    private let finishedFeeding = AsyncStream<Void>.makeStream()

    init(url: URL, chunkSeconds: Double = 0.25) {
        self.url = url
        self.chunkSeconds = chunkSeconds
    }

    func prepare() async throws {}

    func start(
        deliver: @escaping @Sendable (AVAudioPCMBuffer) -> Void,
        interrupted: @escaping @Sendable () -> Void
    ) throws {
        let file = try AVAudioFile(forReading: url)
        let frames = AVAudioFrameCount(file.processingFormat.sampleRate * chunkSeconds)
        let pause = chunkSeconds
        let done = finishedFeeding.1
        feeding = Task.detached {
            while !Task.isCancelled, file.framePosition < file.length {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames),
                      (try? file.read(into: buffer)) != nil, buffer.frameLength > 0 else { break }
                deliver(buffer)
                try? await Task.sleep(for: .seconds(pause))
            }
            done.yield()
            done.finish()
        }
    }

    func stop() {
        stopped = true
        feeding?.cancel()
    }

    func waitUntilFed() async {
        for await _ in finishedFeeding.0 { return }
    }
}

@available(iOS 18.0, *)
private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [LiveDictationSession.Event] = []
    func add(_ event: LiveDictationSession.Event) { lock.lock(); events.append(event); lock.unlock() }
    var all: [LiveDictationSession.Event] { lock.lock(); defer { lock.unlock() }; return events }
    var transcripts: [(confirmed: String, volatile: String, ended: Bool)] {
        all.compactMap { if case let .transcript(c, v, e) = $0 { return (c, v, e) } else { return nil } }
    }
    var levels: [Float] {
        all.compactMap { if case let .level(l) = $0 { return l } else { return nil } }
    }
}

final class LiveDictationTests: XCTestCase {
    private var pluginBundle: Bundle? {
        let beside = Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
        return Bundle(url: beside.appendingPathComponent("MikeSpeech_MikeSpeechPlugin.bundle"))
    }

    private func words(_ text: String) -> [String] {
        text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted.subtracting(CharacterSet(charactersIn: "$")))
            .filter { !$0.isEmpty }
    }

    func testReportsLiveInTheStatus() throws {
        guard #available(iOS 18.0, *) else { throw XCTSkip("Fluid Speech Mini needs iOS 18") }
        let bundle = try XCTUnwrap(pluginBundle)
        guard FluidSpeechMini.modelDirectory(in: bundle) != nil else { throw XCTSkip("model not fetched") }
        let status = FluidSpeechMini.status(in: bundle)
        XCTAssertTrue(status.live)
        XCTAssertTrue(MikeSpeechPlugin.payload(status)["live"] as? Bool == true)
        XCTAssertNil(MikeSpeechPlugin.payload(OnDeviceSpeech.Status(state: .available, engine: "sf-speech", locale: "en"))["live"])
    }

    func testLiveDictationOfTheClipMatchesTheClipTranscription() async throws {
        guard #available(iOS 18.0, *) else { throw XCTSkip("Fluid Speech Mini needs iOS 18") }
        let bundle = try XCTUnwrap(pluginBundle)
        guard let directory = FluidSpeechMini.modelDirectory(in: bundle) else { throw XCTSkip("model not fetched") }
        let clip = Bundle.module.resourceURL!.appendingPathComponent("Fixtures/dictation.m4a")
        let expected = try await FluidSpeechMini.transcribe(file: clip, in: bundle)

        let source = ClipSource(url: clip)
        let collected = Collected()
        try await LiveDictation.shared.start(modelDirectory: directory, source: source) { collected.add($0) }
        await source.waitUntilFed()
        // The simulator has no Neural Engine, so a window takes several seconds
        // there; give the first update time to arrive. On a phone it arrives
        // while the clip is still playing. Either way it comes before finish().
        let deadline = Date().addingTimeInterval(180)
        while collected.transcripts.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(200)) }
        let updatesBeforeStop = collected.transcripts.count
        let started = Date()
        let text = try await LiveDictation.shared.stop()
        print("LIVE-DICTATION updates before stop: \(updatesBeforeStop), stop took \(Date().timeIntervalSince(started)) s")

        XCTAssertGreaterThan(updatesBeforeStop, 0, "text should arrive while the clip is still playing")
        XCTAssertFalse(collected.levels.isEmpty, "level events")
        XCTAssertTrue(source.stopped, "the source is released on stop")
        XCTAssertEqual(words(text), words(expected), "live: \(text) / clip: \(expected)")

        // The Runtime may unload once the live session is over.
        await FluidSpeechMini.Runtime.shared.unload()
    }

    func testCancelDiscardsAndReleasesTheSource() async throws {
        guard #available(iOS 18.0, *) else { throw XCTSkip("Fluid Speech Mini needs iOS 18") }
        let bundle = try XCTUnwrap(pluginBundle)
        guard let directory = FluidSpeechMini.modelDirectory(in: bundle) else { throw XCTSkip("model not fetched") }
        let clip = Bundle.module.resourceURL!.appendingPathComponent("Fixtures/dictation.m4a")
        let source = ClipSource(url: clip)
        try await LiveDictation.shared.start(modelDirectory: directory, source: source) { _ in }
        await LiveDictation.shared.cancel()
        XCTAssertTrue(source.stopped)
        do {
            _ = try await LiveDictation.shared.stop()
            XCTFail("nothing to stop after a cancel")
        } catch let failure as OnDeviceSpeech.Failure {
            XCTAssertEqual(failure.code, "failed")
        }
    }

    func testTheModelStaysLoadedWhileLiveRuns() async throws {
        guard #available(iOS 18.0, *) else { throw XCTSkip("Fluid Speech Mini needs iOS 18") }
        let bundle = try XCTUnwrap(pluginBundle)
        guard let directory = FluidSpeechMini.modelDirectory(in: bundle) else { throw XCTSkip("model not fetched") }
        let clip = Bundle.module.resourceURL!.appendingPathComponent("Fixtures/dictation.m4a")
        let source = ClipSource(url: clip)
        try await LiveDictation.shared.start(modelDirectory: directory, source: source) { _ in }
        await FluidSpeechMini.Runtime.shared.unload()  // as a memory warning would
        let loaded = await FluidSpeechMini.Runtime.shared.isLoaded
        XCTAssertTrue(loaded, "the runtime must not unload during a live dictation")
        await LiveDictation.shared.cancel()
        await FluidSpeechMini.Runtime.shared.unload()
        let after = await FluidSpeechMini.Runtime.shared.isLoaded
        XCTAssertFalse(after)
    }

    func testLevelIsZeroForSilenceAndRisesWithSound() throws {
        guard #available(iOS 18.0, *) else { throw XCTSkip("needs iOS 18") }
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160)!
        buffer.frameLength = 160
        XCTAssertEqual(LiveDictationSession.level(of: buffer), 0)
        for index in 0..<160 { buffer.floatChannelData![0][index] = 0.1 }
        XCTAssertGreaterThan(LiveDictationSession.level(of: buffer), 0.3)
        buffer.frameLength = 0
        XCTAssertEqual(LiveDictationSession.level(of: buffer), 0)
    }
}

#endif
