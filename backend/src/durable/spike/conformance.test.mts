import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { spikeUrl, testSchema } from "./helpers.mjs";

// Upstream storage contract, run against the published Postgres adapter on
// Mike's Postgres 17. Skipped unless PI_SPIKE_DATABASE_URL is set.
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
