import Foundation

public enum Limits {
    public static let maxActionsPerBatch = 20
    public static let maxWaitPerActionMs = 5_000
    public static let maxWaitPerBatchMs = 15_000
    public static let maxElements = 150
    public static let maxTextLength = 80
    public static let screenshotLongEdge = 1280.0
}

public enum PolicyDecision: Equatable, Sendable {
    case allow
    case refuse(String)
}

public enum Policy {
    /// May the helper act while this app is frontmost?
    public static func app(bundleId: String?, config: HelperConfig) -> PolicyDecision {
        guard let bundleId else {
            return config.allowedApps.isEmpty ? .allow : .refuse("the frontmost app is unknown")
        }
        if config.blockedApps.contains(where: { $0.caseInsensitiveCompare(bundleId) == .orderedSame }) {
            return .refuse("\(bundleId) is blocked on this computer")
        }
        if !config.allowedApps.isEmpty,
            !config.allowedApps.contains(where: { $0.caseInsensitiveCompare(bundleId) == .orderedSame })
        {
            return .refuse("\(bundleId) is not in this computer's allowed apps")
        }
        return .allow
    }

    /// Checks a batch before any action runs.
    public static func batch(_ command: ComputerActCommand, currentFrameId: String?) -> PolicyDecision {
        if command.actions.isEmpty { return .refuse("no actions") }
        if command.actions.count > Limits.maxActionsPerBatch {
            return .refuse("at most \(Limits.maxActionsPerBatch) actions per batch")
        }
        let usesRef = command.actions.contains { $0.ref != nil }
        let usesPoint = command.actions.contains {
            if case let .click(ref, x, y, _, _) = $0 { return ref == nil && x != nil && y != nil }
            if case let .scroll(ref, x, y, _, _) = $0 { return ref == nil && x != nil && y != nil }
            return false
        }
        if (usesRef || usesPoint) && command.frameId != currentFrameId {
            return .refuse("stale frame: observe again")
        }
        for action in command.actions {
            switch action {
            case let .click(ref, x, y, _, count):
                if ref == nil && (x == nil || y == nil) { return .refuse("click needs a ref or x and y") }
                if count < 1 || count > 3 { return .refuse("click count must be 1 to 3") }
            case let .scroll(_, _, _, dx, dy):
                if abs(dx) > 50 || abs(dy) > 50 { return .refuse("scroll at most 50 lines at a time") }
            case let .openApp(name, bundleId):
                if (name ?? "").isEmpty && (bundleId ?? "").isEmpty {
                    return .refuse("open_app needs a name or bundle_id")
                }
            case let .wait(ms):
                if ms < 0 { return .refuse("wait must not be negative") }
            case .type(let text):
                if text.isEmpty { return .refuse("type needs text") }
            case .key(let combo):
                if KeyCombo.parse(combo) == nil { return .refuse("unknown key \(combo)") }
            }
        }
        return .allow
    }

    /// The wait an action may take, given what the batch has already waited.
    public static func clampedWait(ms: Int, alreadyWaitedMs: Int) -> Int {
        max(0, min(ms, Limits.maxWaitPerActionMs, Limits.maxWaitPerBatchMs - alreadyWaitedMs))
    }

    public static func truncate(_ s: String?) -> String? {
        guard var s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        s = s.replacingOccurrences(of: "\n", with: " ")
        if s.count > Limits.maxTextLength { s = String(s.prefix(Limits.maxTextLength - 1)) + "…" }
        return s
    }
}

/// Maps between screen points (global, top-left origin) and screenshot pixels.
public struct ScreenMapping: Equatable, Sendable {
    /// The main display in global points.
    public var displayOrigin: (x: Double, y: Double)
    public var displaySize: (w: Double, h: Double)
    /// Screenshot pixels per point.
    public var scale: Double

    public init(displayX: Double, displayY: Double, displayW: Double, displayH: Double, longEdge: Double = Limits.screenshotLongEdge) {
        displayOrigin = (displayX, displayY)
        displaySize = (displayW, displayH)
        let edge = max(displayW, displayH)
        // Never upscale: a display smaller than the long edge keeps one pixel per point.
        scale = edge > 0 ? min(1, longEdge / edge) : 1
    }

    public var pixelWidth: Int { Int((displaySize.w * scale).rounded()) }
    public var pixelHeight: Int { Int((displaySize.h * scale).rounded()) }

    public func toPixels(x: Double, y: Double) -> (x: Double, y: Double) {
        ((x - displayOrigin.x) * scale, (y - displayOrigin.y) * scale)
    }

    public func toPoints(x: Double, y: Double) -> (x: Double, y: Double) {
        (x / scale + displayOrigin.x, y / scale + displayOrigin.y)
    }

    public func containsPoint(x: Double, y: Double) -> Bool {
        x >= displayOrigin.x && y >= displayOrigin.y
            && x < displayOrigin.x + displaySize.w && y < displayOrigin.y + displaySize.h
    }

    public static func == (a: ScreenMapping, b: ScreenMapping) -> Bool {
        a.displayOrigin == b.displayOrigin && a.displaySize == b.displaySize && a.scale == b.scale
    }
}
