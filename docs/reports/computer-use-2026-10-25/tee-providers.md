# Confidential / TEE-attested LLM inference providers (read 2026-10-26)

Tags: [V] read from the provider's own page or live API on 2026-10-26; [R] secondhand (aggregator, blog, search snippet). Prices are USD per 1M tokens unless noted. "Cache read" = discounted cached-input rate. Model release dates come from the `created` field of the provider/OpenRouter APIs where available. Models older than about 6 months (before ~2026-04-26) are flagged **comparison only (CO)**.

## 0. Headline findings

1. **Phala's catalog is largely a reseller/router layer at a markup.** [V] The RedPill API (`api.redpill.ai/v1/models`) lists the upstream `providers` for each TEE model: Chutes, Tinfoil, NEAR AI, Privatemode, Fortanix, 0G Private Computer, and Phala itself. Qwen3.8 27B on Phala ($0.20/$2.50/$0.05) is served by `chutes` and `phala`. Chutes sells the same model directly at $0.039/$1.25/$0.0039, and NEAR AI at $0.04/$1.35/$0.018. Phala's price is a gateway price, not a hardware price. The `aci/1` receipt records whether the upstream was verified.
2. **Cheapest direct sources for the models you care about:** Chutes (Qwen3.8 27B, Gemma 4 31B, Kimi K3) and NEAR AI (GLM 5.3 Flash, Qwen3.8 27B). Both are far cheaper than Phala. Both have weaker or incomplete attestation evidence, and NEAR re-sells Chutes and Phala/dstack hardware for several models.
3. **Strongest verification story:** Tinfoil (open-source client SDK verifies the enclave; TLS terminates inside the enclave) and Privatemode (client proxy does attestation against a published manifest). Both are 2-10x more expensive per token than Chutes/NEAR for the same open models. Tinfoil has no cache discount on Gemma 4 31B. Privatemode has no Qwen3.8, Kimi K3 or Gemma.
4. **No frontier closed model is available with attestation today.** OpenAI "Private Inference" was announced 2026-09-29 as a "coming this fall" preview with no hardware, region or pricing [R, via Privatemode blog]. Anthropic: no confidential-inference product found. Apple PCC (now also on Google Cloud, Blackwell + TDX) serves Apple's own workloads only [R, InfoQ].
5. **Third-party verification is weak everywhere.** The independent directory confidentialinference.net (synced 2026-10-25) shows **0 verified** models across all providers, with "incomplete evidence", "availability issue" or "explicit trust failure" flags. See Section 4.

## 1. Provider-by-provider

### 1.1 Chutes (Bittensor) [V: llm.chutes.ai/v1/models, chutes.ai/pricing, 2026-10-26]
- **Catalog (14 `confidential_compute: true` models, `-TEE` suffix):** Qwen3.8-27B (2026-08), Qwen3.6-27B, Qwen3.5-397B-A17B, Kimi-K3 (2026-08), Kimi-K2.6 (2026-05), GLM-5.2, GLM-5.1, DeepSeek-V4-Flash-0731, Gemma-4-31B-turbo (2026-04), DeepSeek-V3.2 (CO), Qwen3-32B (CO), Qwen3-235B-Thinking-2507 (CO), Mistral-Nemo-2407 (CO), Nemotron-3-Nano-Omni-30B. **GLM 5.3, GLM 5.3 Flash and DeepSeek V4.1 Flash are not available as TEE on Chutes.**
- **Pricing (input / output / cache read):**
  - Qwen3.8-27B: 0.039 / 1.25 / 0.0039
  - Gemma-4-31B-turbo: 0.12 / 0.37 / 0.012
  - Kimi-K3: 1.85 / 9.50 / 0.185
  - DeepSeek-V4-Flash-0731: 0.44 / 1.32 / 0.044
  - GLM-5.2: 1.25 / 3.95 / 0.125
  - Qwen3.5-397B: 0.45 / 3.00 / 0.045
  - Kimi-K2.6: 0.45 / 1.95 / 0.045
  - Cache read is a flat 10% of input. Cache write is not charged. Prices are market-set and can move.
