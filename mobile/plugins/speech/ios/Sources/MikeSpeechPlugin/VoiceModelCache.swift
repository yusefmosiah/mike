import CoreML
import Foundation
import UIKit
#if canImport(FluidAudio)
import FluidAudio
#endif

#if canImport(FluidAudio) && canImport(PhononTTS)

/// The listening models of hands-free voice mode, loaded once per app run and
/// kept across voice sessions.
///
/// Loading them is the slow part of a start: Core ML specialises each model
/// for its compute units when it is loaded (the EOU encoder and WeSpeaker run
/// on the GPU, where the specialisation is not kept between loads), then a
/// first prediction warms it. Before this cache every start loaded VAD, EOU,
/// Smart Turn and the speaker models one after another and every stop dropped
/// them, so each start paid the full cost again. The models hold no per-run
/// state (streams and VAD state are made fresh for each run), so one set
/// serves each run in turn.
///
/// Each model loads on its own task, all at once; a load that fails is
/// forgotten so the next start tries again, and one still running when a start
/// is cancelled carries on for the next. `prewarm` starts them ahead of the
/// tap. They are dropped on a memory warning while voice mode is off, and when
/// the models are removed.
@available(iOS 18.0, *)
actor VoiceModelCache {
    static let shared = VoiceModelCache()

    /// Everything a listening run needs from the cache.
    struct Listening: @unchecked Sendable {
        let vadModel: MLModel
        let eou: EouStream.Models
        let smartTurn: SmartTurn.Model?
        let speaker: SpeakerModels?
    }

    private var tasks: [String: Any] = [:]
    private var observer: NSObjectProtocol?

    /// The listening models, loading what is not loaded yet in parallel.
    /// `speaker`: whether the speaker models are wanted.
    func listening(speaker wantsSpeaker: Bool) async throws -> Listening {
        observeMemory()
        async let vad = value("vad") { try await Self.loadVad() }
        async let eou = value("eou") { try await Self.loadEou() }
        async let smartTurn = value("smart-turn") { Box(try? await Self.loadSmartTurn()) }
        async let speaker = speakerModels(wanted: wantsSpeaker)
        let vadModel = try await vad
        let eouModels = try await eou
        return Listening(vadModel: vadModel, eou: eouModels, smartTurn: try await smartTurn.value, speaker: try await speaker.value)
    }

    private func speakerModels(wanted: Bool) async throws -> Box<SpeakerModels?> {
        guard wanted else { return Box(nil) }
        return try await value("speaker") { Box(await Self.loadSpeaker()) }
    }

    /// Drops every model; a running voice mode keeps the copies it holds.
    func release() {
        tasks = [:]
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        VoiceMode.log.info("voice cache: released")
    }

    // MARK: - Loading

    private struct Box<T>: @unchecked Sendable {
        let value: T
        init(_ value: T) { self.value = value }
    }

    /// The memoised result of `work`, run once for `key` and shared by every caller.
    private func value<T: Sendable>(_ key: String, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let task: Task<T, Error>
        if let existing = tasks[key] as? Task<T, Error> {
            task = existing
        } else {
            task = Task { try await work() }
            tasks[key] = task
        }
        do {
            return try await task.value
        } catch {
            // A failed load is forgotten so the next start retries it.
            if (tasks[key] as? Task<T, Error>) == task { tasks[key] = nil }
            throw error
        }
    }

    private static let units = MLComputeUnits.cpuAndNeuralEngine

    private static func timed<T>(_ name: String, _ work: () async throws -> T) async rethrows -> T {
        let started = ContinuousClock.now
        defer { VoiceMode.log.info("voice cache: \(name, privacy: .public) ready in \(VoiceEngine.milliseconds(since: started), privacy: .public) ms") }
        return try await work()
    }

    private static func loadVad() async throws -> MLModel {
        try await timed("vad") {
            let configuration = MLModelConfiguration()
            configuration.computeUnits = units
            let model = try MLModel(
                contentsOf: VoiceModels.vad.directory.appendingPathComponent(VoiceModels.vadFile), configuration: configuration)
            // Warm it with a throwaway manager; each run builds its own with its threshold.
            let manager = VadManager(config: VadConfig(defaultThreshold: VoiceConfig.defaults.vadThreshold, computeUnits: units), vadModel: model)
            _ = try await manager.processStreamingChunk([Float](repeating: 0, count: VadManager.chunkSize), state: .initial())
            return model
        }
    }

    private static func loadEou() async throws -> EouStream.Models {
        try await timed("eou") {
            // The streaming encoder fails the Neural Engine compiler on device
            // (ANECCompile FAILED) and the fallback can stall; run it on the GPU.
            let models = try await EouStream.loadModels(directory: VoiceModels.eou.directory, computeUnits: .cpuAndGPU)
            try EouStream(models: models).warmUp()
            return models
        }
    }

    private static func loadSmartTurn() async throws -> SmartTurn.Model {
        try await timed("smart turn") {
            let model = try SmartTurn.Model(directory: VoiceModels.smartTurn.directory, computeUnits: units)
            _ = try? model.probability(of: [])
            return model
        }
    }

    /// Both speaker models, side by side; one that fails is left out, and nil
    /// if none loads (every voice is then taken as the person's).
    private static func loadSpeaker() async -> SpeakerModels? {
        await timed("speaker") {
            let embedders = await withTaskGroup(of: SpeakerEmbedder?.self) { group in
                for kind in SpeakerModelKind.allCases {
                    group.addTask {
                        do {
                            let embedder = try SpeakerEmbedder(kind: kind, directory: VoiceModels.speakerModel(kind).directory)
                            _ = try embedder.embedding(of: [Float](repeating: 0, count: 1600))
                            return embedder
                        } catch {
                            VoiceMode.log.error("voice start: speaker model \(kind.rawValue, privacy: .public) failed to load")
                            return nil
                        }
                    }
                }
                var loaded: [SpeakerEmbedder] = []
                for await embedder in group { if let embedder { loaded.append(embedder) } }
                return loaded
            }
            // Kind order, as before, whichever finished first.
            let ordered = SpeakerModelKind.allCases.compactMap { kind in embedders.first { $0.kind == kind } }
            return ordered.isEmpty ? nil : SpeakerModels(ordered)
        }
    }

    private func observeMemory() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
        ) { _ in
            Task {
                if await !VoiceEngine.shared.isRunning { await VoiceModelCache.shared.release() }
            }
        }
    }
}

#endif
