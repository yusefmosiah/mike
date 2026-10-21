import Foundation

/// The speaker models voice mode can check a voice with. Each turns speech
/// into an embedding; two stretches of one voice score high on cosine
/// similarity. Their scores are not on one scale, so each has its own threshold.
enum SpeakerModelKind: String, CaseIterable, Codable, Sendable {
    /// WeSpeaker ResNet34-LM (VoxCeleb, English and more): 256 numbers.
    case wespeaker
    /// CAM++ (FunASR, trained on Mandarin): 192 numbers.
    case campplus

    var dimensions: Int {
        switch self {
        case .wespeaker: return 256
        case .campplus: return 192
        }
    }

    /// Two learning turns at least this alike are the same voice: above the
    /// highest different-voice score between 1.5–3 s LibriSpeech enrolment
    /// turns (WeSpeaker 0.48; CAM++ 0.73, a few pairs in ten thousand above
    /// 0.68). `.both` groups by WeSpeaker.
    var candidateSimilarity: Float {
        switch self {
        case .wespeaker: return 0.5
        case .campplus: return 0.68
        }
    }
}

/// Which model decides whether speech is the person's.
enum SpeakerDecider: String, Equatable, Sendable {
    case wespeaker
    case campplus
    /// Both, each score measured from its own threshold and the two averaged.
    case both

    var kinds: [SpeakerModelKind] {
        switch self {
        case .wespeaker: return [.wespeaker]
        case .campplus: return [.campplus]
        case .both: return [.wespeaker, .campplus]
        }
    }
}

/// How speech is judged: the decider and each model's threshold.
///
/// Thresholds were fitted on held-out LibriSpeech speakers to miss the person
/// in about 2 % of clean 1–2 s turns (WeSpeaker 0.32, rounded up to 0.35;
/// CAM++ 0.39; the joined space 0.27). CAM++ alone, trained on Mandarin, lets
/// in far more other voices than WeSpeaker on English speech; it is meant to
/// be used through `.both`.
struct SpeakerRule: Equatable, Sendable {
    var decider: SpeakerDecider = .wespeaker
    var thresholds: [SpeakerModelKind: Float] = [.wespeaker: 0.35, .campplus: 0.39]
    /// `.both` compares voices in the joined space when this is set
    /// (SpeakerFusion.swift), and averages the two margins when it is not.
    var fusion: SpeakerFusion?
    var fusedThreshold: Float = 0.27

    func threshold(_ kind: SpeakerModelKind) -> Float { thresholds[kind] ?? 0.5 }

    static func == (a: SpeakerRule, b: SpeakerRule) -> Bool {
        a.decider == b.decider && a.thresholds == b.thresholds && a.fusion === b.fusion && a.fusedThreshold == b.fusedThreshold
    }
}

/// One stretch of speech as each model heard it (unit length), by model.
typealias SpeakerEmbeddings = [SpeakerModelKind: [Float]]

/// The voice voice mode listens to (docs/voice-chat.md, "Other voices"). It is
/// learned from the person's first turns, as each speaker model's embedding,
/// kept on the phone. Once learned, a turn or a barge-in in a voice too
/// unlike it (a TV, someone else in the room, the answer's own echo on a Mac
/// speaker) is not taken as the person's.
///
/// Pure: no audio and no model, so its rules are tested on their own.
struct SpeakerProfile: Codable, Equatable {
    /// Turns that must agree with one another before the voice is learned.
    static let enrolTurns = 3
    /// Turns kept while learning; a voice heard only once or twice in them (a
    /// TV, a visitor) cannot outvote the person's.
    static let maxCandidates = 6
    /// Shorter turns neither teach nor are learned from (their embeddings
    /// scatter: same-voice scores fall to 0.25 at half a second).
    static let minimumLearnMs = 1500
    /// Shorter speech is not judged: it passes.
    static let minimumCheckMs = 1000
    /// A learned voice keeps adapting (a cold, another microphone), but only
    /// from turns this far above the threshold.
    static let adaptMargin: Float = 0.15
    static let adaptRate: Float = 0.1

    struct Verdict: Equatable {
        enum Outcome: Equatable {
            /// Not learned yet, too little speech, or no score from the
            /// deciding models: let it through.
            case unknown
            case match
            case mismatch
        }

        var outcome: Outcome
        /// Each model's score against the learned voice (for the log).
        var similarities: [SpeakerModelKind: Float] = [:]
        /// How far the decision is above (or below) the threshold.
        var margin: Float?

        static let unknown = Verdict(outcome: .unknown)
    }

    private(set) var version = 2
    /// The learned voice as each model has it (unit length).
    private(set) var centroids: [String: [Float]] = [:]
    /// Turns heard while learning, oldest first.
    private(set) var candidates: [[String: [Float]]] = []

    var learned: Bool { !centroids.isEmpty }

    func centroid(_ kind: SpeakerModelKind) -> [Float]? { centroids[kind.rawValue] }

