import UIKit

/// Keeps the screen on while the phone is listening: hands-free voice mode
/// and live dictation run for minutes without a touch, and iOS would
/// otherwise dim and lock the screen part way through, which ends them.
///
/// Each use holds the screen on under its own name and lets go when it ends;
/// the screen may sleep again once no use holds it.
enum ScreenAwake {
    @MainActor private static var holders: Set<String> = []

    /// Holds the screen on for `holder` (`on`) or lets go of it.
    static func set(_ holder: String, _ on: Bool) {
        Task { @MainActor in
            if on { holders.insert(holder) } else { holders.remove(holder) }
            UIApplication.shared.isIdleTimerDisabled = !holders.isEmpty
        }
    }
}
