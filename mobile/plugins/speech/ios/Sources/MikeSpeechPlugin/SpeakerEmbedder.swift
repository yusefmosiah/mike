import CoreML
import Foundation

/// One speaker model on Core ML: 16 kHz speech in, a voice embedding out
/// (unit length). Speech is judged on its last 10 s.
///
/// - WeSpeaker ResNet34-LM (pyannote's community-1 VoxCeleb model, FluidAudio's
///   conversion) is two models: a filterbank on the CPU (about 4 ms) feeding
///   the embedding network in half precision on the Neural Engine (about 6 ms
///   a window on a Mac). One 10 s window is used, the speech repeated to fill
///   it (padding with silence would pull every embedding toward the same
///   point); every frame of it is then speech, so the frame weights are all 1.
///   The earlier single-model conversion ran on the GPU, took over a minute to
///   specialise on a first load and is not comparable with this one (the
///   speaker profile's version covers that).
/// - CAM++ (FunASR, Fluid Inference's conversion) is a filterbank model on
///   the CPU, then the embedding model on the Neural Engine; it needs at least
///   0.66 s, so shorter speech is repeated to a second.
final class SpeakerEmbedder {
    static let windowSamples = 160_000
    static let wespeakerFrames = 589
    private static let campplusMinimumSamples = 16_000

    let kind: SpeakerModelKind
    private let models: [MLModel]

    /// The compiled models of `kind`, with the units each runs on.
    static func files(_ kind: SpeakerModelKind) -> [(name: String, units: MLComputeUnits)] {
        switch kind {
        case .wespeaker: return [("FBank.mlmodelc", .cpuOnly), ("Embedding.mlmodelc", .cpuAndNeuralEngine)]
        case .campplus: return [("CamPlusPreprocessor.mlmodelc", .cpuOnly), ("CamPlusPlus.mlmodelc", .cpuAndNeuralEngine)]
        }
    }

    /// Short names of the parts in `files(_:)` order, for the log.
    static func parts(_ kind: SpeakerModelKind) -> [String] {
        switch kind {
        case .wespeaker: return ["fbank", "embedding"]
        case .campplus: return ["preprocessor", "campplus"]
        }
    }

    /// `onPart` hears how long each part took (its name, milliseconds): to load
    /// in the initialiser, to predict in `embedding(of:onPart:)`.
    init(kind: SpeakerModelKind, directory: URL, computeUnits: MLComputeUnits? = nil,
         onPart: ((String, Double) -> Void)? = nil) throws {
        self.kind = kind
        let names = Self.parts(kind)
        models = try Self.files(kind).enumerated().map { index, file in
            let configuration = MLModelConfiguration()
            configuration.computeUnits = computeUnits ?? file.units
            let started = ContinuousClock.now
            let model = try MLModel(contentsOf: directory.appendingPathComponent(file.name), configuration: configuration)
            onPart?(names[index], Self.milliseconds(since: started))
            return model
        }
    }

    private static func milliseconds(since start: ContinuousClock.Instant) -> Double {
        let elapsed = ContinuousClock.now - start
        return Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
    }

    /// The embedding of `samples` (its last 10 s), or nil for no audio.
    func embedding(of samples: [Float], onPart: ((String, Double) -> Void)? = nil) throws -> [Float]? {
        guard !samples.isEmpty else { return nil }
        let speech = Array(samples.suffix(Self.windowSamples))
        let output: MLMultiArray?
        switch kind {
        case .wespeaker: output = try wespeaker(speech, onPart: onPart)
        case .campplus: output = try campplus(speech, onPart: onPart)
        }
        guard let output, output.count >= kind.dimensions else { return nil }
        var embedding = [Float](repeating: 0, count: kind.dimensions)
        for i in 0..<kind.dimensions { embedding[i] = output[i].floatValue }
        return SpeakerProfile.normalised(embedding, kind: kind)
    }

    /// Runs part `index` on `input`, telling `onPart` how long it took.
    private func predict(_ index: Int, _ input: [String: MLMultiArray], onPart: ((String, Double) -> Void)?) throws -> MLFeatureProvider {
        let started = ContinuousClock.now
        let result = try models[index].prediction(from: MLDictionaryFeatureProvider(dictionary: input))
        onPart?(Self.parts(kind)[index], Self.milliseconds(since: started))
        return result
    }

