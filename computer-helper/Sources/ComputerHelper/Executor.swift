import AppKit
import ApplicationServices
import Carbon
import ComputerHelperCore
import os

/// Watches for input that did not come from the helper, so a person can take over at any moment.
///
/// A listen-only event tap sees every mouse-down, key-down and scroll in the session. Events the
/// helper posts carry `HelperIdentity.eventTag` in eventSourceUserData; anything else is the person.
/// Mouse movement alone is ignored, so a brushed trackpad does not stop a batch.
final class TakeoverMonitor: @unchecked Sendable {
    static let shared = TakeoverMonitor()
    private let lastHuman = OSAllocatedUnfairLock<Double>(initialState: 0)
    private var tap: CFMachPort?

    var isRunning: Bool { tap != nil }

    /// Seconds since boot of the person's last click, key or scroll.
    var lastHumanInput: Double { lastHuman.withLock { $0 } }

    func record() {
        let now = ProcessInfo.processInfo.systemUptime
        lastHuman.withLock { $0 = now }
    }

    /// Needs Accessibility; returns false until it is granted.
    @MainActor
    func start() -> Bool {
        if tap != nil { return true }
        let types: [CGEventType] = [
            .leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel, .flagsChanged,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let callback: CGEventTapCallBack = { _, type, event, _ in
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let port = TakeoverMonitor.shared.tap { CGEvent.tapEnable(tap: port, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            if event.getIntegerValueField(.eventSourceUserData) != HelperIdentity.eventTag {
                TakeoverMonitor.shared.record()
            }
            return Unmanaged.passUnretained(event)
        }
        guard
            let port = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                eventsOfInterest: mask, callback: callback, userInfo: nil)
        else { return false }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        tap = port
        return true
    }
}

enum ActError: Error, CustomStringConvertible {
    case refused(String)
    var description: String {
        switch self {
        case .refused(let s): return s
        }
    }
}

/// Runs an action batch with instant (unpaced) input.
@MainActor
final class Executor {
    private(set) var frame: Frame?
    var config: HelperConfig
    /// Set by "Stop now"; checked between actions and during waits.
    var stopRequested = false
    private let source: CGEventSource?

    init(config: HelperConfig) {
        self.config = config
        source = CGEventSource(stateID: .hidSystemState)
        source?.userData = HelperIdentity.eventTag
    }

    func remember(_ frame: Frame) { self.frame = frame }

    func run(_ command: ComputerActCommand) async -> ComputerActResult {
        if case .refuse(let reason) = Policy.batch(command, currentFrameId: frame?.id) {
            return ComputerActResult(outcomes: [], stoppedReason: reason)
        }
        if !AXIsProcessTrusted() {
            return ComputerActResult(
                outcomes: [],
                stoppedReason:
                    "Accessibility permission is not granted to the helper, so it cannot click or type.")
        }
        stopRequested = false
        let started = ProcessInfo.processInfo.systemUptime
        var waited = 0
        var outcomes: [ComputerActionOutcome] = []
        for (index, action) in command.actions.enumerated() {
            if let reason = interruption(since: started) {
                return ComputerActResult(outcomes: outcomes, stoppedReason: reason)
            }
            do {
                waited += try await perform(action, waited: waited)
                outcomes.append(.init(index: index, ok: true))
            } catch {
                let message = "\(error)"
                outcomes.append(.init(index: index, ok: false, error: message))
                return ComputerActResult(outcomes: outcomes, stoppedReason: "action \(index) failed: \(message)")
            }
            // Let the app react before the next action.
            try? await Task.sleep(for: .milliseconds(60))
        }
        if let reason = interruption(since: started) {
            return ComputerActResult(outcomes: outcomes, stoppedReason: reason)
        }
        return ComputerActResult(outcomes: outcomes)
    }

    private func interruption(since started: Double) -> String? {
        if stopRequested { return "stopped from the menu bar" }
        if TakeoverMonitor.shared.lastHumanInput > started { return "the person took over" }
        return nil
    }

    // MARK: Actions

    /// Performs one action; returns how long it waited, in ms.
    private func perform(_ action: ComputerAction, waited: Int) async throws -> Int {
        switch action {
        case .wait(let ms):
            let allowed = Policy.clampedWait(ms: ms, alreadyWaitedMs: waited)
            try await interruptibleSleep(ms: allowed)
            return allowed
        case let .openApp(name, bundleId):
            try await openApp(name: name, bundleId: bundleId)
            return 0
        default:
            break
        }

        try checkInputAllowed()
        switch action {
        case let .click(ref, x, y, button, count):
            if let ref {
                let target = try resolve(ref)
                if button == .left, count == 1, Self.pressRoles.contains(target.role),
                    Observer.actionNames(target.element).contains(kAXPressAction as String),
                    AXUIElementPerformAction(target.element, kAXPressAction as CFString) == .success
                {
                    return 0
                }
                click(at: target.center, button: button, count: count)
            } else if let x, let y, let frame {
                let p = frame.mapping.toPoints(x: x, y: y)
                click(at: CGPoint(x: p.x, y: p.y), button: button, count: count)
            }
        case .type(let text):
            try await type(text)
        case .key(let combo):
            guard let parsed = KeyCombo.parse(combo) else { throw ActError.refused("unknown key \(combo)") }
            press(parsed)
        case let .scroll(ref, x, y, dx, dy):
            if let ref {
                move(to: try resolve(ref).center)
            } else if let x, let y, let frame {
                let p = frame.mapping.toPoints(x: x, y: y)
                move(to: CGPoint(x: p.x, y: p.y))
            }
            scroll(dx: dx, dy: dy)
        case .wait, .openApp:
            break
        }
        return 0
    }

    static let pressRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXMenuBarItem", "AXMenuButton",
        "AXPopUpButton", "AXLink", "AXTab", "AXDisclosureTriangle", "AXDockItem", "AXSwitch", "AXToggle",
    ]

    private func resolve(_ ref: String) throws -> ObservedElement {
        guard let target = frame?.elements[ref] else { throw ActError.refused("no element \(ref) in this frame") }
        return target
    }

    private func checkInputAllowed() throws {
        if IsSecureEventInputEnabled() {
            throw ActError.refused("secure input is on (a password field has focus); the helper will not type or click")
        }
        let front = NSWorkspace.shared.frontmostApplication
        if case .refuse(let reason) = Policy.app(bundleId: front?.bundleIdentifier, config: config) {
            throw ActError.refused(reason)
        }
    }

    private func interruptibleSleep(ms: Int) async throws {
        var left = ms
        while left > 0 {
            if stopRequested { throw ActError.refused("stopped from the menu bar") }
            let slice = min(left, 100)
            try await Task.sleep(for: .milliseconds(slice))
            left -= slice
        }
    }

    // MARK: Events

    private func post(_ event: CGEvent?) {
        guard let event else { return }
        event.setIntegerValueField(.eventSourceUserData, value: HelperIdentity.eventTag)
        event.post(tap: .cghidEventTap)
    }

    private func move(to point: CGPoint) {
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    }

    private func click(at point: CGPoint, button: MouseButton, count: Int) {
        move(to: point)
        let (down, up, cgButton): (CGEventType, CGEventType, CGMouseButton) =
            button == .right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
        for n in 1...max(1, min(count, 3)) {
            for type in [down, up] {
                let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: cgButton)
                e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                post(e)
            }
        }
    }

