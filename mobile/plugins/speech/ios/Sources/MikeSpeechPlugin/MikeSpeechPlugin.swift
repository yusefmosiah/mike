import AVFoundation
import Capacitor
import Foundation
#if canImport(FluidAudio)
import FluidAudio
#endif
#if canImport(PhononTTS)
import PhononTTS
#endif

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
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startLive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopLive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelLive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceInstall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceSpeak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceEndAnswer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceCancelAnswer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceForgetSpeaker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceMicrophoneModes", returnType: CAPPluginReturnPromise)
    ]

    /// About half an hour of the web view's AAC recording.
    static let maxAudioBytes = 25 * 1024 * 1024
    /// One read-aloud call; the web app sends a response in chunks.
    static let maxSpeechCharacters = 20_000

    @objc func status(_ call: CAPPluginCall) {
        if Self.usesPhonon(call) {
            Task { call.resolve(await PhononVoice.status().payload) }
            return
        }
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
        // Phonon's model is downloaded here, from the person's click; the web
        // app watches `status` for the progress while this call is pending.
        if Self.usesPhonon(call) {
            Task {
                do {
                    try await PhononVoice.install()
                    call.resolve(await PhononVoice.status().payload)
                } catch {
                    call.reject("The voice model could not be downloaded.", "install-failed")
                }
            }
            return
        }
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

    /// Starts loading Fluid Speech Mini while the person is still speaking.
    /// Answers at once; the transcription waits for the load if it is not done.
    @objc func prepare(_ call: CAPPluginCall) {
        if Self.usesFluidMini(call) {
            Task { await FluidSpeechMini.prepare() }
        }
        call.resolve()
    }

    /// Deletes Phonon's downloaded model. Nothing else can be removed.
    @objc func remove(_ call: CAPPluginCall) {
        guard Self.usesPhonon(call) else {
            call.reject("Nothing to remove.", "unavailable")
            return
        }
        Task {
            guard await !PhononVoice.inVoiceMode() else {
                call.reject("The voice is in use by voice mode.", "busy")
                return
            }
            await PhononVoice.remove()
            call.resolve(await PhononVoice.status().payload)
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
        // Fluid Speech Mini ignores the vocabulary for now; an older web build sends none.
        let vocabulary = OnDeviceSpeech.contextualStrings(call.getArray("vocabulary", String.self))
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mike-dictation-\(UUID().uuidString)")
            .appendingPathExtension(ext)
        Task {
            defer { try? FileManager.default.removeItem(at: url) }
            do {
                try audio.write(to: url, options: [.atomic, .completeFileProtection])
                let text = fluidMini
                    ? try await FluidSpeechMini.transcribe(file: url)
                    : try await OnDeviceSpeech.transcribe(file: url, language: language, vocabulary: vocabulary)
                call.resolve(["text": text])
            } catch {
                Self.reject(call, error)
            }
        }
    }

    /// Starts recording and transcribing with Fluid Speech Mini as the person
    /// speaks. Resolves when recording has started; the text arrives as
    /// `liveTranscript` events (`{ confirmed, volatile }` with the whole text
    /// so far, `{ level }` about ten times a second, and `ended: true` when an
    /// interruption stopped the dictation). Audio is kept in memory only.
    @objc func startLive(_ call: CAPPluginCall) {
        guard Self.usesFluidMini(call) else {
            call.reject("Live dictation needs Fluid Speech Mini.", "unavailable")
            return
        }
        #if canImport(FluidAudio)
        guard #available(iOS 18.0, *), let directory = FluidSpeechMini.modelDirectory() else {
            call.reject("Live dictation is not available on this iPhone.", "unavailable")
            return
        }
        let send: @Sendable (LiveDictationSession.Event) -> Void = { [weak self] event in
            self?.notifyListeners(Self.liveEventName, data: Self.livePayload(event))
        }
        Task {
            do {
                try await LiveDictation.shared.start(modelDirectory: directory, emit: send)
                call.resolve()
            } catch {
                Self.reject(call, error)
            }
        }
        #else
        call.reject("Live dictation is not available on this iPhone.", "unavailable")
        #endif
    }

    /// Stops recording, finishes the transcription and resolves `{ text }`.
    @objc func stopLive(_ call: CAPPluginCall) {
        #if canImport(FluidAudio)
        guard #available(iOS 18.0, *) else {
            call.reject("Live dictation is not available on this iPhone.", "unavailable")
            return
        }
        Task {
            do {
                call.resolve(["text": try await LiveDictation.shared.stop()])
            } catch {
                Self.reject(call, error)
            }
        }
        #else
        call.reject("Live dictation is not available on this iPhone.", "unavailable")
        #endif
    }

    /// Stops recording and discards everything.
    @objc func cancelLive(_ call: CAPPluginCall) {
        #if canImport(FluidAudio)
        if #available(iOS 18.0, *) {
            Task {
                await LiveDictation.shared.cancel()
                call.resolve()
            }
            return
        }
        #endif
        call.resolve()
    }

    static let liveEventName = "liveTranscript"

    #if canImport(FluidAudio)
    @available(iOS 18.0, *)
    static func livePayload(_ event: LiveDictationSession.Event) -> [String: Any] {
        switch event {
        case let .transcript(confirmed, volatile, ended):
            var payload: [String: Any] = ["confirmed": confirmed, "volatile": volatile]
            if ended { payload["ended"] = true }
            return payload
        case let .level(level):
            return ["level": Double(level)]
        }
    }
    #endif

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
        if Self.usesPhonon(call) {
            Task {
                do {
                    let audio = try await PhononVoice.render(text: text, voice: voice)
                    call.resolve(["audio": audio.base64EncodedString(), "mimeType": "audio/wav"])
                } catch {
                    let failure = error as? PhononVoice.Failure ?? .failed
                    call.reject("Reading aloud on this iPhone failed.", failure.code)
                }
            }
            return
        }
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

    // MARK: - Hands-free voice mode (docs/voice-chat-contract.md)

    /// Voice calls run one after another in the order the web app made them,
    /// so clause 1 can never overtake clause 0, nor a cancel the start it follows.
    private lazy var voiceCalls: AsyncStream<@Sendable () async -> Void>.Continuation = {
        let (stream, continuation) = AsyncStream.makeStream(of: (@Sendable () async -> Void).self)
        Task {
            for await work in stream { await work() }
        }
        return continuation
    }()

    private func sendVoiceEvent(_ event: VoiceEvent) {
        notifyListeners(VoiceEvent.listenerName, data: event.payload)
    }

    /// `{ available, missing, downloadBytes }`.
    @objc func voiceStatus(_ call: CAPPluginCall) {
        Task { call.resolve(await VoiceMode.status().payload) }
    }

    /// Downloads and prepares the missing models; progress arrives as
    /// `voiceEvent` `{ type: "install", fraction }`.
    @objc func voiceInstall(_ call: CAPPluginCall) {
        let send: @Sendable (VoiceEvent) -> Void = { [weak self] event in self?.sendVoiceEvent(event) }
        Task {
            guard VoiceMode.canRunHere else {
                call.reject("Voice mode is not available on this iPhone.", "unavailable")
                return
            }
            do {
                try await VoiceMode.install { fraction in send(.install(fraction: fraction)) }
                call.resolve(["available": await VoiceMode.status().available])
            } catch {
                call.reject("The voice models could not be downloaded.", "failed")
            }
        }
    }

    /// Loads and warms every model, asks for the microphone if needed, and
    /// resolves once the engine is listening.
    @objc func voiceStart(_ call: CAPPluginCall) {
        let config = VoiceConfig(call.options["config"] as? [String: Any])
        let voice = call.getString("voice")
        #if canImport(FluidAudio) && canImport(PhononTTS)
        if #available(iOS 18.0, *) {
            let send: @Sendable (VoiceEvent) -> Void = { [weak self] event in self?.sendVoiceEvent(event) }
            voiceCalls.yield {
                do {
                    try await VoiceEngine.shared.start(config: config, voice: voice, emit: send)
                    call.resolve()
                } catch {
                    let failure = error as? OnDeviceSpeech.Failure ?? .failed
                    call.reject("Voice mode could not start.", failure.code)
                }
            }
            return
        }
        #endif
        call.reject("Voice mode is not available on this iPhone.", "unavailable")
    }

    /// Ends any answer being spoken and releases the audio. A start still
    /// loading is told at once (not after it, through the queue) and rejects
    /// with `cancelled` without opening the microphone.
    @objc func voiceStop(_ call: CAPPluginCall) {
        #if canImport(FluidAudio) && canImport(PhononTTS)
        if #available(iOS 18.0, *) {
            VoiceEngine.cancelPendingStart()
            voiceCalls.yield {
                await VoiceEngine.shared.stop(reason: .stopped)
                call.resolve()
            }
            return
        }
        #endif
        call.resolve()
    }

    /// Deletes the downloaded voice-mode models (VAD, EOU, Smart Turn; Phonon
    /// has its own `remove`) and resolves the new `voiceStatus` payload.
    /// Rejects with `busy` while voice mode runs.
    @objc func voiceRemove(_ call: CAPPluginCall) {
        #if canImport(FluidAudio) && canImport(PhononTTS)
        if #available(iOS 18.0, *) {
            voiceCalls.yield {
                if await VoiceEngine.shared.isRunning {
                    call.reject("Voice mode is in use.", "busy")
                    return
                }
                await VoiceMode.remove()
                call.resolve(await VoiceMode.status().payload)
            }
            return
        }
        #endif
        Task {
            await VoiceMode.remove()
            call.resolve(await VoiceMode.status().payload)
        }
    }

    /// Forgets the person's learned voice (voice mode learns it again from
    /// the next turns) and resolves the new `voiceStatus` payload. Works while
    /// voice mode runs.
    @objc func voiceForgetSpeaker(_ call: CAPPluginCall) {
        #if canImport(FluidAudio) && canImport(PhononTTS)
        if #available(iOS 18.0, *) {
            voiceCalls.yield {
                await VoiceEngine.shared.forgetSpeaker()
                call.resolve(await VoiceMode.status().payload)
            }
            return
        }
        #endif
        Task {
            SpeakerStore.remove()
            call.resolve(await VoiceMode.status().payload)
        }
    }

    /// Opens the system's microphone modes (Voice Isolation, Wide Spectrum).
    /// iOS lists them only while the app is using the microphone, so the web
    /// app offers this during voice mode. Resolves once it is shown.
    @objc func voiceMicrophoneModes(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            AVCaptureDevice.showSystemUserInterface(.microphoneModes)
            call.resolve()
        }
    }

    /// Queues one clause of the current answer. Resolves at once.
    @objc func voiceSpeak(_ call: CAPPluginCall) {
        guard let turnId = call.getString("turnId"), let clauseId = call.getInt("clauseId"), clauseId >= 0,
              let text = call.getString("text") else {
            call.reject("A clause needs a turn, an id and text.", "failed")
            return
        }
        call.resolve()
        #if canImport(FluidAudio) && canImport(PhononTTS)
        if #available(iOS 18.0, *) {
            voiceCalls.yield { await VoiceEngine.shared.speak(turnId: turnId, clauseId: clauseId, text: text) }
        }
        #endif
    }

    /// No more clauses for this turn. Resolves at once.
    @objc func voiceEndAnswer(_ call: CAPPluginCall) {
        guard let turnId = call.getString("turnId") else {
            call.reject("No turn given.", "failed")
            return
        }
        call.resolve()
        #if canImport(FluidAudio) && canImport(PhononTTS)
        if #available(iOS 18.0, *) {
            voiceCalls.yield { await VoiceEngine.shared.endAnswer(turnId: turnId) }
        }
        #endif
    }

    /// Drops the answer; resolves once playback has stopped.
    @objc func voiceCancelAnswer(_ call: CAPPluginCall) {
        guard let turnId = call.getString("turnId") else {
            call.reject("No turn given.", "failed")
            return
        }
        #if canImport(FluidAudio) && canImport(PhononTTS)
        if #available(iOS 18.0, *) {
            voiceCalls.yield {
                await VoiceEngine.shared.cancelAnswer(turnId: turnId)
                call.resolve()
            }
            return
        }
        #endif
        call.resolve()
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

    /// Whether the call asks for Phonon (read-aloud, and its download).
    static func usesPhonon(_ call: CAPPluginCall) -> Bool {
        call.getString("engine") == PhononVoice.engineName
    }

    static func payload(_ status: OnDeviceSpeech.Status) -> [String: Any] {
        var result: [String: Any] = ["state": status.state.rawValue]
        if let engine = status.engine { result["engine"] = engine }
        if let locale = status.locale { result["locale"] = locale }
        if status.live { result["live"] = true }
        return result
    }

    static func reject(_ call: CAPPluginCall, _ error: Error) {
        let failure = error as? OnDeviceSpeech.Failure ?? .failed
        call.reject("On-device transcription failed.", failure.code)
    }
}
