import ComputerHelperCore
import Foundation

enum ConfigStore {
    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(HelperIdentity.bundleId, isDirectory: true)
    }

    static var file: URL { directory.appendingPathComponent("config.json") }

    /// Reads the config, writing the template on first launch.
    static func load() -> Result<HelperConfig, Error> {
        do {
            if !FileManager.default.fileExists(atPath: file.path) {
                try writeTemplate()
            }
            let data = try Data(contentsOf: file)
            return .success(try JSONDecoder().decode(HelperConfig.self, from: data))
        } catch {
            return .failure(error)
        }
    }

    static func writeTemplate() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(HelperConfig.template)
        try data.write(to: file, options: .atomic)
        // The token is a credential: owner-only.
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
