import Foundation

/// What voice mode's models are doing for this phone, for the web app to show
/// (`voiceStatus` and the `preparation` event, docs/voice-chat-contract.md).
///
/// The first load of each model after an install, an app update or a system
/// update is slow: Core ML compiles and specialises it for the Neural Engine
/// or the GPU, and the system keeps the result for later launches. The app
/// does that work in the background as early as it can (after an install, and
/// at launch after an update) and says so, rather than leaving the first tap
/// to wait without a word.
///
/// Pure bookkeeping, no models: loaders report into it. Thread-safe.
final class VoicePreparation: @unchecked Sendable {
    static let shared = VoicePreparation()

    /// The state the web app reads.
    struct Snapshot: Equatable, Sendable {
        /// Models are loading or warming now (a prewarm, or a start's loads).
        var preparing: Bool
        /// This is the first preparation since an install or an update (or the
        /// loads were evidently cold): it takes tens of seconds, not a few.
        var firstTime: Bool
        /// Models that are loaded and warm, by `VoiceModelName` raw value.
        var ready: [String]

        var payload: [String: Any] {
            ["preparing": preparing, "firstTime": firstTime, "ready": ready]
        }
    }

    /// A model that took this long to load was compiled, not read from the
    /// system's cache (warm loads take well under a second to a few seconds).
    static let coldLoadMs = 10_000.0

    /// What identifies the installed build and system, whose change empties
    /// the system's Core ML caches: the app's version and build, and the OS.
    static func signature(
        bundle: Bundle = .main, system: String = ProcessInfo.processInfo.operatingSystemVersionString
    ) -> String {
        let info = bundle.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        return "\(version)+\(build)/\(system)"
    }

    /// Whether the models must be prepared again: nothing is recorded, or the
    /// build or the system is not the one they were prepared under.
    static func needsPreparation(stored: String?, current: String) -> Bool {
        stored != current
    }

    /// The models voice mode is prepared when all of these are ready.
    static func isComplete(ready: Set<String>, wantsSpeaker: Bool) -> Bool {
        var required: Set<String> = ["vad", "smart-turn", "eou", "fluid-mini", "phonon"]
        if wantsSpeaker { required.insert("speaker") }
        return required.isSubset(of: ready)
    }

    static let preparedKey = "mike.voice.preparedFor"

    private let lock = NSLock()
    private let defaults: UserDefaults
    private let current: String
    private var active = 0
    private var firstTime: Bool
    private var wantsSpeaker = true
    private var ready: Set<String> = []
    private var listeners: [UUID: @Sendable (Snapshot) -> Void] = [:]
    private var last: Snapshot

    init(defaults: UserDefaults = .standard, signature: String = VoicePreparation.signature()) {
        self.defaults = defaults
        current = signature
        let first = Self.needsPreparation(stored: defaults.string(forKey: Self.preparedKey), current: signature)
        firstTime = first
        last = Snapshot(preparing: false, firstTime: first, ready: [])
    }

    var snapshot: Snapshot {
        lock.lock()
        defer { lock.unlock() }
        return makeSnapshot()
    }

    /// Whether a prewarm should run at launch whatever the "used before" flag says.
    var needsFirstPreparation: Bool { snapshot.firstTime }

    /// One stretch of loading work, ended exactly once by `end()` (calling it
    /// again does nothing). While any is open the state is `preparing`.
    final class Activity: @unchecked Sendable {
        private let owner: VoicePreparation
        private let lock = NSLock()
        private var ended = false

        fileprivate init(_ owner: VoicePreparation) { self.owner = owner }

        func end() {
            lock.lock()
            let first = !ended
            ended = true
            lock.unlock()
            if first { owner.finish() }
        }

        deinit { end() }
    }

    func begin(wantsSpeaker: Bool) -> Activity {
        lock.lock()
        active += 1
        self.wantsSpeaker = wantsSpeaker
        lock.unlock()
        publish()
        return Activity(self)
    }

    private func finish() {
        lock.lock()
        active = max(0, active - 1)
        lock.unlock()
        publish()
    }

    /// A model is loaded and warm. The last one needed records the preparation
    /// as done for this build, so a later launch does not repeat it.
    func markReady(_ name: String) {
        lock.lock()
        ready.insert(name)
        let done = firstTime && Self.isComplete(ready: ready, wantsSpeaker: wantsSpeaker)
        if done {
            firstTime = false
            defaults.set(current, forKey: Self.preparedKey)
        }
        lock.unlock()
        publish()
    }

    /// A model was dropped (a memory warning, an idle unload, removal).
    func markUnloaded(_ names: [String]) {
        lock.lock()
        for name in names { ready.remove(name) }
        lock.unlock()
        publish()
    }

    /// A model took `ms` to load: a load that long was a compile, so the
    /// system's caches are cold whatever the build says, and the person is
    /// told it is the first time.
    func noteLoad(_ name: String, ms: Double) {
        guard ms >= Self.coldLoadMs else { return }
        lock.lock()
        let changed = !firstTime
        firstTime = true
        if changed { defaults.removeObject(forKey: Self.preparedKey) }
        lock.unlock()
        if changed { VoiceMode.log.notice("voice prepare: \(name, privacy: .public) took \(Int(ms), privacy: .public) ms, caches look cold") }
        publish()
    }

    /// Calls `listener` with each new snapshot, until the returned token is
    /// passed to `remove`.
    func observe(_ listener: @escaping @Sendable (Snapshot) -> Void) -> UUID {
        let token = UUID()
        lock.lock()
        listeners[token] = listener
        lock.unlock()
        return token
    }

    func remove(_ token: UUID) {
        lock.lock()
        listeners[token] = nil
        lock.unlock()
    }

    private func makeSnapshot() -> Snapshot {
        Snapshot(preparing: active > 0, firstTime: firstTime, ready: ready.sorted())
    }

    /// Tells the listeners if the state changed since they were last told.
    private func publish() {
        lock.lock()
        let next = makeSnapshot()
        let changed = next != last
        last = next
        let receivers = Array(listeners.values)
        lock.unlock()
        guard changed else { return }
        VoiceMode.log.notice("voice prepare: preparing \(next.preparing, privacy: .public), first time \(next.firstTime, privacy: .public), ready \(next.ready.joined(separator: ","), privacy: .public)")
        for receiver in receivers { receiver(next) }
    }
}
