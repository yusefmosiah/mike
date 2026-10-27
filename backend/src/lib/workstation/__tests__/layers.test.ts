import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSTATION_LAYERS } from "../layers";
import { workstationCapabilitiesSection } from "../capabilities";

// The flake's manifest is the source of truth; the backend mirrors it because
// its image does not ship infra/. This test is the contract between them.
const manifest = JSON.parse(
    readFileSync(
        resolve(__dirname, "../../../../../infra/workstation/layers.json"),
        "utf8",
    ),
) as { layers: Record<string, unknown> };

describe("WORKSTATION_LAYERS", () => {
    it("mirrors infra/workstation/layers.json exactly", () => {
        expect(WORKSTATION_LAYERS).toEqual(manifest.layers);
    });
});

describe("workstationCapabilitiesSection", () => {
    it("names every manifest layer with its purpose and entry point", () => {
        const section = workstationCapabilitiesSection();
        for (const [name, layer] of Object.entries(WORKSTATION_LAYERS)) {
            expect(section).toContain(`layer use ${name}`);
            expect(section).toContain(layer.purpose);
        }
    });

    it("states save_to_mike's accepted formats in the context", () => {
        const section = workstationCapabilitiesSection();
        for (const ext of [".mp3", ".m4a", ".wav", ".ogg", ".mp4", ".webm", ".mov"]) {
            expect(section).toContain(ext);
        }
    });
});
