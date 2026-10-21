import CoreML
import CryptoKit
import Foundation

/// The models hands-free voice mode downloads, where they live, and their
/// install. Each comes from its upstream public Hugging Face repository at
/// one pinned commit (resolved with the Hub API), every file checked against
/// its size and SHA-256 before it is kept, into Application Support
/// (excluded from backup), never bundled. Phonon has its own install
/// (PhononVoice.swift) and Fluid Speech Mini ships in the app.
///
/// - Silero VAD v6.2.1 (MIT), FluidAudio's Core ML conversion.
/// - Parakeet realtime EOU 120M, 320 ms (NVIDIA Open Model License),
///   FluidAudio's Core ML conversion.
/// - Smart Turn v3.2 (BSD-2-Clause), aufklarer's Core ML port.
///
/// Nothing is uploaded; only these public files are fetched, and no user
/// content is sent.
enum VoiceModels {
    struct File: Equatable, Sendable {
        let path: String
        let size: Int
        let sha256: String
    }

    struct Model: Sendable {
        let name: VoiceModelName
        let repository: String
        let revision: String
        /// The folder inside the repository the files are in ("" for the root).
        let folder: String
        let files: [File]

        var totalBytes: Int { files.reduce(0) { $0 + $1.size } }

        func url(for file: File) -> URL {
            let path = folder.isEmpty ? file.path : "\(folder)/\(file.path)"
            return URL(string: "https://huggingface.co/\(repository)/resolve/\(revision)/\(path)")!
        }

        /// Where the files are installed (relative paths below `folder`).
        var directory: URL { VoiceModels.root.appendingPathComponent(name.rawValue, isDirectory: true) }
    }

