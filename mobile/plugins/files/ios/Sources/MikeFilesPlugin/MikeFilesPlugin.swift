import Capacitor
import Foundation
import UIKit

/// Downloads for the web app (frontend/src/app/lib/nativeFiles.ts). The web
/// view ignores a link that downloads a blob, so the web app sends the file's
/// bytes here and the share sheet offers Save to Files, AirDrop, Mail and the
/// rest. The file exists only in a protected temporary folder while the sheet
/// is open, and its name and contents are never logged. In the Mac app (Mac
/// Catalyst) the file is saved to ~/Downloads instead.
@objc(MikeFilesPlugin)
public class MikeFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MikeFilesPlugin"
    public let jsName = "MikeFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise)
    ]

    /// Larger files are better downloaded from the web app on a computer.
    static let maxBytes = 200 * 1024 * 1024

    @objc func share(_ call: CAPPluginCall) {
        guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded) else {
            call.reject("No file to save.", "invalid-file")
            return
        }
        guard data.count <= Self.maxBytes else {
            call.reject("The file is too large to save on this iPhone.", "too-large")
            return
        }
        let name = Self.safeName(call.getString("filename"))
        #if targetEnvironment(macCatalyst)
        // On a Mac the share sheet offers no "Save to Files" or Finder, so a
        // download goes straight to ~/Downloads, as in a browser and the old
        // Electron app (the sandbox's downloads entitlement allows it).
        saveToDownloads(data, name: name, call: call)
        #else
        presentShareSheet(data, name: name, call: call)
        #endif
    }

    private func presentShareSheet(_ data: Data, name: String, call: CAPPluginCall) {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("downloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = folder.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: file, options: [.atomic, .completeFileProtection])
        } catch {
            try? FileManager.default.removeItem(at: folder)
            call.reject("The file could not be saved.", "write-failed")
            return
        }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                try? FileManager.default.removeItem(at: folder)
                call.reject("The file could not be saved.", "unavailable")
                return
            }
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, completed, _, error in
                try? FileManager.default.removeItem(at: folder)
                if error != nil {
                    call.reject("The file could not be saved.", "share-failed")
                } else {
                    call.resolve(["completed": completed])
                }
            }
            // An iPad shows the sheet as a popover, which needs an anchor.
            if let popover = sheet.popoverPresentationController, let view = presenter.view {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            presenter.present(sheet, animated: true)
        }
    }

    #if targetEnvironment(macCatalyst)
    /// Writes the file to ~/Downloads under a name not yet taken there
    /// ("report.pdf", then "report (2).pdf", as the Electron app did), never
    /// replacing a file.
    private func saveToDownloads(_ data: Data, name: String, call: CAPPluginCall) {
        guard let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            call.reject("The file could not be saved.", "unavailable")
            return
        }
        let file = Self.freeName(name, in: downloads) { FileManager.default.fileExists(atPath: $0.path) }
        do {
            try data.write(to: file, options: [.withoutOverwriting])
            call.resolve(["completed": true])
        } catch {
            call.reject("The file could not be saved.", "write-failed")
        }
    }
    #endif

    /// `name` in `folder`, or with " (2)", " (3)"… before its extension while `taken`.
    static func freeName(_ name: String, in folder: URL, taken: (URL) -> Bool) -> URL {
        let first = folder.appendingPathComponent(name)
        guard taken(first) else { return first }
        let ext = first.pathExtension
        let stem = first.deletingPathExtension().lastPathComponent
        for number in 2...999 {
            let candidate = folder.appendingPathComponent(ext.isEmpty ? "\(stem) (\(number))" : "\(stem) (\(number)).\(ext)")
            if !taken(candidate) { return candidate }
        }
        return folder.appendingPathComponent("\(stem) \(UUID().uuidString)\(ext.isEmpty ? "" : ".\(ext)")")
    }

    /// The file's name as the share sheet shows it: no folders, never empty.
    static func safeName(_ name: String?) -> String {
        let cleaned = (name ?? "")
            .components(separatedBy: CharacterSet(charactersIn: "/\\:\0"))
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmed = cleaned.hasPrefix(".") ? String(cleaned.drop(while: { $0 == "." })) : cleaned
        return trimmed.isEmpty ? "document" : String(trimmed.prefix(200))
    }
}
