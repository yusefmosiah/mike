import Foundation
import UIKit
#if canImport(PhononTTS)
import PhononTTS
#endif

/// Read-aloud with Phonon 31m by Gradium (Apache-2.0): a Core ML speech model
/// that runs on the Neural Engine through the xn-ptts package (module
/// PhononTTS). English only. Nothing leaves the phone except the model's own
/// download, and neither text nor audio is logged.
///
/// The model is not in the app. The person asks for it in Settings → Voice, and
/// `install` fetches it from the public Hugging Face repository named below,
/// pinned to a commit, with every file checked against its `bundle.json`
/// (`PhononModels.download`, which resumes an interrupted download). It lives
/// in Application Support, excluded from backup, and `remove` deletes it.
///
/// Needs iOS 18. The first reading after a download compiles the models for
/// this phone (about 10 seconds); later loads take under a second. The model
/// loads on the first reading and is kept while the app is in the foreground;
/// it is dropped on a memory warning and after five idle minutes.
enum PhononVoice {
    /// The `engine` value the web app sends.
    static let engineName = "phonon"

    /// Where the model is served from: the repository's files at one commit,
    /// so a later change to the repository never reaches a phone unannounced.
    static let modelBaseURL = URL(
        string: "https://huggingface.co/mosiah/phonon-31m-en-coreml/resolve/0a2596e9154f0340005b6445514fdd57f7bc9ddb/"
    )!

    enum Failure: Error {
        case empty
        case notInstalled
        /// Hands-free voice mode holds the voice; read-aloud waits for it to end.
        case busy
        case failed

        var code: String {
            switch self {
            case .empty: return "empty-text"
            case .notInstalled: return "not-installed"
            case .busy: return "busy"
            case .failed: return "failed"
            }
        }
    }

    struct Status: Equatable {
        /// "not-installed", "installing", "available" or "unavailable".
        let state: String
        let progress: Double?
        /// The next reading first compiles the models.
        let compiling: Bool

        var payload: [String: Any] {
            var result: [String: Any] = ["state": state, "engine": PhononVoice.engineName]
            if let progress { result["progress"] = progress }
            if compiling { result["compiling"] = true }
            return result
        }
    }

    private static let unavailable = Status(state: "unavailable", progress: nil, compiling: false)

    private static var canSpeak: Bool {
        #if canImport(PhononTTS)
        return true
        #else
        return false
        #endif
    }

    static func status() async -> Status {
        guard #available(iOS 18.0, *), canSpeak else { return unavailable }
        #if canImport(PhononTTS)
        return await Runtime.shared.status()
        #else
        return unavailable
        #endif
    }

    static func install() async throws {
        guard #available(iOS 18.0, *), canSpeak else { throw Failure.failed }
        #if canImport(PhononTTS)
        try await Runtime.shared.install()
        #endif
    }

    /// Whether hands-free voice mode holds the voice (read-aloud and removal wait).
    static func inVoiceMode() async -> Bool {
        guard #available(iOS 18.0, *) else { return false }
        #if canImport(PhononTTS)
        return await Runtime.shared.inVoiceMode
        #else
        return false
        #endif
    }

    static func remove() async {
        guard #available(iOS 18.0, *) else { return }
        #if canImport(PhononTTS)
        await Runtime.shared.remove()
        #endif
    }

