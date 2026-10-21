import AVFoundation
import Foundation
import UIKit

/// The one audio engine of a voice conversation (docs/voice-chat.md, "Audio
/// session and engine"): Apple's voice processing on the microphone, so the
/// echo canceller hears Phonon (played through the same engine) as its
/// reference; the microphone converted to 16 kHz mono and handed on; a player
/// node for Phonon's 24 kHz audio, scheduled on its own timeline so the
/// played-sample clock says exactly what has been heard.
///
/// Audio stays in memory: nothing is written to disk or logged.
@available(iOS 18.0, *)
final class VoiceAudioEngine: @unchecked Sendable {
    enum Notice: Sendable {
        /// The graph was rebuilt (route or hardware change): the player's
        /// timeline restarted empty, so unplayed speech must be scheduled
        /// again, with this epoch (`schedule` drops buffers from older ones).
        case rebuilt(epoch: Int)
        /// The engine can no longer run; voice mode ends.
        case ended(VoiceEndReason)
    }

    static let microphoneRate = 16_000.0
    static let playerRate = 24_000.0
    static let playerFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: playerRate, channels: 1, interleaved: false)!
    private static let microphoneFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: microphoneRate, channels: 1, interleaved: false)!

    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    /// The microphone format the current tap was built for.
    private var inputFormat: AVAudioFormat?
    /// When recent rebuilds happened, to stop a rebuild loop.
    private var recentRebuilds: [ContinuousClock.Instant] = []
    private var observers: [NSObjectProtocol] = []
    private var saved: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?
    private var deliver: (@Sendable ([Float]) -> Void)?
    private var notify: (@Sendable (Notice) -> Void)?
    private var ended = false
    /// Output latency in player samples: what has rendered is heard this much later.
    private var latencySamples = 0
    /// Bumped by every rebuild: a buffer meant for an older graph's timeline
    /// would land at the wrong time on the new one.
    private(set) var epoch = 0
    /// Playback held by the policy, and the clock's values when it was held:
    /// a paused player reports no player time.
    private var paused = false
    private var pausedPlayed = 0
    private var pausedRendered = 0
    /// Notifications are handled here, never on the thread that posted them:
    /// NotificationCenter delivers on the posting thread, and a session or
    /// engine notice posted synchronously while `lock` is held (inside
    /// `buildGraph`) would otherwise deadlock on it.
    private let notices = DispatchQueue(label: "MikeSpeech.voice-audio-notices", qos: .userInitiated)
    /// How long a failed rebuild waits for an interruption notice to arrive
    /// and give the real reason (an interruption also changes the configuration).
    static let rebuildGrace: DispatchTimeInterval = .milliseconds(250)
    /// More rebuilds than this within the window means the graph cannot run.
    static let rebuildLimit = 5
    static let rebuildWindow: Duration = .seconds(2)

    static func sameFormat(_ a: AVAudioFormat, _ b: AVAudioFormat) -> Bool {
        a.sampleRate == b.sampleRate && a.channelCount == b.channelCount
            && a.commonFormat == b.commonFormat && a.isInterleaved == b.isInterleaved
    }

    /// Asks for the microphone if needed.
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

    /// Takes the audio session, builds the graph and starts it. `deliver` gets
    /// the microphone as 16 kHz mono samples on a background thread; `notify`
    /// gets rebuilds and the end.
    func start(deliver: @escaping @Sendable ([Float]) -> Void, notify: @escaping @Sendable (Notice) -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        let session = AVAudioSession.sharedInstance()
        saved = (session.category, session.mode, session.categoryOptions)
        do {
            // .voiceChat turns on the system's echo cancellation for this route
            // too; Bluetooth HFP so a headset's microphone can be used.
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
        } catch {
            restoreSession()
            throw OnDeviceSpeech.Failure.failed
        }
        self.deliver = deliver
        self.notify = notify
        ended = false
        paused = false
        epoch = 0
        do {
            try buildGraph()
        } catch {
            teardownGraph()
            restoreSession()
            throw error
        }
        observe()
    }

    /// Stops everything and hands the audio session back as it was.
    func stop() {
        lock.lock()
        defer { lock.unlock() }
        ended = true
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        teardownGraph()
        deliver = nil
        notify = nil
        restoreSession()
    }

    // MARK: - Playback

    /// Queues mono 24 kHz samples to play at `sample` on the player's
    /// timeline of graph `epoch`. Returns false (and plays nothing) when the
    /// graph has been rebuilt since.
    @discardableResult
    func schedule(_ samples: [Float], at sample: Int, epoch: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard epoch == self.epoch else { return false }
        guard let player, !samples.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: Self.playerFormat, frameCapacity: AVAudioFrameCount(samples.count))
        else { return false }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        let when = AVAudioTime(sampleTime: AVAudioFramePosition(sample), atRate: Self.playerRate)
        player.scheduleBuffer(buffer, at: when, options: [], completionHandler: nil)
        return true
    }

    /// The played-sample clock: the position on the player's timeline the
    /// person has heard (what has rendered, less the output latency), or nil
    /// before the player has rendered.
    func playedSample() -> Int? {
        lock.lock()
        defer { lock.unlock() }
        if paused { return pausedPlayed }
        guard let player, let nodeTime = player.lastRenderTime, nodeTime.isSampleTimeValid,
              let playerTime = player.playerTime(forNodeTime: nodeTime) else { return nil }
        return max(0, Int(playerTime.sampleTime) - latencySamples)
    }

    /// The rendering position itself (where new audio can still be placed).
    func renderedSample() -> Int? {
        lock.lock()
        defer { lock.unlock() }
        if paused { return pausedRendered }
        guard let player, let nodeTime = player.lastRenderTime, nodeTime.isSampleTimeValid,
              let playerTime = player.playerTime(forNodeTime: nodeTime) else { return nil }
        return max(0, Int(playerTime.sampleTime))
    }

    /// Holds playback (a possible barge-in); the timeline stops with it.
    func pausePlayer() {
        lock.lock()
        defer { lock.unlock() }
        guard !paused, let player else { return }
        // Read the clock first: once paused it reports nothing.
        let rendered = Self.position(of: player) ?? 0
        pausedRendered = rendered
        pausedPlayed = max(0, rendered - latencySamples)
        paused = true
        player.pause()
    }

    func resumePlayer() {
        lock.lock()
        defer { lock.unlock() }
        guard paused else { return }
        paused = false
        player?.play()
    }

    var isPaused: Bool {
        lock.lock()
        defer { lock.unlock() }
        return paused
    }

    /// Drops everything scheduled at once and plays again (a held player
    /// too). The timeline restarts at zero.
    func stopPlayer() {
        lock.lock()
        defer { lock.unlock() }
        paused = false
        guard let player else { return }
        player.stop()
        if engine?.isRunning == true { player.play() }
    }

    private static func position(of player: AVAudioPlayerNode) -> Int? {
        guard let nodeTime = player.lastRenderTime, nodeTime.isSampleTimeValid,
              let playerTime = player.playerTime(forNodeTime: nodeTime) else { return nil }
        return max(0, Int(playerTime.sampleTime))
    }

    // MARK: - Graph

    private func buildGraph() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // Voice processing before any format is read: it changes them.
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            throw OnDeviceSpeech.Failure.unavailable
        }
        // Other apps' audio is ducked as little as voice processing allows.
        input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw OnDeviceSpeech.Failure.unavailable }
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: mono, to: Self.microphoneFormat)
        else { throw OnDeviceSpeech.Failure.failed }
        VoiceMode.log.info("voice mic: \(format.sampleRate, privacy: .public) Hz, \(format.channelCount, privacy: .public) ch, format \(format.commonFormat.rawValue, privacy: .public), interleaved \(format.isInterleaved, privacy: .public)")
        let deliver = self.deliver
        let resampler = Resampler(converter: converter, mono: mono)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            // Voice processing can report several channels; channel 0 is the processed one.
            guard let samples = resampler.convert(channel0Of: buffer), !samples.isEmpty else { return }
            deliver?(samples)
        }
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: Self.playerFormat)
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw OnDeviceSpeech.Failure.failed
        }
        // A player the policy is holding stays held; its timeline starts on resume.
        if paused {
            pausedPlayed = 0
            pausedRendered = 0
        } else {
            player.play()
        }
        self.engine = engine
        self.player = player
        inputFormat = format
        let session = AVAudioSession.sharedInstance()
        latencySamples = Int(((session.outputLatency + session.ioBufferDuration) * Self.playerRate).rounded())
        observeEngine(engine)
    }

    private func teardownGraph() {
        guard let engine else { return }
        player?.stop()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        player = nil
        inputFormat = nil
    }

    /// The engine stopped on a configuration change: restart it, or build the
    /// graph again when the microphone format changed (a headset, a route).
    private func rebuild() {
        lock.lock()
        // The engine stops itself on a real change; one that kept running
        // (a notice from our own start) needs nothing.
        guard !ended, let engine, !engine.isRunning else { lock.unlock(); return }
        let now = ContinuousClock.now
        recentRebuilds = recentRebuilds.filter { now - $0 < Self.rebuildWindow } + [now]
        guard recentRebuilds.count <= Self.rebuildLimit else {
            lock.unlock()
            VoiceMode.log.error("voice: audio graph keeps stopping, giving up")
            end(.error)
            return
        }
        epoch += 1
        do {
            // Enabling voice processing on a new engine posts a configuration
            // change of its own, which stops it: rebuilding on that notice
            // would loop. When the microphone format is unchanged, restart
            // this engine (its voice processing and tap stay); build a new
            // graph only for a real format change (a headset, a new route).
            if let built = inputFormat, let player, Self.sameFormat(engine.inputNode.outputFormat(forBus: 0), built) {
                player.stop()
                engine.prepare()
                do {
                    try engine.start()
                    VoiceMode.log.info("voice: audio engine restarted")
                    if paused {
                        pausedPlayed = 0
                        pausedRendered = 0
                    } else {
                        player.play()
                    }
                } catch {
                    teardownGraph()
                    try buildGraph()
                }
            } else {
                teardownGraph()
                try buildGraph()
            }
            let notify = self.notify
            let epoch = self.epoch
            lock.unlock()
            notify?(.rebuilt(epoch: epoch))
        } catch {
            lock.unlock()
            // An interruption (a call, Siri) also changes the configuration,
            // and its own notice may come just after: give it the chance to
            // name the reason before this one does.
            let reason: VoiceEndReason = AVAudioSession.sharedInstance().isInputAvailable ? .error : .route
            notices.asyncAfter(deadline: .now() + Self.rebuildGrace) { [weak self] in self?.end(reason) }
        }
    }

    private func end(_ reason: VoiceEndReason) {
        lock.lock()
        guard !ended else { lock.unlock(); return }
        ended = true
        let notify = self.notify
        lock.unlock()
        notify?(.ended(reason))
    }

    private var engineObserver: NSObjectProtocol?

    private func observeEngine(_ engine: AVAudioEngine) {
        if let engineObserver { NotificationCenter.default.removeObserver(engineObserver) }
        engineObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.notices.async { self?.rebuild() }
        }
    }

    private func observe() {
        let center = NotificationCenter.default
        let notices = self.notices
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            notices.async { self?.end(.interruption) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { [weak self] _ in
            notices.async { self?.end(.interruption) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] _ in
            notices.async {
                if !AVAudioSession.sharedInstance().isInputAvailable { self?.end(.route) }
            }
        })
        // Voice mode runs in the foreground only (docs/voice-chat.md,
        // "Lifetime"); the contract has no separate reason for it.
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
            notices.async { self?.end(.interruption) }
        })
    }

    private func restoreSession() {
        if let engineObserver {
            NotificationCenter.default.removeObserver(engineObserver)
            self.engineObserver = nil
        }
        guard let saved else { return }
        self.saved = nil
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(saved.category, mode: saved.mode, options: saved.options)
    }
}