- **Image input:** Qwen3.8-27B, Qwen3.6-27B, Gemma-4-31B, Kimi K3 and K2.6 (also video), Qwen3.5-397B all list `text, image`. GLM-5.x and DeepSeek V4 Flash 0731 are text-only. Directory flags Chutes "vision: not supported", which contradicts the live API; trust the API.
- **Context:** Qwen3.8-27B 262k; Gemma 131k; Kimi K3 1.05M (the directory lists a 64K max output).
- **Rate limits:** PAYG has no published per-model limits. Plus/Pro plans ($10/$20 per month, 2,000/5,000 requests a day) are barred for automated or high-volume use under the ToS. Private Chutes (dedicated) is RTX Pro 6000 96 GB at $1.80/h.
- **Attestation:** Intel TDX (most models) and AMD SEV-SNP, with NVIDIA GPU CC. The Chutes article describes TD quotes, measured boot (RTMR), a validator checking a known-good config, an encrypted rootfs unlocked only after attestation, and cosign-only images. **E2EE is optional**: the client encrypts the prompt to the attested instance key. The default path is a Chutes gateway TLS hop. The hardware is community-run Bittensor miners, so the threat model includes a miner with physical access (see TEE.fail, Section 5). [V article; client-side steps not documented there]
- **API:** OpenAI-compatible, streaming. The directory says function calling is not supported; check this before relying on it (the models themselves support tools).
- **Maturity:** The latest independent check (2026-10-26) had 0 verified, 13 incomplete, 1 unreachable. Workload identity, source provenance and request route are "not proven" [R].

### 1.2 NEAR AI Cloud [V: cloud-api.near.ai/v1/models, near.ai/models, docs.near.ai, 2026-10-26]
- **Private TEE (NEAR-operated), pricing in / out / cache read:**
  - GLM 5.3 Flash (2026-09): 0.08 / 0.50 / 0.012, 1.05M ctx, text+image
  - Qwen3.8 27B (2026-08): 0.04 / 1.35 / 0.018, 262k, text+image
  - Qwen3.6 35B A3B FP8: 0.17 / 1.10 / 0.056, text only
  - Qwen3-VL-30B-A3B (CO, 2026-03): 0.15 / 0.55 / 0.03, 16k ctx
  - Privacy Filter, embeddings, reranker, Whisper.
- **Private 3P TEE ("attested 3P"):**
  - Kimi K3: 3.30 / 16.50 / 0.33
  - GLM 5.3 (2026-10-21): 1.80 / 5.75 / 0.45, text only
  - Kimi K2.6: 0.81 / 3.85 / 0.41
  - Qwen3.5-397B: 0.50 / 3.30 / 0.25, 128k
  - DeepSeek V3.2 (CO).
  - Per the directory these are Chutes-backed, so NEAR is about 1.8x Chutes on Kimi K3. The docs say the JS SDK verifies Chutes model attestation; the Python SDK verifies only the gateway.
- **Incognito tier:** a router to Anthropic/OpenAI/Google/xAI/DeepSeek with **no TEE for the model**. It includes Claude Opus 5.5, Sonnet 5.5 ($2/$10/$0.10 cache read), GPT-6.x and others. Do not confuse these with the confidential tier.
- **Caching:** discounted `input_cache_read` is advertised per model. The discounts are about 0.3x input (Qwen3.8) to 0.15x (GLM Flash). Cache write is not charged.
- **Attestation:** Intel TDX with NVIDIA H200 CC. TLS terminates in the TEE. **Gateway attestation** (fresh TDX quote bound to a nonce) is the first check, then model attestation, then response signatures, with optional X25519 + XChaCha20-Poly1305 E2EE. Intel Trust Authority integration was announced 2026-08-12 [R]. Open-source verifier repos plus a browser Verification Center at cloud.near.ai/verify [V docs]. Direct completions verification is marked experimental.
- **Maturity:** the directory shows "explicit trust failure" for GLM 5.3 (verifier policy failed) and the rest incomplete [R]. I found no public outage or security incident report for NEAR.
- **Several NEAR "Private TEE" models are shown as running on Phala/dstack (declared, not verified)** [R directory]. NEAR is therefore partly a re-seller of Phala hardware at a lower price than Phala's own gateway.

