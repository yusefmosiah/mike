import AppKit
import ApplicationServices
import ComputerHelperCore

@main
@MainActor
enum Main {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    enum Status: Equatable {
        case notConfigured, connecting, connected, paused, acting, error(String)

        var text: String {
            switch self {
            case .notConfigured: return "Not configured"
            case .connecting: return "Connecting…"
            case .connected: return "Connected"
            case .paused: return "Paused"
            case .acting: return "Acting…"
            case .error(let s): return s
            }
        }
    }

    private var statusItem: NSStatusItem!
    private var status: Status = .connecting { didSet { refreshIcon() } }
    private var paused = false
    private var config: HelperConfig?
    private var configError: String?
    private var executor: Executor?
    private var pollTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?

    /// "Mike Computer" style name, from the bundle (set at build time from packages/brand).
    static var displayName: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Computer helper"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        refreshIcon()
        _ = TakeoverMonitor.shared.start()
        start()
    }

    // MARK: Lifecycle

    private func start() {
        switch ConfigStore.load() {
        case .success(let c):
            config = c
            configError = nil
        case .failure(let e):
            config = nil
            configError = "config.json: \(e.localizedDescription)"
        }
        guard let config, config.isConfigured else {
            status = configError.map { .error($0) } ?? .notConfigured
            return
        }
        let executor = Executor(config: config)
        self.executor = executor
        let transport = Transport(config: config)
        status = paused ? .paused : .connecting
        pollTask = Task { [weak self] in await self?.pollLoop(transport, executor) }
        heartbeatTask = Task { [weak self] in await self?.heartbeatLoop(transport) }
    }

    private func stop() {
        pollTask?.cancel()
        heartbeatTask?.cancel()
        pollTask = nil
        heartbeatTask = nil
        executor?.stopRequested = true
    }

    private func pollLoop(_ transport: Transport, _ executor: Executor) async {
        var backoff = 1.0
        while !Task.isCancelled {
            if paused {
                try? await Task.sleep(for: .seconds(1))
                continue
            }
            do {
                guard let command = try await transport.next() else {
                    if status != .acting { status = .connected }
                    backoff = 1
                    continue
                }
                status = .acting
                let result = await handle(command, executor)
                try await transport.post(result: result, for: command.id)
                status = .connected
                backoff = 1
            } catch is CancellationError {
                return
            } catch let error as TransportError {
                status = .error(error.description)
                // A rejected token or gate won't fix itself quickly; check again slowly.
                let wait: Double
                switch error {
                case .tokenRejected, .gateLocked, .gatePasswordWrong: wait = 60
                default: wait = backoff
                }
                try? await Task.sleep(for: .seconds(wait))
                backoff = min(backoff * 2, 30)
            } catch {
                if Task.isCancelled { return }
                status = .error("Offline: \(error.localizedDescription)")
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 30)
            }
        }
    }

    /// Keeps the computer listed as online even during a long batch. Silent while paused, so a
    /// paused computer goes offline and chat stops offering it.
    private func heartbeatLoop(_ transport: Transport) async {
        while !Task.isCancelled {
            if !paused { try? await transport.heartbeat() }
            try? await Task.sleep(for: .seconds(15))
        }
    }

    private func handle(_ command: ComputerCommand, _ executor: Executor) async -> ComputerCommandResult {
        switch command {
        case .observe(let observe):
            let (observation, frame) = await Observer.observe(observe)
            executor.remember(frame)
            return .observation(observation)
        case .act(let act):
            return .act(await executor.run(act))
        }
    }

    // MARK: Menu

    private func refreshIcon() {
        guard let button = statusItem?.button else { return }
        let symbol: String
        switch status {
        case .acting: symbol = "cursorarrow.motionlines"
        case .connected: symbol = "cursorarrow.rays"
        case .paused: symbol = "pause.circle"
        default: symbol = "cursorarrow.slash"
        }
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "\(Self.displayName): \(status.text)")
        button.toolTip = "\(Self.displayName): \(status.text)"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(disabled("\(Self.displayName): \(status.text)"))
        if let configError { menu.addItem(disabled(configError)) }
        menu.addItem(.separator())

        let ax = AXIsProcessTrusted()
        menu.addItem(
            item(
                ax ? "Accessibility: granted" : "Accessibility: not granted — open settings…",
                ax ? nil : #selector(openAccessibility)))
        let screen = CGPreflightScreenCaptureAccess()
        menu.addItem(
            item(
                screen ? "Screen Recording: granted" : "Screen Recording: not granted — open settings…",
                screen ? nil : #selector(openScreenRecording)))
        menu.addItem(.separator())

        menu.addItem(item(paused ? "Resume" : "Pause", #selector(togglePause)))
        menu.addItem(item("Stop now", status == .acting ? #selector(stopNow) : nil))
        menu.addItem(.separator())
        menu.addItem(item("Open config", #selector(openConfig)))
        menu.addItem(item("Restart", #selector(restart)))
        menu.addItem(item("Quit", #selector(quit)))
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }

    private func item(_ title: String, _ action: Selector?) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
        i.target = self
        i.isEnabled = action != nil
        return i
    }

    @objc private func openAccessibility() {
        // Shows the system prompt, which adds the helper to the list for the person to switch on.
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    @objc private func openScreenRecording() {
        _ = CGRequestScreenCaptureAccess()
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    private func open(_ url: String) {
        if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    }

    @objc private func togglePause() {
        paused.toggle()
        if paused {
            executor?.stopRequested = true
            status = .paused
        } else {
            status = .connecting
        }
    }

    @objc private func stopNow() {
        executor?.stopRequested = true
    }

    @objc private func openConfig() {
        if !FileManager.default.fileExists(atPath: ConfigStore.file.path) { try? ConfigStore.writeTemplate() }
        NSWorkspace.shared.open(
            [ConfigStore.file], withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"),
            configuration: NSWorkspace.OpenConfiguration())
    }

    /// Relaunches, so new permission grants and config take effect.
    @objc private func restart() {
        stop()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Wait for this process to exit, then open a fresh copy.
        task.arguments = ["-c", "sleep 0.5; /usr/bin/open -n \"$0\"", Bundle.main.bundlePath]
        try? task.run()
        NSApp.terminate(nil)
    }

    @objc private func quit() {
        stop()
        NSApp.terminate(nil)
    }
}
