import Foundation

// Mirrors the "Computers" section of packages/contracts/index.d.ts.

public struct ComputerObserveCommand: Codable, Equatable, Sendable {
    public var id: String
    public var screenshot: Bool
    public var maxElements: Int

    enum CodingKeys: String, CodingKey {
        case id, screenshot
        case maxElements = "max_elements"
    }

    public init(id: String, screenshot: Bool, maxElements: Int) {
        self.id = id
        self.screenshot = screenshot
        self.maxElements = maxElements
    }
}

public enum MouseButton: String, Codable, Sendable {
    case left, right
}

public enum ComputerAction: Equatable, Sendable {
    case click(ref: String?, x: Double?, y: Double?, button: MouseButton, count: Int)
    case type(text: String)
    case key(combo: String)
    case scroll(ref: String?, x: Double?, y: Double?, dx: Int, dy: Int)
    case openApp(name: String?, bundleId: String?)
    case wait(ms: Int)

    /// The ref this action points at, if any.
    public var ref: String? {
        switch self {
        case .click(let ref, _, _, _, _), .scroll(let ref, _, _, _, _): return ref
        default: return nil
        }
    }
}

extension ComputerAction: Codable {
    enum CodingKeys: String, CodingKey {
        case type, ref, x, y, button, count, text, combo, dx, dy, name, ms
        case bundleId = "bundle_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .type)
        switch kind {
        case "click":
            self = .click(
                ref: try c.decodeIfPresent(String.self, forKey: .ref),
                x: try c.decodeIfPresent(Double.self, forKey: .x),
                y: try c.decodeIfPresent(Double.self, forKey: .y),
                button: try c.decodeIfPresent(MouseButton.self, forKey: .button) ?? .left,
                count: try c.decodeIfPresent(Int.self, forKey: .count) ?? 1
            )
        case "type":
            self = .type(text: try c.decode(String.self, forKey: .text))
        case "key":
            self = .key(combo: try c.decode(String.self, forKey: .combo))
        case "scroll":
            self = .scroll(
                ref: try c.decodeIfPresent(String.self, forKey: .ref),
                x: try c.decodeIfPresent(Double.self, forKey: .x),
                y: try c.decodeIfPresent(Double.self, forKey: .y),
                dx: try c.decodeIfPresent(Int.self, forKey: .dx) ?? 0,
                dy: try c.decodeIfPresent(Int.self, forKey: .dy) ?? 0
            )
        case "open_app":
            self = .openApp(
                name: try c.decodeIfPresent(String.self, forKey: .name),
                bundleId: try c.decodeIfPresent(String.self, forKey: .bundleId)
            )
        case "wait":
            self = .wait(ms: try c.decode(Int.self, forKey: .ms))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "Unknown action type \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .click(ref, x, y, button, count):
            try c.encode("click", forKey: .type)
            try c.encodeIfPresent(ref, forKey: .ref)
            try c.encodeIfPresent(x, forKey: .x)
            try c.encodeIfPresent(y, forKey: .y)
            try c.encode(button, forKey: .button)
            try c.encode(count, forKey: .count)
        case let .type(text):
            try c.encode("type", forKey: .type)
            try c.encode(text, forKey: .text)
        case let .key(combo):
            try c.encode("key", forKey: .type)
            try c.encode(combo, forKey: .combo)
        case let .scroll(ref, x, y, dx, dy):
            try c.encode("scroll", forKey: .type)
            try c.encodeIfPresent(ref, forKey: .ref)
            try c.encodeIfPresent(x, forKey: .x)
            try c.encodeIfPresent(y, forKey: .y)
            try c.encode(dx, forKey: .dx)
            try c.encode(dy, forKey: .dy)
        case let .openApp(name, bundleId):
            try c.encode("open_app", forKey: .type)
            try c.encodeIfPresent(name, forKey: .name)
            try c.encodeIfPresent(bundleId, forKey: .bundleId)
        case let .wait(ms):
            try c.encode("wait", forKey: .type)
            try c.encode(ms, forKey: .ms)
        }
    }
}

public struct ComputerActCommand: Codable, Equatable, Sendable {
    public var id: String
    public var frameId: String
    public var actions: [ComputerAction]

    enum CodingKeys: String, CodingKey {
        case id, actions
        case frameId = "frame_id"
    }

    public init(id: String, frameId: String, actions: [ComputerAction]) {
        self.id = id
        self.frameId = frameId
        self.actions = actions
    }
}

public enum ComputerCommand: Equatable, Sendable {
    case observe(ComputerObserveCommand)
    case act(ComputerActCommand)

    public var id: String {
        switch self {
        case .observe(let c): return c.id
        case .act(let c): return c.id
        }
    }
}

