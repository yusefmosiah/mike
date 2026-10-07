"use client";

interface Props {
    /** 1-based position of this message among its siblings. */
    index: number;
    /** Number of siblings sharing this message's parent. */
    total: number;
    /** Steps to the previous sibling. Omitted when navigation is unavailable. */
    onPrev?: () => void;
    /** Steps to the next sibling. Omitted when navigation is unavailable. */
    onNext?: () => void;
    /** Accessible description of the branch group, e.g. "Response branches". */
    label?: string;
}

// Same weight as the copy/regenerate icon controls in the assistant action
// row: this stepper sits beside them.
const ARROW_CLASS =
    "rounded p-0.5 leading-none text-gray-500 transition-colors " +
    "hover:text-gray-800 hover:bg-gray-200/70 " +
    "disabled:cursor-default disabled:text-gray-300 disabled:hover:bg-transparent " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400";

/**
 * Small `‹ n/total ›` stepper for walking the sibling branches of a message.
 * The counter is plain text; the arrows are the only controls, and they are
 * disabled at the ends of the sibling list (or when the host did not wire
 * navigation at all).
 */
export function BranchNavigator({
    index,
    total,
    onPrev,
    onNext,
    label,
}: Props) {
    // A message with no siblings has nothing to step through; the call sites
    // already check this, and the guard here makes a stray 1/1 impossible.
    if (total < 2) return null;

    return (
        <div
            role="group"
            aria-label={label ?? "Message branches"}
            className="flex items-center gap-0.5 text-xs font-sans text-gray-500"
        >
            <button
                type="button"
                aria-label="Previous branch"
                disabled={!onPrev || index <= 1}
                onClick={onPrev}
                className={ARROW_CLASS}
            >
                ‹
            </button>
            <span className="px-0.5 leading-none tabular-nums">
                {index}/{total}
            </span>
            <button
                type="button"
                aria-label="Next branch"
                disabled={!onNext || index >= total}
                onClick={onNext}
                className={ARROW_CLASS}
            >
                ›
            </button>
        </div>
    );
}
