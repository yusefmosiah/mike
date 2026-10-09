import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A kind of subagent the model may delegate to: a markdown file in `types/`
 * whose frontmatter fixes what the child may do and whose body is its
 * instructions. The file is authoritative: a `delegate` call chooses a type
 * and may pick a model, but cannot widen the tools or raise the budgets.
 */
export type SubagentType = {
    name: string;
    description: string;
    /**
     * Tools the child may call, or "all" for every tool the parent turn was
     * offered. Either way the child gets only tools the parent has, and never
     * `delegate` (depth 1) or `ask_inputs` (a child cannot ask the user).
     */
    tools: string[] | "all";
    /** Tool rounds the child may run before it must report. */
    maxRounds: number;
    /** Output tokens the child may spend across its run. */
    maxOutputTokens: number;
    /** Wall-clock limit for the child's run. */
    timeoutMs: number;
    instructions: string;
};

/** The directory holding the type files, beside this module (copied into dist by the build). */
export const SUBAGENT_TYPES_DIR = path.join(__dirname, "types");

/** The model-selection memo the `delegate` tool description carries. */
export const SUBAGENT_MODEL_MEMO_PATH = path.join(__dirname, "model-memo.md");

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;

/** Split `---` frontmatter of `key: value` lines from the body. */
export function parseFrontmatter(source: string): {
    fields: Record<string, string>;
    body: string;
} {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
    if (!match) throw new Error("missing frontmatter");
    const fields: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        const colon = line.indexOf(":");
        if (colon <= 0) throw new Error(`unreadable frontmatter line: ${line}`);
        fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return { fields, body: match[2].trim() };
}

function positiveInteger(fields: Record<string, string>, key: string): number {
    const value = Number(fields[key]);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${key} must be a positive integer`);
    }
    return value;
}

/** Tools no subagent may have, whatever its type file says. */
export const NEVER_CHILD_TOOLS: ReadonlySet<string> = new Set(["delegate", "ask_inputs"]);

/**
 * Parse one type file. `tools: *` gives the child every tool the parent
 * has; a list restricts it to those. A type exists to change what a child
 * may do or how it must work, not the subject it works on.
 */
export function parseSubagentType(source: string, fileName: string): SubagentType {
    const { fields, body } = parseFrontmatter(source);
    const name = fields.name;
    if (!name || !NAME_RE.test(name)) throw new Error("name must be snake_case");
    if (`${name}.md` !== fileName) throw new Error(`name must match the file name (${fileName})`);
    if (!fields.description) throw new Error("description is required");
    const listed = (fields.tools ?? "")
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
    if (listed.length === 0) throw new Error("tools must be * or list at least one tool");
    if (listed.includes("*") && listed.length > 1) throw new Error("tools: * stands alone");
    for (const tool of listed) {
        if (NEVER_CHILD_TOOLS.has(tool)) throw new Error(`tool ${tool} is never given to a subagent`);
    }
    const tools: SubagentType["tools"] = listed[0] === "*" ? "all" : listed;
    if (!body) throw new Error("the instructions body is empty");
    return {
        name,
        description: fields.description,
        tools,
        maxRounds: positiveInteger(fields, "max_rounds"),
        maxOutputTokens: positiveInteger(fields, "max_output_tokens"),
        timeoutMs: positiveInteger(fields, "timeout_ms"),
        instructions: body,
    };
}

let cached: Map<string, SubagentType> | undefined;

/** Every type in `dir`, by name. A malformed file fails loudly: it is shipped code. */
export function loadSubagentTypes(dir = SUBAGENT_TYPES_DIR): Map<string, SubagentType> {
    if (dir === SUBAGENT_TYPES_DIR && cached) return cached;
    const types = new Map<string, SubagentType>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
        try {
            const type = parseSubagentType(readFileSync(path.join(dir, file), "utf8"), file);
            types.set(type.name, type);
        } catch (error) {
            throw new Error(
                `Subagent type ${file}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    if (dir === SUBAGENT_TYPES_DIR) cached = types;
    return types;
}

let memo: string | undefined;

export function subagentModelMemo(): string {
    return (memo ??= readFileSync(SUBAGENT_MODEL_MEMO_PATH, "utf8").trim());
}
