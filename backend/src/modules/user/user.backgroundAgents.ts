import { type Db } from "../../lib/db";

/**
 * Whether the person allows background subagents (user_profiles
 * .background_agents). Off when unreadable, as on a database without the
 * 20261022 agent-messaging migration.
 */
export async function backgroundAgentsEnabled(db: Db, userId: string): Promise<boolean> {
    const { data, error } = await db
        .from("user_profiles")
        .select("background_agents")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) return false;
    return (data as { background_agents?: boolean | null } | null)?.background_agents === true;
}
