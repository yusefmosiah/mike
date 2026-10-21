import AVFoundation
import CoreML
import Foundation
import os
#if canImport(FluidAudio)
import FluidAudio
#endif
#if canImport(PhononTTS)
import PhononTTS
#endif

/// Hands-free voice mode on the iPhone (docs/voice-chat.md, "The iPhone
/// design"; the plugin contract is docs/voice-chat-contract.md).
///
/// Listening: the microphone runs through Silero VAD, Parakeet EOU (live words
/// and `<EOU>` candidates) and, once per candidate pause, Smart Turn; the
/// pure `TurnPolicy` decides from those when a turn ends, when the person is
/// barging in and when speech was a false start. A committed turn is
/// transcribed once by Fluid Speech Mini (the warm model live dictation uses).
/// Speaking: clauses from the web app go one at a time through Phonon into
/// the engine's player node, one clause prepared ahead, with `ClauseQueue`
/// deciding what is next and what the played-sample clock has reached.
///
/// Logs carry stage names and timings only: never text or audio.
enum VoiceMode {
    static let log = Logger(subsystem: "MikeSpeech", category: "voice")

    struct Status: Equatable {
        let available: Bool
        let missing: [String]
        let downloadBytes: Int

        /// Whether the person's voice has been learned (see SpeakerProfile).
        var speakerLearned = false

        var payload: [String: Any] {
            ["available": available, "missing": missing, "downloadBytes": downloadBytes, "speakerLearned": speakerLearned]
        }
    }

    /// Voice mode needs about 700 MB of models in memory beside the web view
    /// (docs/voice-chat.md, "Models in memory"): a 6 GB iPhone or more.
    static let minimumMemory: UInt64 = 5_000_000_000

    static var canRunHere: Bool {
        #if canImport(FluidAudio) && canImport(PhononTTS)
        guard #available(iOS 18.0, *) else { return false }
        return ProcessInfo.processInfo.physicalMemory >= minimumMemory
        #else
        return false
        #endif
    }

    static func status() async -> Status {
        var missing: [String] = []
        var bytes = 0
        for model in VoiceModels.downloaded where !VoiceModels.isInstalled(model) {
            missing.append(model.name.rawValue)
            bytes += model.totalBytes
        }
        if await PhononVoice.status().state != "available" {
            missing.append(VoiceModelName.phonon.rawValue)
            bytes += VoiceModels.phononBytes
        }
        // Fluid Speech Mini ships in the app; a build without it cannot get it.
        if FluidSpeechMini.modelDirectory() == nil {
            missing.append(VoiceModelName.fluidMini.rawValue)
        }
        let order = VoiceModelName.allCases.map(\.rawValue)
        missing.sort { (order.firstIndex(of: $0) ?? 0) < (order.firstIndex(of: $1) ?? 0) }
        return Status(
            available: canRunHere && missing.isEmpty, missing: missing, downloadBytes: bytes,
            speakerLearned: SpeakerStore.load().learned)
    }

    /// Downloads and prepares every missing model. `progress` gets 0...1 over
    /// the bytes still to fetch. A second call while one runs joins it.
    static func install(progress: @escaping @Sendable (Double) -> Void) async throws {
        try await Installer.shared.run(progress: progress)
    }

    /// Deletes the downloaded voice models (VAD, the speaker models, EOU, Smart Turn)
    /// and the learned voice, cancelling an install. Refused (`busy`) while
    /// voice mode runs.
    static func remove() async {
        await Installer.shared.cancel()
        VoiceModels.removeAll()
        SpeakerStore.remove()
    }

    /// Install progress, delivered in order on the caller's thread: never
    /// backwards, about once per percent, and always ending at 1.
    final class ProgressRelay: @unchecked Sendable {
        private let lock = NSLock()
        private var listeners: [@Sendable (Double) -> Void] = []
        private var last = -1.0

        func add(_ listener: @escaping @Sendable (Double) -> Void) {
            lock.lock()
            listeners.append(listener)
            lock.unlock()
        }

        func report(_ fraction: Double) {
            lock.lock()
            let value = min(1, max(0, fraction))
            guard value > last, value >= 1 || value - last >= 0.01 || last < 0 else {
                lock.unlock()
                return
            }
            last = value
            let listeners = self.listeners
            // Called under the lock so two reports cannot cross.
            for listener in listeners { listener(value) }
            lock.unlock()
        }
    }

