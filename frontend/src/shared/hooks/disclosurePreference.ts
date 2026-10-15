/**
 * How a kind of collapsible block opens: the reader's last choice, carried to
 * the next block of that kind. Expanding one keeps the next expanded;
 * collapsing one keeps the next collapsed. Someone checking the work keeps
 * code cells open; someone who only wants the answer keeps them shut.
 *
 * Kept per browser. Storage can be missing or refuse writes (a private
 * window, an Office webview with storage blocked), so the choice also lives
 * in memory for this page.
 */
export type DisclosureKind = "reasoning" | "code-cell";

/** Before any choice: thinking opens in full, code stays shut. */
const DEFAULT_OPEN: Record<DisclosureKind, boolean> = {
    reasoning: true,
    "code-cell": false,
};

const storageKey = (kind: DisclosureKind) => `mike.disclosure.${kind}`;

const remembered = new Map<DisclosureKind, boolean>();

export function disclosurePreference(kind: DisclosureKind): boolean {
    const known = remembered.get(kind);
    if (known !== undefined) return known;
    let open = DEFAULT_OPEN[kind];
    try {
        const stored = globalThis.localStorage?.getItem(storageKey(kind));
        if (stored === "1" || stored === "0") open = stored === "1";
    } catch {
        // No storage: the default.
    }
    remembered.set(kind, open);
    return open;
}

export function rememberDisclosure(kind: DisclosureKind, open: boolean): void {
    remembered.set(kind, open);
    try {
        globalThis.localStorage?.setItem(storageKey(kind), open ? "1" : "0");
    } catch {
        // Kept in memory for this page.
    }
}

/** Forget every choice held in memory and storage (tests). */
export function resetDisclosurePreferencesForTests(): void {
    for (const kind of Object.keys(DEFAULT_OPEN) as DisclosureKind[]) {
        try {
            globalThis.localStorage?.removeItem(storageKey(kind));
        } catch {
            // No storage in this environment.
        }
    }
    remembered.clear();
}
