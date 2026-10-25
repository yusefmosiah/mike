import Foundation

// Small pure helpers of voice mode, kept apart from the audio and model code
// so they are tested directly.

/// The last stretch of the 16 kHz microphone stream, addressed by absolute
/// sample index (samples since voice mode started), for Smart Turn's window
/// and the final pass.
struct SampleRing {
    let capacity: Int
    private var storage: [Float] = []
    /// The absolute index of `storage[0]`.
    private(set) var start = 0

    init(capacity: Int) {
        self.capacity = max(1, capacity)
        storage.reserveCapacity(self.capacity)
    }

    /// The absolute index one past the newest sample.
    var end: Int { start + storage.count }

    mutating func append(_ samples: [Float]) {
        storage.append(contentsOf: samples)
        // Trim in batches so appending stays cheap.
        let excess = storage.count - capacity
        if excess > capacity / 4 {
            storage.removeFirst(excess)
            start += excess
        }
    }

    /// The samples `from..<to` that are still held (clamped to what is).
    func slice(from: Int, to: Int) -> [Float] {
        let lower = max(from, max(start, end - capacity))
        let upper = min(to, end)
        guard lower < upper else { return [] }
        return Array(storage[(lower - start)..<(upper - start)])
    }
}

/// The few-millisecond ramps at clause seams: each Phonon call starts and
/// stops fresh, and a ramp keeps the joins from clicking.
enum Fade {
    /// 5 ms at 24 kHz.
    static let samples = 120

    static func fadeIn(_ chunk: inout [Float], length: Int = samples) {
        let count = min(length, chunk.count)
        guard count > 0 else { return }
        for index in 0..<count { chunk[index] *= Float(index) / Float(count) }
    }

    static func fadeOut(_ chunk: inout [Float], length: Int = samples) {
        let count = min(length, chunk.count)
        guard count > 0 else { return }
        let offset = chunk.count - count
        for index in 0..<count { chunk[offset + index] *= Float(count - 1 - index) / Float(count) }
    }
}

/// How a step said while the answer works (`kind: "step"`) sounds different
/// from the answer: a soft two-note cue before it, the words a little quieter,
/// and, when the answer arrives mid-step, a short fade and a pause before the
/// answer begins (docs/voice-chat.md, "Speaking while it works").
enum StepSound {
    static let rate = 24_000.0
    /// The words of a step, relative to the answer's.
    static let gain: Float = 0.75
    /// The fade when the answer takes over: 150 ms.
    static let yieldFadeSamples = 3_600
    /// Silence between the faded step and the answer: 250 ms.
    static let yieldGapSamples = 6_000

    /// Two short, soft sine notes (a fifth apart, 55 ms each with a smooth
    /// envelope), then 80 ms of silence before the words.
    static let cue: [Float] = {
        func note(_ frequency: Double, _ length: Int) -> [Float] {
            (0..<length).map { index in
                let envelope = sin(Double.pi * Double(index) / Double(length))
                return Float(0.12 * envelope * envelope * sin(2 * Double.pi * frequency * Double(index) / rate))
            }
        }
        let length = Int(rate * 0.055)
        return note(660, length) + note(990, length) + [Float](repeating: 0, count: Int(rate * 0.08))
    }()

    /// The step's first chunk: the cue, then the words at the step's gain.
    static func first(_ chunk: [Float]) -> [Float] { cue + chunk.map { $0 * gain } }

    static func later(_ chunk: [Float]) -> [Float] { chunk.map { $0 * gain } }

    /// What is left of a step from `offset`, faded out over `yieldFadeSamples`.
    static func tail(of samples: [Float], from offset: Int) -> [Float] {
        let start = min(max(0, offset), samples.count)
        var tail = Array(samples[start..<min(samples.count, start + yieldFadeSamples)])
        Fade.fadeOut(&tail, length: tail.count)
        return tail
    }
}

/// The audio the final pass transcribes for a committed turn: the VAD bounds,
/// widened a little because VAD frames are coarse and words trail off.
enum UtteranceBounds {
    static let preRollSamples = 3_200   // 200 ms
    static let postRollSamples = 4_800  // 300 ms

    static func samples(startMs: Int, endMs: Int, available: Int) -> Range<Int> {
        let lower = max(0, startMs * 16 - preRollSamples)
        let upper = min(available, endMs * 16 + postRollSamples)
        return lower..<max(lower, upper)
    }
}

/// Whether loading the voice models ahead of a tap is polite right now. It
/// takes a few seconds of the CPU, GPU and Neural Engine and several hundred
/// MB, so it is skipped when the phone is saving power or running hot.
enum PrewarmGate {
    static func allows(lowPowerMode: Bool, thermalState: ProcessInfo.ThermalState) -> Bool {
        !lowPowerMode && thermalState != .serious && thermalState != .critical
    }

    static var allowsNow: Bool {
        allows(lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled, thermalState: ProcessInfo.processInfo.thermalState)
    }

    /// How long after launch the app-launch prewarm waits, so the web view's
    /// first load has the phone to itself.
    static let launchDelay: Duration = .seconds(3)
}

/// Whether the person has started voice mode on this phone, kept natively so
/// the launch prewarm does not wait for the web app to say so.
enum VoiceUsage {
    static let usedKey = "mike.voice.used"
    static let speakerKey = "mike.voice.usedWithSpeaker"

    static func hasBeenUsed(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: usedKey)
    }

    /// Whether the last start wanted the speaker models (true before any start).
    static func wantsSpeaker(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: speakerKey) as? Bool ?? true
    }

    /// Called when a start gets as far as listening.
    static func markUsed(speaker: Bool, _ defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: usedKey)
        defaults.set(speaker, forKey: speakerKey)
    }
}

/// Runs each keyed piece of work once at a time: a caller that asks while the
/// work is running awaits that run's result instead of starting another, and a
/// finished result is kept for the callers after it. A run that throws is
/// forgotten, so the next caller tries again. The voice models load through
/// it (`VoiceModelCache`, Phonon), so the launch prewarm, a start and the web
/// app's `voicePrewarm` asking at once load each model once.
actor SingleFlight {
    private var tasks: [String: Any] = [:]

    /// The result of `work`, run once for `key` and shared by every caller.
    func value<T: Sendable>(_ key: String, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let task: Task<T, Error>
        if let existing = tasks[key] as? Task<T, Error> {
            task = existing
        } else {
            task = Task { try await work() }
            tasks[key] = task
        }
        do {
            return try await task.value
        } catch {
            if (tasks[key] as? Task<T, Error>) == task { tasks[key] = nil }
            throw error
        }
    }

    /// Forgets every result and run; callers already waiting still get theirs.
    func forgetAll() { tasks = [:] }
}

/// Logs, once, a load that is taking long. It never cancels the load (Core ML
/// cannot be cancelled and a slow compile is kept by the system when it ends);
/// nothing waits on the log.
enum LoadWatchdog {
    static let defaultAfter: Duration = .seconds(60)

    /// Runs `work`; if it has not finished after `after`, calls `onSlow` with
    /// the seconds waited.
    static func run<T>(after: Duration = defaultAfter, onSlow: @escaping @Sendable (Int) -> Void,
                       _ work: () async throws -> T) async rethrows -> T {
        let watchdog = Task {
            try? await Task.sleep(for: after)
            if !Task.isCancelled { onSlow(Int(after.components.seconds)) }
        }
        defer { watchdog.cancel() }
        return try await work()
    }
}