    private actor Installer {
        static let shared = Installer()
        private var task: Task<Void, Error>?
        private var relay: ProgressRelay?

        func run(progress: @escaping @Sendable (Double) -> Void) async throws {
            if let task, let relay {
                relay.add(progress)
                try await task.value
                return
            }
            // Every attempt starts its own relay, so a retry reports from 0 again.
            let relay = ProgressRelay()
            relay.add(progress)
            let task = Task<Void, Error> { try await Self.installAll { relay.report($0) } }
            self.task = task
            self.relay = relay
            defer {
                if self.relay === relay {
                    self.task = nil
                    self.relay = nil
                }
            }
            try await task.value
        }

        func cancel() {
            task?.cancel()
            task = nil
            relay = nil
        }

        private static func installAll(report: @escaping @Sendable (Double) -> Void) async throws {
            guard canRunHere else { throw OnDeviceSpeech.Failure.unavailable }
            let pending = VoiceModels.downloaded.filter { !VoiceModels.isInstalled($0) }
            let needsPhonon = await PhononVoice.status().state != "available"
            let total = Double(pending.reduce(0) { $0 + $1.totalBytes } + (needsPhonon ? VoiceModels.phononBytes : 0))
            guard total > 0 else {
                report(1)
                return
            }
            var done = 0.0
            report(0)
            for model in pending {
                try Task.checkCancellation()
                let before = done
                try await VoiceModels.install(model) { bytes in report(min(1, (before + Double(bytes)) / total)) }
                try VoiceModels.compile(model)
                done += Double(model.totalBytes)
                report(done / total)
            }
            if needsPhonon {
                try Task.checkCancellation()
                let before = done
                let watcher = Task {
                    while !Task.isCancelled {
                        if let fraction = await PhononVoice.status().progress {
                            report(min(1, (before + fraction * Double(VoiceModels.phononBytes)) / total))
                        }
                        try? await Task.sleep(for: .milliseconds(250))
                    }
                }
                defer { watcher.cancel() }
                try await PhononVoice.install()
            }
            report(1)
        }
    }
}

#if canImport(FluidAudio) && canImport(PhononTTS)

/// The microphone side of a run: VAD, EOU, Smart Turn and the recent audio.
/// Owned by the listening loop alone (one task), so it needs no locking.
@available(iOS 18.0, *)
final class ListeningPipeline: @unchecked Sendable {
    let eou: EouStream
    private let vad: VadManager
    private var vadState: VadStreamState
    private let smartTurn: SmartTurn.Model?
    private let speaker: SpeakerModels?
    private var ring: SampleRing
    private var vadPending: [Float] = []
    private var vadStart = 0
    private(set) var total = 0
    // Diagnostics, logged every 2 s: microphone level and the highest speech
    // probability (numbers only, never audio or words).
    private var levelSum: Float = 0
    private var levelCount = 0
    private var peakSpeech: Float = 0
    private var lastReportMs = 0

    init(vad: VadManager, eou: EouStream, smartTurn: SmartTurn.Model?, speaker: SpeakerModels?, config: VoiceConfig) {
        self.vad = vad
        self.eou = eou
        self.smartTurn = smartTurn
        self.speaker = speaker
        vadState = VadStreamState.initial()
        // The longest turn, plus room for the padding and an 8 s Smart Turn window.
        ring = SampleRing(capacity: (config.maxTurnMs + 10_000) * 16)
    }

    /// One microphone buffer in, the policy's inputs out (VAD frames, EOU
    /// words and candidates, then the clock).
    func process(_ samples: [Float]) async throws -> [TurnPolicy.Input] {
        ring.append(samples)
        total += samples.count
        for sample in samples { levelSum += sample * sample }
        levelCount += samples.count
        var inputs: [TurnPolicy.Input] = []
        vadPending.append(contentsOf: samples)
        while vadPending.count >= VadManager.chunkSize {
            let block = Array(vadPending.prefix(VadManager.chunkSize))
            vadPending.removeFirst(VadManager.chunkSize)
            let result = try await vad.processStreamingChunk(block, state: vadState)
            vadState = result.state
            let startMs = vadStart / 16
            vadStart += VadManager.chunkSize
            inputs.append(.vad(probability: result.probability, startMs: startMs, endMs: vadStart / 16))
            peakSpeech = max(peakSpeech, result.probability)
        }
        for output in try eou.feed(samples) {
            switch output {
            case let .partial(text): inputs.append(.partial(text: text))
            case let .endOfUtterance(sample): inputs.append(.eou(atMs: sample / 16))
            }
        }
        inputs.append(.tick(nowMs: total / 16))
        if total / 16 - lastReportMs >= 2000 {
            let rms = levelCount > 0 ? (levelSum / Float(levelCount)).squareRoot() : 0
            let decibels = 20 * log10(max(rms, 1e-7))
            VoiceMode.log.info("voice listen: \(self.total / 16, privacy: .public) ms heard, level \(decibels, format: .fixed(precision: 1), privacy: .public) dBFS, peak speech \(self.peakSpeech, format: .fixed(precision: 2), privacy: .public)")
            lastReportMs = total / 16
            levelSum = 0
            levelCount = 0
            peakSpeech = 0
        }
        return inputs
    }

