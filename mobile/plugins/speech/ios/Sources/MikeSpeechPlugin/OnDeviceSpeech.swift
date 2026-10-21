import AVFoundation
import Foundation
import Speech

/// Transcription with Apple's speech recognition, on the device only.
///
/// iOS 26 and later use SpeechAnalyzer, which never sends audio anywhere:
/// SpeechTranscriber where the hardware supports it, otherwise
/// DictationTranscriber (the keyboard dictation model). Older systems use
/// SFSpeechRecognizer, and only when it can recognise on the device
/// (`requiresOnDeviceRecognition`); Apple's server recognition is never used.
enum OnDeviceSpeech {
    enum State: String {
        /// Ready to transcribe.
        case available
        /// The language needs Apple's speech model first (`install`).
        case downloadable
        /// Apple's speech model is downloading.
        case downloading
        /// No on-device recognition for this language on this device.
        case unavailable
    }

    struct Status {
        let state: State
        /// "speech-transcriber", "dictation-transcriber" or "sf-speech".
        let engine: String?
        /// BCP 47 identifier of the language that will be used.
        let locale: String?
        /// Fluid Speech Mini only: the build can transcribe while the person speaks.
        var live: Bool = false
    }

    /// Failures the web app maps to its own messages, by `code`.
    enum Failure: Error {
        case unavailable
        case notInstalled
        case unreadableAudio
        case permissionDenied
        /// Hands-free voice mode: `voiceStop` came before `voiceStart` finished.
        case cancelled
        /// Hands-free voice mode: refused while a conversation runs.
        case busy
        case failed

        var code: String {
            switch self {
            case .unavailable: return "unavailable"
            case .notInstalled: return "not-installed"
            case .unreadableAudio: return "unsupported-audio"
            case .permissionDenied: return "permission-denied"
            case .cancelled: return "cancelled"
            case .busy: return "busy"
            case .failed: return "failed"
            }
        }
    }

    /// The most terms handed to the recognizer.
    static let maxContextualStrings = 100
    /// The longest a term can be (the web app allows 64 characters).
    static let maxContextualStringLength = 64

    /// The vocabulary the web app sent, cleaned for the recognizer: trimmed,
    /// non-empty, at most 64 characters each, no repeats, at most 100,
    /// in the order sent (the person's own terms come first).
    static func contextualStrings(_ raw: [String]?) -> [String] {
        var seen = Set<String>()
        var terms: [String] = []
        for item in raw ?? [] {
            let term = item.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !term.isEmpty, term.count <= maxContextualStringLength, seen.insert(term.lowercased()).inserted else { continue }
            terms.append(term)
            if terms.count == maxContextualStrings { break }
        }
        return terms
    }

    static func requestedLocale(_ language: String?) -> Locale {
        if let language = language?.trimmingCharacters(in: .whitespaces), !language.isEmpty {
            return Locale(identifier: language)
        }
        return Locale.current
    }

    static func status(language: String?) async -> Status {
        let locale = requestedLocale(language)
        if #available(iOS 26.0, macOS 26.0, *), let module = await AnalyzerModule.make(locale) {
            return Status(state: await module.state(), engine: module.engine, locale: module.localeIdentifier)
        }
        if let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition {
            return Status(state: .available, engine: "sf-speech", locale: recognizer.locale.identifier)
        }
        return Status(state: .unavailable, engine: nil, locale: nil)
    }

    /// Downloads Apple's speech model for the language (a system download,
    /// shared with other apps). Call only from the user's request.
    static func install(language: String?) async throws {
        let locale = requestedLocale(language)
        guard #available(iOS 26.0, macOS 26.0, *), let module = await AnalyzerModule.make(locale) else {
            // SFSpeechRecognizer has no install step: it is available or not.
            if await status(language: language).state == .available { return }
            throw Failure.unavailable
        }
        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module.module]) {
                try await request.downloadAndInstall()
            }
        } catch {
            throw Failure.failed
        }
    }

    /// Transcribes an audio file (m4a, wav, aiff, mp3: what AVAudioFile reads).
    /// `vocabulary` (names and terms to spell exactly) biases the recognizer
    /// toward those spellings; it never leaves the device.
    static func transcribe(file url: URL, language: String?, vocabulary: [String] = []) async throws -> String {
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            throw Failure.unreadableAudio
        }
        let locale = requestedLocale(language)
        if #available(iOS 26.0, macOS 26.0, *), let module = await AnalyzerModule.make(locale) {
            switch await module.state() {
            case .available:
                return try await module.transcribe(file, vocabulary: vocabulary)
            case .downloadable, .downloading:
                throw Failure.notInstalled
            case .unavailable:
                break
            }
        }
        return try await transcribeWithRecognizer(url, locale: locale, vocabulary: vocabulary)
    }

    private static func transcribeWithRecognizer(_ url: URL, locale: Locale, vocabulary: [String]) async throws -> String {
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else {
            throw Failure.unavailable
        }
        guard await speechAuthorized() else { throw Failure.permissionDenied }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        if !vocabulary.isEmpty {
            request.contextualStrings = vocabulary
        }
        if #available(iOS 16.0, macOS 13.0, *) {
            request.addsPunctuation = true
        }
        return try await withCheckedThrowingContinuation { continuation in
            var finished = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !finished else { return }
                if let result = result, result.isFinal {
                    finished = true
                    continuation.resume(returning: result.bestTranscription.formattedString)
                } else if error != nil {
                    finished = true
                    continuation.resume(throwing: Failure.failed)
                }
            }
        }
    }

    private static func speechAuthorized() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
        default:
            return false
        }
    }
}

