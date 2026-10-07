// Business logic + stable facade for the diligence module.
//
// The service takes an explicit Supabase client plus request-derived
// primitives, performs the project-access checks and job enqueue, and returns
// typed results — the route layer only parses and maps them onto HTTP. The
// rlm.deep_run job handler and its payload contract are re-exported here so
// the worker registry reaches them through this one door:
//
//   diligence.rlm.ts — the rlm.deep_run handler (waves, synthesis, memo)
//
// Scope: enqueue runs (project content.edit) and read run status (project
// read). Nothing here touches req/res.

import { checkProjectAccess } from "../../lib/access";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { dbJobsEnabled } from "../../lib/dbq/runner";
import type { DbJob } from "../../lib/dbq/types";
import { can } from "../../lib/permissions";
import { assertModelAllowed } from "../../lib/privateMode";
import { resolveModel } from "../../lib/llm/models";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";
import {
    DEFAULT_RLM_MODEL,
    RLM_DEEP_RUN_KIND,
    RLM_DEFAULT_MAX_DOCS,
    RLM_DEFAULT_MAX_WAVES,
    RLM_MAX_DOCS,
    RLM_MAX_WAVES,
    RLM_PROMPT_MAX_CHARS,
    type RlmScope,
} from "./diligence.rlm";

export {
    handleRlmDeepRun,
    parseRlmPayload,
    RLM_DEEP_RUN_KIND,
    DEFAULT_RLM_MODEL,
    RLM_DEFAULT_MAX_WAVES,
    RLM_MAX_WAVES,
    RLM_DEFAULT_MAX_DOCS,
    RLM_MAX_DOCS,
    RLM_PROMPT_MAX_CHARS,
} from "./diligence.rlm";
export type { RlmPayload, RlmScope } from "./diligence.rlm";

/** maxAttempts for one deep run: a retry covers a transient provider or
 *  storage failure without paying for an unbounded number of full reruns. */
const RLM_RUN_MAX_ATTEMPTS = 3;

export const RLM_RUNS_UNAVAILABLE =
    "Diligence runs are temporarily unavailable. Please try again later.";

export type ParsedRlmRunRequest = {
    projectId: string;
    prompt: string;
    scope: RlmScope;
    model: string;
    maxWaves: number;
    maxDocs: number;
};

type ParseOutcome =
    | { ok: true; value: ParsedRlmRunRequest }
    | { ok: false; detail: string };

type CounterOutcome =
    | { ok: true; value: number }
    | { ok: false; detail: string };

function optionalCounter(
    value: unknown,
    fallback: number,
    max: number,
    label: string,
): CounterOutcome {
    if (value === undefined || value === null) return { ok: true, value: fallback };
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
        return { ok: false, detail: `${label} must be an integer between 1 and ${max}` };
    }
    return { ok: true, value };
}

/**
 * Validate and normalize a POST /diligence/runs body. Returns a human-readable
 * detail for the first offending field; unknown extra fields are ignored so
 * clients can send forward-compatible envelopes.
 */
export function parseRlmRunBody(body: unknown): ParseOutcome {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Request body must be a JSON object" };
    }
    const raw = body as Record<string, unknown>;

    const projectId =
        typeof raw.project_id === "string" ? raw.project_id.trim() : "";
    if (!projectId) return { ok: false, detail: "project_id is required" };

    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    if (!prompt) return { ok: false, detail: "prompt is required" };
    if (prompt.length > RLM_PROMPT_MAX_CHARS) {
        return {
            ok: false,
            detail: `prompt must be ${RLM_PROMPT_MAX_CHARS} characters or fewer`,
        };
    }

    const scope: RlmScope = {};
    if (raw.scope !== undefined && raw.scope !== null) {
        if (typeof raw.scope !== "object" || Array.isArray(raw.scope)) {
            return { ok: false, detail: "scope must be a JSON object" };
        }
        const rawScope = raw.scope as Record<string, unknown>;
        if (rawScope.documentIds !== undefined && rawScope.documentIds !== null) {
            if (!Array.isArray(rawScope.documentIds)) {
                return {
                    ok: false,
                    detail: "scope.documentIds must be an array of document ids",
                };
            }
            const ids: string[] = [];
            for (const id of rawScope.documentIds) {
                if (typeof id !== "string" || !id.trim()) {
                    return {
                        ok: false,
                        detail: "scope.documentIds must contain non-empty strings",
                    };
                }
                ids.push(id.trim());
            }
            if (ids.length > RLM_MAX_DOCS) {
                return {
                    ok: false,
                    detail: `scope.documentIds may contain at most ${RLM_MAX_DOCS} ids`,
                };
            }
            if (ids.length > 0) scope.documentIds = ids;
        }
        if (rawScope.folderPath !== undefined && rawScope.folderPath !== null) {
            if (typeof rawScope.folderPath !== "string") {
                return { ok: false, detail: "scope.folderPath must be a string" };
            }
            const folderPath = rawScope.folderPath.trim();
            if (folderPath.length > 500) {
                return { ok: false, detail: "scope.folderPath is too long" };
            }
            if (folderPath) scope.folderPath = folderPath;
        }
    }

    let model: string;
    if (raw.model === undefined || raw.model === null) {
        model = DEFAULT_RLM_MODEL;
    } else if (typeof raw.model === "string" && raw.model.trim()) {
        // An unknown id quietly resolves to the default, like every other
        // entry point; an explicit hosted lane is refused in strict private
        // mode instead of failing later inside the worker.
        model = resolveModel(raw.model.trim(), DEFAULT_RLM_MODEL);
    } else {
        return { ok: false, detail: "model must be a non-empty string" };
    }
    try {
        assertModelAllowed(model);
    } catch (error) {
        return {
            ok: false,
            detail: error instanceof Error ? error.message : "model is not allowed",
        };
    }

    const maxWaves = optionalCounter(
        raw.max_waves,
        RLM_DEFAULT_MAX_WAVES,
        RLM_MAX_WAVES,
        "max_waves",
    );
    if (!maxWaves.ok) return maxWaves;
    const maxDocs = optionalCounter(
        raw.max_docs,
        RLM_DEFAULT_MAX_DOCS,
        RLM_MAX_DOCS,
        "max_docs",
    );
    if (!maxDocs.ok) return maxDocs;

    return {
        ok: true,
        value: {
            projectId,
            prompt,
            scope,
            model,
            maxWaves: maxWaves.value,
            maxDocs: maxDocs.value,
        },
    };
}