    /// Smart Turn on the turn so far (its last 8 s), or nil if it cannot run.
    func smartTurnProbability(fromMs: Int, toMs: Int) -> Float? {
        guard let smartTurn else { return nil }
        let to = min(total, toMs * 16)
        let from = max(fromMs * 16 - UtteranceBounds.preRollSamples, to - SmartTurn.windowSamples)
        return try? smartTurn.probability(of: ring.slice(from: from, to: to))
    }

    /// Speech shorter than this is widened back to it for a speaker check.
    static let speakerCheckSamples = 24_000

    /// The voice embedding of `fromMs..<toMs`, widened to at least the last
    /// 1.5 s, or nil if it cannot run.
    func speakerEmbedding(fromMs: Int, toMs: Int) -> SpeakerHeard? {
        let to = min(total, toMs * 16)
        let from = max(0, min(fromMs * 16, to - Self.speakerCheckSamples))
        let samples = ring.slice(from: from, to: to)
        return speakerEmbedding(of: samples)
    }

    /// Each speaker model's embedding of `samples`, or nil if none can run.
    func speakerEmbedding(of samples: [Float]) -> SpeakerHeard? {
        guard let speaker else { return nil }
        let embeddings = speaker.embeddings(of: samples)
        return embeddings.isEmpty ? nil : SpeakerHeard(embeddings: embeddings, audioMs: samples.count / 16)
    }

    /// The committed utterance for the final pass.
    func utterance(_ commit: TurnPolicy.Commit) -> [Float] {
        let range = UtteranceBounds.samples(startMs: commit.startMs, endMs: commit.endMs, available: total)
        return ring.slice(from: range.lowerBound, to: range.upperBound)
    }
}

/// Speech as the speaker models heard it.
struct SpeakerHeard: Sendable {
    let embeddings: SpeakerEmbeddings
    let audioMs: Int
}

/// Counts microphone samples dropped by the bounded stream.
final class DropCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var samples = 0

    func add(_ count: Int) {
        lock.lock()
        samples += count
        lock.unlock()
    }

    /// The count since the last call.
    func take() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let value = samples
        samples = 0
        return value
    }
}

/// A counter a start reads at its beginning and checks after each long wait.
final class StartGate: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    var current: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func bump() {
        lock.lock()
        value += 1
        lock.unlock()
    }
}

