// Copy the non-TypeScript files the backend reads at runtime into dist/,
// beside the compiled modules that read them: subagent types and the model
// memo (src/modules/chat/engine/subagents). tsc copies only what it compiles.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_DIRS = ["modules/chat/engine/subagents"];

for (const dir of ASSET_DIRS) {
    const from = path.join(root, "src", dir);
    const to = path.join(root, "dist", dir);
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const source = path.join(entry.parentPath, entry.name);
        const target = path.join(to, path.relative(from, source));
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(source, target);
    }
}
