import AVFoundation
import Foundation

/// Read-aloud with Apple's voices, for the web app's "This iPhone" read-aloud
/// engine. The text is rendered to a WAV file instead of being spoken, so the
/// web app plays it in its own audio player: one file it can seek, pause,
/// speed up and keep playing in the background. Neither text nor audio is
/// logged, and the file is deleted as soon as it has been read.
enum OnDeviceVoice {
    struct Voice {
        let identifier: String
        let name: String
        let language: String
        /// "default", "enhanced" or "premium".
        let quality: String
    }

    enum Failure: Error {
        case empty
        case failed

        var code: String {
            switch self {
            case .empty: return "empty-text"
            case .failed: return "failed"
            }
        }
    }

    /// The voices installed on this iPhone, best quality first.
    static func voices() -> [Voice] {
        AVSpeechSynthesisVoice.speechVoices()
            .map { voice in
                Voice(
                    identifier: voice.identifier,
                    name: voice.name,
                    language: voice.language,
                    quality: quality(voice.quality)
                )
            }
            .sorted { ($0.language, rank($0.quality), $0.name) < ($1.language, rank($1.quality), $1.name) }
    }

    /// `text` spoken by the voice with `voiceIdentifier` (or the best voice
    /// for `language`, or the phone's own), as a 16-bit mono WAV.
    static func render(text: String, voiceIdentifier: String?, language: String?) async throws -> Data {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw Failure.empty }
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = voice(identifier: voiceIdentifier, language: language)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mike-speech-\(UUID().uuidString)")
            .appendingPathExtension("wav")
        defer { try? FileManager.default.removeItem(at: url) }
        try await Renderer(url: url).render(utterance)
        return try Data(contentsOf: url)
    }

    private static func voice(identifier: String?, language: String?) -> AVSpeechSynthesisVoice? {
        if let identifier, let voice = AVSpeechSynthesisVoice(identifier: identifier) { return voice }
        if let language, let voice = AVSpeechSynthesisVoice(language: language) { return voice }
        return AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    }

    private static func quality(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality {
        case .enhanced: return "enhanced"
        case .premium: return "premium"
        default: return "default"
        }
    }

    private static func rank(_ quality: String) -> Int {
        quality == "premium" ? 0 : quality == "enhanced" ? 1 : 2
    }

    /// Writes one utterance's buffers to a file. The synthesizer must stay
    /// alive until the last (empty) buffer arrives, so this object holds it.
    private final class Renderer: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
        private let synthesizer = AVSpeechSynthesizer()
        private let url: URL
        private let lock = NSLock()
        private var file: AVAudioFile?
        private var continuation: CheckedContinuation<Void, Error>?
        private var failed = false
        private var done = false

        init(url: URL) {
            self.url = url
            super.init()
            synthesizer.delegate = self
        }

        func render(_ utterance: AVSpeechUtterance) async throws {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                self.continuation = continuation
                lock.unlock()
                synthesizer.write(utterance) { [self] buffer in
                    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                    if pcm.frameLength == 0 {
                        finish()
                        return
                    }
                    append(pcm)
                }
            }
        }

        private func append(_ buffer: AVAudioPCMBuffer) {
            lock.lock()
            defer { lock.unlock() }
            guard !failed, !done else { return }
            do {
                if file == nil {
                    let settings: [String: Any] = [
                        AVFormatIDKey: kAudioFormatLinearPCM,
                        AVSampleRateKey: buffer.format.sampleRate,
                        AVNumberOfChannelsKey: 1,
                        AVLinearPCMBitDepthKey: 16,
                        AVLinearPCMIsFloatKey: false,
                        AVLinearPCMIsBigEndianKey: false,
                    ]
                    file = try AVAudioFile(
                        forWriting: url,
                        settings: settings,
                        commonFormat: buffer.format.commonFormat,
                        interleaved: buffer.format.isInterleaved
                    )
                }
                try file?.write(from: buffer)
            } catch {
                failed = true
            }
        }

        private func finish() {
            lock.lock()
            guard !done else {
                lock.unlock()
                return
            }
            done = true
            let continuation = self.continuation
            self.continuation = nil
            // Closing the file writes its header.
            let wrote = file != nil && !failed
            file = nil
            lock.unlock()
            if wrote { continuation?.resume() } else { continuation?.resume(throwing: Failure.failed) }
        }

        // Some iOS versions end with this instead of an empty buffer.
        func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
            finish()
        }

        func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
            finish()
        }
    }
}
