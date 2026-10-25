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
| `group` | no | Heading the model is listed under in the pickers, normally the provider serving it (`"Phala (encrypted)"`, `"River"`). Defaults to `Configured`. At most 80 characters. |
| `apiModel` | no | Model name to send upstream, when it differs from `id`. |
| `baseUrl` | yes | The endpoint's OpenAI-compatible base URL. |
| `apiKey` | no | Literal key. Prefer `apiKeyEnv`. |
| `apiKeyEnv` | no | Environment variable holding the key. |
| `apiKeyProvider` | no | Use the requesting user's saved key for that provider. |
| `tolerateTextToolCalls` | no | Override the tolerance default. |
| `maxTokensField` | no | Output-token request field: `max_tokens` (default) or `max_completion_tokens`. |
| `contextWindow` | recommended | Total tokens (input and output) the model accepts, at least 1,024. Drives compaction and the output budget. Omitted, Mike assumes 128,000 and logs a warning at startup. |
| `maxOutputTokens` | recommended | Most output tokens one response may use; less than `contextWindow`. Omitted, 16,384 or half the window, whichever is smaller. |
| `reasoning` | for reasoning models | How the model reasons (below). Omitted, the model is treated as non-reasoning and sent no reasoning parameters. |
| `cost` | no | US dollars per million tokens: `{ "input", "output", "cacheRead", "cacheWrite" }`, each optional (default 0). Makes the model's spend visible in usage. |
| `streamIdleTimeoutMs` | no | Longest silence (5,000 to 1,800,000 ms) tolerated once a response is flowing. Defaults to `STREAM_CONFIGURED_CHUNK_TIMEOUT_MS` (180,000). |

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
chat, tabular-review, and model-preference selectors. The pickers group every
model by the provider serving it: the direct providers (Anthropic, Google,
OpenAI), each router (OpenCode Go, OpenRouter, Vercel AI Gateway) with all of
the models chosen for it, then each declared `group` in alphabetical order, then
`Configured` and `Local`. The response contains
only display metadata; endpoint URLs and credentials remain server-side.

Declared models are served through the same pi-ai provider layer as
everything else (`backend/src/lib/llm/pi/providers.mts`), so they inherit its
transport, retries, egress gate and streaming.

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

For example, River's hosted open models (https://docs.river.ai/guides/inference-models/),
listed under their own heading with their real limits and reasoning controls:

```json
{
  "models": [
    {
      "id": "river/deepseek-v4.1-flash-1017",
      "label": "DeepSeek V4.1 Flash 1017",
      "group": "River",
      "provider": "openai-compatible",
      "location": "cloud",
      "baseUrl": "https://api.river.ai/v1",
      "apiModel": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "apiKeyEnv": "RIVER_API_KEY",
      "supportsVision": true,
      "contextWindow": 1048576,
      "maxOutputTokens": 384000,
      "reasoning": {
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "default": "high",
        "canDisable": true,
        "offValue": "none"
      },
      "cost": {
        "input": 0.12,
        "cacheRead": 0.0024,
        "output": 0.48
      }
    },
    {
      "id": "river/nemotron-3.5-super",
      "label": "Nemotron 3.5 Super",
      "group": "River",
      "provider": "openai-compatible",
      "location": "cloud",
      "baseUrl": "https://api.river.ai/v1",
      "apiModel": "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
      "apiKeyEnv": "RIVER_API_KEY",
      "supportsVision": true,
      "contextWindow": 1048576,
      "maxOutputTokens": 131072,
      "reasoning": {
        "efforts": [
          "low",
          "high"
        ],
        "default": "high",
        "canDisable": true,
        "offValue": "none"
      },
      "cost": {
        "input": 0.07,
        "cacheRead": 0.024,
        "output": 0.37
      }
    },
    {
      "id": "river/glm-5.3-flash",
      "label": "GLM 5.3 Flash",
      "group": "River",
      "provider": "openai-compatible",
      "location": "cloud",
      "baseUrl": "https://api.river.ai/v1",
      "apiModel": "zai-org/GLM-5.3-Flash",
      "apiKeyEnv": "RIVER_API_KEY",
      "supportsVision": true,
      "contextWindow": 1048576,
      "maxOutputTokens": 131072,
      "reasoning": {
        "efforts": [
          "low",
          "high",
          "max"
        ],
        "default": "high",
        "canDisable": false
      },
      "cost": {
        "input": 0.12,
        "cacheRead": 0.024,
        "output": 0.4
      }
    }
  ]
}
```

