import Capacitor
import Foundation

/// Dictation with Apple's on-device speech recognition, for the web app's
/// "This iPhone" engine (frontend/src/app/lib/voice/deviceSpeech.ts). The web
/// app records the clip; this transcribes it on the phone. The clip is written
/// to a protected temporary file only for the length of the call, and neither
/// audio nor text is logged.
@objc(MikeSpeechPlugin)
public class MikeSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MikeSpeechPlugin"
    public let jsName = "MikeSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "install", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise)
    ]

    /// About half an hour of the web view's AAC recording.
    static let maxAudioBytes = 25 * 1024 * 1024

    @objc func status(_ call: CAPPluginCall) {
        let language = call.getString("language")
        Task {
            call.resolve(Self.payload(await OnDeviceSpeech.status(language: language)))
        }
    }

    @objc func install(_ call: CAPPluginCall) {
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
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mike-dictation-\(UUID().uuidString)")
            .appendingPathExtension(ext)
        Task {
            defer { try? FileManager.default.removeItem(at: url) }
            do {
                try audio.write(to: url, options: [.atomic, .completeFileProtection])
                let text = try await OnDeviceSpeech.transcribe(file: url, language: language)
                call.resolve(["text": text])
            } catch {
                Self.reject(call, error)
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
