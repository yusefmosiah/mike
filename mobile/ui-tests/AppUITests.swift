// Copied into the generated iOS project by scripts/configure-ios.mjs and run by
// scripts/ui-test-ios.sh (README.md, "UI test"). Taps the chat composer, waits
// for the software keyboard, closes it with the Done button above the keyboard
// (as people do: tapping the page does not blur the field), and attaches a
// screenshot of each state. The page is whatever the built app's
// capacitor.config.json points at; the script rewrites that before the run.
import XCTest

final class AppUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testKeyboardAtTop() throws {
        try runKeyboardCycle(scrollToEnd: false)
    }

    // The composer once floated above the bottom after the keyboard closed at
    // the end of a long thread (lib/displayEdge.ts).
    func testKeyboardAtEndOfPage() throws {
        try runKeyboardCycle(scrollToEnd: true)
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func runKeyboardCycle(scrollToEnd: Bool) throws {
        let app = XCUIApplication()
        app.launch()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30), "web view did not appear")
        sleep(6) // let the page load and lay out

        let tag = scrollToEnd ? "end" : "top"
        if scrollToEnd {
            for _ in 0..<3 { web.swipeUp(velocity: .fast) }
            sleep(2)
        }
        attach("\(tag)-0-before")

        // A plain page's textarea is a text view; Mike's composer is not
        // exposed as one, so tap where it sits, at the bottom of the screen.
        let field = web.textViews.firstMatch
        if field.exists {
            field.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.88)).tap()
        }
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "software keyboard did not appear (hardware keyboard connected?)")
        sleep(1)
        attach("\(tag)-1-keyboard-up")

        // Tap Done by position: the bar's buttons are re-created while the
        // keyboard settles, so a held element reference can go stale.
        let done = app.buttons.matching(NSPredicate(format: "label == 'Done'")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5), "no Done button above the keyboard")
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: done.frame.midX, dy: done.frame.midY)).tap()
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard)
        let dismissed = XCTWaiter().wait(for: [gone], timeout: 5) == .completed
        sleep(2)
        attach("\(tag)-2-keyboard-" + (dismissed ? "dismissed" : "still-up"))
        XCTAssertTrue(dismissed, "keyboard still up after Done")
    }
}