    /// `text` spoken by the Phonon voice named `voice` (or its default), as a
    /// 16-bit mono WAV at 24 kHz.
    static func render(text: String, voice: String?) async throws -> Data {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw Failure.empty }
        guard #available(iOS 18.0, *), canSpeak else { throw Failure.notInstalled }
        #if canImport(PhononTTS)
        return wav(samples: try await Runtime.shared.synthesize(trimmed, voice: voice), sampleRate: 24_000)
        #else
        throw Failure.notInstalled
        #endif
    }

    /// Mono float samples as a 16-bit PCM WAV file.
    static func wav(samples: [Float], sampleRate: Int) -> Data {
        var pcm = Data(capacity: samples.count * 2)
        for sample in samples {
            let clamped = max(-1, min(1, sample))
            withUnsafeBytes(of: Int16((clamped * 32767).rounded()).littleEndian) { pcm.append(contentsOf: $0) }
        }
        func le32(_ value: Int) -> Data { withUnsafeBytes(of: UInt32(value).littleEndian) { Data($0) } }
        func le16(_ value: Int) -> Data { withUnsafeBytes(of: UInt16(value).littleEndian) { Data($0) } }
        var header = Data("RIFF".utf8)
        header += le32(36 + pcm.count)
        header += Data("WAVEfmt ".utf8)
        header += le32(16) + le16(1) + le16(1) + le32(sampleRate) + le32(sampleRate * 2) + le16(2) + le16(16)
        header += Data("data".utf8)
        header += le32(pcm.count)
        return header + pcm
    }

    #if canImport(PhononTTS)
    @available(iOS 18.0, *)
    actor Runtime {
        static let shared = Runtime()
        static let idleLimit: Duration = .seconds(5 * 60)

        private var phonon: Phonon?
        private var running = 0
        /// Voice mode's hold on the instance (0 or 1).
        private var voiceHolds = 0
        private var idleTask: Task<Void, Never>?
        private var installTask: Task<Void, Error>?
        private var progress = 0.0
        private var compiling = false
        /// Whether the loaded instance has spoken once (it conditions on its voice then).
        private var warm = false
        private var observers: [NSObjectProtocol] = []

        func status() -> Status {
            if installTask != nil { return Status(state: "installing", progress: progress, compiling: compiling) }
            let directory = PhononModels.defaultDirectory
            guard PhononModels.isInstalled(at: directory) else {
                return Status(state: "not-installed", progress: nil, compiling: false)
            }
            return Status(state: "available", progress: nil, compiling: phonon == nil && Phonon.needsCompiling(directory))
        }

        /// Downloads the model, then loads it once so Core ML compiles it for
        /// this phone (about ten seconds) as part of the install rather than on
        /// the first reading; the loaded model is kept for that reading. A
        /// second call while one is running joins it.
        func install() async throws {
            if let installTask {
                try await installTask.value
                return
            }
            progress = 0
            compiling = false
            let task = Task<Void, Error> {
                _ = try await PhononModels.download(from: PhononVoice.modelBaseURL) { fraction in
                    Task { await Runtime.shared.setProgress(fraction) }
                }
                try Task.checkCancellation()
                try await Runtime.shared.compile()
            }
            installTask = task
            defer { installTask = nil }
            do {
                try await task.value
            } catch {
                throw Failure.failed
            }
        }

        private func compile() async throws {
            progress = 1
            compiling = true
            defer { compiling = false }
            _ = try await loaded()
            scheduleUnload()
        }

        private func setProgress(_ fraction: Double) {
            progress = max(progress, min(1, fraction))
        }

        /// Cancels a download, drops the loaded model and deletes the files.
        func remove() {
            installTask?.cancel()
            installTask = nil
            unload(force: true)
            let directory = PhononModels.defaultDirectory
            try? FileManager.default.removeItem(at: directory)
            // A download that was cut short leaves its staging folders beside it.
            let parent = directory.deletingLastPathComponent()
            let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: parent.path)) ?? []
            for name in leftovers where name.hasPrefix("\(directory.lastPathComponent).partial") {
                try? FileManager.default.removeItem(at: parent.appendingPathComponent(name))
            }
        }

        /// Whether voice mode is using the instance (read-aloud refuses then).
        var inVoiceMode: Bool { voiceHolds > 0 }

        func synthesize(_ text: String, voice: String?) async throws -> [Float] {
            // Fail fast rather than queue behind (or re-voice) a conversation.
            guard voiceHolds == 0 else { throw Failure.busy }
            idleTask?.cancel()
            running += 1
            defer {
                running -= 1
                scheduleUnload()
            }
            let tts: Phonon
            do {
                tts = try await loaded()
            } catch let failure as Failure {
                throw failure
            } catch {
                throw Failure.failed
            }
            // Voice mode may have started while the model loaded.
            guard voiceHolds == 0 else { throw Failure.busy }
            do {
                if let voice, voice != tts.voice, tts.voices.contains(voice) { try await tts.setVoice(voice) }
                guard voiceHolds == 0 else { throw Failure.busy }
                return try await tts.synthesize(text)
            } catch let failure as Failure {
                throw failure
            } catch {
                throw Failure.failed
            }
        }

        /// The loaded model for hands-free voice mode, which streams clauses
        /// through it into its own audio engine. The model stays loaded until
        /// `endVoice` (a memory warning does not drop it mid-conversation).
        /// Voice mode and read-aloud share this one instance; Phonon serialises
        /// their calls.
        func beginVoice(voice: String?) async throws -> Phonon {
            idleTask?.cancel()
            let tts: Phonon
            do {
                tts = try await loaded()
            } catch let failure as Failure {
                throw failure
            } catch {
                throw Failure.failed
            }
            running += 1
            voiceHolds += 1
            if let voice, voice != tts.voice, tts.voices.contains(voice) { try? await tts.setVoice(voice) }
            return tts
        }

        /// Loads the model and has it speak once, ahead of voice mode: the first
        /// utterance conditions it on its voice, which takes a while. Holds
        /// nothing; the model is kept like any other load. Does nothing while
        /// voice mode holds the voice (it is warm then).
        func prepare() async throws {
            guard voiceHolds == 0 || phonon == nil else { return }
            idleTask?.cancel()
            running += 1
            defer {
                running -= 1
                scheduleUnload()
            }
            let tts = try await loaded()
            if !warm {
                _ = try? await tts.synthesize("Ready.")
                warm = true
            }
        }

        /// Whether the loaded instance has already spoken once.
        var isWarm: Bool { warm && phonon != nil }

        func markWarm() { warm = true }

        func endVoice() {
            guard voiceHolds > 0 else { return }
            voiceHolds -= 1
            running = max(0, running - 1)
            scheduleUnload()
        }

        private func loaded() async throws -> Phonon {
            if let phonon { return phonon }
            let directory = PhononModels.defaultDirectory
            guard PhononModels.isInstalled(at: directory) else { throw Failure.notInstalled }
            let created = try await Phonon.load(models: directory, language: .english)
            phonon = created
            observe()
            return created
        }

        private func scheduleUnload() {
            idleTask?.cancel()
            guard phonon != nil, running == 0 else { return }
            idleTask = Task {
                try? await Task.sleep(for: Self.idleLimit)
                guard !Task.isCancelled else { return }
                unload()
            }
        }

        /// Drops the model unless a reading is running (or `force`).
        func unload(force: Bool = false) {
            guard force || running == 0 else { return }
            idleTask?.cancel()
            phonon = nil
            warm = false
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []
        }

        private func observe() {
            guard observers.isEmpty else { return }
            let center = NotificationCenter.default
            // Not the background: a reading continues there (the audio background
            // mode), and its later pieces would load the model again.
            observers.append(center.addObserver(
                forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
            ) { _ in
                Task { await Runtime.shared.unload() }
            })
        }
    }
    #endif
}
