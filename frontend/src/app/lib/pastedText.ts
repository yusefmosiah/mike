/**
 * A long paste is attached as a text document instead of going into the
 * message, as a dropped .txt file would be: the message keeps only what the
 * person typed, and the pasted text is stored once, read and cited like any
 * other document, and kept whole when a long chat is compacted.
 */
export const LONG_PASTE_CHARS = 4_000;

export function isLongPaste(text: string): boolean {
    return text.trim().length >= LONG_PASTE_CHARS;
}

/** The paste as a text file, named apart from the composer's other attachments. */
export function pastedTextFile(text: string, takenNames: Iterable<string>): File {
    const taken = new Set(takenNames);
    let name = "Pasted text.txt";
    for (let copy = 2; taken.has(name); copy += 1) name = `Pasted text ${copy}.txt`;
    return new File([text.trim()], name, { type: "text/plain" });
}
