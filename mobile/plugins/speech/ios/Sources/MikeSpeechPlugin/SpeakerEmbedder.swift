import CoreML
import Foundation

/// WeSpeaker ResNet34-LM (pyannote's VoxCeleb model, FluidAudio's Core ML
/// conversion): 16 kHz audio in, a 256-number voice embedding out. The model
/// takes a batch of three 10 s windows with a frame mask; one window is used,
/// the speech repeated to fill it (padding with silence would pull every
/// embedding toward the same point).
final class SpeakerEmbedder {
    static let modelFile = "wespeaker_v2.mlmodelc"
    static let windowSamples = 160_000
    private static let batch = 3
    private static let maskFrames = 589

    private let model: MLModel

    init(directory: URL, computeUnits: MLComputeUnits) throws {
        let configuration = MLModelConfiguration()
        configuration.computeUnits = computeUnits
        model = try MLModel(contentsOf: directory.appendingPathComponent(Self.modelFile), configuration: configuration)
    }

    /// The embedding of `samples` (its last 10 s), or nil for no audio.
    func embedding(of samples: [Float]) throws -> [Float]? {
        guard !samples.isEmpty else { return nil }
        let speech = samples.suffix(Self.windowSamples)
        let waveform = try MLMultiArray(shape: [NSNumber(value: Self.batch), NSNumber(value: Self.windowSamples)], dataType: .float32)
        let mask = try MLMultiArray(shape: [NSNumber(value: Self.batch), NSNumber(value: Self.maskFrames)], dataType: .float32)
        let wave = waveform.dataPointer.bindMemory(to: Float.self, capacity: waveform.count)
        wave.update(repeating: 0, count: waveform.count)
        var index = 0
        while index < Self.windowSamples {
            for sample in speech where index < Self.windowSamples {
                wave[index] = sample
                index += 1
            }
        }
        let frames = mask.dataPointer.bindMemory(to: Float.self, capacity: mask.count)
        frames.update(repeating: 0, count: mask.count)
        frames.update(repeating: 1, count: Self.maskFrames)
        let input = try MLDictionaryFeatureProvider(dictionary: ["waveform": waveform, "mask": mask])
        guard let output = try model.prediction(from: input).featureValue(for: "embedding")?.multiArrayValue,
              output.count >= SpeakerProfile.dimensions else { return nil }
        var embedding = [Float](repeating: 0, count: SpeakerProfile.dimensions)
        for i in 0..<SpeakerProfile.dimensions { embedding[i] = output[i].floatValue }
        return SpeakerProfile.normalised(embedding)
    }
}
