import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getAutoModeDecisionSettings: api.get,
  setAutoModeDecisionModel: api.set,
}));

import { AutoModeDecisionModelRow, decisionDetailText, decisionPriceText } from "./AutoModeDecisionModelRow";

const options = [
  { value: "openrouter-decisions/cloudflare/clef-flash", id: "cloudflare/clef-flash", name: "Cloudflare: Clef Flash", inputPricePerMillion: 0.021, openWeights: "Cloudflare/clef-flash", medianLatencyMs: 352 },
  { value: "openrouter-decisions/typesafe/jev-1.13", id: "typesafe/jev-1.13", name: "TypeSafe: Jev 1.13", inputPricePerMillion: 0.042, openWeights: null, medianLatencyMs: 256.4 },
];

beforeEach(() => {
  api.get.mockReset();
  api.set.mockReset();
});

describe("AutoModeDecisionModelRow", () => {
  it("shows the default until a decision model is chosen, and saves the choice", async () => {
    api.get.mockResolvedValue({ model: null, options });
    api.set.mockResolvedValue({ model: options[1].value, options });
    render(<AutoModeDecisionModelRow />);
    const trigger = await screen.findByRole("button", { name: "Auto Mode decision model" });
    expect(trigger).toHaveTextContent("Default — the chat's own model");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(await screen.findByText("Open weights")).toBeInTheDocument();
    expect(screen.getByText("Hosted")).toBeInTheDocument();
    fireEvent.click(screen.getByText("TypeSafe: Jev 1.13"));

    expect(api.set).toHaveBeenCalledWith("openrouter-decisions/typesafe/jev-1.13");
    expect(await screen.findByRole("button", { name: "Auto Mode decision model" })).toHaveTextContent("TypeSafe: Jev 1.13");
  });

  it("says so when no decision model is available (strict private mode)", async () => {
    api.get.mockResolvedValue({ model: null, options: [] });
    render(<AutoModeDecisionModelRow />);
    expect(await screen.findByText(/No decision models are available here/)).toBeInTheDocument();
  });

  it("shows a fixed message, not the server's, when loading fails", async () => {
    api.get.mockRejectedValue(new Error("relation user_profiles does not exist"));
    render(<AutoModeDecisionModelRow />);
    expect(await screen.findByText("Decision models could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText(/user_profiles/)).not.toBeInTheDocument();
  });

  it("shows measured speed before price", () => {
    expect(decisionDetailText(options[1])).toBe("~256 ms · $0.042 per million tokens");
    expect(decisionDetailText({ ...options[1], inputPricePerMillion: null })).toBe("~256 ms");
  });

  it("prices per million tokens", () => {
    expect(decisionPriceText(options[0])).toBe("$0.021 per million tokens");
    expect(decisionPriceText({ ...options[0], inputPricePerMillion: 0 })).toBe("free");
    expect(decisionPriceText({ ...options[0], inputPricePerMillion: 0.24 })).toBe("$0.24 per million tokens");
    expect(decisionPriceText({ ...options[0], inputPricePerMillion: null })).toBeNull();
  });
});