### 1.3 Tinfoil [V: inference.tinfoil.sh/v1/models, docs.tinfoil.sh, 2026-10-26]
- **Catalog and pricing (in / out / cache read):**
  - DeepSeek V4.1 Flash (1017, experimental, 2026-09-11): 0.65 / 1.45 / 0.13, 1.05M ctx, **image yes**
  - GLM-5.3 (2026-09): 1.80 / 5.75 / 0.45, 1.05M, text only
  - Kimi K3 (2026-08): 4.00 / 20.00 / 0.80, 262k (docs and API), **image yes**
  - Gemma 4 31B (2026-04): 0.40 / 1.00 / no cached rate, 262k, **image yes**
  - gpt-oss-120b, Llama 3.3 70B (CO), Voxtral, Whisper, Qwen3-TTS, embeddings, "decision" models and PII filter.
  - **No Qwen3.8, Qwen3.6 or GLM 5.3 Flash.** GLM 5.3 Flash was added in September and was being removed by 2026-10-09 per the changelog.
- **Caching:** supported in the SDKs (Python 0.13.5+, JS 1.1.10+, Go, Rust, Swift). The `user_cache_secret` must match, prompts need a few thousand characters, the prefix is matched in fixed-size chunks, and caches can be evicted at any time. The cached rate is on only 3 of 6 chat models.
- **Rate limits:** tiered by lifetime paid spend; RPM, with TPM counting uncached input plus output [V pricing page].
- **Attestation:** the directory says Intel TDX with H100 CC; the Tinfoil repo says DeepSeek V4.1 Flash runs on 4x B200/B300, so the exact hardware varies by model and the directory is inconsistent. **The enclave terminates TLS itself** (ACME cert whose SAN holds the attestation-report hash). The **SDK is open source and verifies on the client**: it fetches expected measurements from GitHub and Sigstore, checks the signed bundle and the enclave report, and aborts on a mismatch. Reproducible CVM image. Clients verify only the **router** (itself an enclave that decrypts to route and bill), and the router verifies each model enclave. V3 attestation is in beta. [V docs]
- **Compare with Phala aci/1:** the shape is similar (nonce-bound quote, keyset, source provenance). Tinfoil's contribution is a signed-measurement transparency flow (Sigstore) and a TLS key bound into the cert. ACI uses SPKI pinning plus a signed per-request receipt, and states the upstream-verification level for aggregators. ACI is a draft spec [V github.com/Dstack-TEE/private-ai-gateway spec/aci.md].
- **Maturity:** the directory shows "availability issue" for 2026-10-26: 0 verified, 1 incomplete, 11 unavailable, 11 of 17 models "declared, route not bound" [R]. The changelog shows fast catalog churn (models removed within weeks) [V].

### 1.4 Privatemode (Edgeless Systems) [V: privatemode.ai/pricing, docs.privatemode.ai, 2026-10-26]
- **Catalog:** GLM-5.3 (1M ctx, text), GLM-5.3-Flash (1M, **text+image**), gpt-oss-120b (128k), DeepSeek-OCR-2 (preview, image, 8k), Qwen3-Embedding 4B, Voxtral Mini 3B and Whisper v3 for speech. **No Kimi, Qwen3.8, Gemma or DeepSeek chat.**
- **Pricing in EUR (plus VAT):**
  - GLM-5.3: 1.55 / 5.74 / cached 0.15
  - GLM-5.3-Flash: 0.20 / 0.65 / cached 0.05
  - gpt-oss-120b: 0.20 / 0.65 / cached 0.04
  - A free tier gives 5M tokens at sign-up plus 1M a month, with E2EE and attestation included.
