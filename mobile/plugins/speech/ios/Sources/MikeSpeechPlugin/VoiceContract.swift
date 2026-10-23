import Foundation

// Hands-free voice mode: the plugin side of docs/voice-chat-contract.md.
// These types are pure (no audio, no models) so the contract's encoding is
// tested on its own. Change them only together with the contract.

/// The thresholds the web app passes to `voiceStart`. Every field is optional
/// on the wire; a missing or unusable value keeps the default.
struct VoiceConfig: Equatable, Sendable {
    /// Speech probability at or above which a VAD frame is speech.
    var vadThreshold: Float = 0.5
    /// Silence that opens the end-of-turn check (two VAD frames: one ended
    /// turns on a breath).
    var pauseMs: Int = 500
    /// At or above: Smart Turn says the turn is complete. Below it, Smart
    /// Turn is asked again every `smartTurnRecheckMs` of further silence.
    var smartTurnThreshold: Float = 0.6
    /// The turn ends after this much silence whatever the models say.
    var maxSilenceMs: Int = 3000
    /// While Smart Turn is missing (still loading at a progressive start, or
    /// it failed to load) nothing else can say "done", so silence alone ends
    /// the turn, after this long: past a thinking pause (Smart Turn's own
    /// re-check is 750 ms) yet well short of `maxSilenceMs`, which would make
    /// every answer wait three seconds. Capped by `maxSilenceMs`. Not on the
    /// wire: it applies only to those first seconds.
    var fallbackSilenceMs: Int = 1500
    /// Speech resumed within this long after a turn was sent continues it:
    /// the two are transcribed together and sent as one turn that replaces
    /// the earlier one (`continues`). 0 turns it off.
    var continueMs: Int = 3000
    /// VAD speech needed for a barge-in.
    var bargeInSpeechMs: Int = 300
    /// VAD speech needed to hold playback before any words: longer than a
    /// cough or a gust.
    var holdSpeechMs: Int = 700
    /// While the answer is awaited or playing, speech starts only at this
    /// VAD probability (wind and traffic score lower than a voice).
    var bargeInVadThreshold: Float = 0.7
    /// Words not in the clause being played needed for a barge-in.
    var bargeInWords: Int = 2
    /// Speech without qualifying words for this long: resume playback.
    var falseStartMs: Int = 1500
    /// A single turn is cut here.
    var maxTurnMs: Int = 60_000
    /// Which speaker model decides whether speech is the person's, once
    /// their voice is learned; nil ("off") checks nothing and learns nothing.
    var speakerModel: SpeakerDecider? = .wespeaker
    /// Below this WeSpeaker score speech is another voice. Same-voice scores
    /// at a second of speech or more run from about 0.45 up; other voices
    /// stayed under 0.41 in testing, so this errs toward the person.
    var speakerThreshold: Float = 0.35
    /// The same for CAM++ (fitted like WeSpeaker's; see SpeakerRule).
    var campplusThreshold: Float = 0.39

    var speakerRule: SpeakerRule {
        SpeakerRule(decider: speakerModel ?? .wespeaker, thresholds: [.wespeaker: speakerThreshold, .campplus: campplusThreshold],
                    fusion: speakerModel == .both ? SpeakerFusion.bundled : nil)
    }

    static let defaults = VoiceConfig()
    /// The longest turn accepted (the final pass and the audio kept for it scale with it).
    static let maxTurnLimitMs = 120_000

    /// Reads the wire object; ignores unknown keys, wrong types and values
    /// out of range, so a newer web build cannot break an older engine.
    init(_ object: [String: Any]? = nil) {
        guard let object else { return }
        func number(_ key: String) -> Double? {
            switch object[key] {
            case let value as NSNumber where CFGetTypeID(value) != CFBooleanGetTypeID():
                let double = value.doubleValue
                return double.isFinite ? double : nil
            default: return nil
            }
        }
        func probability(_ key: String) -> Float? {
            guard let value = number(key), value > 0, value < 1 else { return nil }
            return Float(value)
        }
        func millis(_ key: String, _ range: ClosedRange<Double>) -> Int? {
            guard let value = number(key), range.contains(value) else { return nil }
            return Int(value.rounded())
        }
        if let value = probability("vadThreshold") { vadThreshold = value }
        if let value = millis("pauseMs", 0...10_000) { pauseMs = value }
        if let value = probability("smartTurnThreshold") { smartTurnThreshold = value }
        if let value = millis("maxSilenceMs", 100...30_000) { maxSilenceMs = value }
        if let value = millis("continueMs", 0...30_000) { continueMs = value }
        if let value = millis("bargeInSpeechMs", 0...10_000) { bargeInSpeechMs = value }
        if let value = millis("holdSpeechMs", 0...10_000) { holdSpeechMs = value }
        if let value = probability("bargeInVadThreshold") { bargeInVadThreshold = value }
        if let value = number("bargeInWords"), (0...20).contains(value) { bargeInWords = Int(value.rounded()) }
        if let value = millis("falseStartMs", 0...30_000) { falseStartMs = value }
        if let value = millis("maxTurnMs", 1_000...Double(Self.maxTurnLimitMs)) { maxTurnMs = value }
        if let value = probability("speakerThreshold") { speakerThreshold = value }
        if let value = probability("campplusThreshold") { campplusThreshold = value }
        if let value = object["speakerModel"] as? String {
            if value == "off" {
                speakerModel = nil
            } else if let decider = SpeakerDecider(rawValue: value) {
                speakerModel = decider
            }
        }
    }
}