    /// Whether speech of `audioMs` sounds like the person.
    func check(_ heard: SpeakerEmbeddings, audioMs: Int, rule: SpeakerRule) -> Verdict {
        guard learned else { return .unknown }
        var similarities: [SpeakerModelKind: Float] = [:]
        for kind in SpeakerModelKind.allCases {
            if let centroid = centroid(kind), let embedding = heard[kind], let similarity = Self.cosine(centroid, embedding) {
                similarities[kind] = similarity
            }
        }
        guard audioMs >= Self.minimumCheckMs else { return Verdict(outcome: .unknown, similarities: similarities) }
        let margin: Float
        if rule.decider == .both, let fused = fusedSimilarity(heard, fusion: rule.fusion) {
            margin = fused - rule.fusedThreshold
        } else {
            let margins = rule.decider.kinds.compactMap { kind in similarities[kind].map { $0 - rule.threshold(kind) } }
            guard !margins.isEmpty else { return Verdict(outcome: .unknown, similarities: similarities) }
            margin = margins.reduce(0, +) / Float(margins.count)
        }
        return Verdict(outcome: margin >= 0 ? .match : .mismatch, similarities: similarities, margin: margin)
    }

    /// The learned voice against `heard` in the joined space, or nil without
    /// the head or either model's embedding on either side.
    func fusedSimilarity(_ heard: SpeakerEmbeddings, fusion: SpeakerFusion?) -> Float? {
        guard let fusion else { return nil }
        var learnedVoice: SpeakerEmbeddings = [:]
        for kind in SpeakerModelKind.allCases { learnedVoice[kind] = centroid(kind) }
        guard let a = fusion.project(learnedVoice), let b = fusion.project(heard) else { return nil }
        return Self.cosine(a, b)
    }

    /// Learns from a turn that was sent as the person's. Returns whether the
    /// profile changed (and should be saved).
    mutating func learn(_ heard: SpeakerEmbeddings, audioMs: Int, rule: SpeakerRule) -> Bool {
        guard audioMs >= Self.minimumLearnMs else { return false }
        var units: [String: [Float]] = [:]
        for (kind, embedding) in heard {
            if let unit = Self.normalised(embedding, kind: kind) { units[kind.rawValue] = unit }
        }
        guard !units.isEmpty else { return false }
        if learned {
            let verdict = check(heard, audioMs: audioMs, rule: rule)
            guard verdict.outcome == .match, let margin = verdict.margin, margin >= Self.adaptMargin else { return false }
            for (key, unit) in units {
                guard let centroid = centroids[key] else {
                    // A model added after the voice was learned starts from here.
                    centroids[key] = unit
                    continue
                }
                let blended = zip(centroid, unit).map { (1 - Self.adaptRate) * $0 + Self.adaptRate * $1 }
                if let kind = SpeakerModelKind(rawValue: key), let next = Self.normalised(blended, kind: kind) {
                    centroids[key] = next
                }
            }
            return true
        }
        candidates.append(units)
        if candidates.count > Self.maxCandidates { candidates.removeFirst(candidates.count - Self.maxCandidates) }
        // The largest group of mutually alike turns, around any one of them.
        let order = rule.decider.kinds + SpeakerModelKind.allCases.filter { !rule.decider.kinds.contains($0) }
        var best: [[String: [Float]]] = []
        for anchor in candidates {
            let group = candidates.filter { Self.alike(anchor, $0, order: order) }
            if group.count > best.count { best = group }
        }
        guard best.count >= Self.enrolTurns else { return true }
        for kind in SpeakerModelKind.allCases {
            let members = best.compactMap { $0[kind.rawValue] }
            if !members.isEmpty, let mean = Self.normalised(Self.mean(members, kind.dimensions), kind: kind) {
                centroids[kind.rawValue] = mean
            }
        }
        candidates = []
        return true
    }

    /// Two learning turns are one voice by the first model in `order` both have.
    private static func alike(_ a: [String: [Float]], _ b: [String: [Float]], order: [SpeakerModelKind]) -> Bool {
        for kind in order {
            if let x = a[kind.rawValue], let y = b[kind.rawValue] {
                return (cosine(x, y) ?? 0) >= kind.candidateSimilarity
            }
        }
        return false
    }

    // MARK: - Vectors

    static func normalised(_ vector: [Float], kind: SpeakerModelKind) -> [Float]? {
        guard vector.count == kind.dimensions else { return nil }
        return normalised(vector)
    }

    static func normalised(_ vector: [Float]) -> [Float]? {
        guard !vector.isEmpty, vector.allSatisfy(\.isFinite) else { return nil }
        let length = vector.reduce(0) { $0 + $1 * $1 }.squareRoot()
        guard length > 1e-6 else { return nil }
        return vector.map { $0 / length }
    }

    /// Cosine similarity of two embeddings of one model, nil if unusable.
    static func cosine(_ a: [Float], _ b: [Float]) -> Float? {
        guard a.count == b.count, let a = normalised(a), let b = normalised(b) else { return nil }
        return zip(a, b).reduce(0) { $0 + $1.0 * $1.1 }
    }

    private static func mean(_ vectors: [[Float]], _ dimensions: Int) -> [Float] {
        var sum = [Float](repeating: 0, count: dimensions)
        for vector in vectors where vector.count == dimensions {
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
