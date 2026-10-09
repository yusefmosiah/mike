import { describe, expect, it } from "vitest";
import { DbClient } from "../db";
import { createServerSupabase } from "../supabase";

describe("createServerSupabase", () => {
  it("is the shared Postgres client", () => {
    expect(createServerSupabase()).toBeInstanceOf(DbClient);
    expect(createServerSupabase()).toBe(createServerSupabase());
  });
});