    static let vad = Model(
        name: .vad,
        repository: "FluidInference/silero-vad-coreml",
        revision: "b419383c55c110e2c9271fa6ee0ea83d03c70d96",
        folder: "",
        files: [
            File(path: "silero-vad-unified-256ms-v6.2.1.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "8067594eb3126ab8318af507f0c00cabfed40d5fedb8a0ee5075dd02e903d909"),
            File(path: "silero-vad-unified-256ms-v6.2.1.mlmodelc/coremldata.bin", size: 625, sha256: "7db35a4fd995222a7fb0129713473b15d1462572ab4a2e5e4d56bcaad9e40f41"),
            File(path: "silero-vad-unified-256ms-v6.2.1.mlmodelc/metadata.json", size: 3335, sha256: "2740be542c611e1ba358e1849b4e265c65cdf0b17192767e1e5de86a31ac94d6"),
            File(path: "silero-vad-unified-256ms-v6.2.1.mlmodelc/model.mil", size: 176_918, sha256: "c6a9d1bf22d413265da0a07a1d14151c3ea2fad296b3aa5859275b33ef1c3270"),
            File(path: "silero-vad-unified-256ms-v6.2.1.mlmodelc/weights/weight.bin", size: 882_304, sha256: "53ecc8b5081146140ab654c89109cf001f2183abddd7a2411c5081feeffff063"),
        ])

    static let eou = Model(
        name: .eou,
        repository: "FluidInference/parakeet-realtime-eou-120m-coreml",
        revision: "40a23f4c0b333aa17ad8c0f2ea47ec2347f2f355",
        folder: "320ms",
        files: [
            File(path: "decoder.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "3996975a8cbc1949159c55605b3132b39b2484f51acbd55d796d93c70de02b49"),
            File(path: "decoder.mlmodelc/coremldata.bin", size: 497, sha256: "c3ccbff963d8cf07e2be2bd56ea3384a89ea49628922c6bd95ff62e2ae57dc34"),
            File(path: "decoder.mlmodelc/metadata.json", size: 3283, sha256: "0977480649f2756894b0acfe2fdf4231a991f25e3fe02562bfb71b65ca944575"),
            File(path: "decoder.mlmodelc/model.mil", size: 7409, sha256: "b7c084a35bdbc887d69d6226cd533e2c11b2792c37d7352cf878f9f6f3c13555"),
            File(path: "decoder.mlmodelc/weights/weight.bin", size: 7_873_600, sha256: "0b4cacecdcd9df79ab1e56de67230baf5a8664d2afe0bb8f3408eefa972cb2f4"),
            File(path: "joint_decision.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "5bca32ad130dcad6605cc00044c752aa5b45ef57d14c17f2d1a2fa49d6cf55b5"),
            File(path: "joint_decision.mlmodelc/coremldata.bin", size: 493, sha256: "22d4abc4625b935ee035b5f8ce7cb28d1041b9b01c12173e287bf4b5f5d99625"),
            File(path: "joint_decision.mlmodelc/metadata.json", size: 3181, sha256: "e970ae87137730020690d24d971813db3633bbdfed602d43b6a9c84deced6dc8"),
            File(path: "joint_decision.mlmodelc/model.mil", size: 9608, sha256: "45e8590bc87e34c162b547e43a4f60e64db15b017f48395d7835a6867884804f"),
            File(path: "joint_decision.mlmodelc/weights/weight.bin", size: 2_794_182, sha256: "7039b2010a269153f5a96edf28637f921a86ef8822f248f2d6712f7a6bce84b4"),
            File(path: "streaming_encoder.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "ae0a559f8d53c43fe13c5c142b15ca237b97812febde71a36475b7b9612baec5"),
            File(path: "streaming_encoder.mlmodelc/coremldata.bin", size: 670, sha256: "b57dfe32ed2acb0081f97d7a9e410117005823e3d2d995e21feb9e60775443c3"),
            File(path: "streaming_encoder.mlmodelc/metadata.json", size: 5327, sha256: "3adc7839db0f5d20b19e2dcd1c009bcf935a7edc61d7473c8150be444bd80488"),
            File(path: "streaming_encoder.mlmodelc/model.mil", size: 655_998, sha256: "eb9d56d7467ad3a8796ec9098b27fb89197638b31e24ede6dd924807d25086e6"),
            File(path: "streaming_encoder.mlmodelc/weights/weight.bin", size: 212_865_856, sha256: "ff553fcb4f4560cfce1e558e16bb9d856e4b4f6a4c08f800d5c126fce4196822"),
            File(path: "vocab.json", size: 17_437, sha256: "83fd42ad33dae1bd3ceee6c0bb6c625f314cf0b2dc8430be441ac1e2643d5c36"),
        ])

    static let smartTurn = Model(
        name: .smartTurn,
        repository: "aufklarer/Smart-Turn-v3.2-CoreML",
        revision: "75f069717f500947195fa1945c46ddb472559cff",
        folder: "",
        files: [
            File(path: "LICENSE", size: 1406, sha256: "db31415d226689aaf6fa6274da0416171edb70ca7ebf97bd3d99d8d8b88cd34e"),
            File(path: "config.json", size: 1029, sha256: "bc09d1b40285465b389dc42cef54290fa1db7b4928348018bc61d819b4914402"),
            File(path: "smart_turn.mlmodelc/analytics/coremldata.bin", size: 243, sha256: "1646746d0029e78d26be065e62602d4f89e51013ec238b653adf7d7d21057f89"),
            File(path: "smart_turn.mlmodelc/coremldata.bin", size: 643, sha256: "9245ac99889c9d738cba6c89da9e851fd16488bf8effbc15a109d06b401c9383"),
            File(path: "smart_turn.mlmodelc/model.mil", size: 69968, sha256: "41a6d9ac0f7d01d738e56ecdf4435e55f139591541b7cf1a4dba6b9ce2f1c9ef"),
            File(path: "smart_turn.mlmodelc/weights/weight.bin", size: 16_714_240, sha256: "b6295316741a0149e1fcab7cdf030e1b9bfb0eef778207accee91a2a9703a39c"),
        ])

    /// The downloaded models, in install order (smallest first).
    static let downloaded: [Model] = [vad, smartTurn, eou]

    /// Phonon 31m's bundle at the commit PhononVoice pins (its bundle.json's total).
    static let phononBytes = 162_877_586

    static let vadFile = "silero-vad-unified-256ms-v6.2.1.mlmodelc"

    /// `Application Support/MikeVoice/models`.
    static var root: URL {
        URL.applicationSupportDirectory.appending(path: "MikeVoice/models", directoryHint: .isDirectory)
    }

    /// The stamp written once every file is in, naming the commit.
    static func stamp(_ model: Model) -> URL { model.directory.appendingPathComponent(".installed") }

    /// Whether `model` is installed at its pinned commit. Checks the stamp and
    /// each file's size, not its hash (that was checked when it was written).
    static func isInstalled(_ model: Model) -> Bool {
        guard let revision = try? String(contentsOf: stamp(model), encoding: .utf8),
              revision.trimmingCharacters(in: .whitespacesAndNewlines) == model.revision else { return false }
        return model.files.allSatisfy { file in
            let url = model.directory.appendingPathComponent(file.path)
            return (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) == file.size
        }
    }

    // MARK: - Install

    /// Downloads `model` unless it is installed. Files already fetched and
    /// verified in an earlier, interrupted attempt are kept. `progress` gets
    /// the bytes done so far for this model.
    static func install(_ model: Model, progress: @escaping @Sendable (Int) -> Void) async throws {
        if isInstalled(model) {
            progress(model.totalBytes)
            return
        }
        let fm = FileManager.default
        let staging = root.appendingPathComponent(stagingName(model), isDirectory: true)
        removeStaleStaging(model)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        var done = 0
        for file in model.files {
            try Task.checkCancellation()
            let destination = staging.appendingPathComponent(file.path)
            if !(try matches(destination, file)) {
                let before = done
                let delegate = DownloadProgress { progress(before + Int($0)) }
                let (temporary, response) = try await URLSession.shared.download(from: model.url(for: file), delegate: delegate)
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    try? fm.removeItem(at: temporary)
                    throw OnDeviceSpeech.Failure.failed
                }
                guard try matches(temporary, file) else {
                    try? fm.removeItem(at: temporary)
                    throw OnDeviceSpeech.Failure.failed
                }
                try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? fm.removeItem(at: destination)
                try fm.moveItem(at: temporary, to: destination)
            }
            done += file.size
            progress(done)
        }
        try model.revision.write(to: staging.appendingPathComponent(".installed"), atomically: true, encoding: .utf8)
        try? fm.removeItem(at: model.directory)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        try fm.moveItem(at: staging, to: model.directory)
        var url = root.deletingLastPathComponent()
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    /// The folder a download of `model` at its pinned commit is staged in;
    /// kept between attempts so an interrupted download resumes.
    static func stagingName(_ model: Model) -> String {
        "\(model.name.rawValue).partial-\(model.revision.prefix(12))"
    }

    /// Deletes staging folders of `model` left by a download of another commit.
    static func removeStaleStaging(_ model: Model) {
        let fm = FileManager.default
        let keep = stagingName(model)
        let names = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
        for name in names where name.hasPrefix("\(model.name.rawValue).partial-") && name != keep {
            try? fm.removeItem(at: root.appendingPathComponent(name))
        }
    }

    /// Deletes every downloaded voice model, installed or partly downloaded
    /// (Phonon is read-aloud's too and has its own removal).
    static func removeAll() {
        try? FileManager.default.removeItem(at: root)
    }

    /// Whether the file at `url` has `file`'s size and SHA-256.
    static func matches(_ url: URL, _ file: File) throws -> Bool {
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size == file.size else { return false }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined() == file.sha256
    }

    /// Loads each downloaded model once so Core ML prepares it for this phone
    /// as part of the install, not on the first conversation.
    static func compile(_ model: Model) throws {
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuAndNeuralEngine
        let compiled: [String]
        switch model.name {
        case .vad: compiled = [vadFile]
        case .smartTurn: compiled = [SmartTurn.modelFile]
        case .eou: compiled = ["streaming_encoder.mlmodelc", "decoder.mlmodelc", "joint_decision.mlmodelc"]
        default: compiled = []
        }
        for name in compiled {
            _ = try MLModel(contentsOf: model.directory.appendingPathComponent(name), configuration: configuration)
        }
    }

    /// Byte progress of one download.
    private final class DownloadProgress: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
        let report: @Sendable (Int64) -> Void
        init(_ report: @escaping @Sendable (Int64) -> Void) { self.report = report }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
            report(totalBytesWritten)
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
    }
}