- **Caching:** **explicitly supported and documented inside the TEE** (cache stays in GPU and encrypted CPU memory). Isolation uses a client-supplied `cache_salt` carried in the E2EE request, chained into vLLM's SHA-256 prefix hash. The default proxy generates a random salt per request, which gives **no cross-request cache hits** unless you configure a shared salt or scope (see the prompt-caching docs).
- **Attestation:** AMD SEV-SNP and Intel TDX CPUs with H100 and B200 GPUs in CC mode. The **client-side proxy (or JS SDK) verifies the CPU and GPU reports against a published manifest** (Contrast) before sending anything. The SNP report is signed with VCEK P-384, with REPORT_DATA binding the session key and nonce. This is the cleanest "client verifies from source" flow [V docs, R search]. The directory lists its channel as "TEE-only gateway" with incomplete evidence.
- **API:** OpenAI and Anthropic-compatible (`/v1/messages`) via the proxy; tool calling, streaming and structured outputs supported.
- **Maturity:** Edgeless is an established confidential-computing vendor (Contrast, Continuum). The catalog is small.

### 1.5 Venice [V: docs.venice.ai pricing and privacy pages]
- **E2EE/TEE text models (`e2ee-*` ids):** DeepSeek V4 Flash 0.182 / 0.373 / 0.038 (1M ctx); GLM 5.3 Flash 0.16 / 0.54 / 0.038 (image yes); GLM 5.3 1.75 / 5.50 / 0.325; GLM 5.2; Kimi K3 3.75 / 18.75 / 0.375 (image yes); Kimi K2.6; Qwen 3.8 27B 0.47 / 3.53 / 0.047 (256k, vision); Qwen3.6 35B; Qwen3 VL 30B; Gemma 4 26B Uncensored 0.19 / 0.88; gpt-oss-120b. Many ids end in `-p`, and the prices track Phala/RedPill listings plus a markup, so Venice appears to resell Phala hardware (inference, not confirmed).
- Cache write is not charged. TEE and E2EE are text-only. **Web search, memory and tool flows are disabled in E2EE mode.** The client encrypts `user` and `system` messages. Venice relays ciphertext. The directory flags an "availability issue" [R].
- DeepSeek V4 Flash at $0.182/$0.373 is the cheapest DeepSeek TEE price I found, but the model is older than V4.1 and text-only.

### 1.6 Confidential AI (confidential.ai) [V: confidential.ai/pricing, 2026-10-20 price date]
- DeepSeek V4 Flash 0.20 / 0.40 / 0.018 (available now). Qwen3.8 27B 0.30 / 1.80, GLM 5.3 1.40 / 4.40, Kimi K3 3.00 / 15.00 (**all three by capacity request only**; no cache rate shown).
- Confidential GPU VMs: B300 $7.50/h, B200 $6.50/h, H100 $3.25/h (minimum $500 and 3 months). Licensing is available for your own hardware.
- Intel TDX plus every GPU in NVIDIA CC mode, with open-source guest attestation tooling. TLS termination is not documented. The directory shows "incomplete evidence" and a single model.
- Notable because the prices match Phala's Kimi K3 and GLM 5.3 exactly, which suggests a shared supply chain (inference).

### 1.7 RedPill / Phala (baseline) [V: phala.com/models, api.redpill.ai/v1/models, 2026-10-26]
- RedPill is Phala's multi-provider router. The API gives `is_tee` plus `providers` per model. 25 TEE models (see Section 3 for prices). Phala-hosted: Qwen3.8 27B Uncensored (0.30 / 1.50 / 0.05, text+image), Gemma 4 26B-A4B Uncensored (0.15 / 0.70 / 0.05), Kev 4B, Qwen 2.5 7B.
- aci/1: nonce-bound gateway attestation (TDX quote over a keyset), signed per-request receipt that records the upstream verification outcome (`verified/unverified`), SPKI pinning of the TLS key. The gateway sees plaintext and client IP and timing. It verifies a TEE upstream before forwarding if you require it, and refuses with `upstream_verification_failed` otherwise [V spec]. This is the only provider whose receipts say whether *each request* went to an attested upstream, which matters because the Phala catalog is an aggregation.

