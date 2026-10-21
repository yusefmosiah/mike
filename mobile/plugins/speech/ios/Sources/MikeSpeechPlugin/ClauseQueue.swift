import Foundation

/// The clauses of the answer being spoken, where each one's samples sit on the
/// player's timeline, and the turn token that makes stale work harmless. Pure:
/// the engine synthesises and schedules, this decides what to synthesise next
/// and which events the played-sample clock has reached
/// (docs/voice-chat.md, "Speaking"; docs/voice-chat-contract.md).
///
/// Every path that ends an answer (it finished, the web app cancelled it, the
/// person barged in, voice mode stopped, the audio graph was rebuilt) bumps
/// `token`; work that carries an older token is dropped.
struct ClauseQueue {
    struct Clause: Equatable {
        let id: Int
        let text: String
    }

    enum Event: Equatable {
        case started(clauseId: Int)
        case played(clauseId: Int)
        /// Every clause played after `voiceEndAnswer`.
        case finished
    }

    struct Interruption: Equatable {
        let clauseId: Int
        /// Of that clause's samples, the share that played (0...1).
        let fraction: Double
    }

    private struct Chunk: Equatable {
        let start: Int
        let count: Int
        var end: Int { start + count }
    }

    private enum Preparation: Equatable {
        case queued
        case preparing
        case ready
    }

    private struct Record {
        let id: Int
        let text: String
        var preparation: Preparation = .queued
        var chunks: [Chunk] = []
        var started = false
        var played = false

        var sampleCount: Int { chunks.reduce(0) { $0 + $1.count } }

        func playedSamples(at position: Int) -> Int {
            chunks.reduce(0) { $0 + min($1.count, max(0, position - $1.start)) }
        }
    }

    private(set) var turnId: String?
    private(set) var token = 0
    private(set) var endRequested = false
    /// The end of the last sample scheduled on the player's timeline.
    private(set) var timelineEnd = 0
    private var records: [Record] = []
    private var finishedSent = false

    /// Starts a new answer, dropping anything left of another.
    mutating func begin(turnId: String) {
        token += 1
        self.turnId = turnId
        endRequested = false
        finishedSent = false
        records = []
    }

    /// Queues a clause of the current answer. Refuses another turn's clause, a
    /// clause after `voiceEndAnswer`, and an id that does not increase.
    @discardableResult
    mutating func accept(turnId: String, clauseId: Int, text: String) -> Bool {
        guard turnId == self.turnId, !endRequested, clauseId >= 0 else { return false }
        if let last = records.last, clauseId <= last.id { return false }
        records.append(Record(id: clauseId, text: text))
        return true
    }

    /// No more clauses for this answer.
    @discardableResult
    mutating func end(turnId: String) -> Bool {
        guard turnId == self.turnId else { return false }
        endRequested = true
        return true
    }

    func isCurrent(_ token: Int) -> Bool { token == self.token && turnId != nil }

    var anythingStarted: Bool { records.contains { $0.started } }

    func text(of clauseId: Int) -> String? { records.first { $0.id == clauseId }?.text }

    /// The next clause to synthesise, if one may start now: exactly one clause
    /// is prepared ahead of the one playing, so a clause starts preparing once
    /// every clause before it has started playing.
    mutating func nextToPrepare() -> Clause? {
        guard turnId != nil else { return nil }
        guard !records.contains(where: { $0.preparation == .preparing }) else { return nil }
        guard !records.contains(where: { $0.preparation == .ready && !$0.started && !$0.chunks.isEmpty }) else { return nil }
        guard let index = records.firstIndex(where: { $0.preparation == .queued }) else { return nil }
        records[index].preparation = .preparing
        return Clause(id: records[index].id, text: records[index].text)
    }

    /// A chunk of `clauseId` was placed on the timeline at `startSample`.
    /// Returns false (and records nothing) for stale work.
    @discardableResult
    mutating func scheduled(clauseId: Int, startSample: Int, count: Int, token: Int) -> Bool {
        guard isCurrent(token), count > 0,
              let index = records.firstIndex(where: { $0.id == clauseId && $0.preparation == .preparing })
        else { return false }
        records[index].chunks.append(Chunk(start: startSample, count: count))
        timelineEnd = max(timelineEnd, startSample + count)
        return true
    }

    /// Where the next chunk goes: straight after the last one, or a little
    /// ahead of the play position after an underrun.
    func placement(playedSample: Int, lead: Int) -> Int {
        max(timelineEnd, playedSample + lead)
    }

    /// The synthesis of `clauseId` ended (with or without audio).
    mutating func prepared(clauseId: Int, token: Int) {
        guard isCurrent(token),
              let index = records.firstIndex(where: { $0.id == clauseId && $0.preparation == .preparing })
        else { return }
        records[index].preparation = .ready
    }

    /// The events the played-sample clock has reached, in order.
    mutating func advance(playedSample: Int) -> [Event] {
        guard turnId != nil else { return [] }
        var events: [Event] = []
        for index in records.indices {
            if records[index].played { continue }
            let record = records[index]
            if record.chunks.isEmpty {
                // Nothing to hear (the synthesis failed or gave no audio):
                // it counts as played once everything before it has.
                guard record.preparation == .ready else { break }
                if !record.started {
                    records[index].started = true
                    events.append(.started(clauseId: record.id))
                }
                records[index].played = true
                events.append(.played(clauseId: record.id))
                continue
            }
            if !record.started {
                guard playedSample >= record.chunks[0].start else { break }
                records[index].started = true
                events.append(.started(clauseId: record.id))
            }
            guard record.preparation == .ready, let last = record.chunks.last, playedSample >= last.end else { break }
            records[index].played = true
            events.append(.played(clauseId: record.id))
        }
        if endRequested, !finishedSent, records.allSatisfy(\.played) {
            finishedSent = true
            events.append(.finished)
        }
        return events
    }

    /// Ends the answer now (barge-in, cancel, stop) and says what was heard:
    /// the clause that was playing and the share of its samples played. Nil
    /// when nothing had started playing.
    mutating func interrupt(playedSample: Int) -> Interruption? {
        defer { clear() }
        guard turnId != nil, anythingStarted else { return nil }
        if let record = records.first(where: { !$0.played }) {
            guard record.started else {
                // Between clauses: everything before this one was heard.
                return Interruption(clauseId: record.id, fraction: 0)
            }
            let total = record.sampleCount
            let fraction = total > 0 ? Double(record.playedSamples(at: playedSample)) / Double(total) : 0
            return Interruption(clauseId: record.id, fraction: min(1, max(0, fraction)))
        }
        guard let last = records.last else { return nil }
        return Interruption(clauseId: last.id, fraction: 1)
    }

    /// Drops the answer without reporting anything.
    mutating func clear() {
        token += 1
        turnId = nil
        endRequested = false
        finishedSent = false
        records = []
    }

    /// The player's timeline restarted (the node was stopped, the audio graph
    /// rebuilt). Clauses not yet fully played are prepared again from their
    /// start; a clause already reported as started is not reported again.
    mutating func rewind() {
        token += 1
        timelineEnd = 0
        for index in records.indices where !records[index].played {
            records[index].chunks = []
            records[index].preparation = .queued
        }
    }

    /// The player was stopped between answers: its timeline starts at zero again.
    mutating func resetTimeline() {
        timelineEnd = 0
    }
}
