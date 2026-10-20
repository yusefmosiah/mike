import XCTest
@testable import MikeSpeechPlugin

/// Runs Fluid Speech Mini on a clip made with macOS `say`:
///   say -o dictation.m4a --data-format=aac "Hello, this is a test of dictation. ..."
/// Needs the model (`npm run speech-model` in mobile/) and iOS 18; without
/// either the test is skipped. Run it in the simulator:
///   xcodebuild test -scheme MikeSpeech -destination 'platform=iOS Simulator,name=iPhone 17'
final class FluidSpeechMiniTests: XCTestCase {
    /// The plugin's resource bundle, which sits beside the test bundle.
    private var pluginBundle: Bundle? {
        let beside = Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
        return Bundle(url: beside.appendingPathComponent("MikeSpeech_MikeSpeechPlugin.bundle"))
    }

    func testReportsUnavailableWithoutTheModel() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("empty-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let empty = try XCTUnwrap(Bundle(url: directory))
        XCTAssertEqual(FluidSpeechMini.status(in: empty).state, .unavailable)
    }

    func testTranscribesTheDictationClip() async throws {
        guard #available(iOS 18.0, *) else { throw XCTSkip("Fluid Speech Mini needs iOS 18") }
        let bundle = try XCTUnwrap(pluginBundle)
        guard FluidSpeechMini.modelDirectory(in: bundle) != nil else { throw XCTSkip("model not fetched") }
        XCTAssertEqual(FluidSpeechMini.status(in: bundle).state, .available)
        XCTAssertEqual(FluidSpeechMini.status(in: bundle).engine, FluidSpeechMini.engineName)

        let fixtures = Bundle.module.resourceURL!.appendingPathComponent("Fixtures")
        let clip = fixtures.appendingPathComponent("dictation.m4a")

        let started = Date()
        let text = try await FluidSpeechMini.transcribe(file: clip, in: bundle)
        print("FLUID-MINI first call (model load + transcribe): \(Date().timeIntervalSince(started)) s")
        print("FLUID-MINI text: \(text)")
        XCTAssertEqual(
            text,
            "Hello, this is a test of dictation. Can it handle punctuation, numbers like $25, and capital letters in London?")

        let again = Date()
        _ = try await FluidSpeechMini.transcribe(file: clip, in: bundle)
        print("FLUID-MINI second call: \(Date().timeIntervalSince(again)) s")
    }

    func testPreparingLoadsTheModelBeforeTheTranscription() async throws {
        guard #available(iOS 18.0, *) else { throw XCTSkip("Fluid Speech Mini needs iOS 18") }
        let bundle = try XCTUnwrap(pluginBundle)
        guard FluidSpeechMini.modelDirectory(in: bundle) != nil else { throw XCTSkip("model not fetched") }
        await FluidSpeechMini.Runtime.shared.unload()
        let clip = Bundle.module.resourceURL!.appendingPathComponent("Fixtures/dictation.m4a")

        let preparing = Date()
        await FluidSpeechMini.prepare(in: bundle)
        print("FLUID-MINI prepare (model load): \(Date().timeIntervalSince(preparing)) s")
        let transcribing = Date()
        let text = try await FluidSpeechMini.transcribe(file: clip, in: bundle)
        print("FLUID-MINI transcribe after prepare: \(Date().timeIntervalSince(transcribing)) s")
        XCTAssertTrue(text.hasPrefix("Hello, this is a test of dictation."))
    }

    func testPreparingWithoutTheModelDoesNothing() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("empty-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        await FluidSpeechMini.prepare(in: try XCTUnwrap(Bundle(url: directory)))
    }

    func testRejectsAnUnreadableRecording() async throws {
        guard #available(iOS 18.0, *) else { throw XCTSkip("Fluid Speech Mini needs iOS 18") }
        let bundle = try XCTUnwrap(pluginBundle)
        guard FluidSpeechMini.modelDirectory(in: bundle) != nil else { throw XCTSkip("model not fetched") }
        let junk = FileManager.default.temporaryDirectory.appendingPathComponent("junk-\(UUID().uuidString).m4a")
        try Data("not audio".utf8).write(to: junk)
        defer { try? FileManager.default.removeItem(at: junk) }
        do {
            _ = try await FluidSpeechMini.transcribe(file: junk, in: bundle)
            XCTFail("expected a failure")
        } catch let failure as OnDeviceSpeech.Failure {
            XCTAssertEqual(failure.code, "unsupported-audio")
        }
    }
}