### 1.8 Maple (OpenSecret) [V: maple.ai/pricing]
- A consumer/prosumer app plus API (Pro $20/month) running on Tinfoil and Edgeless infrastructure [R]. API prices are about 2x Tinfoil: Kimi K3 8.00 / 1.60 / 25.00, GLM 5.3 3.60 / 0.90 / 11.50, GLM 5.3 Flash 0.80 / 0.20 / 2.50, DeepSeek V4.1 Flash 0.65 / 0.13 / 1.45, Gemma 4 31B 0.80 / 2.00. Not competitive for API use.

### 1.9 Others
- **0G Private Computer** (pc.0g.ai) [V partial]: router with Standard, Verified and Private tiers (Private = TEE, E2EE, zero retention; Intel TDX with H100/H200 per its blog [R]). Lists GLM-5.3 at 1.40 / 4.40 (same as Phala). Pays in 0G or USD via Stripe. The full model table was not retrievable. A RedPill upstream.
- **Secret AI (SCRT Labs)** [V pricing page 2026]: Qwen3-VL:30B and Qwen3-Coder:30B 0.03 / 0.12, GPT-OSS:120B 0.15 / 0.50. The homepage lists Qwen3.6 27B, Gemma 4 31B and cached input at $0.075, but the two pages conflict. Attestation details not retrieved. Small, crypto-adjacent; low priority.
- **Nillion nilAI** [V docs overview]: OpenAI-compatible, `/v1/attestation/report`, signed responses, NVIDIA CC. The documented models are gemma-3-27b-it on testnet and gpt-oss-20b by application. All CO, no Qwen3.8, GLM, Kimi or DeepSeek. Not viable.
- **Atoma Network** [R, 2024-25 material only]: Sui-based decentralized TEE inference. No 2026 catalog or pricing found. Not viable.
- **Super Protocol** [R]: a confidential AI cloud and marketplace (TDX, SEV-SNP, Blackwell). Hourly GPU model with no public per-token API pricing found. Not a drop-in LLM API.
- **Cocoon (Telegram/TON)** [V cocoon.wiki, R]: the site says "Submit confidential inference request via Cocoon SDK or API" and lists no models, prices or docs. The page says "launching October 29, 2025." Access is by application. Not usable yet as a priced API.
- **NanoGPT** (24 models) and **PPQ.AI** (6): aggregators; PPQ is a Tinfoil router. NanoGPT is flagged "explicit trust failures" by the directory [R]. Skip.
- **Prem, io.net, Darkbloom, Fortanix:** Prem (3 models, TDX, $0.30/$1.40 from) [R]. io.net advertises confidential inference but none of its 28 models had attestation enabled when checked 2026-07-27 [R]. Darkbloom (Eigen Labs) runs on idle Macs with Secure Enclave attestation, public alpha, small models, and is also an OpenRouter provider [R]. Fortanix Confidential AI is an enterprise deploy-into-your-environment product, not a per-token API [R].
- **OpenRouter:** no TEE routing of its own. Its ZDR filter is a policy filter, and OpenRouter itself sees plaintext [R]. It lists Phala, NEAR AI, Venice, Chutes, Darkbloom, Near AI and others as providers, but these are non-attested routes through OpenRouter's infrastructure. The OpenRouter API exposes no attestation flag. Use for non-sensitive traffic only. Its DeepSeek V4.1 Flash price ($0.15 / $0.60 / $0.003 at off-peak hours, $0.30 / $1.20 / $0.006 at peak) is a useful non-TEE price benchmark [V API].
- **Azure** [R, Microsoft blog]: Azure OpenAI confidential inferencing was announced as a preview (OHTTP + TEE key release). I found no GA, pricing or model list; Cohere Model Vault on Azure H100 CC is in beta via sales. **Google Cloud** has Confidential A3 (H100) GA and G4 RTX PRO 6000 in preview [R]. No hosted Gemini in a TEE found. You can rent confidential GPU VMs on both and self-host.
- **Anthropic:** nothing purchasable. **OpenAI:** Private Inference preview "coming this fall"; ZDR with attested safety processing is available now for approved API projects [R]. **Apple PCC:** not for third parties [R].

