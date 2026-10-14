/**
 * Answering the replay's ask_inputs pauses with what the owner originally
 * answered. The replay's questions will not match the original's word for
 * word, so answers are mapped by position (k-th pause of the turn, i-th item
 * of the pause) and kept only where they still fit the new item; everything
 * else is skipped, which is what a user closing the prompt would send.
 */
import type {
    AskInputItem,
    AskInputResponseItem,
    AssistantEvent,
    OriginalAsk,
} from "./types.mts";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function skipped(item: AskInputItem): AskInputResponseItem {
    switch (item.kind) {
        case "choice":
        case "multi_choice":
        case "text":
            return { id: item.id, kind: item.kind, question: item.question, skipped: true };
        case "documents":
            return { id: item.id, kind: "documents", filenames: [], skipped: true };
        case "secret":
            return { id: item.id, kind: "secret", skipped: true };
        case "approval":
            // An approval cannot be skipped; refusing is the safe default.
            return { id: item.id, kind: "approval", decision: "reject" };
    }
}

/** One item's answer, carried over from `original` when it still fits `item`. */
export function mapItem(
    item: AskInputItem,
    original: AskInputResponseItem | undefined,
    documentFilenames: ReadonlySet<string> = new Set(),
): AskInputResponseItem {
    if (!original || original.kind !== item.kind) return skipped(item);
    if ("skipped" in original && original.skipped) return skipped(item);
    switch (item.kind) {
        case "choice": {
            const answer = original.kind === "choice" ? original.answer : undefined;
            if (!answer) return skipped(item);
            const option = item.options.find((o) => same(o.value, answer));
            if (option) return { id: item.id, kind: "choice", question: item.question, answer: option.value };
            return item.allow_other
                ? { id: item.id, kind: "choice", question: item.question, answer }
                : skipped(item);
        }
        case "multi_choice": {
            const answers = original.kind === "multi_choice" ? (original.answers ?? []) : [];
            const kept = answers.flatMap((a) => {
                const option = item.options.find((o) => same(o.value, a));
                return option ? [option.value] : item.allow_other ? [a] : [];
            });
            return kept.length > 0
                ? { id: item.id, kind: "multi_choice", question: item.question, answers: kept }
                : skipped(item);
        }
        case "text": {
            const answer = original.kind === "text" ? original.answer : undefined;
            return answer
                ? { id: item.id, kind: "text", question: item.question, answer }
                : skipped(item);
        }
        case "documents": {
            const filenames = original.kind === "documents" ? original.filenames : [];
            // Only documents the simulation account was seeded with can be attached.
            return filenames.length > 0 && filenames.every((f) => documentFilenames.has(f))
                ? { id: item.id, kind: "documents", filenames }
                : skipped(item);
        }
        case "approval":
            return original.kind === "approval"
                ? { id: item.id, kind: "approval", decision: original.decision }
                : skipped(item);
        case "secret":
            // The simulation account has no vault secrets to name.
            return skipped(item);
    }
}

/**
 * The response to one replay pause: the original pause at the same position
 * in the turn, item by item; all skipped when there was none or it was never
 * answered.
 */
export function mapAskResponse(
    items: readonly AskInputItem[],
    original: OriginalAsk | undefined,
    documentFilenames?: ReadonlySet<string>,
): { mappedFrom: "original" | "skipped"; responses: AskInputResponseItem[] } {
    if (!original?.responses) {
        return { mappedFrom: "skipped", responses: items.map((item) => mapItem(item, undefined)) };
    }
    const responses = items.map((item, i) => mapItem(item, original.responses![i], documentFilenames));
    return { mappedFrom: "original", responses };
}

/**
 * The user-message text the web app sends with an ask_inputs response
 * (AskInputPopup's buildContent), so the replay's history matches the app's.
 */
export function askResponseContent(
    items: readonly AskInputItem[],
    responses: readonly AskInputResponseItem[],
): string {
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const lines = responses.map((item, index) => {
        if (item.kind === "secret") {
            const asked = itemsById.get(item.id);
            const requested = asked?.kind === "secret" ? asked.name : "credential";
            return item.skipped || !item.secret_name
                ? `${index + 1}. Did not store the credential "${requested}".`
                : `${index + 1}. Stored the credential in the vault as "${item.secret_name}".`;
        }
        if (item.kind === "approval") {
            const asked = itemsById.get(item.id);
            const action = asked?.kind === "approval" ? `${asked.title} (${asked.connector_name})` : "Connector action";
            return `${index + 1}. ${item.decision === "approve" ? "Approved" : "Rejected"}: ${action}`;
        }
        if (item.kind === "multi_choice") {
            if (item.skipped) return `${index + 1}. Skipped: ${item.question}`;
            return `${index + 1}. ${item.question}\n${item.answers?.join(", ") ?? ""}`;
        }
        if (item.kind !== "documents") {
            if (item.skipped) return `${index + 1}. Skipped: ${item.question}`;
            return `${index + 1}. ${item.question}\n${item.answer ?? ""}`;
        }
        if (item.skipped) return `${index + 1}. Skipped document request.`;
        return `${index + 1}. Documents attached: ${item.filenames.join(", ")}`;
    });
    const onlyApprovals = responses.every((item) => item.kind === "approval");
    return `${onlyApprovals ? "Decisions on the requested actions" : "Responses to your questions"}:\n${lines.join("\n\n")}`;
}

/** The last ask_inputs in `parts` that no ask_inputs_response answers yet. */
export function pendingAsk(
    parts: readonly AssistantEvent[],
): Extract<AssistantEvent, { type: "ask_inputs" }> | null {
    const answered = new Set(
        parts.flatMap((p) => (p.type === "ask_inputs_response" ? [p.ask_event_id] : [])),
    );
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i]!;
        if (part.type === "ask_inputs") return answered.has(part.event_id) ? null : part;
    }
    return null;
}
