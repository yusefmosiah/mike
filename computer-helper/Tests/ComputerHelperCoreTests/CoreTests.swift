import XCTest

@testable import ComputerHelperCore

final class ProtocolTests: XCTestCase {
    func testMapsRolesOntoTheSharedVocabulary() {
        XCTAssertEqual(Roles.shared("AXButton"), "button")
        XCTAssertEqual(Roles.shared("AXSecureTextField"), "textfield")
        XCTAssertEqual(Roles.shared("AXPopUpButton"), "popup")
        XCTAssertEqual(Roles.shared("AXSomethingNew"), "other")
    }

    func testEncodesHeartbeatAndElementInTheContractShape() throws {
        let beat = try JSONSerialization.jsonObject(with: JSONEncoder().encode(Heartbeat.macOS(version: "0.2"))) as! [String: Any]
        XCTAssertEqual(beat["platform"] as? String, "macos")
        XCTAssertEqual(beat["helper_version"] as? String, "0.2")
        let caps = beat["capabilities"] as! [String: String]
        XCTAssertEqual(caps, ["coordinates": "screen", "takeover": "full", "secure_input": "system"])

        let element = ComputerElement(
            ref: "e1", role: "button", nativeRole: "AXButton", frame: ElementFrame(x: 1, y: 2, w: 3, h: 4))
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(element)) as! [String: Any]
        XCTAssertEqual(json["native_role"] as? String, "AXButton")
        XCTAssertEqual(json["role"] as? String, "button")
    }

    func testDecodesObserve() throws {
        let json = #"{"id":"c1","type":"observe","screenshot":true,"max_elements":80}"#
        let command = try JSONDecoder().decode(ComputerCommand.self, from: Data(json.utf8))
        XCTAssertEqual(command, .observe(.init(id: "c1", screenshot: true, maxElements: 80)))
        XCTAssertEqual(command.id, "c1")
    }

    func testDecodesActWithEveryActionType() throws {
        let json = #"""
            {"id":"c2","type":"act","frame_id":"f1","actions":[
              {"type":"click","ref":"e3"},
              {"type":"click","x":10.5,"y":20,"button":"right","count":2},
              {"type":"type","text":"héllo"},
              {"type":"key","combo":"cmd+s"},
              {"type":"scroll","dy":-3},
              {"type":"open_app","bundle_id":"com.apple.TextEdit"},
              {"type":"wait","ms":500}
            ]}
            """#
        let command = try JSONDecoder().decode(ComputerCommand.self, from: Data(json.utf8))
        guard case .act(let act) = command else { return XCTFail("expected act") }
        XCTAssertEqual(act.frameId, "f1")
        XCTAssertEqual(
            act.actions,
            [
                .click(ref: "e3", x: nil, y: nil, button: .left, count: 1),
                .click(ref: nil, x: 10.5, y: 20, button: .right, count: 2),
                .type(text: "héllo"),
                .key(combo: "cmd+s"),
                .scroll(ref: nil, x: nil, y: nil, dx: 0, dy: -3),
                .openApp(name: nil, bundleId: "com.apple.TextEdit"),
                .wait(ms: 500),
            ])
    }

    func testRejectsUnknownTypes() {
        let bad = [
            #"{"id":"c","type":"format_disk"}"#,
            #"{"id":"c","type":"act","frame_id":"f","actions":[{"type":"drag"}]}"#,
        ]
        for json in bad {
            XCTAssertThrowsError(try JSONDecoder().decode(ComputerCommand.self, from: Data(json.utf8)))
        }
    }

    func testActionRoundTrips() throws {
        let actions: [ComputerAction] = [
            .click(ref: "e1", x: nil, y: nil, button: .left, count: 1),
            .scroll(ref: nil, x: 5, y: 6, dx: 1, dy: 2),
            .openApp(name: "TextEdit", bundleId: nil),
        ]
        let data = try JSONEncoder().encode(actions)
        XCTAssertEqual(try JSONDecoder().decode([ComputerAction].self, from: data), actions)
    }

    func testEncodesResultsInTheContractShape() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        let failure = try encoder.encode(ComputerCommandResult.failure("nope"))
        XCTAssertEqual(String(decoding: failure, as: UTF8.self), #"{"error":"nope","ok":false}"#)

        let act = try encoder.encode(
            ComputerCommandResult.act(
                .init(outcomes: [.init(index: 0, ok: false, error: "x")], stoppedReason: "x")))
        XCTAssertEqual(
            String(decoding: act, as: UTF8.self),
            #"{"act":{"outcomes":[{"error":"x","index":0,"ok":false}],"stopped_reason":"x"},"ok":true}"#)

        let observation = ComputerObservation(
            frameId: "f", app: .init(name: "Finder", bundleId: nil), windowTitle: nil,
            elements: [.init(ref: "e1", role: "AXButton", frame: .init(x: 1, y: 2, w: 3, h: 4))],
            screenshot: .init(data: "AAAA", width: 10, height: 5))
        let encoded = try encoder.encode(ComputerCommandResult.observation(observation))
        let object = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        let obs = object["observation"] as! [String: Any]
        XCTAssertEqual(obs["frame_id"] as? String, "f")
        XCTAssertTrue(obs["window_title"] is NSNull)
        XCTAssertTrue((obs["app"] as! [String: Any])["bundle_id"] is NSNull)
        XCTAssertEqual((obs["screenshot"] as! [String: Any])["mime_type"] as? String, "image/jpeg")
        XCTAssertEqual(
            try JSONDecoder().decode(ComputerCommandResult.self, from: encoded), .observation(observation))
    }

    func testConfigFillsDefaults() throws {
        let config = try JSONDecoder().decode(
            HelperConfig.self, from: Data(#"{"server_url":"https://x.test/api/","token":"t"}"#.utf8))
        XCTAssertTrue(config.isConfigured)
        XCTAssertEqual(config.baseUrl, "https://x.test/api")
        XCTAssertEqual(config.blockedApps, HelperConfig.defaultBlockedApps)
        XCTAssertEqual(config.speed, "instant")
        XCTAssertFalse(HelperConfig.template.isConfigured)
    }
}

final class PolicyTests: XCTestCase {
    let config = HelperConfig.template

    func testBlockedAppsAreRefused() {
        XCTAssertEqual(Policy.app(bundleId: "com.apple.TextEdit", config: config), .allow)
        XCTAssertNotEqual(Policy.app(bundleId: "com.apple.Terminal", config: config), .allow)
        XCTAssertNotEqual(Policy.app(bundleId: "COM.APPLE.KEYCHAINACCESS", config: config), .allow)
    }

    func testAllowListLimitsApps() {
        var limited = config
        limited.allowedApps = ["com.apple.TextEdit"]
        XCTAssertEqual(Policy.app(bundleId: "com.apple.TextEdit", config: limited), .allow)
        XCTAssertNotEqual(Policy.app(bundleId: "com.apple.Safari", config: limited), .allow)
        XCTAssertNotEqual(Policy.app(bundleId: nil, config: limited), .allow)
        XCTAssertEqual(Policy.app(bundleId: nil, config: config), .allow)
    }

    func testBatchChecks() {
        func act(_ actions: [ComputerAction], frame: String = "f1") -> ComputerActCommand {
            .init(id: "c", frameId: frame, actions: actions)
        }
        let click = ComputerAction.click(ref: "e1", x: nil, y: nil, button: .left, count: 1)
        XCTAssertEqual(Policy.batch(act([click]), currentFrameId: "f1"), .allow)
        XCTAssertEqual(Policy.batch(act([click]), currentFrameId: "f2"), .refuse("stale frame: observe again"))
        XCTAssertEqual(
            Policy.batch(act([.click(ref: nil, x: 1, y: 1, button: .left, count: 1)]), currentFrameId: nil),
            .refuse("stale frame: observe again"))
        // Typing and keys don't depend on a frame.
        XCTAssertEqual(Policy.batch(act([.type(text: "hi"), .key(combo: "return")]), currentFrameId: nil), .allow)
        XCTAssertNotEqual(Policy.batch(act([]), currentFrameId: "f1"), .allow)
        XCTAssertNotEqual(Policy.batch(act(Array(repeating: .wait(ms: 1), count: 21)), currentFrameId: nil), .allow)
        XCTAssertNotEqual(Policy.batch(act([.key(combo: "cmd+banana")]), currentFrameId: nil), .allow)
        XCTAssertNotEqual(
            Policy.batch(act([.click(ref: nil, x: 1, y: nil, button: .left, count: 1)]), currentFrameId: "f1"), .allow)
        XCTAssertNotEqual(Policy.batch(act([.openApp(name: nil, bundleId: "")]), currentFrameId: nil), .allow)
    }

    func testWaitIsCapped() {
        XCTAssertEqual(Policy.clampedWait(ms: 9_000, alreadyWaitedMs: 0), 5_000)
        XCTAssertEqual(Policy.clampedWait(ms: 5_000, alreadyWaitedMs: 12_000), 3_000)
        XCTAssertEqual(Policy.clampedWait(ms: 5_000, alreadyWaitedMs: 15_000), 0)
    }

    func testTruncate() {
        XCTAssertNil(Policy.truncate("  \n "))
        XCTAssertEqual(Policy.truncate("a\nb"), "a b")
        XCTAssertEqual(Policy.truncate(String(repeating: "x", count: 200))?.count, 80)
    }

    func testKeyCombos() {
        XCTAssertEqual(KeyCombo.parse("cmd+s"), KeyCombo(keyCode: 0x01, modifiers: .command))
        XCTAssertEqual(KeyCombo.parse("Cmd+Shift+T"), KeyCombo(keyCode: 0x11, modifiers: [.command, .shift]))
        XCTAssertEqual(KeyCombo.parse("return")?.keyCode, 0x24)
        XCTAssertEqual(KeyCombo.parse("f12")?.keyCode, 0x6F)
        XCTAssertNil(KeyCombo.parse(""))
        XCTAssertNil(KeyCombo.parse("hyper+a"))
        XCTAssertNil(KeyCombo.parse("cmd+"))
    }

    func testScreenMapping() {
        let mapping = ScreenMapping(displayX: 0, displayY: 0, displayW: 2560, displayH: 1600)
        XCTAssertEqual(mapping.scale, 0.5)
        XCTAssertEqual(mapping.pixelWidth, 1280)
        let p = mapping.toPixels(x: 1000, y: 500)
        XCTAssertEqual(p.x, 500)
        let back = mapping.toPoints(x: p.x, y: p.y)
        XCTAssertEqual(back.x, 1000)
        XCTAssertEqual(back.y, 500)
        XCTAssertEqual(ScreenMapping(displayX: 0, displayY: 0, displayW: 1024, displayH: 768).scale, 1)
    }
}
