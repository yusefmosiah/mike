/**
 * Which of the three sidebar layouts the window's width calls for:
 * - narrow (below 768 px, Tailwind's `md`): the sidebar is an overlay;
 * - medium (768 to 1023 px): a column that starts as the icon rail, since a
 *   full column leaves the chat too narrow on an iPad in portrait or in
 *   Split View, or on a folding phone's inner screen held sideways;
 * - wide (1024 px and up): a column that starts open.
 */
export type SidebarWidthClass = "narrow" | "medium" | "wide";

const MEDIUM_QUERY = "(min-width: 768px)";
const WIDE_QUERY = "(min-width: 1024px)";

const canMatch = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

/** No `window` (server render): wide. No `matchMedia` (jsdom): by `innerWidth`. */
export function sidebarWidthClass(): SidebarWidthClass {
  if (typeof window === "undefined") return "wide";
  const atLeast = (query: string, px: number) =>
    canMatch() ? window.matchMedia(query).matches : window.innerWidth >= px;
  if (atLeast(WIDE_QUERY, 1024)) return "wide";
  return atLeast(MEDIUM_QUERY, 768) ? "medium" : "narrow";
}

/**
 * Call `onChange` when the window crosses into another width class, and only
 * then: resizing within a class (dragging a Stage Manager window, adjusting
 * Split View) does not call it. Returns the unsubscribe function.
 */
export function watchSidebarWidthClass(
  onChange: (widthClass: SidebarWidthClass) => void,
): () => void {
  if (!canMatch()) return () => {};
  let current = sidebarWidthClass();
  const queries = [MEDIUM_QUERY, WIDE_QUERY].map((query) =>
    window.matchMedia(query),
  );
  const check = () => {
    const next = sidebarWidthClass();
    if (next === current) return;
    current = next;
    onChange(next);
  };
  for (const query of queries) query.addEventListener("change", check);
  return () => {
    for (const query of queries) query.removeEventListener("change", check);
  };
}
