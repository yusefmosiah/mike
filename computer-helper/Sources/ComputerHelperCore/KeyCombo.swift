import Foundation

/// A key combination such as "cmd+shift+t", parsed to a US-layout virtual key code and modifiers.
public struct KeyCombo: Equatable, Sendable {
    public struct Modifiers: OptionSet, Equatable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let command = Modifiers(rawValue: 1 << 0)
        public static let shift = Modifiers(rawValue: 1 << 1)
        public static let option = Modifiers(rawValue: 1 << 2)
        public static let control = Modifiers(rawValue: 1 << 3)
        public static let function = Modifiers(rawValue: 1 << 4)
    }

    public var keyCode: UInt16
    public var modifiers: Modifiers

    public init(keyCode: UInt16, modifiers: Modifiers) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    static let modifierNames: [String: Modifiers] = [
        "cmd": .command, "command": .command, "meta": .command, "super": .command,
        "shift": .shift,
        "opt": .option, "option": .option, "alt": .option,
        "ctrl": .control, "control": .control,
        "fn": .function,
    ]

    // kVK_* values from Carbon's Events.h (ANSI layout).
    static let keyCodes: [String: UInt16] = {
        var m: [String: UInt16] = [
            "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
            "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
            "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
            "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20,
            "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
            "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
            "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31, "delete": 0x33,
            "backspace": 0x33, "escape": 0x35, "esc": 0x35, "forwarddelete": 0x75,
            "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
            "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
            "arrowleft": 0x7B, "arrowright": 0x7C, "arrowdown": 0x7D, "arrowup": 0x7E,
        ]
        let fKeys: [UInt16] = [
            0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F,
        ]
        for (i, code) in fKeys.enumerated() { m["f\(i + 1)"] = code }
        return m
    }()

    public static func parse(_ combo: String) -> KeyCombo? {
        let raw = combo.trimmingCharacters(in: .whitespaces).lowercased()
        guard !raw.isEmpty else { return nil }
        // "+" alone, or a trailing "++" (cmd++), means the plus key; not on the table, so refuse.
        let parts = raw.split(separator: "+", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard let keyName = parts.last, !keyName.isEmpty else { return nil }
        var mods: Modifiers = []
        for name in parts.dropLast() {
            guard let m = modifierNames[name] else { return nil }
            mods.insert(m)
        }
        guard let code = keyCodes[keyName] else { return nil }
        return KeyCombo(keyCode: code, modifiers: mods)
    }
}
