import CoreML
import Foundation
#if canImport(FluidAudio)
import FluidAudio
#endif

#if canImport(FluidAudio)

/// NVIDIA's Parakeet realtime EOU 120M (NVIDIA Open Model License) at the
/// 320 ms tier: live words for the screen and for barge-in, and an `<EOU>`
/// token as a candidate end of turn.
///
/// This drives FluidAudio's own pieces (its NeMo mel spectrogram, the
/// loopback streaming encoder, `RnntDecoder`, `Tokenizer`) chunk by chunk, the
/// way `StreamingEouAsrManager.processChunkAndDecode` does, rather than through
/// the manager, because the manager gets two things wrong for us (FluidAudio
/// #1007, unchanged in 0.17.7): after a mid-sentence `<EOU>` later words are
/// lost until `reset()`, and some pauses decode words twice. It also only
/// reports `<EOU>` after its own 1.28 s debounce.
///
/// So every `<EOU>` re-arms the model here: fresh encoder caches and decoder
/// state, and the audio since the last decoded token is replayed into the
/// fresh state. Nothing depends on when `reset()` runs relative to a chunk.
/// Not thread-safe: the listening loop owns it.
@available(iOS 18.0, *)
final class EouStream {
    enum Output: Equatable {
        /// The whole text since the last `clearText()`.
        case partial(String)
        /// `<EOU>` after words, at this sample (16 kHz, since voice mode started).
        case endOfUtterance(atSample: Int)
    }

    static let chunkSize = StreamingChunkSize.ms320
    static let modelSubdirectory = "320ms"
    /// Audio per encoder step: 64 mel frames (630 ms) in, 320 ms shift.
    static let chunkSamples = chunkSize.chunkSamples
    static let shiftSamples = chunkSize.shiftSamples
    static let validFrames = chunkSize.validOutputLen
    /// One encoder output frame: 80 ms.
    static let frameSamples = shiftSamples / validFrames

    private let encoder: MLModel
    private let tokenizer: Tokenizer
    private let rnnt: RnntDecoder
    private let mel = AudioMelSpectrogram()

    private var preCache: MLMultiArray
    private var cacheChannel: MLMultiArray
    private var cacheTime: MLMultiArray
    private var cacheLength: MLMultiArray

    /// Audio not yet consumed, from `bufferStart` (absolute sample index).
    private var buffer: [Float] = []
    private var bufferStart = 0
    /// Where the current model state began, and how many chunks it has decoded.
    private var segmentStart = 0
    private var chunksInSegment = 0
    private var segmentTokens: [Int] = []
    /// The sample after the last decoded token's frame.
    private var lastTokenEnd: Int?
    private var earlierText = ""
    private var lastReported = ""

    /// How many times `<EOU>` re-armed the model (metrics).
    private(set) var rearmCount = 0

    /// The loaded Core ML models and vocabulary. Stateless, so one set serves
    /// any number of streams one after another (VoiceModelCache keeps it).
    struct Models: @unchecked Sendable {
        let encoder: MLModel
        let decoder: MLModel
        let joint: MLModel
        let tokenizer: Tokenizer
    }

    /// Loads the 320 ms models from `directory` (the `320ms` folder). The three
    /// models load side by side.
    static func loadModels(directory: URL, computeUnits: MLComputeUnits = .cpuAndNeuralEngine) async throws -> Models {
        let configuration = MLModelConfiguration()
        configuration.computeUnits = computeUnits
        async let encoder = MLModel.load(contentsOf: directory.appendingPathComponent("streaming_encoder.mlmodelc"), configuration: configuration)
        async let decoder = MLModel.load(contentsOf: directory.appendingPathComponent("decoder.mlmodelc"), configuration: configuration)
        async let joint = MLModel.load(contentsOf: directory.appendingPathComponent("joint_decision.mlmodelc"), configuration: configuration)
        let tokenizer = try Tokenizer(vocabPath: directory.appendingPathComponent("vocab.json"))
        return try await Models(encoder: encoder, decoder: decoder, joint: joint, tokenizer: tokenizer)
    }

    /// Loads the 320 ms models from `directory` (the `320ms` folder).
    static func load(directory: URL, computeUnits: MLComputeUnits = .cpuAndNeuralEngine) async throws -> EouStream {
        try EouStream(models: await loadModels(directory: directory, computeUnits: computeUnits))
    }

    /// A stream with fresh state over already loaded models.
    convenience init(models: Models) throws {
        try self.init(encoder: models.encoder, decoder: models.decoder, joint: models.joint, tokenizer: models.tokenizer)
    }

    private init(encoder: MLModel, decoder: MLModel, joint: MLModel, tokenizer: Tokenizer) throws {
        self.encoder = encoder
        self.tokenizer = tokenizer
        rnnt = RnntDecoder(decoderModel: decoder, jointModel: joint)
        (preCache, cacheChannel, cacheTime, cacheLength) = try Self.freshCaches()
    }

