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