## 2. Image input and context (summary)
| Model | Image on which TEE endpoints |
|---|---|
| Qwen3.8 27B | Phala (yes), Chutes (yes), NEAR (yes), Venice (yes, vision-language) |
| Gemma 4 31B | Chutes (yes), Tinfoil (yes), Phala (page says text-only [V], while its API lists image/video; ambiguous) |
| GLM 5.3 Flash | Phala (yes), NEAR (yes), Privatemode (yes), Venice (yes) |
| GLM 5.3 | text-only everywhere |
| Kimi K3 | Phala, Chutes, NEAR, Tinfoil, Venice (yes); Tinfoil context only 262k |
| DeepSeek V4.1 Flash | Tinfoil and Phala (yes, 1M ctx) |
| DeepSeek V4 Flash 0731 | text-only |

Published throughput or latency numbers: none found for any provider. Super Protocol claims 64 tok/s for MedGemma 27B on one B200 [R]. Rate limits: Tinfoil (tiered by spend), Chutes (plans only), NEAR (unspecified), Privatemode (page unpublished).

## 3. Same-model price comparison and computer-use step cost
Step assumption: 30,000 input tokens of which 25,000 are cache hits (billed at the cache-read rate), plus a 1,500-token screenshot billed uncached, so uncached input = 5,000 + 1,500 = 6,500; 500 output tokens. Cost = (25,000 x cache + 6,500 x input + 500 x output) / 1M. Where no cache rate exists, cached tokens are billed at the input rate. Screenshot token counts differ by model tokenizer, so treat 1,500 as nominal. Reasoning tokens would add to output, and they are the largest uncertainty for GLM, Kimi and Qwen thinking modes. Prices from Sections 1 and 3 (all [V] except Maple, Tinfoil=[V API]).