Every River model above takes text and images, streams, reasons and calls
tools. Each accepts `reasoning_effort`, including `none` to turn reasoning
off; the efforts listed are the ones checked against River on 2026-10-21. The
prices come from River's published list
(https://console.river.ai/api/public/pricing), in US dollars per million
tokens. Check them there before relying on the spend shown.

Do not declare River's original `deepseek-ai/DeepSeek-V4.1-Flash` (the id
`river/deepseek-v4.1-flash`): it is retired here. Mike reads that id as
`river/deepseek-v4.1-flash-1017`, so chats and preferences saved with it
move to the 1017 release. A deployment that still declares the old id gets a
startup warning, and the old entry is left out of the pickers.

OpenGateway (https://opengateway.ai/models) serves "ultrafast" DeepSeek V4.1
Flash and GLM-5.3-Flash at `https://apis.opengateway.ai/v1`. It is a
third-party host with no attestation, so it suits experiments rather than
client work:

```json
{
  "models": [
    {
      "id": "opengateway/deepseek-v4.1-flash-ultrafast",
      "label": "DeepSeek V4.1 Flash Ultrafast",
      "group": "OpenGateway",
      "provider": "openai-compatible",
      "location": "cloud",
      "baseUrl": "https://apis.opengateway.ai/v1",
      "apiModel": "deepseek/deepseek-v4.1-flash-ultrafast",
      "apiKeyEnv": "OPENGATEWAY_API_KEY",
      "supportsVision": true,
      "contextWindow": 1000000,
      "maxOutputTokens": 384000,
      "reasoning": {
        "efforts": ["low", "high", "max"],
        "default": "high",
        "canDisable": true,
        "offValue": "none"
      },
      "cost": { "input": 0.3, "cacheRead": 0.006, "output": 1.2 }
    },
    {
      "id": "opengateway/glm-5.3-flash-ultrafast",
      "label": "GLM 5.3 Flash Ultrafast",
      "group": "OpenGateway",
      "provider": "openai-compatible",
      "location": "cloud",
      "baseUrl": "https://apis.opengateway.ai/v1",
      "apiModel": "z-ai/glm-5.3-flash-ultrafast",
      "apiKeyEnv": "OPENGATEWAY_API_KEY",
      "supportsVision": true,
      "contextWindow": 1000000,
      "maxOutputTokens": 131072,
      "reasoning": {
        "efforts": ["low", "high", "max"],
        "default": "high",
        "canDisable": true,
        "offValue": "none"
      },
      "cost": { "input": 0.15, "cacheRead": 0.03, "output": 0.5 }
    }
  ]
}
```

The ids, window and list prices come from `GET /v1/models` on 2026-10-25;
the costs above are list prices, before OpenGateway's time-limited
discounts (90% and 50% for DeepSeek, 70% and 30% for GLM, which the same
endpoint reports with an expiry). The API accepts `reasoning_effort` `low`,
`medium`, `high`, `max` and `none`. With `none`, both models answered with
no reasoning text in a quick test from one connection: 1.2 to 4.3 s to the
first token and 50 to 230 tokens a second for about 300 tokens. Its catalog
also lists decision and embedding models, which are not chat models; do not
declare them.

Staging's copy of these two entries is in `infra/node-a/staging/models.json`;
`scripts/staging-env.sh push OPENGATEWAY_API_KEY` and then `push-models` put
them on staging (see "Staging keys and models" in `docs/deployment.md`).

## Context window and output limit

Declare `contextWindow` and `maxOutputTokens` for every model. Mike compacts
a conversation as it nears the window, and pi-ai shrinks each request's output
budget to what the window leaves. A window declared too small (the 128,000
default, for a model with a million) makes Mike compact far too early and can
leave a long request one token to answer with.

A response that stops for its output limit after at most 16 tokens, with no
tool call, when it had a real budget, is treated as a context overflow rather
than an answer: the conversation is compacted and the request asked again, or,
if it still does not fit, the turn fails with a message saying the
conversation is too long for the model.

## Reasoning

Reasoning models are not built to answer without reasoning. Declare
`reasoning` so Mike sends the model an effort it accepts:

| Field | Meaning |
| --- | --- |
| `efforts` | The efforts the endpoint accepts, from `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Sent verbatim. A request for an effort the model lacks goes out at the nearest heavier one it has (or the heaviest it has). |
| `default` | The effort used when Mike asks for none in particular (bulk work such as extraction). Defaults to `high` when listed, else the heaviest effort. |
| `canDisable` | Whether reasoning can be turned off. Default `false`: a request for no reasoning (the "none" level, or a one-shot title) is sent at the lightest declared effort instead. |
| `offValue` | With `canDisable`, the effort value that turns reasoning off. Default `none`. |
| `param` | Where the effort goes: `reasoning_effort` (default, top level), `reasoning.effort` (OpenRouter's nested object), or `none` for a model that reasons with no control field. |

The reasoning text comes back in `reasoning_content` (or `reasoning`) and is
shown as the model's thinking, not as part of the answer. An entry with a
malformed `reasoning`, `cost`, `contextWindow`, `maxOutputTokens` or
`streamIdleTimeoutMs` is dropped like any other malformed entry.

## Streaming silence

Mike ends a response that goes silent (`STREAM_FIRST_CHUNK_TIMEOUT_MS` before
the first output, then the gap limit). Any bytes the endpoint sends count,
including SSE keep-alive comments. Some endpoints send a long tool call's
arguments in one piece after a long silence, so configured models get
`STREAM_CONFIGURED_CHUNK_TIMEOUT_MS` (default 180,000 ms) rather than the
hosted providers' `STREAM_CHUNK_TIMEOUT_MS`, and a model can set its own
`streamIdleTimeoutMs`.

## Restarts

Every declared model is registered with the model loop when the backend
starts, before interrupted turns and compactions resume, so they find their
model even if nothing else has used it since the restart.

## Attested inference (Phala)

`attestation` makes every request to the model verify the endpoint first and
fail closed: if verification fails, the request never leaves Mike, and there
is no fallback to another model. Phala's confidential AI gateway speaks
Attested Confidential Inference (ACI, `aci/1`), declared with
`"attestation": {"scheme": "aci"}`:

```json
{
  "id": "phala/glm-5.3",
  "label": "GLM 5.3",
  "group": "Phala (encrypted)",
  "provider": "openai-compatible",
  "location": "cloud",
  "baseUrl": "https://inference.phala.com/v1",
  "apiModel": "z-ai/glm-5.3",
  "apiKeyEnv": "PHALA_API_KEY",
  "attestation": { "scheme": "aci" }
}
```

What Mike checks (`backend/src/lib/llm/attestation/aci.ts` and `tdx.ts`):

- The gateway's Intel TDX quote verifies to Intel's SGX root CA: the quote
  signature, the quoting enclave's report and identity, and the PCK chain.
  The TD must not be in debug mode.
- The quote binds the gateway's published keys and a fresh 32-byte nonce
  Mike chose, so the evidence is current and the keys are the attested ones.
- The boot event log replays to the quote's measurement registers. The
  measured compose hash is the hash of the published app compose, and the
  workload's source repository is `repoUrl` (default
  `https://github.com/Dstack-TEE/private-ai-gateway`). `composeHash`
  optionally pins the exact compose, so any redeploy fails closed until the
  pin is updated.
- The TLS key the gateway presents is the attested one, and every inference
  connection is pinned to it. A WebPKI certificate alone is not trusted.
- Each request carries `provider.aci_verified: true`, so the gateway refuses
  to serve it through an upstream model it has not verified.
- After a response, its signed receipt is fetched. Mike checks the Ed25519
  signature under the attested receipt key, the hashes of the exact request
  and response bytes, and that the upstream was verified. The result is
  logged.

Identity is re-established with a new nonce every ten minutes, when the
keyset expires, or when the gateway reports a different keyset.

Not yet checked: the platform's TCB level (Intel's signed TCB info and
revocation lists), the dstack KMS custody chain for the keys, and Mike's own
audit of the upstream sessions (the gateway's own verification of them is
relied on through `aci_verified`).

