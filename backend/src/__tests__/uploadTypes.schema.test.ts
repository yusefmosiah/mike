// The database checks upload sessions' file types itself. Its list must match
// the backend's, or an upload the API accepts fails as an invalid manifest
// (images did, until 20261010_10_image_upload_types.sql).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ALLOWED_DOCUMENT_TYPES } from "../lib/documentTypes";

const schema = readFileSync(path.resolve(__dirname, "../../schema.sql"), "utf8");

const typeLists = (sql: string) =>
  [...sql.matchAll(/file_type (?:not )?in \(([^)]*)\)/g)].map((match) =>
    [...match[1]!.matchAll(/'([^']+)'/g)].map((type) => type[1]).sort(),
  );

describe("upload file types in schema.sql", () => {
  it("match ALLOWED_DOCUMENT_TYPES in the table check and in create_upload_session", () => {
    const lists = typeLists(schema);
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toEqual([...ALLOWED_DOCUMENT_TYPES].sort());
  });
});
