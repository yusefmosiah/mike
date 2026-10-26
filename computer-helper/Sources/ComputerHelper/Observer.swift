import AppKit
import ApplicationServices
import ComputerHelperCore
import ScreenCaptureKit

/// What `act` needs from the latest observation.
struct ObservedElement {
    let element: AXUIElement
    let role: String
    /// Centre in global screen points (top-left origin).
    let center: CGPoint
}

struct Frame {
    let id: String
    let mapping: ScreenMapping
    let elements: [String: ObservedElement]
}

@MainActor
enum Observer {
    static let actionableRoles: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXSecureTextField", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXComboBox", "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXLink",
        "AXTab", "AXSlider", "AXSearchField", "AXDisclosureTriangle", "AXIncrementor", "AXColorWell",
        "AXSegmentedControl", "AXDockItem", "AXStepper", "AXSwitch", "AXToggle",
    ]
    static let textRoles: Set<String> = ["AXStaticText", "AXCell", "AXHeading", "AXRow", "AXImage"]

    static func mainDisplayMapping() -> ScreenMapping {
        let b = CGDisplayBounds(CGMainDisplayID())
        return ScreenMapping(
            displayX: b.origin.x, displayY: b.origin.y, displayW: b.width, displayH: b.height)
    }

    static func observe(_ command: ComputerObserveCommand) async -> (ComputerObservation, Frame) {
        let frameId = String(UUID().uuidString.prefix(8)).lowercased()
        let mapping = mainDisplayMapping()
        let front = NSWorkspace.shared.frontmostApplication
        let app = front.map { ObservedApp(name: $0.localizedName ?? "Unknown", bundleId: $0.bundleIdentifier) }

        var elements: [ComputerElement] = []
        var refs: [String: ObservedElement] = [:]
        var windowTitle: String?
        var elementsNote: String?

        if !AXIsProcessTrusted() {
            elementsNote =
                "Accessibility permission is not granted to the helper, so no element tree. Grant it in System Settings › Privacy & Security › Accessibility, then choose Restart in the helper's menu."
        } else if let front {
            let appElement = AXUIElementCreateApplication(front.processIdentifier)
            AXUIElementSetMessagingTimeout(appElement, 1.0)
            let window =
                copyElement(appElement, kAXFocusedWindowAttribute)
                ?? copyElement(appElement, kAXMainWindowAttribute)
                ?? (copyArray(appElement, kAXWindowsAttribute)?.first)
            if let window {
                windowTitle = Policy.truncate(copyString(window, kAXTitleAttribute))
                let limit = max(1, min(command.maxElements, Limits.maxElements))
                var walker = TreeWalker(mapping: mapping, limit: limit)
                walker.walk(window, depth: 0)
                elements = walker.elements
                refs = walker.refs
                if walker.truncated { elementsNote = "Element list stopped at \(limit); ask for more with max_elements." }
            } else {
                elementsNote = "The frontmost app has no window the helper can read."
            }
        } else {
            elementsNote = "No frontmost app."
        }

        var screenshot: Screenshot?
        var screenshotNote: String?
        if command.screenshot {
            do {
                screenshot = try await capture(mapping: mapping, badges: elements)
            } catch {
                screenshotNote = "\(error)"
            }
        }

        let observation = ComputerObservation(
            frameId: frameId, app: app, windowTitle: windowTitle, elements: elements,
            elementsNote: elementsNote, screenshot: screenshot, screenshotNote: screenshotNote)
        return (observation, Frame(id: frameId, mapping: mapping, elements: refs))
    }

    // MARK: Accessibility helpers

    static func copyValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    static func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let v = copyValue(element, attribute), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func copyArray(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]? {
        copyValue(element, attribute) as? [AXUIElement]
    }

    static func copyString(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let v = copyValue(element, attribute) else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID() { return n.stringValue }
        return nil
    }

    static func copyBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        copyValue(element, attribute) as? Bool
    }

    static func copyRect(_ element: AXUIElement) -> CGRect? {
        guard let p = copyValue(element, kAXPositionAttribute), let s = copyValue(element, kAXSizeAttribute),
            CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size)
        else { return nil }
        return CGRect(origin: point, size: size)
    }

    static func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    struct TreeWalker {
        let mapping: ScreenMapping
        let limit: Int
        var elements: [ComputerElement] = []
        var refs: [String: ObservedElement] = [:]
        var visited = 0
        var truncated = false
        static let maxDepth = 25
        static let maxVisited = 3000

        init(mapping: ScreenMapping, limit: Int) {
            self.mapping = mapping
            self.limit = limit
        }

        @MainActor
        mutating func walk(_ element: AXUIElement, depth: Int) {
            guard depth <= Self.maxDepth, visited < Self.maxVisited else { return }
            if elements.count >= limit {
                truncated = true
                return
            }
            visited += 1
            let role = Observer.copyString(element, kAXRoleAttribute) ?? ""
            let rect = Observer.copyRect(element)
            // Off-screen subtrees (scrolled away, other displays) are skipped whole.
            let display = CGRect(
                x: mapping.displayOrigin.x, y: mapping.displayOrigin.y,
                width: mapping.displaySize.w, height: mapping.displaySize.h)
            if let rect, depth > 0, rect.width > 0, rect.height > 0, !rect.intersects(display) {
                return
            }
            consider(element, role: role, rect: rect)
            for child in Observer.copyArray(element, kAXChildrenAttribute) ?? [] {
                walk(child, depth: depth + 1)
                if elements.count >= limit || visited >= Self.maxVisited { break }
            }
        }

        @MainActor
        mutating func consider(_ element: AXUIElement, role: String, rect: CGRect?) {
            guard let rect, rect.width >= 2, rect.height >= 2,
                mapping.containsPoint(x: rect.midX, y: rect.midY)
            else { return }
            let title = Policy.truncate(Observer.copyString(element, kAXTitleAttribute))
            let description = Policy.truncate(Observer.copyString(element, kAXDescriptionAttribute))
            // Never read what is typed into a password field.
            let value =
                role == "AXSecureTextField" ? nil : Policy.truncate(Observer.copyString(element, kAXValueAttribute))
            let actionable = Observer.actionableRoles.contains(role)
            let hasText = title != nil || value != nil || description != nil
            guard actionable || (Observer.textRoles.contains(role) && hasText) else { return }

            let ref = "e\(elements.count + 1)"
            let origin = mapping.toPixels(x: rect.minX, y: rect.minY)
            let frame = ElementFrame(
                x: origin.x.rounded(), y: origin.y.rounded(),
                w: (rect.width * mapping.scale).rounded(), h: (rect.height * mapping.scale).rounded())
            let enabled = Observer.copyBool(element, kAXEnabledAttribute)
            let focused = Observer.copyBool(element, kAXFocusedAttribute)
            elements.append(
                ComputerElement(
                    ref: ref, role: role, title: title, value: value, description: description, frame: frame,
                    enabled: enabled == false ? false : nil, focused: focused == true ? true : nil))
            refs[ref] = ObservedElement(element: element, role: role, center: CGPoint(x: rect.midX, y: rect.midY))
        }
    }

    // MARK: Screenshot

    enum CaptureError: Error, CustomStringConvertible {
        case notPermitted, noDisplay, encodeFailed
        var description: String {
            switch self {
            case .notPermitted:
                return
                    "Screen Recording permission is not granted to the helper. Grant it in System Settings › Privacy & Security › Screen & System Audio Recording, then choose Restart in the helper's menu."
            case .noDisplay: return "The main display was not found."
            case .encodeFailed: return "The screenshot could not be encoded."
            }
        }
    }

    static func capture(mapping: ScreenMapping, badges: [ComputerElement]) async throws -> Screenshot {
        // Preflight so an observe never pops the system prompt by itself.
        guard CGPreflightScreenCaptureAccess() else { throw CaptureError.notPermitted }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first
        else { throw CaptureError.noDisplay }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = mapping.pixelWidth
        config.height = mapping.pixelHeight
        config.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let jpeg = annotate(image, width: mapping.pixelWidth, height: mapping.pixelHeight, badges: badges)
        else { throw CaptureError.encodeFailed }
        return Screenshot(data: jpeg.base64EncodedString(), width: mapping.pixelWidth, height: mapping.pixelHeight)
    }

    /// Draws each element's ref at its centre and encodes a JPEG.
    static func annotate(_ image: CGImage, width: Int, height: Int, badges: [ComputerElement]) -> Data? {
        guard
            let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0),
            let context = NSGraphicsContext(bitmapImageRep: rep)
        else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let cg = context.cgContext
        cg.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        let font = NSFont.boldSystemFont(ofSize: 11)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
        let fill = NSColor(calibratedRed: 0.85, green: 0.1, blue: 0.1, alpha: 0.85)
        for element in badges {
            let label = element.ref as NSString
            let size = label.size(withAttributes: attributes)
            let cx = element.frame.x + element.frame.w / 2
            let cy = element.frame.y + element.frame.h / 2
            // Image y runs top-down; the bitmap context runs bottom-up.
            let box = CGRect(
                x: cx - size.width / 2 - 3, y: Double(height) - cy - size.height / 2 - 1,
                width: size.width + 6, height: size.height + 2)
            fill.setFill()
            NSBezierPath(roundedRect: box, xRadius: 3, yRadius: 3).fill()
            label.draw(at: CGPoint(x: box.minX + 3, y: box.minY + 1), withAttributes: attributes)
        }
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7])
    }
}
