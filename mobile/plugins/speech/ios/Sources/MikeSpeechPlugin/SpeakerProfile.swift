import Foundation

/// The voice voice mode listens to (docs/voice-chat.md, "Other voices"). It is
/// learned from the person's first turns: a 256-number WeSpeaker embedding of
/// each turn, kept on the phone. Once learned, a turn or a barge-in in a
/// voice too unlike it (a TV, someone else in the room, the answer's own echo
/// on a Mac speaker) is not taken as the person's.
///
/// Pure: no audio and no model, so its rules are tested on their own.
struct SpeakerProfile: Codable, Equatable {
    static let dimensions = 256
    /// Turns that must agree with one another before the voice is learned.
    static let enrolTurns = 3
    /// Turns kept while learning; a voice heard only once in them (a TV, a
    /// visitor) cannot outvote the person's.
    static let maxCandidates = 6
    /// Two learning turns at least this alike are the same voice. Above the
    /// highest different-voice score seen at 1.5 s and more of speech.
    static let candidateSimilarity: Float = 0.5
    /// Shorter turns neither teach nor are learned from (their embeddings
    /// scatter: same-voice scores fall to 0.25 at half a second).
    static let minimumLearnMs = 1500
    /// Shorter speech is not judged: it passes.
    static let minimumCheckMs = 1000
    /// A learned voice keeps adapting (a cold, another microphone), but only
    /// from turns well above the threshold.
    static let adaptMargin: Float = 0.15
    static let adaptRate: Float = 0.1

    enum Verdict: Equatable {
        /// Not learned yet, or too little speech to judge: let it through.
        case unknown
        case match(similarity: Float)
        case mismatch(similarity: Float)

        var similarity: Float? {
            switch self {
            case .unknown: return nil
            case let .match(similarity), let .mismatch(similarity): return similarity
            }
        }
    }

    private(set) var version = 1
    /// The learned voice (unit length), once `enrolTurns` agree.
    private(set) var centroid: [Float]?
    /// Turns heard while learning (unit length), oldest first.
    private(set) var candidates: [[Float]] = []

    var learned: Bool { centroid != nil }

    /// Whether `embedding` of `audioMs` of speech sounds like the person.
    /// `threshold` 0 turns the check off.
    func check(_ embedding: [Float], audioMs: Int, threshold: Float) -> Verdict {
        guard threshold > 0, let centroid, audioMs >= Self.minimumCheckMs,
              let similarity = Self.cosine(centroid, embedding) else { return .unknown }
        return similarity >= threshold ? .match(similarity: similarity) : .mismatch(similarity: similarity)
    }

    /// Learns from a turn that was sent as the person's. Returns whether the
    /// profile changed (and should be saved).
    mutating func learn(_ embedding: [Float], audioMs: Int, threshold: Float) -> Bool {
        guard audioMs >= Self.minimumLearnMs, let unit = Self.normalised(embedding) else { return false }
        if let centroid {
            guard let similarity = Self.cosine(centroid, unit), similarity >= threshold + Self.adaptMargin else { return false }
            let blended = zip(centroid, unit).map { (1 - Self.adaptRate) * $0 + Self.adaptRate * $1 }
            guard let next = Self.normalised(blended) else { return false }
            self.centroid = next
            return true
        }
        candidates.append(unit)
        if candidates.count > Self.maxCandidates { candidates.removeFirst(candidates.count - Self.maxCandidates) }
        // The largest group of mutually alike turns, around any one of them.
        var best: [[Float]] = []
        for anchor in candidates {
            let group = candidates.filter { (Self.cosine(anchor, $0) ?? 0) >= Self.candidateSimilarity }
            if group.count > best.count { best = group }
        }
        if best.count >= Self.enrolTurns, let mean = Self.normalised(Self.mean(best)) {
            centroid = mean
            candidates = []
        }
        return true
    }

    // MARK: - Vectors

    static func normalised(_ vector: [Float]) -> [Float]? {
        guard vector.count == dimensions, vector.allSatisfy(\.isFinite) else { return nil }
        let length = vector.reduce(0) { $0 + $1 * $1 }.squareRoot()
        guard length > 1e-6 else { return nil }
        return vector.map { $0 / length }
    }

    /// Cosine similarity of two embeddings, nil if either is unusable.
    static func cosine(_ a: [Float], _ b: [Float]) -> Float? {
        guard let a = normalised(a), let b = normalised(b) else { return nil }
        return zip(a, b).reduce(0) { $0 + $1.0 * $1.1 }
    }

    private static func mean(_ vectors: [[Float]]) -> [Float] {
        var sum = [Float](repeating: 0, count: dimensions)
        for vector in vectors {
            for index in 0..<dimensions { sum[index] += vector[index] }
        }
        return sum.map { $0 / Float(vectors.count) }
    }
}

/// Where the profile is kept: `Application Support/MikeVoice/speaker.json`,
/// excluded from backup, readable only once the phone has been unlocked.
/// Removed with the voice models and by "Forget my voice".
enum SpeakerStore {
    static var url: URL {
        URL.applicationSupportDirectory.appending(path: "MikeVoice/speaker.json", directoryHint: .notDirectory)
    }

    static func load(from url: URL = url) -> SpeakerProfile {
        guard let data = try? Data(contentsOf: url),
              let profile = try? JSONDecoder().decode(SpeakerProfile.self, from: data),
              profile.version == SpeakerProfile().version else { return SpeakerProfile() }
        return profile
    }

    static func save(_ profile: SpeakerProfile, to url: URL = url) {
        guard let data = try? JSONEncoder().encode(profile) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try? data.write(to: url, options: .atomic)
        #endif
        var excluded = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
    }

    static func remove(at url: URL = url) {
        try? FileManager.default.removeItem(at: url)
    }
}
