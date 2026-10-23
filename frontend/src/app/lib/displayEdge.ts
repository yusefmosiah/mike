/**
 * Edge-to-edge layout in the iPhone app.
 *
 * The app's web view fills the whole screen, under the status bar and the
 * home indicator. When it does, the page marks the document root with
 * `data-display-edge` and sets `--display-corner-radius`, so the chat
 * composer can sit near the bottom of the screen with corners concentric
 * with the display's (globals.css). Safari and older app builds, whose web
 * view stops at the safe area, report no bottom inset and keep the ordinary
 * layout.
 */

/** Display corner radii in points, by portrait screen size in points. */
const CORNER_RADIUS_BY_SCREEN: Record<string, number> = {
    "375x812": 39, // X, XS, 11 Pro, 12 mini, 13 mini
    "414x896": 41.5, // XR, XS Max, 11, 11 Pro Max
    "390x844": 47.33, // 12, 12 Pro, 13, 13 Pro, 14, 16e
    "428x926": 53.33, // 12 Pro Max, 13 Pro Max, 14 Plus
    "393x852": 55, // 14 Pro, 15, 15 Pro, 16
    "430x932": 55, // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
    "402x874": 62, // 16 Pro, 17, 17 Pro
    "420x912": 62, // Air
    "440x956": 62, // 16 Pro Max, 17 Pro Max
};
const DEFAULT_CORNER_RADIUS = 55;

export function displayCornerRadius(width: number, height: number): number {
    const key = `${Math.min(width, height)}x${Math.max(width, height)}`;
    return CORNER_RADIUS_BY_SCREEN[key] ?? DEFAULT_CORNER_RADIUS;
}

// The composer's geometry, edge to edge (globals.css).
/** Its distance from the edges of the screen (--chat-composer-gap). */
const COMPOSER_GAP = 6;
/** The send button's distance from the composer's right and bottom edges while the keyboard is up. */
const CONTROLS_INSET = 23;
/** Half the round send button's width. */
const SEND_BUTTON_RADIUS = 16;
/** How close the send button comes to the composer's curved corner at rest. */
const CORNER_CLEARANCE = 12;

/**
 * How far the composer's controls drop at rest, below where they sit while
 * the keyboard is up (the keyboard covers the composer's bottom band, so
 * there they sit above it). At rest the send button moves down until it is
 * CORNER_CLEARANCE from the composer's bottom-right curve, which is
 * concentric with the display's corner.
 *
 * The curve's centre is `inner` from the composer's right and bottom edges,
 * less the button's radius. The button's centre stays `CONTROLS_INSET` in
 * from the right, and comes `inner - CORNER_CLEARANCE` from the curve's
 * centre.
 */
export function composerControlsDrop(cornerRadius: number): number {
    const inner = cornerRadius - COMPOSER_GAP - SEND_BUTTON_RADIUS;
    const across = Math.max(0, inner - CONTROLS_INSET);
    const reach = inner - CORNER_CLEARANCE;
    const below = Math.sqrt(Math.max(0, reach * reach - across * across));
    const bottomInset = Math.max(CORNER_CLEARANCE, inner - below);
    return Math.max(0, Math.round((CONTROLS_INSET - bottomInset) * 2) / 2);
}

type CapacitorGlobal = { getPlatform?: () => string };

function inIosApp(): boolean {
    const capacitor = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
    return capacitor?.getPlatform?.() === "ios";
}

const INSET_PROBE_STYLE =
    "position:fixed;left:0;bottom:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-bottom,0px)";

/** The bottom safe-area inset as laid out (0 when the page stops above it). */
function bottomInset(): number {
    const probe = document.createElement("div");
    probe.style.cssText = INSET_PROBE_STYLE;
    document.body.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
}

/**
 * Marks or unmarks the document root for edge-to-edge layout. Once marked,
 * the page stays marked: an app build cannot change while it runs, so a
 * later reading of 0 is not a reason to fall back to Safari's spacing.
 */
export function updateDisplayEdge(): void {
    const root = document.documentElement;
    const marked = root.dataset.displayEdge !== undefined;
    if (inIosApp() && (marked || bottomInset() > 0)) {
        const radius = displayCornerRadius(window.screen.width, window.screen.height);
        root.dataset.displayEdge = "";
        root.style.setProperty("--display-corner-radius", `${radius}px`);
        root.style.setProperty("--chat-controls-drop", `${composerControlsDrop(radius)}px`);
    } else {
        delete root.dataset.displayEdge;
        root.style.removeProperty("--display-corner-radius");
        root.style.removeProperty("--chat-controls-drop");
    }
}

/**
 * Keeps the mark current; returns a cleanup. The app's web view often
 * reports no inset when the page first runs and the real one a moment
 * later, with no resize event between (measured in the simulator), so a
 * probe sized to the inset is watched as well as the window.
 */
export function watchDisplayEdge(): () => void {
    updateDisplayEdge();
    window.addEventListener("resize", updateDisplayEdge);
    const probe = document.createElement("div");
    probe.style.cssText = INSET_PROBE_STYLE;
    probe.setAttribute("aria-hidden", "true");
    document.body.appendChild(probe);
    const observer =
        typeof ResizeObserver === "undefined"
            ? null
            : new ResizeObserver(() => updateDisplayEdge());
    observer?.observe(probe);
    return () => {
        window.removeEventListener("resize", updateDisplayEdge);
        observer?.disconnect();
        probe.remove();
    };
}