/// Channel 0 of the voice-processed input, resampled to 16 kHz mono. The
/// converter keeps its filter state between buffers so the stream is seamless.
@available(iOS 18.0, *)
final class Resampler: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let mono: AVAudioFormat

    // Diagnostics: buffers seen and buffers that could not be converted,
    // logged every few seconds (counts only, never audio).
    private var buffers = 0
    private var failures = 0

    init(converter: AVAudioConverter, mono: AVAudioFormat) {
        self.converter = converter
        self.mono = mono
    }

    func convert(channel0Of buffer: AVAudioPCMBuffer) -> [Float]? {
        buffers += 1
        let samples = resample(buffer)
        if samples?.isEmpty ?? true { failures += 1 }
        if buffers % 200 == 1 {
            VoiceMode.log.info("voice tap: \(self.buffers, privacy: .public) buffers, \(self.failures, privacy: .public) unconverted")
        }
        return samples
    }

    private func resample(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        guard let source = buffer.floatChannelData, buffer.frameLength > 0,
              let input = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { return nil }
        input.frameLength = buffer.frameLength
        input.floatChannelData![0].update(from: source[0], count: Int(buffer.frameLength))
        let ratio = converter.outputFormat.sampleRate / mono.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return input
        }
        guard status != .error, let channel = output.floatChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: channel, count: Int(output.frameLength)))
    }
}
