import CoreML
import Foundation

/// Pipecat's Smart Turn v3.2 (BSD-2-Clause), through the Core ML port at
/// huggingface.co/aufklarer/Smart-Turn-v3.2-CoreML: given the last 8 s of the
/// person's turn, the probability that they have finished.
///
/// The port carries the Whisper front-end inside the model (zero-mean,
/// unit-variance normalisation of the window, then an 80-bin log-mel with
/// n_fft 400 and hop 160, per its config.json), so the input is raw 16 kHz
/// audio, not features: `audio` float32 [1, 128000], most recent sample last,
/// zeros at the front. Run once per candidate pause.
enum SmartTurn {
    static let sampleRate = 16_000
    static let windowSamples = 128_000
    static let inputName = "audio"
    static let outputName = "probability"
    static let modelFile = "smart_turn.mlmodelc"

    /// The model's input for a turn: its last 8 s, right-aligned, zeros before.
    static func window<C: Collection>(_ turn: C) -> [Float] where C.Element == Float {
        let tail = turn.suffix(windowSamples)
        var window = [Float](repeating: 0, count: windowSamples - tail.count)
        window.append(contentsOf: tail)
        return window
    }

    static func input(_ turn: [Float]) throws -> MLMultiArray {
        let samples = window(turn)
        let array = try MLMultiArray(shape: [1, NSNumber(value: windowSamples)], dataType: .float32)
        let pointer = array.dataPointer.bindMemory(to: Float.self, capacity: windowSamples)
        samples.withUnsafeBufferPointer { pointer.update(from: $0.baseAddress!, count: windowSamples) }
        return array
    }

    /// The loaded model. Not thread-safe; the listening loop owns it.
    final class Model {
        private let model: MLModel

        init(directory: URL, computeUnits: MLComputeUnits = .cpuAndNeuralEngine) throws {
            let configuration = MLModelConfiguration()
            configuration.computeUnits = computeUnits
            model = try MLModel(contentsOf: directory.appendingPathComponent(SmartTurn.modelFile), configuration: configuration)
        }

        /// The probability that the turn in `turn` (16 kHz mono) is complete.
        func probability(of turn: [Float]) throws -> Float {
            let provider = try MLDictionaryFeatureProvider(dictionary: [SmartTurn.inputName: MLFeatureValue(multiArray: SmartTurn.input(turn))])
            let output = try model.prediction(from: provider)
            guard let value = output.featureValue(for: SmartTurn.outputName)?.multiArrayValue, value.count > 0 else {
                throw OnDeviceSpeech.Failure.failed
            }
            return value[0].floatValue
        }
    }
}