    private func type(_ text: String) async throws {
        // Newlines and tabs go as real keys; apps treat a typed "\n" inconsistently.
        var chunk: [UniChar] = []
        func flush() {
            guard !chunk.isEmpty else { return }
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                post(e)
            }
            chunk.removeAll()
        }
        for scalar in text.unicodeScalars {
            if stopRequested { throw ActError.refused("stopped from the menu bar") }
            if scalar == "\n" || scalar == "\r" || scalar == "\t" {
                flush()
                press(KeyCombo.parse(scalar == "\t" ? "tab" : "return")!)
                try await Task.sleep(for: .milliseconds(5))
                continue
            }
            let units = Array(String(scalar).utf16)
            if chunk.count + units.count > 20 {
                flush()
                try await Task.sleep(for: .milliseconds(5))
            }
            chunk.append(contentsOf: units)
        }
        flush()
    }

    private func press(_ combo: KeyCombo) {
        var flags: CGEventFlags = []
        if combo.modifiers.contains(.command) { flags.insert(.maskCommand) }
        if combo.modifiers.contains(.shift) { flags.insert(.maskShift) }
        if combo.modifiers.contains(.option) { flags.insert(.maskAlternate) }
        if combo.modifiers.contains(.control) { flags.insert(.maskControl) }
        if combo.modifiers.contains(.function) { flags.insert(.maskSecondaryFn) }
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: down)
            e?.flags = flags
            post(e)
        }
    }

    /// dy > 0 scrolls down (content moves up), like a web page's deltaY; dx > 0 scrolls right.
    private func scroll(dx: Int, dy: Int) {
        post(
            CGEvent(
                scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: Int32(-dy),
                wheel2: Int32(-dx), wheel3: 0))
    }

    // MARK: Apps

    private func openApp(name: String?, bundleId: String?) async throws {
        guard let url = Self.appURL(name: name, bundleId: bundleId) else {
            throw ActError.refused("no app named \(bundleId ?? name ?? "")")
        }
        let id = Bundle(url: url)?.bundleIdentifier
        if case .refuse(let reason) = Policy.app(bundleId: id, config: config) { throw ActError.refused(reason) }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        for _ in 0..<30 {
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == id { return }
            try await interruptibleSleep(ms: 100)
        }
        throw ActError.refused("\(id ?? url.lastPathComponent) opened but did not come to the front")
    }

    static func appURL(name: String?, bundleId: String?) -> URL? {
        if let bundleId, !bundleId.isEmpty {
            return NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
        }
        guard var name, !name.isEmpty else { return nil }
        if name.lowercased().hasSuffix(".app") { name = String(name.dropLast(4)) }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let dirs = [
            "/Applications", "/System/Applications", "/System/Applications/Utilities",
            "/Applications/Utilities", "\(home)/Applications",
        ]
        for dir in dirs {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
            if let match = entries.first(where: { $0.caseInsensitiveCompare("\(name).app") == .orderedSame }) {
                return URL(fileURLWithPath: dir).appendingPathComponent(match)
            }
        }
        return nil
    }
}
