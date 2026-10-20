import AVFoundation
import Foundation
import UIKit
#if canImport(FluidAudio)
import FluidAudio
#endif

#if canImport(FluidAudio)

/// Where a live dictation's audio comes from: the microphone in the app, a
/// clip in tests. Buffers are delivered in any PCM format; FluidAudio converts
/// them to 16 kHz mono.
@available(iOS 18.0, *)
protocol LiveAudioSource: AnyObject {
    /// Asks for whatever the source needs (the microphone permission).
    func prepare() async throws
    /// Starts delivering buffers. `interrupted` is called, once, when the
    /// source can no longer deliver (a call, another app, a lost input).
    func start(
        deliver: @escaping @Sendable (AVAudioPCMBuffer) -> Void,
        interrupted: @escaping @Sendable () -> Void
    ) throws
    /// Releases the source. Safe to call more than once.
    func stop()
}

/// Wraps a buffer to cross into the pump task; it is only read after delivery.
struct SendableBuffer: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
}

/// One live dictation: audio from a source goes to FluidAudio's sliding-window
/// recogniser as it arrives, and the transcript so far is reported after each
/// window. Audio stays in memory and is never written to disk or logged, and
/// neither is the text.
@available(iOS 18.0, *)
actor LiveDictationSession {
    enum Event: Sendable {
        /// The whole text so far: `confirmed` will not change; `volatile` may.
        case transcript(confirmed: String, volatile: String, ended: Bool)
        /// Input level 0...1, about ten times a second.
        case level(Float)
    }

    /// FluidAudio's default sliding window is 11 s of audio plus 2 s of right
    /// context, so its first text would arrive 13 s into a dictation. A
    /// shorter chunk puts the first text at about 4.5 s and then one window
    /// every 3 s; the window (3 + 3 + 1.5 s) stays well inside the model's
    /// 15 s input. Text is confirmed once 6 s of audio have gone by. Tune on a
    /// device if words are cut at the seams or the lag is too long.
    static let config = SlidingWindowAsrConfig(
        chunkSeconds: 3.0,
        hypothesisChunkSeconds: 1.0,
        leftContextSeconds: 3.0,
        rightContextSeconds: 1.5,
        minContextForConfirmation: 6.0,
        confirmationThreshold: 0.85)

    /// The shortest time between level events.
    static let levelInterval: TimeInterval = 0.1

    private let manager: SlidingWindowAsrManager
    private let source: LiveAudioSource
    private let emit: @Sendable (Event) -> Void
    private let release: @Sendable () async -> Void

    private var input: AsyncStream<SendableBuffer>.Continuation?
    private var pumpTask: Task<Void, Never>?
    private var updatesTask: Task<Void, Never>?
    private var ending: Task<String, Error>?
    private var released = false
    private var cancelled = false

    /// `release` runs once when the session is over, however it ends.
    init(
        manager: SlidingWindowAsrManager,
        source: LiveAudioSource,
        emit: @escaping @Sendable (Event) -> Void,
        release: @escaping @Sendable () async -> Void
    ) {
        self.manager = manager
        self.source = source
        self.emit = emit
        self.release = release
    }

    func start() async throws {
        let manager = self.manager
        let emit = self.emit
        let updates = await manager.transcriptionUpdates
        do {
            try await manager.startStreaming(source: .microphone)
        } catch {
            await teardown()
            throw OnDeviceSpeech.Failure.failed
        }
        let (stream, continuation) = AsyncStream.makeStream(of: SendableBuffer.self)
        input = continuation
        updatesTask = Task {
            for await _ in updates {
                let confirmed = await manager.confirmedTranscript
                let volatile = await manager.volatileTranscript
                emit(.transcript(confirmed: confirmed, volatile: volatile, ended: false))
            }
        }
        pumpTask = Task {
            var lastLevel = Date.distantPast
            for await item in stream {
                let now = Date()
                if now.timeIntervalSince(lastLevel) >= Self.levelInterval {
                    lastLevel = now
                    emit(.level(Self.level(of: item.buffer)))
                }
                await manager.streamAudio(item.buffer)
            }
        }
        do {
            try source.start(
                deliver: { continuation.yield(SendableBuffer(buffer: $0)) },
                interrupted: { [weak self] in
                    Task { await self?.interrupted() }
                })
        } catch {
            pumpTask?.cancel()
            updatesTask?.cancel()
            await manager.cancel()
            await teardown()
            throw error as? OnDeviceSpeech.Failure ?? OnDeviceSpeech.Failure.failed
        }
    }

    /// Stops listening, lets the recogniser finish what it has heard and
    /// returns the whole text.
    func stop() async throws -> String {
        try await finish()
    }

    /// Stops and throws everything away.
    func cancel() async {
        cancelled = true
        source.stop()
        input?.finish()
        pumpTask?.cancel()
        updatesTask?.cancel()
        await manager.cancel()
        await teardown()
    }

    private func finish() async throws -> String {
        if let ending { return try await ending.value }
        let task = Task { () -> String in
            source.stop()
            input?.finish()
            // The pump drains what was already delivered before it ends.
            await pumpTask?.value
            let text: String?
            do { text = try await manager.finish() } catch { text = nil }
            updatesTask?.cancel()
            await manager.cancel()
            await teardown()
            guard let text else { throw OnDeviceSpeech.Failure.failed }
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        ending = task
        return try await task.value
    }

    /// The source lost its input: end as if stopped, keep the text so far and
    /// tell the web app.
    private func interrupted() async {
        guard ending == nil, !cancelled else { return }
        let confirmed = await manager.confirmedTranscript
        let volatile = await manager.volatileTranscript
        if let text = try? await finish() {
            emit(.transcript(confirmed: text, volatile: "", ended: true))
        } else {
            emit(.transcript(confirmed: confirmed, volatile: volatile, ended: true))
        }
    }

    private func teardown() async {
        guard !released else { return }
        released = true
        source.stop()
        input?.finish()
        await release()
    }

    /// Root-mean-square level of the first channel, scaled so ordinary speech
    /// reads around 0.3...0.8.
    static func level(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += channel[index] * channel[index] }
        let rms = (sum / Float(buffer.frameLength)).squareRoot()
        return min(1, rms * 6)
    }
}