| Model | Provider | In | Out | Cache read | Cost/step | per 1k steps |
|---|---|---|---|---|---|---|
| Qwen3.8 27B | Phala | 0.20 | 2.50 | 0.05 | $0.00380 | $3.80 |
| Qwen3.8 27B Uncensored | Phala | 0.30 | 1.50 | 0.05 | $0.00395 | $3.95 |
| Qwen3.8 27B | **Chutes** | 0.039 | 1.25 | 0.0039 | **$0.00098** | $0.98 |
| Qwen3.8 27B | **NEAR AI** | 0.04 | 1.35 | 0.018 | $0.00138 | $1.39 |
| Qwen3.8 27B | Venice E2EE | 0.47 | 3.53 | 0.047 | $0.00600 | $6.00 |
| Qwen3.8 27B | Confidential AI (on request) | 0.30 | 1.80 | none | $0.01035 | $10.35 |
| Gemma 4 31B | Phala | 0.15 | 0.46 | 0.075 | $0.00308 | $3.08 |
| Gemma 4 31B | Chutes | 0.12 | 0.37 | 0.012 | $0.00127 | $1.27 |
| Gemma 4 31B | Tinfoil | 0.40 | 1.00 | none | $0.01310 | $13.10 |
| Gemma 4 31B | Maple | 0.80 | 2.00 | none | $0.02620 | $26.20 |
| GLM 5.3 Flash | Phala | 0.15 | 0.50 | 0.03 | $0.00198 | $1.98 |
| GLM 5.3 Flash | **NEAR AI** | 0.08 | 0.50 | 0.012 | $0.00107 | $1.07 |
| GLM 5.3 Flash | Venice E2EE | 0.16 | 0.54 | 0.038 | $0.00226 | $2.26 |
| GLM 5.3 Flash | Privatemode (EUR) | 0.20 | 0.65 | 0.05 | about EUR 0.0029 | about EUR 2.9 |
| GLM 5.3 Flash | Maple | 0.80 | 2.50 | 0.20 | $0.01145 | $11.45 |
| GLM 5.3 | Phala | 1.40 | 4.40 | 0.26 | $0.01780 | $17.80 |
| GLM 5.3 | NEAR AI (3P) | 1.80 | 5.75 | 0.45 | $0.02583 | $25.82 |
| GLM 5.3 | Tinfoil | 1.80 | 5.75 | 0.45 | $0.02583 | $25.82 |
| GLM 5.3 | Venice E2EE | 1.75 | 5.50 | 0.325 | $0.02225 | $22.25 |
| GLM 5.3 | Privatemode (EUR) | 1.55 | 5.74 | 0.15 | about EUR 0.0157 | about EUR 15.7 |
| Kimi K3 | Phala | 3.00 | 15.00 | 0.30 | $0.03450 | $34.50 |
| Kimi K3 | **Chutes** | 1.85 | 9.50 | 0.185 | $0.02140 | $21.40 |
| Kimi K3 | NEAR AI (3P) | 3.30 | 16.50 | 0.33 | $0.03795 | $37.95 |
| Kimi K3 | Tinfoil | 4.00 | 20.00 | 0.80 | $0.05600 | $56.00 |
| Kimi K3 | Venice E2EE | 3.75 | 18.75 | 0.375 | $0.04312 | $43.12 |
| DeepSeek V4.1 Flash 1017 | Phala | 0.75 | 1.60 | 0.15 | $0.00942 | $9.42 |
| DeepSeek V4.1 Flash | Tinfoil | 0.65 | 1.45 | 0.13 | $0.00820 | $8.20 |
| DeepSeek V4 Flash 0731 | Phala | 0.44 | 1.32 | 0.028 | $0.00422 | $4.22 |
| DeepSeek V4 Flash 0731 | Chutes | 0.44 | 1.32 | 0.044 | $0.00462 | $4.62 |
| DeepSeek V4 Flash | Venice E2EE | 0.182 | 0.373 | 0.038 | $0.00232 | $2.32 |
| DeepSeek V4 Flash | Confidential AI | 0.20 | 0.40 | 0.018 | $0.00195 | $1.95 |

