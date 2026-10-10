// What the pane says when the server refuses a turn. Kept free of imports so
// the web app's tests can check it without the Office runtime's types.

/**
 * The server's own text never reaches the transcript; a known refusal gets an
 * intentional message.
 */
export async function refusalMessage(res: Response): Promise<string> {
  let code: unknown = null;
  try {
    code = ((await res.json()) as { code?: unknown }).code;
  } catch {
    // Not JSON: fall through to the generic message.
  }
  if (res.status === 409 && code === "turn_in_progress") {
    // Word chats belong to one person, so the other turn is theirs.
    return "A response is still being generated for this chat in another window. Try again once it finishes.";
  }
  return `The chat request failed (${res.status}). Please try again.`;
}
