import ComputerHelperCore
import Foundation

enum TransportError: Error, CustomStringConvertible {
    case tokenRejected
    case gatePasswordWrong
    case gateLocked
    case http(Int)
    case badResponse

    var description: String {
        switch self {
        case .tokenRejected: return "Token rejected"
        case .gatePasswordWrong: return "Gate password rejected (not retried)"
        case .gateLocked: return "Server gate needs gate_password in config"
        case .http(let code): return "Server answered \(code)"
        case .badResponse: return "Unexpected server response"
        }
    }
}

/// HTTPS long-poll client for the device endpoints.
final class Transport: Sendable {
    let config: HelperConfig
    private let session: URLSession
    private let gate = GateState()

    init(config: HelperConfig) {
        self.config = config
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 40
        c.httpCookieAcceptPolicy = .always
        c.httpShouldSetCookies = true
        session = URLSession(configuration: c)
    }

    private func request(_ path: String, method: String, body: Data? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: config.baseUrl + path)!)
        r.httpMethod = method
        r.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    /// Sends a request, signing in through a shared-password gate once if one answers.
    private func send(_ r: URLRequest) async throws -> (Data, HTTPURLResponse) {
        var (data, response) = try await exchange(r)
        if response.statusCode == 401, Self.isGateRefusal(data: data, response: response) {
            try await passGate()
            (data, response) = try await exchange(r)
        }
        if response.statusCode == 401 {
            throw Self.isGateRefusal(data: data, response: response)
                ? TransportError.gateLocked : TransportError.tokenRejected
        }
        return (data, response)
    }

    private func exchange(_ r: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: r)
        guard let http = response as? HTTPURLResponse else { throw TransportError.badResponse }
        return (data, http)
    }

    /// The staging gate answers 401 with an empty, non-JSON body; the API answers with JSON.
    static func isGateRefusal(data: Data, response: HTTPURLResponse) -> Bool {
        let type = response.value(forHTTPHeaderField: "Content-Type") ?? ""
        return data.isEmpty && !type.contains("json")
    }

    private func passGate() async throws {
        guard let password = config.gatePassword, !password.isEmpty else { throw TransportError.gateLocked }
        // Five wrong passwords ban this address for a day: try once per launch only.
        guard await gate.claimAttempt() else { throw TransportError.gatePasswordWrong }
        guard let base = URL(string: config.baseUrl), var origin = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { throw TransportError.badResponse }
        origin.path = "/__gate"
        origin.query = nil
        var r = URLRequest(url: origin.url!)
        r.httpMethod = "POST"
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [.init(name: "password", value: password), .init(name: "next", value: "/robots.txt")]
        r.httpBody = Data((form.percentEncodedQuery ?? "").utf8)
        let (_, response) = try await exchange(r)
        if response.statusCode == 401 {
            await gate.markFailed()
            throw TransportError.gatePasswordWrong
        }
        await gate.markPassed()
    }

    /// Waits up to `wait` seconds for the next command; nil when there is none.
    func next(wait: Int = 25) async throws -> ComputerCommand? {
        let (data, response) = try await send(request("/computers/device/next?wait=\(wait)", method: "GET"))
        switch response.statusCode {
        case 204: return nil
        case 200: return try JSONDecoder().decode(ComputerCommand.self, from: data)
        default: throw TransportError.http(response.statusCode)
        }
    }

    func post(result: ComputerCommandResult, for id: String) async throws {
        let body = try JSONEncoder().encode(result)
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let (_, response) = try await send(request("/computers/device/results/\(escaped)", method: "POST", body: body))
        // 404/409/410: the command expired or was cancelled server-side; nothing to do.
        if response.statusCode >= 500 { throw TransportError.http(response.statusCode) }
    }

    func heartbeat() async throws {
        let (_, response) = try await send(request("/computers/device/heartbeat", method: "POST", body: Data("{}".utf8)))
        if !(200..<300).contains(response.statusCode) { throw TransportError.http(response.statusCode) }
    }
}

private actor GateState {
    private var attempted = false
    private var failed = false

    func claimAttempt() -> Bool {
        if failed { return false }
        if attempted { return true }
        attempted = true
        return true
    }

    func markFailed() { failed = true }
    func markPassed() {}
}
