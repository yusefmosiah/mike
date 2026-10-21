import CoreML
import XCTest
@testable import MikeSpeechPlugin
#if canImport(FluidAudio)
import FluidAudio
#endif

#if canImport(FluidAudio)

/// Runs the listening models on the fixture clip (macOS `say`, about 8 s):
/// Silero VAD, the EOU stream with its re-arm, Smart Turn, and the whole
/// listening pipeline through the turn policy to a commit and Fluid Speech
/// Mini's final pass. Needs the downloaded models in a directory laid out as
/// voice mode installs them (`vad/`, `eou/`, `smart-turn/`, `speaker/`, `speaker-campplus/`), named by
/// MIKE_VOICE_MODELS; skipped without it:
///   TEST_RUNNER_MIKE_VOICE_MODELS=/path/to/models xcodebuild test -scheme MikeSpeech \
///     -destination 'platform=iOS Simulator,name=iPhone 17'
/// The simulator has no Neural Engine, so these run on the CPU.
final class VoiceModelIntegrationTests: XCTestCase {
    private var modelsRoot: URL? {
        ProcessInfo.processInfo.environment["MIKE_VOICE_MODELS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    private var pluginBundle: Bundle? {
        let beside = Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
        return Bundle(url: beside.appendingPathComponent("MikeSpeech_MikeSpeechPlugin.bundle"))
    }

    private func clip() throws -> [Float] {
        let url = Bundle.module.resourceURL!.appendingPathComponent("Fixtures/dictation.m4a")
        return try AudioConverter().resampleAudioFile(url)
    }

    private func words(_ text: String) -> [String] {
        VoiceWords.normalised(text)
    }

    /// Share of `reference`'s words found in `text` (as a multiset).
    private func recall(_ text: String, of reference: String) -> Double {
        var pool = words(text)
        let wanted = words(reference)
        guard !wanted.isEmpty else { return 1 }
        var found = 0
        for word in wanted {
            if let index = pool.firstIndex(of: word) {
                pool.remove(at: index)
                found += 1
            }
        }
        return Double(found) / Double(wanted.count)
    }

    /// The quietest 100 ms between 35% and 65% of the clip: a gap between words.
    private func quietestPoint(_ samples: [Float]) -> Int {
        let window = 1600
        var best = samples.count / 2
        var bestEnergy = Float.greatestFiniteMagnitude
        var start = samples.count * 35 / 100
        while start + window < samples.count * 65 / 100 {
            let energy = samples[start..<(start + window)].reduce(0) { $0 + $1 * $1 }
            if energy < bestEnergy {
                bestEnergy = energy
                best = start + window / 2
            }
            start += 160
        }
        return best
    }

    private func reference(_ samples: [Float]) async throws -> String? {
        guard let bundle = pluginBundle, let directory = FluidSpeechMini.modelDirectory(in: bundle) else { return nil }
        return try await FluidSpeechMini.Runtime.shared.transcribe(samples: samples, modelDirectory: directory)
    }

    func testVadHearsTheClipAndNotSilence() async throws {
        guard #available(iOS 18.0, *), let root = modelsRoot else { throw XCTSkip("MIKE_VOICE_MODELS not set") }
        let model = try MLModel(contentsOf: root.appendingPathComponent("vad/\(VoiceModels.vadFile)"))
        let vad = VadManager(config: .default, vadModel: model)
        let samples = try clip()
        var state = VadStreamState.initial()
        var probabilities: [Float] = []
        var offset = 0
        while offset + VadManager.chunkSize <= samples.count {
            let result = try await vad.processStreamingChunk(Array(samples[offset..<(offset + VadManager.chunkSize)]), state: state)
            state = result.state
            probabilities.append(result.probability)
            offset += VadManager.chunkSize
        }
        var silent = VadStreamState.initial()
        var quiet: [Float] = []
        for _ in 0..<4 {
            let result = try await vad.processStreamingChunk([Float](repeating: 0, count: VadManager.chunkSize), state: silent)
            silent = result.state
            quiet.append(result.probability)
        }
        print("VOICE-VAD clip: \(probabilities.map { String(format: "%.2f", $0) }) silence: \(quiet.map { String(format: "%.2f", $0) })")
        XCTAssertGreaterThan(probabilities.filter { $0 >= 0.5 }.count, probabilities.count / 2, "most of the clip is speech")
        XCTAssertTrue(quiet.allSatisfy { $0 < 0.35 }, "digital silence is silence")
    }

    func testEouStreamKeepsTheWordsAcrossAMidSentencePause() async throws {
        guard #available(iOS 18.0, *), let root = modelsRoot else { throw XCTSkip("MIKE_VOICE_MODELS not set") }
        let samples = try clip()
        let split = quietestPoint(samples)
        let silence = [Float](repeating: 0, count: 24_000)  // 1.5 s
        let audio = Array(samples[..<split]) + silence + Array(samples[split...]) + [Float](repeating: 0, count: 40_000)

        let stream = try await EouStream.load(directory: root.appendingPathComponent("eou"), computeUnits: .cpuOnly)
        try stream.warmUp()
        var text = ""
        var candidates: [Int] = []
        var offset = 0
        while offset < audio.count {
            let piece = Array(audio[offset..<min(audio.count, offset + 1600)])
            offset += piece.count
            for output in try stream.feed(piece) {
                switch output {
                case let .partial(partial): text = partial
                case let .endOfUtterance(sample): candidates.append(sample)
                }
            }
        }
        let expected = try await reference(samples) ?? text
        print("VOICE-EOU split at \(split): \(text) | candidates at \(candidates) | rearms \(stream.rearmCount) | reference: \(expected)")
        XCTAssertFalse(text.isEmpty)
        XCTAssertGreaterThanOrEqual(candidates.count, 1, "<EOU> after the clip")
        XCTAssertGreaterThanOrEqual(recall(text, of: expected), 0.8, "words after the pause are not lost")
        XCTAssertLessThanOrEqual(words(text).count, words(expected).count + 2, "no words decoded twice")
        XCTAssertTrue(candidates.allSatisfy { $0 <= audio.count })
    }

    func testClearTextStartsTheNextTurnEmpty() async throws {
        guard #available(iOS 18.0, *), let root = modelsRoot else { throw XCTSkip("MIKE_VOICE_MODELS not set") }
        let samples = try clip()
        let stream = try await EouStream.load(directory: root.appendingPathComponent("eou"), computeUnits: .cpuOnly)
        try stream.warmUp()
        var last = ""
        for output in try stream.feed(Array(samples.prefix(48_000))) {
            if case let .partial(text) = output { last = text }
        }
        XCTAssertFalse(last.isEmpty)
        stream.clearText()
        var after: String?
        for output in try stream.feed(Array(samples.dropFirst(48_000)) + [Float](repeating: 0, count: 32_000)) {
            if case let .partial(text) = output { after = text }
        }
        if let after {
            XCTAssertFalse(after.hasPrefix(last), "the earlier turn's words are gone")
        }
    }

    func testSmartTurnScoresTheClip() async throws {
        guard #available(iOS 18.0, *), let root = modelsRoot else { throw XCTSkip("MIKE_VOICE_MODELS not set") }
        let model = try SmartTurn.Model(directory: root.appendingPathComponent("smart-turn"), computeUnits: .cpuOnly)
        let samples = try clip()
        let finished = try model.probability(of: samples + [Float](repeating: 0, count: 3_200))
        let cut = try model.probability(of: Array(samples[..<quietestPoint(samples)]))
        print("VOICE-SMART-TURN finished clip: \(finished), cut mid-way: \(cut)")
        XCTAssertTrue((0...1).contains(finished))
        XCTAssertTrue((0...1).contains(cut))
    }

    /// Each speaker model gives unit-length embeddings, and the clip's two
    /// halves (one voice) score above its threshold; both run side by side.
    func testTheSpeakerModelsFindOneVoiceInTheClip() throws {
        guard let root = modelsRoot else { throw XCTSkip("MIKE_VOICE_MODELS not set") }
        let samples = try clip()
        let half = samples.count / 2
        var embedders: [SpeakerEmbedder] = []
        for kind in SpeakerModelKind.allCases {
            let directory = root.appendingPathComponent(VoiceModels.speakerModel(kind).name.rawValue)
            guard FileManager.default.fileExists(atPath: directory.appendingPathComponent(SpeakerEmbedder.files(kind)[0].name).path) else {
                throw XCTSkip("\(kind.rawValue) not downloaded")
            }
            let embedder = try SpeakerEmbedder(kind: kind, directory: directory, computeUnits: .cpuOnly)
            embedders.append(embedder)
            let first = try XCTUnwrap(embedder.embedding(of: Array(samples[..<half])))
            let second = try XCTUnwrap(embedder.embedding(of: Array(samples[half...])))
            XCTAssertEqual(first.count, kind.dimensions)
            XCTAssertEqual(first.reduce(0) { $0 + $1 * $1 }.squareRoot(), 1, accuracy: 1e-3)
            let similarity = try XCTUnwrap(SpeakerProfile.cosine(first, second))
            print("VOICE-SPEAKER \(kind.rawValue) halves similarity \(similarity)")
            XCTAssertGreaterThan(similarity, SpeakerRule().threshold(kind))
            XCTAssertNil(try embedder.embedding(of: []))
            XCTAssertNotNil(try embedder.embedding(of: Array(samples[..<4000])), "a quarter second still embeds")
        }
        let both = SpeakerModels(embedders).embeddings(of: samples)
        XCTAssertEqual(Set(both.keys), Set(SpeakerModelKind.allCases))
    }

    /// The clip, then silence, through the listening pipeline and the turn
    /// policy as the engine runs them: one or more commits whose final-pass
    /// text covers the clip.
    func testThePipelineCommitsTheClipAndTheFinalPassTranscribesIt() async throws {
        guard #available(iOS 18.0, *), let root = modelsRoot else { throw XCTSkip("MIKE_VOICE_MODELS not set") }
        guard let bundle = pluginBundle, let fluid = FluidSpeechMini.modelDirectory(in: bundle) else {
            throw XCTSkip("Fluid Speech Mini not fetched")
        }
        let vadModel = try MLModel(contentsOf: root.appendingPathComponent("vad/\(VoiceModels.vadFile)"))
        let vad = VadManager(config: .default, vadModel: vadModel)
        let eou = try await EouStream.load(directory: root.appendingPathComponent("eou"), computeUnits: .cpuOnly)
        try eou.warmUp()
        let smartTurn = try SmartTurn.Model(directory: root.appendingPathComponent("smart-turn"), computeUnits: .cpuOnly)
        let config = VoiceConfig.defaults
        let pipeline = ListeningPipeline(vad: vad, eou: eou, smartTurn: smartTurn, speaker: nil, config: config)
        var policy = TurnPolicy(config: config)

        let samples = try clip()
        let audio = [Float](repeating: 0, count: 8_000) + samples + [Float](repeating: 0, count: 48_000)
        var commits: [TurnPolicy.Commit] = []
        var texts: [String] = []
        var states: [VoiceState] = []
        var partials: [String] = []
        var offset = 0
        while offset < audio.count {
            let piece = Array(audio[offset..<min(audio.count, offset + 1600)])
            offset += piece.count
            var pending: [TurnPolicy.Decision] = []
            for input in try await pipeline.process(piece) { pending += policy.handle(input) }
            while !pending.isEmpty {
                let decision = pending.removeFirst()
                switch decision {
                case let .state(state): states.append(state)
                case let .partial(text): partials.append(text)
                case let .runSmartTurn(id, from, to):
                    pending += policy.handle(.smartTurn(requestId: id, probability: pipeline.smartTurnProbability(fromMs: from, toMs: to)))
                case let .commit(commit):
                    commits.append(commit)
                    pipeline.eou.clearText()
                    let text = try await FluidSpeechMini.Runtime.shared.transcribe(samples: pipeline.utterance(commit), modelDirectory: fluid)
                    texts.append(text)
                    pending += policy.handle(text.isEmpty ? .turnDiscarded : .turnCommitted(turnId: "t\(commits.count)"))
                    if !text.isEmpty { pending += policy.handle(.answerEnded(turnId: "t\(commits.count)")) }
                default: break
                }
            }
        }
        let expected = try await reference(samples) ?? ""
        print("VOICE-PIPELINE commits: \(commits.map { "\($0.startMs)-\($0.endMs) \($0.reason.rawValue) @\($0.decidedAtMs)" }) texts: \(texts) states: \(states.map(\.rawValue)) last partial: \(partials.last ?? "")")
        XCTAssertGreaterThanOrEqual(commits.count, 1)
        XCTAssertTrue(states.contains(.userSpeaking))
        XCTAssertTrue(states.contains(.confirmingEnd))
        XCTAssertFalse(partials.isEmpty, "live words were shown")
        XCTAssertGreaterThanOrEqual(recall(texts.joined(separator: " "), of: expected), 0.9)
        if let first = commits.first { XCTAssertLessThanOrEqual(first.startMs, 600, "the turn starts where the speech does") }
    }
}

#endif