    private static func freshCaches() throws -> (MLMultiArray, MLMultiArray, MLMultiArray, MLMultiArray) {
        let pre = try EncoderCacheManager.createZeroArray(shape: [1, 128, chunkSize.preCacheSize])
        let caches = try EncoderCacheManager.createInitialCaches(
            config: .init(channelShape: [17, 1, 70, 512], timeShape: [17, 1, 512, 8], lenShape: [1]))
        return (pre, caches.channel, caches.time, caches.len)
    }

    /// Runs one chunk of silence so Core ML specialises the models now, then
    /// starts from a clean state.
    func warmUp() throws {
        _ = try step([Float](repeating: 0, count: Self.chunkSamples))
        try rearm(at: 0)
        buffer = []
        bufferStart = 0
        earlierText = ""
        lastReported = ""
        rearmCount = 0
    }

    /// Feeds 16 kHz mono samples (consecutive with the previous call) and
    /// returns what the model said about them.
    func feed(_ samples: [Float]) throws -> [Output] {
        buffer.append(contentsOf: samples)
        var outputs: [Output] = []
        while true {
            let chunkStart = segmentStart + chunksInSegment * Self.shiftSamples
            let offset = chunkStart - bufferStart
            guard offset >= 0, buffer.count - offset >= Self.chunkSamples else { break }
            let chunk = Array(buffer[offset..<(offset + Self.chunkSamples)])
            let result = try step(chunk)
            chunksInSegment += 1
            if !result.tokenIds.isEmpty {
                segmentTokens.append(contentsOf: result.tokenIds)
                if let frame = result.tokenFrames.last {
                    lastTokenEnd = chunkStart + (frame + 1) * Self.frameSamples
                }
                let text = currentText
                if text != lastReported {
                    lastReported = text
                    outputs.append(.partial(text))
                }
            }
            if result.eouDetected {
                let hadWords = !segmentTokens.isEmpty
                if hadWords {
                    outputs.append(.endOfUtterance(atSample: chunkStart + Self.shiftSamples))
                }
                // Replay from just after the last token; if this state never
                // decoded a word, move past the chunk so the loop always advances.
                var from = max(chunkStart, lastTokenEnd ?? chunkStart)
                if !hadWords || from <= segmentStart { from = chunkStart + Self.shiftSamples }
                try rearm(at: from)
            }
        }
        // Keep only what the next chunk (or a replay) can still need.
        let keepFrom = segmentStart + chunksInSegment * Self.shiftSamples
        let drop = keepFrom - bufferStart
        if drop > 0 {
            buffer.removeFirst(min(drop, buffer.count))
            bufferStart += drop
        }
        return outputs
    }

    /// Forgets the text (the policy committed the turn); the model state is kept.
    func clearText() {
        earlierText = ""
        segmentTokens = []
        lastReported = ""
    }

    private var currentText: String {
        let segment = tokenizer.decode(ids: segmentTokens)
        if earlierText.isEmpty { return segment }
        if segment.isEmpty { return earlierText }
        return earlierText + " " + segment
    }

    /// Fresh caches and decoder state, starting again at `sample`. The text
    /// decoded so far is kept.
    private func rearm(at sample: Int) throws {
        earlierText = currentText
        segmentTokens = []
        lastTokenEnd = nil
        (preCache, cacheChannel, cacheTime, cacheLength) = try Self.freshCaches()
        rnnt.resetState()
        segmentStart = sample
        chunksInSegment = 0
        rearmCount += 1
    }

    /// One encoder step and its greedy RNN-T decode, as FluidAudio's manager does it.
    private func step(_ samples: [Float]) throws -> DecodeResult {
        let (melFlat, melLength, frames) = mel.computeFlat(audio: samples)
        let melArray = try MLMultiArray(shape: [1, 128, NSNumber(value: frames)], dataType: .float32)
        melArray.dataPointer.bindMemory(to: Float.self, capacity: melArray.count).update(from: melFlat, count: melFlat.count)
        let length = try MLMultiArray(shape: [1], dataType: .int32)
        length[0] = NSNumber(value: melLength)
        let input = try MLDictionaryFeatureProvider(dictionary: [
            "audio_signal": MLFeatureValue(multiArray: melArray),
            "audio_length": MLFeatureValue(multiArray: length),
            "pre_cache": MLFeatureValue(multiArray: preCache),
            "cache_last_channel": MLFeatureValue(multiArray: cacheChannel),
            "cache_last_time": MLFeatureValue(multiArray: cacheTime),
            "cache_last_channel_len": MLFeatureValue(multiArray: cacheLength),
        ])
        let output = try encoder.prediction(from: input)
        if let value = output.featureValue(for: "new_pre_cache")?.multiArrayValue { preCache = value }
        if let value = output.featureValue(for: "new_cache_last_channel")?.multiArrayValue { cacheChannel = value }
        if let value = output.featureValue(for: "new_cache_last_time")?.multiArrayValue { cacheTime = value }
        if let value = output.featureValue(for: "new_cache_last_channel_len")?.multiArrayValue { cacheLength = value }
        guard let encoded = output.featureValue(for: "encoded_output")?.multiArrayValue else {
            throw OnDeviceSpeech.Failure.failed
        }
        return try rnnt.decodeWithEOU(encoderOutput: encoded, timeOffset: chunksInSegment, skipFrames: 0, validOutLen: Self.validFrames)
    }
}

#endif