@available(iOS 18.0, *)
actor VoiceEngine {
    static let shared = VoiceEngine()
    typealias Emit = @Sendable (VoiceEvent) -> Void

    private enum LoopAction {
        case clearText
        case runSmartTurn(requestId: Int, fromMs: Int, toMs: Int)
        case checkSpeaker(requestId: Int, fromMs: Int, toMs: Int)
        case finalPass(TurnPolicy.Commit)
    }

    private struct TurnMetrics {
        let turnId: String
        var stages: [String: Double]
        let sentAt: ContinuousClock.Instant
        var sent = false
    }

    /// Where Phonon's next chunk may be placed ahead of the render position.
    private static let leadSamples = 720  // 30 ms at 24 kHz

    private var running = false
    private var generation = 0
    private var emit: Emit?
    private var policy = TurnPolicy()
    private var queue = ClauseQueue()
    private var audio: VoiceAudioEngine?
    private var phonon: Phonon?
    private var fluidDirectory: URL?
    private var input: AsyncStream<[Float]>.Continuation?
    private var listenTask: Task<Void, Never>?
    private var monitorTask: Task<Void, Never>?
    private var synthTask: Task<Void, Never>?
    private var synthToken: Int?
    private var synthStartedAt: ContinuousClock.Instant?
    private var pendingActions: [LoopAction] = []
    private var commitStages: [String: Double] = [:]
    private var metrics: TurnMetrics?
    /// The audio graph epoch this actor has caught up with (see `handle(.rebuilt)`).
    private var graphEpoch = 0
    private var micDrops: DropCounter?
    private var config = VoiceConfig.defaults
    /// The person's voice (loaded at start, saved as it is learned).
    private var speaker = SpeakerProfile()
    private var speakerKinds: [SpeakerModelKind] = []

    /// Whether speech is checked against the person's voice.
    private var checksSpeaker: Bool {
        guard let decider = config.speakerModel, speaker.learned else { return false }
        return decider.kinds.contains { speakerKinds.contains($0) && speaker.centroid($0) != nil }
    }

    /// Forgets the person's voice: it is learned again from the next turns.
    func forgetSpeaker() {
        speaker = SpeakerProfile()
        SpeakerStore.remove()
        policy.checksSpeaker = false
        VoiceMode.log.info("voice: speaker profile forgotten")
    }


    /// Bumped at once by `voiceStop` (outside the plugin's call queue), so a
    /// start still loading its models gives up instead of opening the microphone.
    private static let startGate = StartGate()

    /// Cancels any start in progress. Safe from any thread, never waits.
    nonisolated static func cancelPendingStart() { startGate.bump() }

    /// The microphone stream keeps at most this many buffers (about 4 s or
    /// more) if the listening loop falls behind; older ones are dropped and counted.
    static let micBufferLimit = 200

    // MARK: - Lifetime

    /// Loads and warms every model, takes the microphone and starts listening.
    func start(config: VoiceConfig, voice: String?, emit: @escaping Emit) async throws {
        let ticket = Self.startGate.current
        func stillWanted() throws {
            if Self.startGate.current != ticket { throw OnDeviceSpeech.Failure.cancelled }
        }
        if running { await stop(reason: .stopped, report: false) }
        let status = await VoiceMode.status()
        guard status.available, let fluidDirectory = FluidSpeechMini.modelDirectory() else {
            VoiceMode.log.error("voice start: unavailable (device supported \(VoiceMode.canRunHere, privacy: .public), missing \(status.missing.joined(separator: ","), privacy: .public))")
            throw OnDeviceSpeech.Failure.unavailable
        }
        try stillWanted()
        let audio = VoiceAudioEngine()
        do {
            try await audio.prepare()
        } catch {
            VoiceMode.log.error("voice start: microphone permission denied")
            throw error
        }
        try stillWanted()

        let started = ContinuousClock.now
        var heldFluid = false
        var heldPhonon = false
        let pipeline: ListeningPipeline
        let tts: Phonon
        var speakerKinds: [SpeakerModelKind] = []
        do {
            let units = MLComputeUnits.cpuAndNeuralEngine
            let vadConfiguration = MLModelConfiguration()
            vadConfiguration.computeUnits = units
            let vadModel = try MLModel(
                contentsOf: VoiceModels.vad.directory.appendingPathComponent(VoiceModels.vadFile), configuration: vadConfiguration)
            let vad = VadManager(config: VadConfig(defaultThreshold: config.vadThreshold, computeUnits: units), vadModel: vadModel)
            _ = try await vad.processStreamingChunk([Float](repeating: 0, count: VadManager.chunkSize), state: .initial())
            VoiceMode.log.info("voice start: vad at \(Self.milliseconds(since: started), privacy: .public) ms")
            try stillWanted()
            // The streaming encoder fails the Neural Engine compiler on device
            // (ANECCompile FAILED) and the fallback can stall; run it on the GPU.
            let eou = try await EouStream.load(directory: VoiceModels.eou.directory, computeUnits: .cpuAndGPU)
            VoiceMode.log.info("voice start: eou loaded at \(Self.milliseconds(since: started), privacy: .public) ms")
            try stillWanted()
            try eou.warmUp()
            VoiceMode.log.info("voice start: eou warm at \(Self.milliseconds(since: started), privacy: .public) ms")
            // Without Smart Turn the turn still ends, at maxSilenceMs.
            let smartTurn = try? SmartTurn.Model(directory: VoiceModels.smartTurn.directory, computeUnits: units)
            _ = try? smartTurn?.probability(of: [])
            VoiceMode.log.info("voice start: smart turn at \(Self.milliseconds(since: started), privacy: .public) ms")
            try stillWanted()
            // Without it every voice is taken as the person's, as before.
            // Both speaker models load whichever decides, so both keep
            // learning and both scores are logged; one that fails is left out.
            var embedders: [SpeakerEmbedder] = []
            if config.speakerModel != nil {
                for kind in SpeakerModelKind.allCases {
                    do {
                        let embedder = try SpeakerEmbedder(kind: kind, directory: VoiceModels.speakerModel(kind).directory)
                        _ = try embedder.embedding(of: [Float](repeating: 0, count: 1600))
                        embedders.append(embedder)
                    } catch {
                        VoiceMode.log.error("voice start: speaker model \(kind.rawValue, privacy: .public) failed to load")
                    }
                }
            }
            let speakerModels = embedders.isEmpty ? nil : SpeakerModels(embedders)
            VoiceMode.log.info("voice start: speaker at \(Self.milliseconds(since: started), privacy: .public) ms")
            try stillWanted()
            await FluidSpeechMini.Runtime.shared.prepare(modelDirectory: fluidDirectory)
            _ = try await FluidSpeechMini.Runtime.shared.beginLive(modelDirectory: fluidDirectory)
            VoiceMode.log.info("voice start: fluid mini at \(Self.milliseconds(since: started), privacy: .public) ms")
            heldFluid = true
            try stillWanted()
            tts = try await PhononVoice.Runtime.shared.beginVoice(voice: voice)
            VoiceMode.log.info("voice start: phonon loaded at \(Self.milliseconds(since: started), privacy: .public) ms")
            heldPhonon = true
            // Phonon conditions on its voice on the first utterance; do it now.
            _ = try? await tts.synthesize("Ready.")
            VoiceMode.log.info("voice start: phonon warm at \(Self.milliseconds(since: started), privacy: .public) ms")
            try stillWanted()
            pipeline = ListeningPipeline(vad: vad, eou: eou, smartTurn: smartTurn, speaker: speakerModels, config: config)
            speakerKinds = speakerModels?.kinds ?? []
        } catch {
            if heldFluid { await FluidSpeechMini.Runtime.shared.endLive() }
            if heldPhonon { await PhononVoice.Runtime.shared.endVoice() }
            if (error as? OnDeviceSpeech.Failure) != .cancelled {
                VoiceMode.log.error("voice start: models failed to load")
            }
            throw error as? OnDeviceSpeech.Failure ?? OnDeviceSpeech.Failure.failed
        }

        generation += 1
        let current = generation
        let (stream, continuation) = AsyncStream.makeStream(
            of: [Float].self, bufferingPolicy: .bufferingNewest(Self.micBufferLimit))
        let drops = DropCounter()
        do {
            // The last chance to give up before the microphone opens.
            try stillWanted()
            try audio.start(
                deliver: { samples in
                    if case let .dropped(old) = continuation.yield(samples) { drops.add(old.count) }
                },
                notify: { notice in Task { await VoiceEngine.shared.handle(notice, generation: current) } })
        } catch {
            continuation.finish()
            await FluidSpeechMini.Runtime.shared.endLive()
            await PhononVoice.Runtime.shared.endVoice()
            throw error as? OnDeviceSpeech.Failure ?? OnDeviceSpeech.Failure.failed
        }

        running = true
        graphEpoch = 0
        micDrops = drops
        self.emit = emit
        self.audio = audio
        self.phonon = tts
        self.fluidDirectory = fluidDirectory
        input = continuation
        policy = TurnPolicy(config: config)
        policy.echoCancelled = audio.echoCancelled
        self.config = config
        speaker = SpeakerStore.load()
        self.speakerKinds = speakerKinds
        policy.checksSpeaker = checksSpeaker
        let speakerState = config.speakerModel == nil ? "off" : (checksSpeaker ? "on" : (speaker.learned ? "unavailable" : "learning"))
        VoiceMode.log.info("voice start: speaker check \(speakerState, privacy: .public), decided by \(config.speakerModel?.rawValue ?? "nothing", privacy: .public), models \(speakerKinds.map(\.rawValue).joined(separator: "+"), privacy: .public)")
        queue = ClauseQueue()
        pendingActions = []
        metrics = nil
        listenTask = Task.detached(priority: .userInitiated) { [self] in
            await self.listen(stream, pipeline: pipeline, generation: current)
        }
        monitorTask = Task { [self] in
            while !Task.isCancelled {
                self.monitor(generation: current)
                try? await Task.sleep(for: .milliseconds(10))
            }
        }
        VoiceMode.log.info("voice start: ready in \(Self.milliseconds(since: started), privacy: .public) ms")
        emit(.state(.listening))
    }

    /// Ends any answer, releases the microphone and the models, and sends
    /// `ended`.
    func stop(reason: VoiceEndReason = .stopped, report: Bool = true) async {
        guard running else { return }
        // Everything up to the first await happens at once: a start queued
        // behind this stop can run while it awaits (actor reentrancy), and
        // must find nothing of this run left to touch, its emit included.
        running = false
        generation += 1
        listenTask?.cancel()
        monitorTask?.cancel()
        listenTask = nil
        monitorTask = nil
        let turnId = queue.turnId
        // Always: no synthesis may outlive the run, and no held player.
        if let interruption = stopSpeaking(), let turnId {
            send(.interrupted(turnId: turnId, clauseId: interruption.clauseId, fraction: interruption.fraction))
        }
        queue.clear()
        if let turnId = metrics?.turnId { flushMetrics(turnId) }
        let emit = self.emit
        self.emit = nil
        metrics = nil
        micDrops = nil
        input?.finish()
        input = nil
        audio?.stop()
        audio = nil
        phonon = nil
        await PhononVoice.Runtime.shared.endVoice()
        await FluidSpeechMini.Runtime.shared.endLive()
        VoiceMode.log.info("voice stop: \(reason.rawValue, privacy: .public)")
        if report { emit?(.ended(reason)) }
    }

    var isRunning: Bool { running }

    private func handle(_ notice: VoiceAudioEngine.Notice, generation: Int) async {
        guard generation == self.generation, running else { return }
        switch notice {
        case let .rebuilt(epoch):
            // The new player's timeline is empty: what was not heard is spoken
            // again, on the new epoch (chunks placed for the old one were dropped).
            VoiceMode.log.info("voice: audio graph rebuilt")
            graphEpoch = epoch
            cancelSynthesis()
            queue.rewind()
            pumpSpeech()
        case let .ended(reason):
            await stop(reason: reason)
        }
    }

    // MARK: - Listening

    /// The listening loop, off the actor: the models run here and only the
    /// policy's bookkeeping hops onto the actor.
    nonisolated private func listen(_ stream: AsyncStream<[Float]>, pipeline: ListeningPipeline, generation: Int) async {
        for await samples in stream {
            if Task.isCancelled { break }
            let inputs: [TurnPolicy.Input]
            do {
                inputs = try await pipeline.process(samples)
            } catch {
                VoiceMode.log.error("voice: listening models failed")
                await fail(generation: generation)
                break
            }
            var actions = await apply(inputs, generation: generation)
            while !actions.isEmpty {
                switch actions.removeFirst() {
                case .clearText:
                    pipeline.eou.clearText()
                case let .runSmartTurn(requestId, fromMs, toMs):
                    let started = ContinuousClock.now
                    let probability = pipeline.smartTurnProbability(fromMs: fromMs, toMs: toMs)
                    actions += await smartTurnAnswered(
                        requestId: requestId, probability: probability,
                        milliseconds: Self.milliseconds(since: started), generation: generation)
                case let .checkSpeaker(requestId, fromMs, toMs):
                    let started = ContinuousClock.now
                    let heard = pipeline.speakerEmbedding(fromMs: fromMs, toMs: toMs)
                    actions += await speakerChecked(
                        requestId: requestId, heard: heard,
                        milliseconds: Self.milliseconds(since: started), generation: generation)
                case let .finalPass(commit):
                    let audio = pipeline.utterance(commit)
                    let started = ContinuousClock.now
                    let heard = pipeline.speakerEmbedding(of: audio)
                    let checkMs = Self.milliseconds(since: started)
                    Task { await self.finalPass(commit, audio: audio, heard: heard, checkMs: checkMs, generation: generation) }
                }
            }
        }
    }

    private func smartTurnAnswered(requestId: Int, probability: Float?, milliseconds: Double, generation: Int) -> [LoopAction] {
        guard generation == self.generation else { return [] }
        commitStages["smartTurn"] = milliseconds
        return apply([.smartTurn(requestId: requestId, probability: probability)], generation: generation)
    }

    private func speakerChecked(
        requestId: Int, heard: SpeakerHeard?, milliseconds: Double, generation: Int
    ) -> [LoopAction] {
        guard generation == self.generation else { return [] }
        let verdict = heard.map { speaker.check($0.embeddings, audioMs: $0.audioMs, rule: config.speakerRule) } ?? .unknown
        let match = verdict.outcome != .mismatch
        VoiceMode.log.info("voice: barge-in speaker check \(match ? "same" : "other", privacy: .public) voice, \(Self.describe(verdict), privacy: .public), \(heard?.audioMs ?? 0, privacy: .public) ms audio, \(Int(milliseconds), privacy: .public) ms")
        return apply([.speakerChecked(requestId: requestId, match: match)], generation: generation)
    }

    /// Each model's score and the decision's margin, for the log (numbers only).
    private static func describe(_ verdict: SpeakerProfile.Verdict) -> String {
        var parts = SpeakerModelKind.allCases.compactMap { kind in
            verdict.similarities[kind].map { "\(kind.rawValue) \(String(format: "%.2f", $0))" }
        }
        if let margin = verdict.margin { parts.append("margin \(String(format: "%+.2f", margin))") }
        return parts.isEmpty ? "no scores" : parts.joined(separator: ", ")
    }

    private func fail(generation: Int) async {
        guard generation == self.generation else { return }
        await stop(reason: .error)
    }

    private func apply(_ inputs: [TurnPolicy.Input], generation: Int) -> [LoopAction] {
        guard generation == self.generation, running else { return [] }
        for input in inputs { carryOut(policy.handle(input)) }
        defer { pendingActions = [] }
        return pendingActions
    }

    private func carryOut(_ decisions: [TurnPolicy.Decision]) {
        for decision in decisions {
            switch decision {
            case let .state(state):
                send(.state(state))
            case let .partial(text):
                send(.partial(text: text))
            case let .runSmartTurn(requestId, fromMs, toMs):
                pendingActions.append(.runSmartTurn(requestId: requestId, fromMs: fromMs, toMs: toMs))
            case let .checkSpeaker(requestId, fromMs, toMs):
                pendingActions.append(.checkSpeaker(requestId: requestId, fromMs: fromMs, toMs: toMs))
            case let .commit(commit):
                let smartTurn = commitStages["smartTurn"]
                commitStages = ["endOfSpeechToCommit": Double(commit.decidedAtMs - commit.endMs)]
                if commit.reason == .smartTurn, let smartTurn { commitStages["smartTurn"] = smartTurn }
                VoiceMode.log.info("voice: commit (\(commit.reason.rawValue, privacy: .public)) \(commit.decidedAtMs - commit.endMs, privacy: .public) ms after speech")
                pendingActions += [.clearText, .finalPass(commit)]
            case let .bargeIn(turnId):
                send(.bargeIn(turnId: turnId))
                let interruption = stopSpeaking()
                if let interruption {
                    send(.interrupted(turnId: turnId, clauseId: interruption.clauseId, fraction: interruption.fraction))
                }
                let heard = policy.lastBargeIn
                VoiceMode.log.info("voice: barge-in while \(interruption == nil ? "thinking" : "speaking", privacy: .public), \(heard?.speechMs ?? -1, privacy: .public) ms speech, \(heard?.foreignWords ?? -1, privacy: .public) new words: \(heard?.text ?? "", privacy: .private)")
                flushMetrics(turnId)
            case .clearTranscript:
                pendingActions.append(.clearText)
            case .pausePlayback:
                audio?.pausePlayer()
                VoiceMode.log.info("voice: playback held (possible barge-in)")
            case .resumePlayback:
                audio?.resumePlayer()
                VoiceMode.log.info("voice: false start, playback resumed")
            }
        }
    }

    private func finalPass(
        _ commit: TurnPolicy.Commit, audio samples: [Float], heard: SpeakerHeard?,
        checkMs: Double, generation: Int
    ) async {
        guard generation == self.generation, running else { return }
        let verdict = heard.map { speaker.check($0.embeddings, audioMs: $0.audioMs, rule: config.speakerRule) } ?? .unknown
        if !verdict.similarities.isEmpty {
            VoiceMode.log.info("voice: turn speaker check \(verdict.outcome == .mismatch ? "other" : "same", privacy: .public) voice, \(Self.describe(verdict), privacy: .public), \(heard?.audioMs ?? 0, privacy: .public) ms audio, \(Int(checkMs), privacy: .public) ms")
        }
        if verdict.outcome == .mismatch, checksSpeaker {
            VoiceMode.log.info("voice: turn ignored, another voice")
            send(.ignored(.otherVoice))
            carryOut(policy.handle(.turnDiscarded))
            return
        }
        let started = ContinuousClock.now
        var text = ""
        if let fluidDirectory {
            text = (try? await FluidSpeechMini.Runtime.shared.transcribe(samples: samples, modelDirectory: fluidDirectory)) ?? ""
        }
        guard generation == self.generation, running else { return }
        var stages = commitStages
        stages["finalPass"] = Self.milliseconds(since: started)
        stages["utterance"] = Double(commit.endMs - commit.startMs)
        guard !text.isEmpty else {
            VoiceMode.log.info("voice: nothing to send after the final pass")
            carryOut(policy.handle(.turnDiscarded))
            return
        }
        if let heard { learnSpeaker(heard) }
        if heard != nil { stages["speakerCheck"] = checkMs }
        let turnId = UUID().uuidString.lowercased()
        if let previous = metrics?.turnId { flushMetrics(previous) }
        metrics = TurnMetrics(turnId: turnId, stages: stages, sentAt: .now)
        send(.turn(turnId: turnId, text: text, audioMs: commit.endMs - commit.startMs))
        carryOut(policy.handle(.turnCommitted(turnId: turnId, text: text)))
    }

    /// Learns the person's voice from a turn sent as theirs.
    private func learnSpeaker(_ heard: SpeakerHeard) {
        guard config.speakerModel != nil else { return }
        let wasLearned = speaker.learned
        guard speaker.learn(heard.embeddings, audioMs: heard.audioMs, rule: config.speakerRule) else { return }
        SpeakerStore.save(speaker)
        if speaker.learned, !wasLearned {
            VoiceMode.log.info("voice: speaker profile learned")
        } else if !speaker.learned {
            VoiceMode.log.info("voice: speaker profile learning, \(self.speaker.candidates.count, privacy: .public) turns heard")
        }
        policy.checksSpeaker = checksSpeaker
    }

    // MARK: - Speaking

    /// Queues a clause of the current answer (ignored for any other turn).
    func speak(turnId: String, clauseId: Int, text: String) {
        guard running, turnId == policy.answerTurnId else { return }
        if queue.turnId != turnId { queue.begin(turnId: turnId) }
        queue.accept(turnId: turnId, clauseId: clauseId, text: text)
        pumpSpeech()
    }

    /// No more clauses: `answerFinished` follows the last one.
    func endAnswer(turnId: String) {
        guard running, turnId == policy.answerTurnId else { return }
        if queue.turnId != turnId { queue.begin(turnId: turnId) }
        queue.end(turnId: turnId)
    }

    /// The web app gave up on this answer: stop at once and listen.
    func cancelAnswer(turnId: String) {
        guard running, turnId == policy.answerTurnId || turnId == queue.turnId else { return }
        if queue.turnId == turnId, let interruption = stopSpeaking() {
            send(.interrupted(turnId: turnId, clauseId: interruption.clauseId, fraction: interruption.fraction))
        }
        flushMetrics(turnId)
        carryOut(policy.handle(.answerEnded(turnId: turnId)))
    }

    /// Stops playback and synthesis and ends the queue's answer; says what was heard.
    private func stopSpeaking() -> ClauseQueue.Interruption? {
        cancelSynthesis()
        let played = audio?.playedSample() ?? 0
        let interruption = queue.interrupt(playedSample: played)
        audio?.stopPlayer()
        queue.resetTimeline()
        return interruption
    }

    private func cancelSynthesis() {
        // Cancelling the consuming task stops Phonon's producer at its next
        // 80 ms frame; breaking the loop alone would not.
        synthTask?.cancel()
        synthTask = nil
        synthToken = nil
    }

    private func pumpSpeech() {
        guard running, synthTask == nil, let phonon, let clause = queue.nextToPrepare() else { return }
        let token = queue.token
        synthToken = token
        synthStartedAt = .now
        // Runs on this actor: it waits on Phonon's stream, and placing a chunk
        // is quick bookkeeping plus one scheduleBuffer.
        synthTask = Task { [self] in
            var held: [Float]?
            var first = true
            do {
                for try await chunk in phonon.stream(clause.text) {
                    if Task.isCancelled { break }
                    if var previous = held {
                        if first { Fade.fadeIn(&previous); first = false }
                        self.place(previous, clauseId: clause.id, token: token)
                    }
                    held = chunk
                }
            } catch {
                VoiceMode.log.error("voice: a clause could not be synthesised")
            }
            if !Task.isCancelled, var last = held {
                if first { Fade.fadeIn(&last) }
                Fade.fadeOut(&last)
                self.place(last, clauseId: clause.id, token: token)
            }
            self.prepared(clauseId: clause.id, token: token)
        }
    }

    private func place(_ samples: [Float], clauseId: Int, token: Int) {
        guard let audio, queue.isCurrent(token) else { return }
        let at = queue.placement(playedSample: audio.renderedSample() ?? 0, lead: Self.leadSamples)
        // A rebuild this actor has not handled yet: drop the chunk; the
        // clause is spoken again from its start once it is handled.
        guard audio.schedule(samples, at: at, epoch: graphEpoch) else { return }
        queue.scheduled(clauseId: clauseId, startSample: at, count: samples.count, token: token)
        if var metrics, metrics.turnId == queue.turnId, metrics.stages["firstClauseSynthesis"] == nil, let synthStartedAt {
            metrics.stages["firstClauseSynthesis"] = Self.milliseconds(since: synthStartedAt)
            self.metrics = metrics
        }
    }

    private func prepared(clauseId: Int, token: Int) {
        queue.prepared(clauseId: clauseId, token: token)
        if synthToken == token {
            synthTask = nil
            synthToken = nil
        }
        pumpSpeech()
    }

    /// The played-sample clock, every 10 ms: which clauses have started and
    /// finished being heard.
    private func monitor(generation: Int) {
        guard generation == self.generation, running, let turnId = queue.turnId, let audio else { return }
        for event in queue.advance(playedSample: audio.playedSample() ?? 0) {
            switch event {
            case let .started(clauseId):
                send(.clauseStarted(turnId: turnId, clauseId: clauseId))
                carryOut(policy.handle(.clausePlaying(turnId: turnId, text: queue.text(of: clauseId) ?? "")))
                if var metrics, metrics.turnId == turnId, metrics.stages["commitToFirstAudio"] == nil {
                    metrics.stages["commitToFirstAudio"] = Self.milliseconds(since: metrics.sentAt)
                    self.metrics = metrics
                    flushMetrics(turnId)
                }
            case let .played(clauseId):
                send(.clausePlayed(turnId: turnId, clauseId: clauseId))
            case .finished:
                send(.answerFinished(turnId: turnId))
                queue.clear()
                flushMetrics(turnId)
                carryOut(policy.handle(.answerEnded(turnId: turnId)))
            }
        }
        pumpSpeech()
    }

    // MARK: - Events

    private func send(_ event: VoiceEvent) {
        emit?(event)
    }

    private func flushMetrics(_ turnId: String) {
        guard var metrics, metrics.turnId == turnId, !metrics.sent else { return }
        metrics.sent = true
        // Microphone audio dropped because listening fell behind, since the last report.
        if let dropped = micDrops?.take(), dropped > 0 { metrics.stages["micDroppedMs"] = Double(dropped) / 16 }
        self.metrics = metrics
        VoiceMode.log.info("voice metrics: \(metrics.stages.map { "\($0.key)=\(Int($0.value))" }.sorted().joined(separator: " "), privacy: .public)")
        send(.metrics(turnId: turnId, stages: metrics.stages))
    }

    private static func milliseconds(since start: ContinuousClock.Instant) -> Double {
        let elapsed = ContinuousClock.now - start
        return Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
    }
}

#endif
