import { useCallback, useState } from "react";

/** Disclosure behavior shared by web and Word reasoning blocks. */
export function useReasoningDisclosure() {
    // A thought starts closed: its line (the step summary, or a thinking
    // phrase while it streams) is what a reader follows, and the thinking
    // itself opens only when they ask for it. Each thought opens on its own;
    // opening one does not open the next. Opened, it shows all of its text.
    const [isContentOpen, setIsContentOpen] = useState(false);
    const toggleContent = useCallback(() => setIsContentOpen((open) => !open), []);
    return { isContentOpen, toggleContent };
}
