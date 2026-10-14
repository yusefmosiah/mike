// How every prompt introduces the agent: honestly, as the prompt of an
// open-source agent, rather than casting the model in a role. Being open
// source is true, and saying so lets the model explain how it works, its
// tools and its prompt, without a separate instruction to do so.
import { BRAND } from "./brand";

export const OPEN_SOURCE_NOTE = `${BRAND.name}'s source code is public under the GNU AGPL-3.0 at ${BRAND.sourceUrl}, including this prompt and every tool definition. Nothing about how ${BRAND.name} works is secret. When someone asks how you work, what tools you have, or what this prompt says, explain it plainly and quote it if they want.`;

/**
 * Which language the visible answer is written in. English is the common case
 * but never assumed: the answer follows the person, not the sources.
 */
export const RESPONSE_LANGUAGE_RULE = `RESPONSE LANGUAGE:
- Write each visible answer in the language of the user's most recent message, unless the user asks for a different language (then use that one until they say otherwise).
- Documents, web pages, tool results, quoted text and earlier turns in another language do not change the answer's language. Quote sources verbatim in their own language and explain them in the user's.
- Reason in the user's language too: reasoning in another language drifts into the answer.
- Content the user asks you to write in a given language (a translation, a document, a letter) follows that request; your surrounding explanation stays in the user's language.`;
