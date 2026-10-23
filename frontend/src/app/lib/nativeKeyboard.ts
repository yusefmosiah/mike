/**
 * The keyboard in the iPhone app.
 *
 * WebKit is not told about the keyboard there: the app resizes the web view
 * itself, ending it 24pt below the keyboard's top edge so the keyboard slides
 * over the composer's empty bottom band (mobile/scripts/configure-ios.mjs,
 * MIKE_KEYBOARD_OVERLAP). The app also sends a `mikekeyboard` event when the
 * keyboard starts to move (MIKE_KEYBOARD_EVENTS). With it the page
 *
 * - marks the document root `data-keyboard="open"` and sets
 *   `--keyboard-overlap` and `--keyboard-duration`, so the composer can be
 *   shaded under the keyboard's edge and its controls rise clear of it in
 *   the keyboard's time (globals.css); and
 * - moves the chat composer with the keyboard. The web view takes its new
 *   size at once, which would make the composer jump while the keyboard
 *   slides; instead the composer starts where it was and glides into place
 *   in the keyboard's time.
 *
 * Elsewhere (Safari, the desktop app) no event arrives and nothing changes.
 */

export type NativeKeyboardDetail = { open: boolean; overlap: number; duration: number };

/** The chat's layers fixed to the bottom of the page, which move with the composer. */
export const KEYBOARD_FOLLOWERS =
    '[data-slot="chat-composer-dock"], [data-slot="chat-composer-fade"], [data-slot="chat-scroll-button"]';

/** Close to the curve the keyboard itself moves on. */
export const KEYBOARD_EASING = "cubic-bezier(0.2, 0.9, 0.25, 1)";

/** How long after a keyboard event a resize still belongs to it, and the other way round. */
const PAIRING_MS = 400;

type Move = { at: number; distance: number };
type Keyboard = { at: number; duration: number };

/** Puts each element back by `distance` pixels, then lets it glide to where it is now. */
export function glide(elements: Iterable<HTMLElement>, distance: number, duration: number): void {
    for (const element of elements) {
        element.style.transition = "none";
        element.style.transform = `translateY(${distance}px)`;
        // Commit the starting point before the transition starts.
        void element.getBoundingClientRect();
        element.style.transition = `transform ${duration}ms ${KEYBOARD_EASING}`;
        element.style.transform = "";
        const done = () => {
            element.style.transition = "";
        };
        element.addEventListener("transitionend", done, { once: true });
        window.setTimeout(done, duration + 50);
    }
}

export function watchNativeKeyboard(): () => void {
    const root = document.documentElement;
    let height = window.innerHeight;
    let keyboard: Keyboard | null = null;
    let move: Move | null = null;

    // The keyboard event and the resize can arrive in either order: animate
    // once both are in, for the time the keyboard has left.
    const animate = () => {
        if (!keyboard || !move) return;
        const now = performance.now();
        const remaining = keyboard.duration - (now - Math.min(keyboard.at, move.at));
        const distance = move.distance;
        keyboard = null;
        move = null;
        if (distance === 0 || remaining < 60) return;
        glide(document.querySelectorAll<HTMLElement>(KEYBOARD_FOLLOWERS), distance, remaining);
    };

    const onKeyboard = (event: Event) => {
        const detail = (event as CustomEvent<NativeKeyboardDetail>).detail;
        if (!detail) return;
        if (detail.open) root.dataset.keyboard = "open";
        else delete root.dataset.keyboard;
        root.style.setProperty("--keyboard-overlap", `${detail.open ? detail.overlap : 0}px`);
        root.style.setProperty("--keyboard-duration", `${detail.duration}ms`);
        const now = performance.now();
        keyboard = { at: now, duration: detail.duration };
        if (move && now - move.at > PAIRING_MS) move = null;
        animate();
    };

    const onResize = () => {
        const next = window.innerHeight;
        const distance = height - next;
        height = next;
        if (distance === 0) return;
        const now = performance.now();
        move = { at: now, distance };
        if (keyboard && now - keyboard.at > PAIRING_MS) keyboard = null;
        animate();
    };

    window.addEventListener("mikekeyboard", onKeyboard);
    window.addEventListener("resize", onResize);
    return () => {
        window.removeEventListener("mikekeyboard", onKeyboard);
        window.removeEventListener("resize", onResize);
        delete root.dataset.keyboard;
        root.style.removeProperty("--keyboard-overlap");
        root.style.removeProperty("--keyboard-duration");
    };
}
