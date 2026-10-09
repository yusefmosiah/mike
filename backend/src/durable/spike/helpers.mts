// Spike-only fixtures: every test owns a random schema in the throwaway
// `pi_spike` database, never Mike's application database.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import pg from "pg";
import { PostgresStorage } from "@netzlabor/pi-durable-postgres";
import { nodePostgresDatabase } from "@netzlabor/pi-durable-postgres/node";

export const spikeUrl = process.env.PI_SPIKE_DATABASE_URL;

export async function testSchema() {
  const admin = new pg.Pool({ connectionString: spikeUrl, max: 1 });
  const schema = `spike_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const config: pg.PoolConfig = { connectionString: spikeUrl, options: `-c search_path=${schema}`, max: 1 };
  const storages = new Set<PostgresStorage>();
  return {
    schema,
    config,
    async openStorage() {
      const storage = await PostgresStorage.open(nodePostgresDatabase(new pg.Pool(config)));
      storages.add(storage);
      return storage;
    },
    async cleanup() {
      try {
        await Promise.all([...storages].map((s) => s.close(BACKGROUND_CONTEXT).catch(() => undefined)));
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
