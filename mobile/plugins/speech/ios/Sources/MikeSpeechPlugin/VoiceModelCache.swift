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
/// for its compute units when it is loaded (the EOU encoder runs on the GPU,
/// where the specialisation is not kept between loads; the rest on the Neural
/// Engine, where the system keeps it across launches once it has compiled it
/// after an install or an update), then a first prediction warms it. Before this cache every start loaded VAD, EOU,
/// Smart Turn and the speaker models one after another and every stop dropped
/// them, so each start paid the full cost again. The models hold no per-run
/// state (streams and VAD state are made fresh for each run), so one set
/// serves each run in turn.
///
/// Each model loads on its own task; a load that fails is forgotten so the
/// next start tries again, and one still running when a start is cancelled
/// carries on for the next. A start waits for the VAD only and takes the other
/// models as they finish (see `VoiceEngine.start`); `VoiceMode.prewarm` loads
/// them ahead of the tap, cheapest first. They are dropped on a memory warning while voice mode is off, and when
/// the models are removed.
@available(iOS 18.0, *)
actor VoiceModelCache {
    static let shared = VoiceModelCache()

    /// The listening models, by when a start needs them. A start waits only
    /// for the VAD; the rest attach to the running listener as they arrive.
    enum Model: String, CaseIterable, Sendable {
        case vad, smartTurn, speaker, eou

        /// Its name in `VoicePreparation` and the contract's `ready` list.
        var readyName: String {
            switch self {
            case .vad: return VoiceModelName.vad.rawValue
            case .smartTurn: return VoiceModelName.smartTurn.rawValue
            case .speaker: return VoiceModelName.speaker.rawValue
            case .eou: return VoiceModelName.eou.rawValue
            }
        }
    }

    /// One in-flight (or finished) load per model, shared by every caller.
    private var loads = SingleFlight()
    private var observer: NSObjectProtocol?

    /// The VAD, loading it if needed. Throws if it cannot load.
    func vad() async throws -> MLModel {
        observeMemory()
        return try await value("vad") { try await Self.loadVad() }
    }

    /// The streaming end-of-utterance models (the slowest: a 213 MB encoder on the GPU).
    func eou() async throws -> EouStream.Models {
        observeMemory()
        return try await value("eou") { try await Self.loadEou() }
    }

    /// Smart Turn, or nil if it cannot load.
    func smartTurn() async -> SmartTurn.Model? {
        observeMemory()
        return (try? await value("smart-turn") { Box(try? await Self.loadSmartTurn()) })?.value
    }

    /// One speaker model, or nil if it cannot load. The two kinds load (and
    /// finish) independently, so a start attaches the speaker check with the
    /// first and adds the other when it arrives.
    func speaker(_ kind: SpeakerModelKind) async -> SpeakerEmbedder? {
        observeMemory()
        return (try? await value("speaker-\(kind.rawValue)") { Box(await Self.loadSpeaker(kind)) })?.value
    }

    /// Every speaker model, or nil if none can load (both load at once).
    func speaker() async -> SpeakerModels? {
        async let wespeaker = speaker(.wespeaker)
        async let campplus = speaker(.campplus)
        let loaded = await [wespeaker, campplus].compactMap { $0 }
        return loaded.isEmpty ? nil : SpeakerModels(loaded)
    }

    /// Loads one model ahead of a start, keeping it; failures are left for the start.
    func load(_ model: Model) async {
        switch model {
        case .vad: _ = try? await vad()
        case .smartTurn: _ = await smartTurn()
        case .speaker: _ = await speaker()
        case .eou: _ = try? await eou()
        }
    }

    /// Drops every model; a running voice mode keeps the copies it holds.
    func release() {
        loads = SingleFlight()
        Self.speakerOutcomes.reset()
        VoicePreparation.shared.markUnloaded(Model.allCases.map(\.readyName))
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        VoiceMode.log.notice("voice cache: released")
    }

    // MARK: - Loading

    private struct Box<T>: @unchecked Sendable {
        let value: T
        init(_ value: T) { self.value = value }
    }

    /// The memoised result of `work`, run once for `key` and shared by every caller.
    private func value<T: Sendable>(_ key: String, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await loads.value(key, work)
    }

    private static let units = MLComputeUnits.cpuAndNeuralEngine

    /// Runs a load, logging how long it took (the lines `voice cache: <model>
    /// ready in N ms`) and reporting it to `VoicePreparation`. `ok` says
    /// whether the result is a usable model.
    private static func timed<T>(_ model: Model, _ name: String, ok: (T) -> Bool = { _ in true }, _ work: () async throws -> T) async rethrows -> T {
        let started = ContinuousClock.now
        // A slow compile is only logged, never cancelled or waited for.
        let result = try await LoadWatchdog.run(onSlow: { seconds in
            VoiceMode.log.notice("voice cache: \(name, privacy: .public) still loading after \(seconds, privacy: .public) s")
        }, work)
        let ms = VoiceEngine.milliseconds(since: started)
        VoiceMode.log.notice("voice cache: \(name, privacy: .public) ready in \(ms, privacy: .public) ms")
        VoicePreparation.shared.noteLoad(model.readyName, ms: ms)
        if ok(result) { VoicePreparation.shared.markReady(model.readyName) }
        return result
    }

    private static func loadVad() async throws -> MLModel {
        try await timed(.vad, "vad") {
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
        try await timed(.eou, "eou") {
            // The streaming encoder fails the Neural Engine compiler on device
            // (ANECCompile FAILED) and the fallback can stall; run it on the GPU.
            let models = try await EouStream.loadModels(directory: VoiceModels.eou.directory, computeUnits: .cpuAndGPU)
            try EouStream(models: models).warmUp()
            return models
        }
    }

    private static func loadSmartTurn() async throws -> SmartTurn.Model {
        try await timed(.smartTurn, "smart turn") {
            let model = try SmartTurn.Model(directory: VoiceModels.smartTurn.directory, computeUnits: units)
            _ = try? model.probability(of: [])
            return model
        }
    }

    /// Which speaker kinds have finished loading and whether each worked. The
    /// "speaker" model counts as ready once every kind has finished and at
    /// least one loaded.
    final class SpeakerOutcomes: @unchecked Sendable {
        private let lock = NSLock()
        private var outcomes: [SpeakerModelKind: Bool] = [:]

        /// Records `kind`; true when this completes the set with a usable model.
        func note(_ kind: SpeakerModelKind, loaded: Bool) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            outcomes[kind] = loaded
            return outcomes.count == SpeakerModelKind.allCases.count && outcomes.values.contains(true)
        }

        func reset() {
            lock.lock()
            outcomes = [:]
            lock.unlock()
        }
    }

    static let speakerOutcomes = SpeakerOutcomes()

    /// One speaker model; nil if it fails (the other still serves).
    private static func loadSpeaker(_ kind: SpeakerModelKind) async -> SpeakerEmbedder? {
        let embedder: SpeakerEmbedder? = await timed(.speaker, "speaker \(kind.rawValue)", ok: { _ in false }) {
            do {
                // Each part's own load and first prediction (where the
                // Neural Engine compile happens) is logged separately.
                let embedder = try SpeakerEmbedder(
                    kind: kind, directory: VoiceModels.speakerModel(kind).directory,
                    onPart: { part, ms in
                        VoiceMode.log.notice("voice cache: speaker \(kind.rawValue, privacy: .public) \(part, privacy: .public) loaded in \(ms, privacy: .public) ms")
                    })
                _ = try embedder.embedding(of: [Float](repeating: 0, count: 1600), onPart: { part, ms in
                    VoiceMode.log.notice("voice cache: speaker \(kind.rawValue, privacy: .public) \(part, privacy: .public) first prediction in \(ms, privacy: .public) ms")
                })
                return embedder
            } catch {
                VoiceMode.log.error("voice start: speaker model \(kind.rawValue, privacy: .public) failed to load")
                return nil
            }
        }
        if speakerOutcomes.note(kind, loaded: embedder != nil) { VoicePreparation.shared.markReady(Model.speaker.readyName) }
        return embedder
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
