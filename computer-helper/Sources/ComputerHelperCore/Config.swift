import Foundation

public enum HelperIdentity {
    /// Kept stable so macOS permission grants survive rebuilds.
    public static let bundleId = "org.privateaistack.computer-helper"
    /// Tags every event the helper posts (eventSourceUserData), so it can tell its own input apart.
    public static let eventTag: Int64 = 0x4D49_4B45
}

public struct HelperConfig: Codable, Equatable, Sendable {
    /// The API base, ending in /api for a web deployment (https://example.com/api).
    public var serverUrl: String
    /// The device token from Settings → Computers.
    public var token: String
    /// Bundle ids the helper may act in. Empty allows every app that is not blocked.
    public var allowedApps: [String]
    /// Bundle ids the helper never acts in.
    public var blockedApps: [String]
    /// Only "instant" is implemented.
    public var speed: String
    /// Optional: the password of a shared-password gate in front of the server (staging).
    public var gatePassword: String?

    enum CodingKeys: String, CodingKey {
        case token, speed
        case serverUrl = "server_url"
        case allowedApps = "allowed_apps"
        case blockedApps = "blocked_apps"
        case gatePassword = "gate_password"
    }

    public static let defaultBlockedApps = [
        "com.apple.keychainaccess",
        "com.apple.systempreferences",
        "com.apple.Settings",
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "com.apple.Passwords",
    ]

    public static let template = HelperConfig(
        serverUrl: "https://choir-ip.com/api",
        token: "",
        allowedApps: [],
        blockedApps: defaultBlockedApps,
        speed: "instant",
        gatePassword: ""
    )

    public init(
        serverUrl: String, token: String, allowedApps: [String], blockedApps: [String],
        speed: String, gatePassword: String?
    ) {
        self.serverUrl = serverUrl
        self.token = token
        self.allowedApps = allowedApps
        self.blockedApps = blockedApps
        self.speed = speed
        self.gatePassword = gatePassword
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serverUrl = try c.decodeIfPresent(String.self, forKey: .serverUrl) ?? ""
        token = try c.decodeIfPresent(String.self, forKey: .token) ?? ""
        allowedApps = try c.decodeIfPresent([String].self, forKey: .allowedApps) ?? []
        blockedApps =
            try c.decodeIfPresent([String].self, forKey: .blockedApps) ?? Self.defaultBlockedApps
        speed = try c.decodeIfPresent(String.self, forKey: .speed) ?? "instant"
        gatePassword = try c.decodeIfPresent(String.self, forKey: .gatePassword)
    }

    public var isConfigured: Bool {
        !serverUrl.trimmingCharacters(in: .whitespaces).isEmpty
            && !token.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// The server base without a trailing slash.
    public var baseUrl: String {
        var s = serverUrl.trimmingCharacters(in: .whitespaces)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
