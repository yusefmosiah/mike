import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDocFamily, Harness } from "@earendil-works/pi-durable";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { spikeUrl, testSchema } from "./helpers.mjs";

// What forgetting a session document takes on Mike's Postgres storage, for a
// family set up as Mike's are (runtime.mts: session scope, never
// checkpointed): every change is a delta revision, so blanking a document
// keeps what it held in earlier revisions, and only retiring it drops them.
const Records = defineDocFamily<{ envelopes: string[] }, null>({
  kind: "mike.test-record",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  family: true,
  initial: () => ({ envelopes: [] }),
});

(spikeUrl ? describe : describe.skip)("forgetting a session document", () => {
  it("keeps earlier content when blanked, and none once retired", async () => {
    const fixture = await testSchema();
    const harness = await Harness.open(await fixture.openStorage(), { models: createModels(), registry: createRegistry() }, context);
    const db = new pg.Pool(fixture.config);
    const holding = async (secret: string) =>
      (await db.query("SELECT count(*)::int AS n FROM document_revisions WHERE content LIKE $1", [`%${secret}%`])).rows[0].n as number;
    try {
      for (const key of ["blanked", "retired"]) {
        await harness.commit(async (tx) => {
          (await tx.doc(Records, key, null)).envelopes.push(`task for ${key}`);
        }, context);
        await harness.commit(async (tx) => {
          (await tx.doc(Records, key, null)).envelopes.push(`report from ${key}`);
        }, context);
      }

      await harness.commit(async (tx) => {
        (await tx.doc(Records, "blanked", null)).envelopes = [];
      }, context);
      await harness.commit(async (tx) => {
        await tx.retireDoc(Records, "retired");
      }, context);

      expect(await harness.snapshot(Records, "blanked", context)).toEqual({ envelopes: [] });
      expect(await holding("task for blanked")).toBeGreaterThan(0);
      expect(await harness.snapshot(Records, "retired", context)).toBeUndefined();
      expect(await holding("task for retired")).toBe(0);
      expect(await holding("report from retired")).toBe(0);
    } finally {
      await db.end();
      await harness.close(context).catch(() => undefined);
      await fixture.cleanup();
    }
  });
});
