// Copied into the generated iOS project by scripts/configure-ios.mjs and run by
// scripts/ui-test-ios.sh (README.md, "UI test"). Taps the chat composer, waits
// for the software keyboard, closes it the two ways the app offers (there is
// no Done bar): a tap on the page at the top, a drag down at the end of a long
// page. Attaches a screenshot of each state. The page is whatever the built app's
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

        if scrollToEnd {
            // Drag the page down: the keyboard follows the finger away.
            web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
                .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        } else {
            // Tap an empty stretch of the page, clear of the header buttons.
            web.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.32)).tap()
        }
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard)
        let dismissed = XCTWaiter().wait(for: [gone], timeout: 5) == .completed
        sleep(2)
        attach("\(tag)-2-keyboard-" + (dismissed ? "dismissed" : "still-up"))
        XCTAssertTrue(dismissed, scrollToEnd ? "keyboard still up after dragging the page down" : "keyboard still up after tapping the page")

        // The composer brings the keyboard back, however it was closed.
        if field.exists {
            field.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.88)).tap()
        }
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "keyboard did not come back when the composer was tapped again")
        sleep(1)
        attach("\(tag)-3-keyboard-again")
    }
}