    /// The window as the filterbank takes it: [1, 1, 160000], the speech repeated to fill it.
    static func wespeakerWindow(_ speech: [Float]) throws -> MLMultiArray {
        let waveform = try MLMultiArray(shape: [1, 1, NSNumber(value: windowSamples)], dataType: .float32)
        repeated(speech, into: waveform.dataPointer.bindMemory(to: Float.self, capacity: waveform.count), count: windowSamples)
        return waveform
    }

    /// The frame weights of the embedding network: [1, 589], 1 for a frame of
    /// speech. `speechFraction` is the share of the window that is real speech
    /// (the window is filled by repeating the speech, so it is 1).
    static func wespeakerWeights(speechFraction: Float = 1) throws -> MLMultiArray {
        let weights = try MLMultiArray(shape: [1, NSNumber(value: wespeakerFrames)], dataType: .float32)
        let frames = weights.dataPointer.bindMemory(to: Float.self, capacity: weights.count)
        let speech = Int((Float(wespeakerFrames) * min(1, max(0, speechFraction))).rounded(.up))
        frames.update(repeating: 0, count: weights.count)
        frames.update(repeating: 1, count: speech)
        return weights
    }

    private func wespeaker(_ speech: [Float], onPart: ((String, Double) -> Void)?) throws -> MLMultiArray? {
        let fbank = try predict(0, ["audio": Self.wespeakerWindow(speech)], onPart: onPart)
            .featureValue(for: "fbank_features")?.multiArrayValue
        guard let fbank else { return nil }
        return try predict(1, ["fbank_features": fbank, "weights": Self.wespeakerWeights()], onPart: onPart)
            .featureValue(for: "embedding")?.multiArrayValue
    }

    private func campplus(_ speech: [Float], onPart: ((String, Double) -> Void)?) throws -> MLMultiArray? {
        let count = max(speech.count, Self.campplusMinimumSamples)
        let waveform = try MLMultiArray(shape: [1, NSNumber(value: count)], dataType: .float32)
        Self.repeated(speech, into: waveform.dataPointer.bindMemory(to: Float.self, capacity: count), count: count)
        let features = try predict(0, ["waveform": waveform], onPart: onPart).featureValue(for: "features")?.multiArrayValue
        guard let features else { return nil }
        try Self.removeMean(features)
        return try predict(1, ["feats": features], onPart: onPart).featureValue(for: "embedding")?.multiArrayValue
    }

    /// CAM++ was trained on filterbanks with each bin's mean over the clip
    /// removed (3D-Speaker's `FBank(mean_nor=True)`); the converted
    /// preprocessor leaves it in, which pulls the embedding far from the
    /// reference model's (cosine 0.56–0.75 against 0.99 with it removed).
    static func removeMean(_ features: MLMultiArray) throws {
        let shape = features.shape.map(\.intValue)
        guard shape.count == 3, shape[0] == 1, shape[1] > 0 else { throw OnDeviceSpeech.Failure.failed }
        let frames = shape[1], bins = shape[2]
        let strides = features.strides.map(\.intValue)
        guard features.dataType == .float32 else {
            // Not the converted model's output type: go element by element.
            for bin in 0..<bins {
                var sum = 0.0
                for frame in 0..<frames { sum += features[[0, frame, bin] as [NSNumber]].doubleValue }
                let mean = sum / Double(frames)
                for frame in 0..<frames {
                    let key = [0, frame, bin] as [NSNumber]
                    features[key] = NSNumber(value: features[key].doubleValue - mean)
                }
            }
            return
        }
        let pointer = features.dataPointer.bindMemory(to: Float.self, capacity: strides[0] * shape[0])
        for bin in 0..<bins {
            var sum: Float = 0
            for frame in 0..<frames { sum += pointer[frame * strides[1] + bin * strides[2]] }
            let mean = sum / Float(frames)
            for frame in 0..<frames { pointer[frame * strides[1] + bin * strides[2]] -= mean }
        }
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

/// Every speaker model that loaded, run side by side (each a filterbank on the
/// CPU and an embedding network on the Neural Engine).
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
