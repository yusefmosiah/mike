import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { spikeUrl, testSchema } from "./helpers.mjs";

// Upstream storage contract, run against Mike's Postgres storage
// (lib/llm/pi/postgres/) on Postgres 17. Skipped unless PI_SPIKE_DATABASE_URL
// is set; scripts/test-stack.sh sets it.
(spikeUrl ? describe : describe.skip)("pi-durable-postgres conformance", () => {
  registerStorageConformance({ describe, expect, it }, "PostgresStorage", async (use) => {
    const fixture = await testSchema();
    try {
      await use(await fixture.openStorage());
    } finally {
      await fixture.cleanup();
    }
  });
});
