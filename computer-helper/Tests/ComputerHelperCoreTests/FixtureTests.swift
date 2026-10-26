import XCTest

@testable import ComputerHelperCore

/// The shared fixtures in packages/contracts/fixtures/computers decode into
/// this helper's types and encode back to the same JSON (the Rust core runs
/// the same check).
final class FixtureTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("../packages/contracts/fixtures/computers/\(name)")
        return try Data(contentsOf: url)
    }

    /// Drop keys `actual` has and `expected` lacks (defaults written back), recursively.
    private func pruned(_ actual: Any, to expected: Any) -> Any {
        if let a = actual as? [String: Any], let e = expected as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in a where e[k] != nil { out[k] = pruned(v, to: e[k]!) }
            return out
        }
        if let a = actual as? [Any], let e = expected as? [Any] {
            return zip(a, e).map { pruned($0, to: $1) }
        }
        return actual
    }

    private func assertRoundTrips<T: Codable>(_ type: T.Type, _ name: String) throws {
        let data = try fixture(name)
        let value = try JSONDecoder().decode(T.self, from: data)
        let expected = try JSONSerialization.jsonObject(with: data)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
        let a = try JSONSerialization.data(withJSONObject: pruned(encoded, to: expected), options: .sortedKeys)
        let e = try JSONSerialization.data(withJSONObject: expected, options: .sortedKeys)
        XCTAssertEqual(String(decoding: a, as: UTF8.self), String(decoding: e, as: UTF8.self), name)
    }

    /// The helper only reads commands, so they are checked one way.
    func testCommandsDecode() throws {
        guard case .observe(let observe) = try JSONDecoder().decode(ComputerCommand.self, from: fixture("observe-command.json"))
        else { return XCTFail("not an observe") }
        XCTAssertTrue(observe.screenshot)
        XCTAssertEqual(observe.maxElements, 80)
        guard case .act(let act) = try JSONDecoder().decode(ComputerCommand.self, from: fixture("act-command.json"))
        else { return XCTFail("not an act") }
        XCTAssertEqual(act.frameId, "f1")
        XCTAssertEqual(act.actions.count, 8)
    }

    func testResultsRoundTrip() throws {
        try assertRoundTrips(ComputerCommandResult.self, "observation-result.json")
        try assertRoundTrips(ComputerCommandResult.self, "act-result.json")
        try assertRoundTrips(ComputerCommandResult.self, "error-result.json")
    }

    func testHeartbeatRoundTrips() throws {
        try assertRoundTrips(Heartbeat.self, "heartbeat.json")
    }
}