/// The microphone through AVAudioEngine. Captures into memory only; the audio
/// session category is restored on stop so read-aloud (which plays in the web
/// view) keeps working.
@available(iOS 18.0, *)
final class MicrophoneSource: LiveAudioSource, @unchecked Sendable {
    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var observers: [NSObjectProtocol] = []
    private var saved: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?

    func prepare() async throws {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return
        case .denied: throw OnDeviceSpeech.Failure.permissionDenied
        default:
            guard await AVAudioApplication.requestRecordPermission() else {
                throw OnDeviceSpeech.Failure.permissionDenied
            }
        }
    }

    func start(
        deliver: @escaping @Sendable (AVAudioPCMBuffer) -> Void,
        interrupted: @escaping @Sendable () -> Void
    ) throws {
        let session = AVAudioSession.sharedInstance()
        lock.lock()
        defer { lock.unlock() }
        saved = (session.category, session.mode, session.categoryOptions)
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [])
            try session.setActive(true)
        } catch {
            restoreSession()
            throw OnDeviceSpeech.Failure.failed
        }
        let engine = AVAudioEngine()
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            restoreSession()
            throw OnDeviceSpeech.Failure.unavailable
        }
        engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            deliver(Self.copy(buffer))
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            restoreSession()
            throw OnDeviceSpeech.Failure.failed
        }
        self.engine = engine

        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if raw == AVAudioSession.InterruptionType.began.rawValue { interrupted() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { note in
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if raw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue,
               AVAudioSession.sharedInstance().currentRoute.inputs.isEmpty {
                interrupted()
            }
        })
        // The engine stops itself when the hardware changes under it.
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
            if !engine.isRunning { interrupted() }
        })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in
            interrupted()
        })
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            self.engine = nil
        }
        restoreSession()
    }

    /// Hands the audio session back as it was, so the web view's playback
    /// (Phonon, Apple read-aloud) is not left under the recording category.
    private func restoreSession() {
        guard let saved else { return }
        self.saved = nil
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(saved.category, mode: saved.mode, options: saved.options)
    }

    /// The tap's buffer is only valid during the callback.
    static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength),
              let from = buffer.floatChannelData, let to = copy.floatChannelData else { return buffer }
        copy.frameLength = buffer.frameLength
        for channel in 0..<Int(buffer.format.channelCount) {
            to[channel].update(from: from[channel], count: Int(buffer.frameLength))
        }
        return copy
    }
}

/// The one live dictation the plugin can run at a time.
@available(iOS 18.0, *)
actor LiveDictation {
    static let shared = LiveDictation()

    private var session: LiveDictationSession?
    /// The text of a dictation that ended on its own (an interruption), until
    /// the web app collects it with `stop`.
    private var endedText: String?

    /// Starts recording. `source` is the microphone unless a test supplies one.
    func start(
        modelDirectory: URL,
        source: LiveAudioSource = MicrophoneSource(),
        emit: @escaping @Sendable (LiveDictationSession.Event) -> Void
    ) async throws {
        await cancel()
        try await source.prepare()
        let models: AsrModels
        do {
            models = try await FluidSpeechMini.Runtime.shared.beginLive(modelDirectory: modelDirectory)
        } catch {
            throw OnDeviceSpeech.Failure.failed
        }
        let manager = SlidingWindowAsrManager(config: LiveDictationSession.config)
        let created: LiveDictationSession
        do {
            // Shares the warm models: this builds a light AsrManager around
            // the same Core ML models, it does not load or specialise them again.
            try await manager.loadModels(models)
        } catch {
            await FluidSpeechMini.Runtime.shared.endLive()
            throw OnDeviceSpeech.Failure.failed
        }
        created = LiveDictationSession(
            manager: manager,
            source: source,
            emit: { [weak self] event in
                if case let .transcript(confirmed, _, true) = event {
                    Task { await self?.remember(ended: confirmed) }
                }
                emit(event)
            },
            release: { await FluidSpeechMini.Runtime.shared.endLive() })
        session = created
        endedText = nil
        do {
            try await created.start()
        } catch {
            session = nil
            throw error
        }
    }

    /// Stops and returns the text. After an interruption it returns the text
    /// kept at that point.
    func stop() async throws -> String {
        if let session {
            self.session = nil
            return try await session.stop()
        }
        if let endedText {
            self.endedText = nil
            return endedText
        }
        throw OnDeviceSpeech.Failure.failed
    }

    func cancel() async {
        endedText = nil
        guard let session else { return }
        self.session = nil
        await session.cancel()
    }

    private func remember(ended text: String) {
        endedText = text
        session = nil
    }
}

#endif
