import { describe, expect, it } from "vitest";
import { createDb, DbClient } from "../db";

describe("createDb", () => {
  it("is the shared Postgres client", () => {
    expect(createDb()).toBeInstanceOf(DbClient);
    expect(createDb()).toBe(createDb());
  });
});
