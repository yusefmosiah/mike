# Computer use, overnight

Written Monday morning, October twenty-sixth. It covers about eight hours of computer-use work, from late Sunday evening until half past seven on Monday morning.

Chat can now drive a computer three ways: your own Mac, which you have already seen; a new desktop that belongs to the agent, which works end to end in a container; and, on paper, Windows and Linux, which share a common core that is built and tested.

## Where it stands

The Mac helper works. You configured it this morning and it wrote a haiku. Its one mistake was typing into an existing TextEdit document, and the instructions now tell the model to start a new document first.

Since you left the house, I built two more layers. The first is a common core for every non-Mac helper, written in Rust. The second is the agent's own desktop. It is a container with a virtual screen, a browser and a text editor, connected to chat the same way your Mac is. A test drives it from start to finish: it opens the editor, types two lines of a haiku, and reads them back. That test passed on my machine and now runs in continuous integration, or CI.

You have two things to do when you are back at a keyboard. Rebuild the Mac helper and choose Restart, so it reports its platform and the new shared role names. And when you want it, I can give the agent's desktop a home on the server.

## Sunday night: research and the Mac prototype

Late Sunday I researched computer use and wrote a first design. Then I built the Mac prototype, a small menu-bar helper that takes commands from chat and answers with what is on screen. Devin and I agreed on that design before I wrote it.

It reads the screen two ways. It lists the elements the accessibility system can see, such as buttons, fields and menus, each with a short reference like e-three. And it takes a screenshot with those references drawn on it. The model can click a reference instead of guessing at coordinates. That turned out to matter: references survive small layout changes, and the Mac run this morning used them.

I also chased down why the browser test suite had been failing. The cause was small. An empty setting for the durable chat schema meant "no schema" instead of "the default schema". I fixed that, and the suite runs again.

## Early Monday: Windows, Linux and a plan

You asked for research on Windows and Linux. I wrote it up as a plan with steps. Each platform has its own pieces. On Windows that means UI Automation, which plays the part the Mac's accessibility system plays, plus its own input and capture calls. On Linux it means AT-SPI, which is Linux's accessibility service, plus X11 or Wayland for input and screenshots. The plan also proposed something new: a desktop the agent owns, so it can work without touching anyone's real computer.

## Morning: the Mac app, then the shared protocol

When you sat down, the Mac app would not compile. Its native packages had to be fetched again, and Xcode needed its package cache reset. That fixed it.

Then I did step zero, the shared protocol. Every helper now tells the server three things: its platform, its capabilities, and its version. The capabilities answer three questions. Can it click at screen coordinates, or only on listed elements? Can it notice when a person grabs the mouse? And does the operating system itself protect password fields? Element roles now come from one shared list, so a button is a button on every platform, and each element also carries the platform's own name for its role. The server uses this. When more than one computer is connected, the model can name the one it wants, and a helper that only works with references refuses clicks at raw coordinates. Settings shows each computer's platform on its own line.

A lesson from this step: the Swift helper and the Rust helpers now read the same sample messages from one shared folder. If the two ever disagree about the protocol, a test fails on one side instead of a user finding out.

## Morning: the Rust core

Step one was the common core. It holds everything a helper decides that is not specific to one platform. That includes the message types, the safety policy, key combinations, mapping between screen and screenshot, stale-screen refusal, and the screenshot pipeline with its reference badges. A second crate talks to the server. It handles long-polling for commands, posting results, sending a heartbeat every fifteen seconds, and the one-time sign-in through the staging password gate. CI builds and tests it on Linux and Windows, and both were green.

One choice is worth knowing. In a key combination, "command" means the platform's main shortcut key, so a model that writes command-S saves on every system.

## After you left: the agent's own desktop

Step two is the one I finished just now. I wrote an X11 backend for Linux. It reads the element tree from AT-SPI, presses buttons through each element's own action, and types any character, including ones the keyboard layout lacks, by borrowing a spare key for a moment. It never reads a password field. I also moved the per-action loop into the shared client, so Windows will get interruptions, wait limits and stop-at-first-failure without repeating that code.

The container runs a virtual screen, a simple window manager, Firefox and Mousepad, which is a small text editor. It also offers a view-only browser window onto the screen, so you can watch the agent work.

The first full run passed. The screenshot shows a new Mousepad window with "An old silent pond, a frog jumps into the pond" typed into it, and the element list read the same text back. Two things cost me time, and both were my own mistakes rather than design problems. A stray command sat waiting for input and blocked my first image build for half an hour. And I could not check the Linux code from the Mac without a cross compiler, so I moved that checking into a Rust container, which was faster anyway.

Two smaller things to know. The reference badges on screenshots are drawn in a tiny built-in font, and at this size they are hard to read. I want to make them larger. And the view-only screen viewer has no password, so it must stay on localhost or behind a login until the server-side piece exists.

## What to remember

The agent can now work on a computer of its own, end to end and tested in CI, through the same protocol your Mac uses.

If I were holding the phone, I would do the next step in this order. First, rebuild and restart the Mac helper. Second, give the agent's desktop a home on the server: start a container per user on demand, hand it a device token the server mints, and show its screen inside the app. That piece touches the production machines, so I want your go-ahead before I start it. After that comes the Windows spike.

## Names and receipts

Commits on main, in order: 16dd145c (Mac helper), bde73431 (empty durable schema fix), 3d20ba71 (Windows and Linux report), 71d77908 (step zero, platforms and capabilities), 2591ba95 (step one, Rust core and client), 26ec06e5 (step two, X11 backend and sandbox image).

Reports: docs/reports/computer-use-2026-10-25.md, docs/reports/computer-use-prototype-2026-10-26.md, docs/reports/computer-use-windows-linux-2026-10-26.md.

Code: computer-helper (Swift, macOS), computer-helper-rs/crates/core, computer-helper-rs/crates/client, computer-helper-rs/crates/x11, computer-helper-rs/sandbox (Dockerfile, entrypoint.sh, smoke.py, README.md).

Protocol fixtures: packages/contracts/fixtures/computers. Migration: backend/migrations/20261026_02_computer_device_platform.sql.

CI: .github/workflows/computer-helpers.yml, with the Rust jobs on Linux and Windows and the new "Sandbox desktop" job. Rebuild the Mac helper with computer-helper/scripts/build.sh.
