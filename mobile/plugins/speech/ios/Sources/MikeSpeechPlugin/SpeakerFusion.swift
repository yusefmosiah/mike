import Foundation

/// The "Both" check (docs/voice-chat.md, "Other voices"): WeSpeaker's and
/// CAM++'s embeddings joined into one, by a small linear head trained on top
/// of the two frozen models. Each embedding has the training set's mean voice
/// taken out, the two are joined, and LDA with within-speaker whitening maps
/// them to 150 numbers, where two stretches of one voice are compared by
/// cosine as before.
///
/// Trained on LibriSpeech train-clean-100 (251 speakers) with room, TV,
/// babble, music and noise mixed in; on held-out speakers it misses the
/// person about a quarter less often than WeSpeaker alone at the same
/// false-accept rate.
///
/// `speaker-fusion.bin`, little-endian: "SPKF", then UInt32 version (1),
/// WeSpeaker's and CAM++'s dimensions and the output dimensions, then the
/// two means and the projection (inputs × outputs, row-major), as Float32.
final class SpeakerFusion: Sendable {
    static let fileName = "speaker-fusion"
    private static let kinds: [SpeakerModelKind] = [.wespeaker, .campplus]

    let outputs: Int
    private let means: [SpeakerModelKind: [Float]]
    private let projection: [Float]

    /// The head that ships with the plugin, or nil if it is missing or damaged.
    static let bundled: SpeakerFusion? = {
        guard let url = bundledURL(), let data = try? Data(contentsOf: url) else { return nil }
        return try? SpeakerFusion(data: data)
    }()

    /// The package's resource bundle (`<package>_<target>`) in the app, or
    /// beside the test bundle; looked up by hand, as `Bundle.module` stops
    /// the app when the bundle is not where it expects.
    static func bundledURL() -> URL? {
        let resourceBundle = "MikeSpeech_MikeSpeechPlugin.bundle"
        let code = Bundle(for: SpeakerFusion.self)
        let places = [Bundle.main.resourceURL?.appendingPathComponent(resourceBundle),
                      code.resourceURL?.appendingPathComponent(resourceBundle),
                      code.bundleURL.deletingLastPathComponent().appendingPathComponent(resourceBundle)]
        for case let place? in places {
            if let bundle = Bundle(url: place),
               let url = bundle.url(forResource: fileName, withExtension: "bin", subdirectory: "SpeakerFusion") {
                return url
            }
        }
        return Bundle.main.url(forResource: fileName, withExtension: "bin", subdirectory: "SpeakerFusion")
    }

    init(data: Data) throws {
        var offset = 0
        func uint32() throws -> Int {
            guard offset + 4 <= data.count else { throw OnDeviceSpeech.Failure.failed }
            let value = data[data.startIndex + offset ..< data.startIndex + offset + 4]
                .enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
            offset += 4
            return Int(value)
        }
        func floats(_ count: Int) throws -> [Float] {
            guard offset + 4 * count <= data.count else { throw OnDeviceSpeech.Failure.failed }
            var values = [Float](repeating: 0, count: count)
            for index in 0..<count {
                let start = data.startIndex + offset + 4 * index
                let bits = data[start ..< start + 4].enumerated()
                    .reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
                values[index] = Float(bitPattern: bits)
            }
            offset += 4 * count
            return values
        }
        guard data.prefix(4) == Data("SPKF".utf8) else { throw OnDeviceSpeech.Failure.failed }
        offset = 4
        let version = try uint32()
        let dimensions = [try uint32(), try uint32()]
        let outputs = try uint32()
        guard version == 1, dimensions == Self.kinds.map(\.dimensions), outputs > 0 else { throw OnDeviceSpeech.Failure.failed }
        var means: [SpeakerModelKind: [Float]] = [:]
        for kind in Self.kinds { means[kind] = try floats(kind.dimensions) }
        let projection = try floats(dimensions.reduce(0, +) * outputs)
        guard offset == data.count, (means.values.joined().allSatisfy(\.isFinite)), projection.allSatisfy(\.isFinite) else {
            throw OnDeviceSpeech.Failure.failed
        }
        self.outputs = outputs
        self.means = means
        self.projection = projection
    }

    /// One voice in the joined space (unit length), or nil unless both models
    /// gave a usable embedding.
    func project(_ embeddings: SpeakerEmbeddings) -> [Float]? {
        var joined: [Float] = []
        joined.reserveCapacity(Self.kinds.reduce(0) { $0 + $1.dimensions })
        for kind in Self.kinds {
            guard let embedding = embeddings[kind], let unit = SpeakerProfile.normalised(embedding, kind: kind),
                  let mean = means[kind],
                  let centred = SpeakerProfile.normalised(zip(unit, mean).map { $0 - $1 }) else { return nil }
            joined += centred
        }
        var output = [Float](repeating: 0, count: outputs)
        projection.withUnsafeBufferPointer { weights in
            for (row, value) in joined.enumerated() where value != 0 {
                let base = row * outputs
                for column in 0..<outputs { output[column] += value * weights[base + column] }
            }
        }
        return SpeakerProfile.normalised(output)
    }
}