extension ComputerCommand: Decodable {
    enum CodingKeys: String, CodingKey { case type, id }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .type)
        switch kind {
        case "observe": self = .observe(try ComputerObserveCommand(from: decoder))
        case "act": self = .act(try ComputerActCommand(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "Unknown command type \(kind)")
        }
    }
}

public struct ElementFrame: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

public struct ComputerElement: Codable, Equatable, Sendable {
    public var ref: String
    public var role: String
    public var title: String?
    public var value: String?
    public var description: String?
    public var frame: ElementFrame
    public var enabled: Bool?
    public var focused: Bool?

    public init(
        ref: String, role: String, title: String? = nil, value: String? = nil,
        description: String? = nil, frame: ElementFrame, enabled: Bool? = nil, focused: Bool? = nil
    ) {
        self.ref = ref
        self.role = role
        self.title = title
        self.value = value
        self.description = description
        self.frame = frame
        self.enabled = enabled
        self.focused = focused
    }
}

public struct ObservedApp: Codable, Equatable, Sendable {
    public var name: String
    public var bundleId: String?

    enum CodingKeys: String, CodingKey {
        case name
        case bundleId = "bundle_id"
    }

    public init(name: String, bundleId: String?) {
        self.name = name
        self.bundleId = bundleId
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(bundleId, forKey: .bundleId)  // null, not absent
    }
}

public struct Screenshot: Codable, Equatable, Sendable {
    public var data: String
    public var mimeType: String
    public var width: Int
    public var height: Int

    enum CodingKeys: String, CodingKey {
        case data, width, height
        case mimeType = "mime_type"
    }

    public init(data: String, width: Int, height: Int) {
        self.data = data
        self.mimeType = "image/jpeg"
        self.width = width
        self.height = height
    }
}

public struct ComputerObservation: Codable, Equatable, Sendable {
    public var frameId: String
    public var app: ObservedApp?
    public var windowTitle: String?
    public var elements: [ComputerElement]
    public var elementsNote: String?
    public var screenshot: Screenshot?
    public var screenshotNote: String?

    enum CodingKeys: String, CodingKey {
        case app, elements, screenshot
        case frameId = "frame_id"
        case windowTitle = "window_title"
        case elementsNote = "elements_note"
        case screenshotNote = "screenshot_note"
    }

    public init(
        frameId: String, app: ObservedApp?, windowTitle: String?, elements: [ComputerElement],
        elementsNote: String? = nil, screenshot: Screenshot? = nil, screenshotNote: String? = nil
    ) {
        self.frameId = frameId
        self.app = app
        self.windowTitle = windowTitle
        self.elements = elements
        self.elementsNote = elementsNote
        self.screenshot = screenshot
        self.screenshotNote = screenshotNote
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(frameId, forKey: .frameId)
        try c.encode(app, forKey: .app)  // null, not absent
        try c.encode(windowTitle, forKey: .windowTitle)
        try c.encode(elements, forKey: .elements)
        try c.encodeIfPresent(elementsNote, forKey: .elementsNote)
        try c.encodeIfPresent(screenshot, forKey: .screenshot)
        try c.encodeIfPresent(screenshotNote, forKey: .screenshotNote)
    }
}

public struct ComputerActionOutcome: Codable, Equatable, Sendable {
    public var index: Int
    public var ok: Bool
    public var error: String?

    public init(index: Int, ok: Bool, error: String? = nil) {
        self.index = index
        self.ok = ok
        self.error = error
    }
}

public struct ComputerActResult: Codable, Equatable, Sendable {
    public var outcomes: [ComputerActionOutcome]
    public var stoppedReason: String?

    enum CodingKeys: String, CodingKey {
        case outcomes
        case stoppedReason = "stopped_reason"
    }

    public init(outcomes: [ComputerActionOutcome], stoppedReason: String? = nil) {
        self.outcomes = outcomes
        self.stoppedReason = stoppedReason
    }
}

public enum ComputerCommandResult: Equatable, Sendable {
    case observation(ComputerObservation)
    case act(ComputerActResult)
    case failure(String)
}

extension ComputerCommandResult: Codable {
    enum CodingKeys: String, CodingKey { case ok, observation, act, error }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .observation(let o):
            try c.encode(true, forKey: .ok)
            try c.encode(o, forKey: .observation)
        case .act(let a):
            try c.encode(true, forKey: .ok)
            try c.encode(a, forKey: .act)
        case .failure(let message):
            try c.encode(false, forKey: .ok)
            try c.encode(message, forKey: .error)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if try c.decode(Bool.self, forKey: .ok) {
            if let o = try c.decodeIfPresent(ComputerObservation.self, forKey: .observation) {
                self = .observation(o)
            } else {
                self = .act(try c.decode(ComputerActResult.self, forKey: .act))
            }
        } else {
            self = .failure(try c.decode(String.self, forKey: .error))
        }
    }
}