/// The states the web app sees (`voiceEvent` `{ type: "state" }`).
enum VoiceState: String, Equatable, Sendable {
    case listening
    case userSpeaking = "user-speaking"
    case confirmingEnd = "confirming-end"
    case thinking
    case speaking
}

/// Why voice mode ended on its own or was stopped.
enum VoiceEndReason: String, Equatable, Sendable {
    case stopped
    case interruption
    case route
    case error
}

/// Why a finished turn was not sent.
enum VoiceIgnoreReason: String, Equatable, Sendable {
    case otherVoice = "other-voice"
}

/// Every event the engine sends on the `voiceEvent` listener.
enum VoiceEvent: Equatable, Sendable {
    case install(fraction: Double)
    /// Voice mode's models started or finished preparing for this phone.
    case preparation(VoicePreparation.Snapshot)
    case state(VoiceState)
    case partial(text: String)
    /// `continues`: the earlier turn this one replaces (its words are in `text`).
    case turn(turnId: String, text: String, audioMs: Int, continues: String? = nil)
    case bargeIn(turnId: String)
    case clauseStarted(turnId: String, clauseId: Int)
    case clausePlayed(turnId: String, clauseId: Int)
    case interrupted(turnId: String, clauseId: Int, fraction: Double)
    case answerFinished(turnId: String)
    case ended(VoiceEndReason)
    /// A finished turn was not sent: it was in another voice.
    case ignored(VoiceIgnoreReason)
    case metrics(turnId: String, stages: [String: Double])

    static let listenerName = "voiceEvent"

    /// The object `notifyListeners` sends: always a `type`, then the fields
    /// the contract lists for it.
    var payload: [String: Any] {
        switch self {
        case let .install(fraction):
            return ["type": "install", "fraction": min(1, max(0, fraction))]
        case let .preparation(snapshot):
            var payload = snapshot.payload
            payload["type"] = "preparation"
            return payload
        case let .state(state):
            return ["type": "state", "state": state.rawValue]
        case let .partial(text):
            return ["type": "partial", "text": text]
        case let .turn(turnId, text, audioMs, continues):
            var payload: [String: Any] = ["type": "turn", "turnId": turnId, "text": text, "audioMs": audioMs]
            if let continues { payload["continues"] = continues }
            return payload
        case let .bargeIn(turnId):
            return ["type": "bargeIn", "turnId": turnId]
        case let .clauseStarted(turnId, clauseId):
            return ["type": "clauseStarted", "turnId": turnId, "clauseId": clauseId]
        case let .clausePlayed(turnId, clauseId):
            return ["type": "clausePlayed", "turnId": turnId, "clauseId": clauseId]
        case let .interrupted(turnId, clauseId, fraction):
            return ["type": "interrupted", "turnId": turnId, "clauseId": clauseId, "fraction": min(1, max(0, fraction))]
        case let .answerFinished(turnId):
            return ["type": "answerFinished", "turnId": turnId]
        case let .ended(reason):
            return ["type": "ended", "reason": reason.rawValue]
        case let .ignored(reason):
            return ["type": "ignored", "reason": reason.rawValue]
        case let .metrics(turnId, stages):
            return ["type": "metrics", "turnId": turnId, "stages": stages.mapValues { ($0 * 10).rounded() / 10 }]
        }
    }
}

/// The models voice mode needs, by the names `voiceStatus` reports in `missing`.
enum VoiceModelName: String, CaseIterable, Sendable {
    case vad
    case eou
    case smartTurn = "smart-turn"
    case speaker
    case speakerCampplus = "speaker-campplus"
    case phonon
    case fluidMini = "fluid-mini"
}

/// Words compared for barge-in: lower case, letters and digits only, so the
/// clause the web app sent ("Clause 4, the tenant's duty.") and the EOU
/// partial ("clause four the tenants duty") meet where they can.
enum VoiceWords {
    static func normalised(_ text: String) -> [String] {
        let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX"))
        var words: [String] = []
        var current = ""
        for scalar in folded.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                current.unicodeScalars.append(scalar)
            } else if scalar == "'" || scalar == "\u{2019}" {
                // "tenant's" and "tenants" are the same word to the comparison.
                continue
            } else if !current.isEmpty {
                words.append(current)
                current = ""
            }
        }
        if !current.isEmpty { words.append(current) }
        return words
    }
}
