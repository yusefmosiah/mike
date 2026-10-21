import CoreML
import Foundation

/// One speaker model on Core ML: 16 kHz speech in, a voice embedding out
/// (unit length). Speech is judged on its last 10 s.
///
/// - WeSpeaker ResNet34-LM (pyannote's VoxCeleb model, FluidAudio's
///   conversion) takes a batch of three 10 s windows with a frame mask; one
///   window is used, the speech repeated to fill it (padding with silence
///   would pull every embedding toward the same point).
/// - CAM++ (FunASR, Fluid Inference's conversion) is a filterbank model on
///   the CPU, then the embedding model on the Neural Engine; it needs at least
///   0.66 s, so shorter speech is repeated to a second.
final class SpeakerEmbedder {
    static let windowSamples = 160_000
    private static let wespeakerBatch = 3
    private static let wespeakerMaskFrames = 589
    private static let campplusMinimumSamples = 16_000

    let kind: SpeakerModelKind
    private let models: [MLModel]

    /// The compiled models of `kind`, with the units each runs on.
    static func files(_ kind: SpeakerModelKind) -> [(name: String, units: MLComputeUnits)] {
        switch kind {
        // Its own filterbank is more than the Neural Engine takes whole.
        case .wespeaker: return [("wespeaker_v2.mlmodelc", .cpuAndGPU)]
        case .campplus: return [("CamPlusPreprocessor.mlmodelc", .cpuOnly), ("CamPlusPlus.mlmodelc", .cpuAndNeuralEngine)]
        }
    }

    init(kind: SpeakerModelKind, directory: URL, computeUnits: MLComputeUnits? = nil) throws {
        self.kind = kind
        models = try Self.files(kind).map { file in
            let configuration = MLModelConfiguration()
            configuration.computeUnits = computeUnits ?? file.units
            return try MLModel(contentsOf: directory.appendingPathComponent(file.name), configuration: configuration)
        }
    }

    /// The embedding of `samples` (its last 10 s), or nil for no audio.
    func embedding(of samples: [Float]) throws -> [Float]? {
        guard !samples.isEmpty else { return nil }
        let speech = Array(samples.suffix(Self.windowSamples))
        let output: MLMultiArray?
        switch kind {
        case .wespeaker: output = try wespeaker(speech)
        case .campplus: output = try campplus(speech)
        }
        guard let output, output.count >= kind.dimensions else { return nil }
        var embedding = [Float](repeating: 0, count: kind.dimensions)
        for i in 0..<kind.dimensions { embedding[i] = output[i].floatValue }
        return SpeakerProfile.normalised(embedding, kind: kind)
    }

    private func wespeaker(_ speech: [Float]) throws -> MLMultiArray? {
        let waveform = try MLMultiArray(
            shape: [NSNumber(value: Self.wespeakerBatch), NSNumber(value: Self.windowSamples)], dataType: .float32)
        let mask = try MLMultiArray(
            shape: [NSNumber(value: Self.wespeakerBatch), NSNumber(value: Self.wespeakerMaskFrames)], dataType: .float32)
        let wave = waveform.dataPointer.bindMemory(to: Float.self, capacity: waveform.count)
        wave.update(repeating: 0, count: waveform.count)
        Self.repeated(speech, into: wave, count: Self.windowSamples)
        let frames = mask.dataPointer.bindMemory(to: Float.self, capacity: mask.count)
        frames.update(repeating: 0, count: mask.count)
        frames.update(repeating: 1, count: Self.wespeakerMaskFrames)
        let input = try MLDictionaryFeatureProvider(dictionary: ["waveform": waveform, "mask": mask])
        return try models[0].prediction(from: input).featureValue(for: "embedding")?.multiArrayValue
    }

    private func campplus(_ speech: [Float]) throws -> MLMultiArray? {
        let count = max(speech.count, Self.campplusMinimumSamples)
        let waveform = try MLMultiArray(shape: [1, NSNumber(value: count)], dataType: .float32)
        Self.repeated(speech, into: waveform.dataPointer.bindMemory(to: Float.self, capacity: count), count: count)
        let features = try models[0].prediction(from: MLDictionaryFeatureProvider(dictionary: ["waveform": waveform]))
            .featureValue(for: "features")?.multiArrayValue
        guard let features else { return nil }
        return try models[1].prediction(from: MLDictionaryFeatureProvider(dictionary: ["feats": features]))
            .featureValue(for: "embedding")?.multiArrayValue
    }

    /// Fills `count` samples with `speech`, repeated.
    private static func repeated(_ speech: [Float], into pointer: UnsafeMutablePointer<Float>, count: Int) {
        var index = 0
        while index < count {
            for sample in speech where index < count {
                pointer[index] = sample
                index += 1
            }
        }
    }
}

/// Every speaker model that loaded, run side by side (WeSpeaker on the GPU,
/// CAM++ on the CPU and the Neural Engine).
final class SpeakerModels: @unchecked Sendable {
    let embedders: [SpeakerEmbedder]

    init(_ embedders: [SpeakerEmbedder]) {
        self.embedders = embedders
    }

    var kinds: [SpeakerModelKind] { embedders.map(\.kind) }

    /// Each model's embedding of `samples` (a model that fails is left out).
    func embeddings(of samples: [Float]) -> SpeakerEmbeddings {
        let lock = NSLock()
        var result: SpeakerEmbeddings = [:]
        DispatchQueue.concurrentPerform(iterations: embedders.count) { index in
            let embedder = embedders[index]
            guard let embedding = try? embedder.embedding(of: samples) else { return }
            lock.lock()
            result[embedder.kind] = embedding
            lock.unlock()
        }
        return result
    }
}
