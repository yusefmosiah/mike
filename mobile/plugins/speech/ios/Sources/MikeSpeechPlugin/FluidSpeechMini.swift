import AVFoundation
import Foundation
import UIKit
#if canImport(FluidAudio)
import FluidAudio
#endif

/// Dictation with Fluid Speech Mini by FluidVoice (CC BY 4.0), a Core ML
/// speech model that ships inside the app (npm run speech-model fetches it
/// into FluidSpeechMini/, which Package.swift copies into the app bundle) and
/// runs on the Neural Engine through the FluidAudio package. English only.
/// Nothing leaves the phone, and neither audio nor text is logged.
///
/// Needs iOS 18. The model loads when a dictation starts recording (or, at the
/// latest, when it is transcribed) and is kept while the app is in the
/// foreground; it is dropped on a memory warning, when the app
/// goes to the background, and after five idle minutes.
enum FluidSpeechMini {
    /// The `engine` value the web app sends.
    static let engineName = "fluid-mini"

    /// The directory of the bundled model, or nil when the app was built
    /// without it. A Swift package copies its resources into a bundle named
    /// `<package>_<target>` inside the app.
    static func modelDirectory(in bundle: Bundle = .main) -> URL? {
        let directories = [bundle.url(forResource: "MikeSpeech_MikeSpeechPlugin", withExtension: "bundle"), bundle.resourceURL]
        for case let base? in directories {
            let directory = base.appendingPathComponent("FluidSpeechMini", isDirectory: true)
            if hasModel(at: directory) { return directory }
        }
        return nil
    }

    /// The pieces FluidAudio loads; the fetch script names the joint network
    /// as FluidAudio 0.17 expects it.
    static func hasModel(at directory: URL) -> Bool {
        ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Decoder.mlmodelc", "JointDecisionv3.mlmodelc", "parakeet_vocab.json"]
            .allSatisfy { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0).path) }
    }

    static func status(in bundle: Bundle = .main) -> OnDeviceSpeech.Status {
        guard #available(iOS 18.0, *), canTranscribe, modelDirectory(in: bundle) != nil else {
            return OnDeviceSpeech.Status(state: .unavailable, engine: nil, locale: nil)
        }
        return OnDeviceSpeech.Status(state: .available, engine: engineName, locale: "en")
    }

    private static var canTranscribe: Bool {
        #if canImport(FluidAudio)
        return true
        #else
        return false
        #endif
    }

    static func transcribe(file url: URL, in bundle: Bundle = .main) async throws -> String {
        guard #available(iOS 18.0, *) else { throw OnDeviceSpeech.Failure.unavailable }
        #if canImport(FluidAudio)
        guard let directory = modelDirectory(in: bundle) else { throw OnDeviceSpeech.Failure.unavailable }
        // Fail early, and with the right code, on a recording nothing can read.
        do { _ = try AVAudioFile(forReading: url) } catch { throw OnDeviceSpeech.Failure.unreadableAudio }
        return try await Runtime.shared.transcribe(file: url, modelDirectory: directory)
        #else
        throw OnDeviceSpeech.Failure.unavailable
        #endif
    }

    /// Loads the model ahead of a transcription (when recording starts), so
    /// that the seconds it takes overlap with the person speaking. Does
    /// nothing when the model is already loaded or cannot run here.
    static func prepare(in bundle: Bundle = .main) async {
        guard #available(iOS 18.0, *) else { return }
        #if canImport(FluidAudio)
        guard let directory = modelDirectory(in: bundle) else { return }
        await Runtime.shared.prepare(modelDirectory: directory)
        #endif
    }

    #if canImport(FluidAudio)
    @available(iOS 18.0, *)
    actor Runtime {
        static let shared = Runtime()
        static let idleLimit: Duration = .seconds(5 * 60)

        private var manager: AsrManager?
        private var running = 0
        private var idleTask: Task<Void, Never>?
        private var observers: [NSObjectProtocol] = []

        func transcribe(file url: URL, modelDirectory: URL) async throws -> String {
            idleTask?.cancel()
            running += 1
            defer {
                running -= 1
                scheduleUnload()
            }
            let manager: AsrManager
            do {
                manager = try loaded(modelDirectory)
            } catch {
                throw OnDeviceSpeech.Failure.failed
            }
            do {
                var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
                return try await manager.transcribe(url, decoderState: &state).text
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            } catch {
                throw OnDeviceSpeech.Failure.failed
            }
        }

        /// Loads the model and runs it once on a second of silence: Core ML
        /// specialises a model for the Neural Engine on its first prediction,
        /// not when it is loaded, and that first prediction is the slow part.
        func prepare(modelDirectory: URL) async {
            guard manager == nil else { return }
            idleTask?.cancel()
            running += 1
            defer {
                running -= 1
                scheduleUnload()
            }
            // A failure here surfaces, with its code, on the transcription.
            guard let manager = try? loaded(modelDirectory) else { return }
            var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
            _ = try? await manager.transcribe([Float](repeating: 0, count: 16_000), decoderState: &state)
        }

        private func loaded(_ directory: URL) throws -> AsrManager {
            if let manager { return manager }
            // loadLocal reads exactly this directory and never downloads.
            let models = try AsrModels.loadLocal(from: directory, version: .ultra)
            let created = AsrManager(config: .default, models: models)
            manager = created
            observe()
            return created
        }

        private func scheduleUnload() {
            idleTask?.cancel()
            guard manager != nil, running == 0 else { return }
            idleTask = Task {
                try? await Task.sleep(for: Self.idleLimit)
                guard !Task.isCancelled else { return }
                unload()
            }
        }

        /// Drops the model unless a transcription is running.
        func unload() {
            guard running == 0 else { return }
            idleTask?.cancel()
            manager = nil
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []
        }

        private func observe() {
            guard observers.isEmpty else { return }
            let center = NotificationCenter.default
            for name in [UIApplication.didReceiveMemoryWarningNotification, UIApplication.didEnterBackgroundNotification] {
                observers.append(center.addObserver(forName: name, object: nil, queue: nil) { _ in
                    Task { await Runtime.shared.unload() }
                })
            }
        }
    }
    #endif
}
