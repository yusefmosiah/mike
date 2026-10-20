import Capacitor
import Foundation

/// Apple's speech on the phone, for the web app's "This iPhone" engines
/// (frontend/src/app/lib/voice/deviceSpeech.ts): dictation with on-device
/// speech recognition (the web app records the clip; this transcribes it),
/// and read-aloud with Apple's voices (rendered to a WAV the web app plays).
/// Audio exists only in protected temporary files for the length of a call,
/// and neither audio nor text is logged.
@objc(MikeSpeechPlugin)
public class MikeSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MikeSpeechPlugin"
    public let jsName = "MikeSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "install", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise)
    ]

    /// About half an hour of the web view's AAC recording.
    static let maxAudioBytes = 25 * 1024 * 1024
    /// One read-aloud call; the web app sends a response in chunks.
    static let maxSpeechCharacters = 20_000

    @objc func status(_ call: CAPPluginCall) {
        if Self.usesFluidMini(call) {
            call.resolve(Self.payload(FluidSpeechMini.status()))
            return
        }
        let language = call.getString("language")
        Task {
            call.resolve(Self.payload(await OnDeviceSpeech.status(language: language)))
        }
    }

    @objc func install(_ call: CAPPluginCall) {
        // Fluid Speech Mini ships in the app: there is nothing to download.
        if Self.usesFluidMini(call) {
            call.resolve(Self.payload(FluidSpeechMini.status()))
            return
        }
        let language = call.getString("language")
        Task {
            do {
                try await OnDeviceSpeech.install(language: language)
                call.resolve(Self.payload(await OnDeviceSpeech.status(language: language)))
            } catch {
                Self.reject(call, error)
            }
        }
    }

    @objc func transcribe(_ call: CAPPluginCall) {
        guard let encoded = call.getString("audio"), let audio = Data(base64Encoded: encoded), !audio.isEmpty else {
            call.reject("No audio to transcribe.", "invalid-audio")
            return
        }
        guard audio.count <= Self.maxAudioBytes else {
            call.reject("The recording is too long.", "too-long")
            return
        }
        guard let ext = Self.fileExtension(for: call.getString("mimeType")) else {
            call.reject("This recording format cannot be transcribed.", "unsupported-audio")
            return
        }
        let language = call.getString("language")
        let fluidMini = Self.usesFluidMini(call)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mike-dictation-\(UUID().uuidString)")
            .appendingPathExtension(ext)
        Task {
            defer { try? FileManager.default.removeItem(at: url) }
            do {
                try audio.write(to: url, options: [.atomic, .completeFileProtection])
                let text = fluidMini
                    ? try await FluidSpeechMini.transcribe(file: url)
                    : try await OnDeviceSpeech.transcribe(file: url, language: language)
                call.resolve(["text": text])
            } catch {
                Self.reject(call, error)
            }
        }
    }

    @objc func voices(_ call: CAPPluginCall) {
        let voices = OnDeviceVoice.voices().map { voice in
            ["id": voice.identifier, "name": voice.name, "language": voice.language, "quality": voice.quality]
        }
        call.resolve(["voices": voices])
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("No text to read aloud.", "empty-text")
            return
        }
        guard text.count <= Self.maxSpeechCharacters else {
            call.reject("The text is too long to read aloud at once.", "too-long")
            return
        }
        let voice = call.getString("voice")
        let language = call.getString("language")
        Task {
            do {
                let audio = try await OnDeviceVoice.render(text: text, voiceIdentifier: voice, language: language)
                call.resolve(["audio": audio.base64EncodedString(), "mimeType": "audio/wav"])
            } catch {
                let failure = error as? OnDeviceVoice.Failure ?? .failed
                call.reject("Reading aloud on this iPhone failed.", failure.code)
            }
        }
    }

    /// The extension AVAudioFile needs to read the web view's recording.
    /// WebM (Opus) is refused: AVAudioFile cannot read it.
    static func fileExtension(for mimeType: String?) -> String? {
        let type = (mimeType ?? "").split(separator: ";").first.map {
            $0.trimmingCharacters(in: .whitespaces).lowercased()
        } ?? ""
        switch type {
        case "", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "video/mp4": return "m4a"
        case "audio/wav", "audio/wave", "audio/x-wav": return "wav"
        case "audio/aiff", "audio/x-aiff": return "aiff"
        case "audio/mpeg", "audio/mp3": return "mp3"
        default: return nil
        }
    }

    /// Whether the call asks for Fluid Speech Mini; without `engine` it is
    /// Apple's recognizer, so an older web build keeps working.
    static func usesFluidMini(_ call: CAPPluginCall) -> Bool {
        call.getString("engine") == FluidSpeechMini.engineName
    }

    static func payload(_ status: OnDeviceSpeech.Status) -> [String: Any] {
        var result: [String: Any] = ["state": status.state.rawValue]
        if let engine = status.engine { result["engine"] = engine }
        if let locale = status.locale { result["locale"] = locale }
        return result
    }

    static func reject(_ call: CAPPluginCall, _ error: Error) {
        let failure = error as? OnDeviceSpeech.Failure ?? .failed
        call.reject("On-device transcription failed.", failure.code)
    }
}
