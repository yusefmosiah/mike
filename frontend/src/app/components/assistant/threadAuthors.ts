import type { Message, ThreadAuthor } from "../shared/types";

/** What a reader calls a person on the thread: "You", a name, or an email. */
export function threadPersonLabel(
    person: ThreadAuthor,
    viewerId: string | null | undefined,
): string {
    if (viewerId && person.id === viewerId) return "You";
    return person.name ?? person.email ?? "Someone";
}

/**
 * Whether prompts should name their sender: once anyone but the reader has
 * written in the thread. A thread only the reader writes in stays unlabelled.
 */
export function threadHasOtherAuthors(
    messages: readonly Message[],
    viewerId: string | null | undefined,
): boolean {
    return messages.some(
        (message) => message.author && message.author.id !== viewerId,
    );
}

/** The sentence a reader sees while a colleague's turn is generating. */
export function generatingNotice(
    person: ThreadAuthor,
    viewerId: string | null | undefined,
): string {
    const who = threadPersonLabel(person, viewerId);
    return who === "You"
        ? "Your response is still being generated in another tab or window."
        : `${who} is generating a response. You can send once it finishes.`;
}
