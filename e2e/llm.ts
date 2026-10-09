/**
 * Helpers for specs that require a live LLM turn.
 *
 * Four specs (chat rename, chat delete, project-assistant create+submit, and
 * the critical-path "ask a question" flow) create/populate a chat by sending a
 * message, which needs a live model: locally, the Anthropic model enabled by
 * ANTHROPIC_API_KEY. Without a key they cannot submit a message and would
 * otherwise hang until their timeout.
 *
 * The auto title-generation call (POST /chat/:id/generate-title) is NOT why
 * the gate exists: keyless it just returns 500, and the specs already treat it
 * as best-effort (`.catch(() => null)`).
 *
 * GitHub Actions never receives a model key (.github/workflows/e2e.yml passes
 * none), so these specs always skip there and every other spec still runs.
 * Locally, with ANTHROPIC_API_KEY set, they run and are enforced: see
 * docs/e2e-ci.md, "LLM specs run locally".
 *
 * When the key IS set, the specs' selectClaudeModel helper picks "Claude
 * Sonnet 4.6" in the ModelToggle (see docs/e2e-ci.md, "Model selection"), so
 * the unskipped specs submit against a model this repository actually ships.
 */
export const hasLlmKey = Boolean(process.env.ANTHROPIC_API_KEY);

export const LLM_SKIP_REASON =
    "requires a model key — LLM-dependent specs run locally with ANTHROPIC_API_KEY set";
