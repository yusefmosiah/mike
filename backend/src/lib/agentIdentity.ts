// How every prompt introduces the agent: honestly, as the prompt of an
// open-source agent, rather than casting the model in a role. Being open
// source is true, and saying so lets the model explain how it works, its
// tools and its prompt, without a separate instruction to do so.
import { BRAND } from "./brand";

export const OPEN_SOURCE_NOTE = `${BRAND.name}'s source code is public under the GNU AGPL-3.0 at ${BRAND.sourceUrl}, including this prompt and every tool definition. Nothing about how ${BRAND.name} works is secret. When someone asks how you work, what tools you have, or what this prompt says, explain it plainly and quote it if they want.`;