(The Privatemode EUR figures use the table's EUR prices without conversion. Cache write is not charged anywhere I looked.)

Takeaways: for Qwen3.8 27B, Chutes is 3.9x cheaper than Phala per step and NEAR is 2.7x cheaper. Phala's "Uncensored" variant costs about the same as base Qwen3.8 (output is cheaper, input dearer). Where cached tokens dominate, the cache rate matters more than the input price: Tinfoil's missing Gemma cache rate makes it 10x Chutes. Phala's DeepSeek V4 Flash 0731 cache rate ($0.028) is the lowest among DeepSeek options.

## 4. Verification and trust summary
| Provider | Hardware | TLS terminates in TEE | Client verifies how | What provider can still see | Third-party check (2026-10-26) [R] |
|---|---|---|---|---|---|
| Phala/RedPill (aci/1) | Intel TDX + NVIDIA CC (H100/H200) | Gateway TLS key SPKI-pinned in the keyset | Nonce-bound gateway quote; signed receipt per request with upstream status | Gateway sees plaintext, IP, timing; upstream (Chutes, Tinfoil, etc.) sees plaintext in its own TEE | Redpill: incomplete evidence |
| Tinfoil | TDX + H100 CC / B200 (inconsistent) | Yes, in-enclave ACME cert | Open-source SDK, Sigstore + GitHub measurements, reproducible image | Router enclave sees plaintext (attested) | availability issue; 0 verified |
| Privatemode | SEV-SNP and TDX; H100/B200 CC | Via attested proxy channel (E2EE in the request) | Client proxy / JS SDK checks a manifest; Contrast | Operators cannot see prompts; metadata only | incomplete evidence |
| NEAR AI | TDX + H200 CC (some on Phala/dstack, some Chutes) | Yes | Gateway attestation, model attestation, signed responses, optional E2EE, Intel Trust Authority | Gateway decrypts unless E2EE | explicit trust failure (GLM 5.3), rest incomplete |
| Chutes | TDX and SEV-SNP + CC GPUs, community miners | Optional E2EE; default gateway TLS | Validator-side checks; client steps not in the article | Gateway sees plaintext unless E2EE | 13 incomplete, 1 unreachable |
| Venice | TDX + H100 CC (via Phala?) | E2EE: ciphertext relayed | Client fetches attestation, encrypts | Nothing in E2EE mode; proxy can see TEE-mode plaintext | availability issue |
| Confidential AI | TDX + NVIDIA CC | Not documented | Open guest tooling | Not documented | incomplete evidence |

## 5. Risks
- TEE.fail (IEEE S&P 2026): a sub-$1,000 DDR5 interposer extracts Intel attestation keys, allowing forged quotes, including for NVIDIA CC. This needs physical access and root. It matters most for community-run hardware such as Chutes miners, and less for operator-owned fleets [R].
- Every provider in this list except Privatemode and Tinfoil has "declared but not bound" request routing, meaning a client cannot prove that a given request reached the attested workload. Phala's receipts and Tinfoil's SDK are the best mitigations here.
- Catalog churn: Tinfoil removed GLM-5.2, DeepSeek V4 Flash and GLM 5.3 Flash within one to three months; Chutes lists DeepSeek V4 Flash 0731 rather than V4.1.
- Privacy is weaker than "private" implies where an aggregator layer decrypts: NEAR gateway, Phala gateway, Tinfoil router, OpenRouter (not a TEE).

## 6. Recommendation (see chat summary)
1. Keep Phala as the verified aggregator, because aci/1 receipts are what no other provider matches.
2. Add Chutes as a direct, much cheaper backend for Qwen3.8 27B, Gemma 4 31B and Kimi K3, if its optional E2EE and weaker evidence fit your threat model. NEAR AI as the second source for Qwen3.8 27B and GLM 5.3 Flash.
3. Use Tinfoil or Privatemode where verification strength matters more than price (GLM 5.3 with the lowest cached price is Privatemode at EUR 0.15, and Tinfoil's DeepSeek V4.1 Flash has image input and a 1M context).
4. Skip Nillion, Atoma, Super Protocol, Cocoon, Secret AI, io.net and Maple for now.

## 7. Sources read (2026-10-26)
phala.com/models [V]; api.redpill.ai/v1/models [V]; redpill.ai/models [V]; inference.tinfoil.sh/v1/models [V]; docs.tinfoil.sh (llms.txt, models/chat, models/vision, sdk/prompt-caching, verification-in-tinfoil, resources/changelog) [V]; cloud-api.near.ai/v1/models [V]; near.ai/models [V]; docs.near.ai [V]; llm.chutes.ai/v1/models [V]; chutes.ai/pricing [V]; chutes.ai/news/private-ai-inference... [V]; privatemode.ai/pricing [V]; docs.privatemode.ai (models, prompt-caching) [V]; docs.venice.ai (pricing, privacy) [V]; venice.ai/models [V]; confidential.ai/pricing and /confidential-inference [V]; maple.ai/pricing [V]; secretai.scrtlabs.com/pricing [V]; pc.0g.ai [V]; cocoon.wiki [V]; docs.nillion.com/api/nilai/overview [V]; github.com/Dstack-TEE/private-ai-gateway spec/aci.md [V]; openrouter.ai/api/v1/models [V]; confidentialinference.net (home, /providers/tinfoil, /chutes, /near) [R]; privatemode.ai/blog/openai-private-intelligence [R]; InfoQ Apple PCC on Google Cloud [R]; Microsoft Azure confidential inferencing blog (title only) [R]; TEE.fail coverage [R]; Darkbloom, Atoma, Super Protocol, Fortanix search snippets [R].
