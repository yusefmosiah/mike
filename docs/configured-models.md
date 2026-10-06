# Declaring OpenAI-compatible models

Mike ships with a static catalog of hosted models (Anthropic, Google, OpenAI)
and accepts router-prefixed ids for OpenRouter, the Vercel AI Gateway and
OpenCode Go. A deployment that also runs a self-hosted or third-party
OpenAI-compatible endpoint declares it with `MIKE_MODEL_CONFIG_JSON`, without
a code change.

## Configuration

Set `MIKE_MODEL_CONFIG_JSON` on the backend to a JSON object with a `models`
array:

```json
{
  "models": [
    {
      "id": "local-qwen",
      "label": "Local Qwen 3",
      "provider": "openai-compatible",
      "location": "local",
      "apiModel": "qwen3-32b",
      "baseUrl": "http://localhost:8000/v1"
    },
    {
      "id": "cloud-deepseek",
      "label": "DeepSeek",
      "provider": "openai-compatible",
      "location": "cloud",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The id Mike uses everywhere: model pickers, stored preferences, committee members. |
| `provider` | yes | Must be `openai-compatible`. Hosted providers are already covered by the static catalog and the router prefixes. |
| `location` | yes | `local` or `cloud`. Also the default for tool-call tolerance (below). |
| `label` | no | Display name. Defaults to the id. |
| `apiModel` | no | Model name to send upstream, when it differs from `id`. |
| `baseUrl` | yes | The endpoint's OpenAI-compatible base URL. |
| `apiKey` | no | Literal key. Prefer `apiKeyEnv`. |
| `apiKeyEnv` | no | Environment variable holding the key. |
| `apiKeyProvider` | no | Use the requesting user's saved key for that provider. |
| `tolerateTextToolCalls` | no | Override the tolerance default. |
| `maxTokensField` | no | Output-token request field: `max_tokens` (default) or `max_completion_tokens`. |

An entry that declares no key at all is treated as needing none, regardless of
whether its location is `local` or `cloud`. When a key source is declared but
does not resolve, the model is omitted from the authenticated model catalog
until that key becomes available.

`baseUrl` must be an absolute HTTP or HTTPS URL without embedded credentials,
a query string, or a fragment. Optional string and boolean fields are also
type-checked. Malformed entries are dropped; invalid JSON fails loudly when
the registry is first loaded.

A normal web URL is accepted syntactically, but it only works if that address
serves an OpenAI-compatible API. For example, a base URL ending in `/v1` must
accept the usual chat-completions requests; the public homepage of a model
provider is not enough.

Usable declarations are returned by `GET /models/configured` and appear in the
chat, tabular-review, and model-preference selectors. The response contains
only display metadata; endpoint URLs and credentials remain server-side.

Declared models are served through the same AI SDK provider layer as
everything else, so they inherit its transport, retries and streaming.

The compatible provider sends the output limit as `max_tokens` by default,
which works with most compatible servers. Some newer OpenAI models reject that
field and require `max_completion_tokens`; opt into that request shape for the
configured model:

```json
{
  "id": "custom-openai",
  "provider": "openai-compatible",
  "location": "cloud",
  "apiModel": "gpt-5.4-mini",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "maxTokensField": "max_completion_tokens"
}
```

## Tool-call tolerance

Self-hosted builds of Qwen, DeepSeek and GLM often describe tool calls in
prose rather than emitting them as structured tool calls, and wrap their
reasoning in `<think>` tags. Models whose `location` is `local` are therefore
wrapped in a middleware that:

- routes `<think>` prose to the reasoning channel instead of visible text,
- suppresses tool markup in the visible text, and
- converts described tool calls — JSON in `<tool_call>` markers, XML-ish
  `<function=name>` blocks, DeepSeek DSML invocations, and single-key maps —
  into real tool calls, repairing malformed JSON where it can.

A tolerant model answering a request that declares tools is served through the
endpoint's non-streaming path, because these models interleave markup with
prose in a way a partial stream cannot be reassembled from.

Set `tolerateTextToolCalls` explicitly to turn this on for a cloud endpoint
that needs it, or off for a local one that behaves properly.

Set `DEBUG_LLM_TOOL_CALLS=1` to log the raw text of a tool call that could not
be recovered.

---

## OpenCode Go Model Limits & Synchronization (Models.dev)

OpenCode Go model specifications, context windows, and maximum output token limits are tracked canonically from [Models.dev](https://models.dev/providers/opencode-go/).

Mike dynamically assigns each model its full native output token budget rather than applying a blanket ceiling:

| Model Family | Canonical Model IDs | Max Output Tokens | Context Window |
| --- | --- | --- | --- |
| **DeepSeek** | `deepseek-v4.1-flash`, `deepseek-v4-flash`, `deepseek-v4-pro` | **384,000** | 1,000,000 |
| **xAI Grok** | `grok-4.5`, `grok-4.6`, `grok-4.7` | **500,000** | 500,000 |
| **Space Bunny** | `space-bunny`, `space-bunny-free` | **524,288** | 1,048,576 |
| **Moonshot Kimi** | `kimi-k2.7-code`, `kimi-k3` | **262,144** / **131,072** | 262,144 / 1,048,576 |
| **Zhipu AI GLM** | `glm-5.2`, `glm-5.3`, `glm-5.3-flash` | **131,072** | 1,000,000 |
| **Alibaba Qwen** | `qwen3.8-max`, `qwen3.8-flash` | **131,072** | 1,000,000 |
| **Xiaomi MiMo** | `mimo-v2.6-flash`, `mimo-v2.6-pro` | **131,072** | 1,048,576 |
| **MiniMax** | `minimax-m2.7`, `minimax-m3` | **131,072** | 1,000,000 |

### Synchronizing New Models from Models.dev

When OpenCode releases new models or updates token ceilings:

1. **Query the live Models.dev catalog**:
   ```bash
   curl -s "https://models.dev/api.json" | jq '.["opencode-go"].models | map_values({output: .limit.output, context: .limit.context})'
   ```
2. **Update `backend/src/lib/llm/models.ts`**:
   +- Add the new model ID to `OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS` (or `OPENCODE_GO_MESSAGES_MODEL_IDS` if served over Anthropic protocol).
   +- Add its exact output limit to `OPENCODE_GO_MODEL_OUTPUT_LIMITS`.
3. **Operator Override**:
   +- Set `LLM_MAX_OUTPUT_TOKENS` in `backend/.env` or Docker Compose to enforce a global backstop across all providers if desired.