/// The SpeechAnalyzer module for a language: SpeechTranscriber where this
/// hardware supports it, else DictationTranscriber.
@available(iOS 26.0, macOS 26.0, *)
private enum AnalyzerModule {
    case transcriber(SpeechTranscriber, Locale)
    case dictation(DictationTranscriber, Locale)

    static func make(_ requested: Locale) async -> AnalyzerModule? {
        if SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) {
            return .transcriber(SpeechTranscriber(locale: locale, preset: .transcription), locale)
        }
        if let locale = await DictationTranscriber.supportedLocale(equivalentTo: requested) {
            // Like keyboard dictation, this model punctuates from spoken
            // commands ("period", "comma"); SpeechTranscriber punctuates
            // on its own.
            let module = DictationTranscriber(
                locale: locale,
                contentHints: [],
                transcriptionOptions: [.punctuation],
                reportingOptions: [],
                attributeOptions: []
            )
            return .dictation(module, locale)
        }
        return nil
    }

    var module: any SpeechModule {
        switch self {
        case .transcriber(let module, _): return module
        case .dictation(let module, _): return module
        }
    }

    var engine: String {
        switch self {
        case .transcriber: return "speech-transcriber"
        case .dictation: return "dictation-transcriber"
        }
    }

    var locale: Locale {
        switch self {
        case .transcriber(_, let locale), .dictation(_, let locale): return locale
        }
    }

    var localeIdentifier: String { locale.identifier(.bcp47) }

    func state() async -> OnDeviceSpeech.State {
        // A language installed for the whole system (keyboard dictation,
        // another app) is ready even while the inventory reports it as
        // merely "supported" for this app.
        let installed: [Locale]
        switch self {
        case .transcriber: installed = await SpeechTranscriber.installedLocales
        case .dictation: installed = await DictationTranscriber.installedLocales
        }
        if installed.contains(where: { $0.identifier(.bcp47) == localeIdentifier }) {
            return .available
        }
        switch await AssetInventory.status(forModules: [module]) {
        case .installed: return .available
        case .supported: return .downloadable
        case .downloading: return .downloading
        case .unsupported: return .unavailable
        @unknown default: return .unavailable
        }
    }

    func transcribe(_ file: AVAudioFile, vocabulary: [String]) async throws -> String {
        let segments: Task<[String], Error>
        switch self {
        case .transcriber(let module, _):
            segments = Task {
                var parts: [String] = []
                for try await result in module.results where result.isFinal {
                    parts.append(String(result.text.characters))
                }
                return parts
            }
        case .dictation(let module, _):
            segments = Task {
                var parts: [String] = []
                for try await result in module.results where result.isFinal {
                    parts.append(String(result.text.characters))
                }
                return parts
            }
        }
        do {
            let context = AnalysisContext()
            if !vocabulary.isEmpty {
                context.contextualStrings = [.general: vocabulary]
            }
            let analyzer = try await SpeechAnalyzer(
                inputAudioFile: file,
                modules: [module],
                analysisContext: context,
                finishAfterFile: true
            )
            let parts = try await segments.value
            withExtendedLifetime(analyzer) {}
            return parts
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: " ")
        } catch {
            segments.cancel()
            throw OnDeviceSpeech.Failure.failed
        }
    }
}
