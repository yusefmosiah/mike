/**
 * "Can this model see?" has one answer: the catalog entry a turn on the model
 * would use. Configured endpoints say so themselves; unknown models cannot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelSeesImages } from "../index";
import { resetModelRegistryCache } from "../registry";

const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

beforeAll(() => {
  process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({
    models: [
      {
        id: "phala/gemma-4-26b-a4b-uncensored",
        provider: "openai-compatible",
        location: "cloud",
        baseUrl: "https://inference.example.test/v1",
        apiModel: "phala/gemma-4-26b-a4b-uncensored",
        supportsVision: true,
      },
      {
        id: "phala/glm-text",
        provider: "openai-compatible",
        location: "cloud",
        baseUrl: "https://inference.example.test/v1",
        apiModel: "z-ai/glm-5.3",
      },
    ],
  });
  resetModelRegistryCache();
});

afterAll(() => {
  if (originalConfig === undefined) delete process.env.MIKE_MODEL_CONFIG_JSON;
  else process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
  resetModelRegistryCache();
});

describe("modelSeesImages", () => {
  it("follows a configured endpoint's own declaration, false when omitted", async () => {
    expect(await modelSeesImages("phala/gemma-4-26b-a4b-uncensored")).toBe(true);
    expect(await modelSeesImages("phala/glm-text")).toBe(false);
  });

  it("knows the hosted vision models and the text-only ones", async () => {
    expect(await modelSeesImages("claude-opus-4-7")).toBe(true);
    expect(await modelSeesImages("opencode-go/kimi-k3")).toBe(true);
    expect(await modelSeesImages("opencode-go/glm-5.3")).toBe(false);
  });

  it("says no for a model it cannot resolve", async () => {
    expect(await modelSeesImages("nobody/unknown-model")).toBe(false);
    expect(await modelSeesImages("ollama/llava")).toBe(false);
  });
});