export type EnqueueRlmRunArgs = {
    db: Db;
    userId: string;
    userEmail?: string;
    body: unknown;
};

/** POST /diligence/runs — queue one deep run. */
export async function enqueueRlmRun(
    args: EnqueueRlmRunArgs,
): Promise<ServiceResult<{ jobId: string }>> {
    const parsed = parseRlmRunBody(args.body);
    if (!parsed.ok) return failure("validation", parsed.detail);
    const { projectId, prompt, scope, model, maxWaves, maxDocs } = parsed.value;

    try {
        // Runs start their own chat-like workload over the whole project, so
        // the caller must be allowed to add content to it, not merely view.
        const access = await checkProjectAccess(
            projectId,
            args.userId,
            args.userEmail,
            args.db,
        );
        if (!access.ok) return failure("not_found", "Project not found");
        if (!can(access.projectRole, "content.edit")) {
            return failure(
                "forbidden",
                "You do not have permission to run diligence in this project.",
            );
        }

        // Without a running queue the row would sit pending forever — a
        // receipt for work that cannot happen. Refuse instead.
        if (!dbJobsEnabled()) {
            return failure("unavailable", RLM_RUNS_UNAVAILABLE);
        }

        const enqueued = await enqueueDbJob(args.db, {
            kind: RLM_DEEP_RUN_KIND,
            payload: {
                projectId,
                userId: args.userId,
                prompt,
                model,
                ...(Object.keys(scope).length > 0 ? { scope } : {}),
                maxWaves,
                maxDocs,
            },
            maxAttempts: RLM_RUN_MAX_ATTEMPTS,
        });
        if (!enqueued.id) {
            return internalFailure(new Error("rlm.deep_run enqueue returned no id"));
        }
        return ok({ jobId: enqueued.id });
    } catch (error) {
        return internalFailure(error);
    }
}

export type RlmRunStatus = {
    job_id: string;
    status: DbJob["status"];
    result: Record<string, unknown> | null;
};

export type GetRlmRunArgs = {
    db: Db;
    jobId: string;
    userId: string;
    userEmail?: string;
};

/**
 * GET /diligence/runs/:jobId — poll one run. The row is only reported to a
 * caller who can open its project, and a foreign or unknown id is a 404
 * either way so ids stay unprobeable.
 */
export async function getRlmRun(
    args: GetRlmRunArgs,
): Promise<ServiceResult<RlmRunStatus>> {
    try {
        const { data, error } = await args.db
            .from("db_jobs")
            .select("id, payload, status, result")
            .eq("id", args.jobId)
            .eq("kind", RLM_DEEP_RUN_KIND)
            .maybeSingle();
        if (error) return internalFailure(error);
        if (!data) return failure("not_found", "Run not found");

        const row = data as {
            id: string;
            payload?: { projectId?: unknown } | null;
            status: DbJob["status"];
            result: Record<string, unknown> | null;
        };
        const projectId =
            typeof row.payload?.projectId === "string" ? row.payload.projectId : "";
        const access = projectId
            ? await checkProjectAccess(projectId, args.userId, args.userEmail, args.db)
            : null;
        if (!access?.ok) return failure("not_found", "Run not found");

        return ok({
            job_id: row.id,
            status: row.status,
            result: row.result ?? null,
        });
    } catch (error) {
        return internalFailure(error);
    }
}