The older `{ "endpoint", "expectedMeasurement" }` form compares one reported
measurement string. It is not cryptographic verification.

Phala also serves DeepSeek V4.1 Flash 1017, attested the same way. Phala's
model list names no reasoning parameter for it, but the gateway accepts
`reasoning_effort`, including `none`; checked on 2026-10-21, with the
receipt verified. Prices are Phala's, in US dollars per million tokens:

```json
{
  "id": "phala/deepseek-v4.1-flash-1017",
  "label": "DeepSeek V4.1 Flash 1017",
  "group": "Phala (encrypted)",
  "provider": "openai-compatible",
  "location": "cloud",
  "baseUrl": "https://inference.phala.com/v1",
  "apiModel": "deepseek/deepseek-v4.1-flash-1017",
  "apiKeyEnv": "PHALA_API_KEY",
  "attestation": {
    "scheme": "aci"
  },
  "supportsVision": true,
  "contextWindow": 1048576,
  "maxOutputTokens": 393216,
  "reasoning": {
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "default": "high",
    "canDisable": true,
    "offValue": "none"
  },
  "cost": {
    "input": 0.75,
    "output": 1.6,
    "cacheRead": 0.15
  }
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

## Step summaries

The assistant's timeline summarises each step for the person watching: what a
thinking block concluded, what a code cell did when the model gave it no
summary of its own, and, once the work is done, the whole run. A small side
model writes them. So that the summaries see nothing the chat did not, it
runs on the same provider as the chat:

| Chat model | Summariser |
| --- | --- |
| A configured model | the configured model marked `"summariser": true` with the same `group`, else the same `baseUrl` |
| `opencode-go/*` | `opencode-go/deepseek-v4.1-flash` |
| `ollama/*` | the configured model marked `"summariser": true` whose `location` is `local` |
| anything else | none: steps keep the model's own summaries and the cells' first comments |

Mark the summariser in the provider's block, for example:

```json
{
  "id": "phala/gemma-4-26b-a4b",
  "group": "Phala (encrypted)",
  "summariser": true,
  "provider": "openai-compatible",
  "location": "cloud",
  "baseUrl": "https://phala-gateway.example/v1"
}
```

A summariser is an ordinary configured model, so it is also offered in the
model pickers. Two settings override the pairing for every chat:

- `STEP_SUMMARY_MODEL=<model id>` uses that model for every chat.
- `STEP_SUMMARIES=off` turns side summaries off.

In strict private mode a summariser the mode would refuse is not used. A
summary that fails, times out (8 seconds per step, about 11 at the end of the
turn) or reads like the model thinking aloud is dropped, and the step keeps its
own line. The summariser's tokens are not yet counted in the turn's usage.

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

### Vision capability & text fallback

Vision input is explicit per-model metadata, never inferred from family or name.
`OPENCODE_GO_VISION_MODEL_IDS` in `backend/src/lib/llm/models.ts` is the source:
`deepseek-v4.1-flash`, `glm-5.3-flash`, `minimax-m3`,
`muse-spark-1.3-contributor`, and `kimi-k3` accept image input; `glm-5.3` is
text-only and proves the fallback path. Unknown or route-sensitive ids
(`mimo-v2.5-pro`, `space-bunny`) fail closed to text. Deployments declaring
their own OpenAI-compatible endpoints set `supportsVision: true` in
`MIKE_MODEL_CONFIG_JSON` only when the endpoint actually accepts image parts;
omitted means false. Context/output values in the table are route-specific to
the OpenCode Go provider, not canonical lab defaults.

One answer serves everything: `modelSeesImages` (`backend/src/lib/llm/index.ts`)
reads the catalog entry a turn on the model would use. The picker shows
"Sees images" from `POST /models/vision`, the composer refuses an image for a
model that cannot see, and the chat routes refuse the same turn with
`400 model_cannot_see_images` (goals/mission-15-vision.md). Images in older
messages reach a text-only model as a placeholder. Ollama models are text-only
until Mike probes `/api/show`.

Images are cleaned once at upload (`backend/src/lib/images.ts`: JPEG, PNG,
WebP and GIF only; upright; metadata stripped; at most 3072 px) and resized per
model family when sent (`imageSizingFor` in `backend/src/lib/llm/models.ts`):

| Family | Grid | Photo budget |
| --- | --- | --- |
| Qwen | 32 px | 1,280 tokens (about 1.3 MP) |
| Gemma | 48 px | the 560-token budget (about 1.3 MP) |
| GPT | 32 px | 2,048 px long edge, 2,500 patches |
| DeepSeek | 28 px | about 1300 x 1300 (its 1,024-token cap) |
| Others (Claude's standard size) | 28 px | 1,568 px long edge, about 1.2 MP |

For self-hosted vision models, also cap the server: vLLM and SGLang otherwise
accept whatever the checkpoint allows (Qwen3.8 allows about 16.8 MP). See
`docs/reports/file-intake-2026-10-10.md`, section 2.2.

Phala's `phala/qwen3.8-27b-uncensored`, `phala/gemma-4-26b-a4b-uncensored`
and `phala/deepseek-v4.1-flash-1017` take images; declare them with
`"supportsVision": true`.


### Synchronizing New Models from Models.dev

When OpenCode releases new models or updates token ceilings:

1. **Query the live Models.dev catalog**:
   ```bash
   curl -s "https://models.dev/api.json" | jq '.["opencode-go"].models | map_values({output: .limit.output, context: .limit.context})'
   ```
2. **Update `backend/src/lib/llm/models.ts`**:
   - Add the new model ID to `OPENCODE_GO_CHAT_COMPLETIONS_MODEL_IDS` (or `OPENCODE_GO_MESSAGES_MODEL_IDS` if served over Anthropic protocol).
   - Add its exact output limit to `OPENCODE_GO_MODEL_OUTPUT_LIMITS`.
   - Add its vision status to `OPENCODE_GO_VISION_MODEL_IDS` (check the route row's input modalities; fail closed when absent) and its context window to `OPENCODE_GO_CONTEXT_WINDOWS`.
3. **Operator Override**:
   +- Set `LLM_MAX_OUTPUT_TOKENS` in `backend/.env` or Docker Compose to enforce a global backstop across all providers if desired.
