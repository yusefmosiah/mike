// The product's name comes from packages/brand/brand.json, so an install can
// rebrand by replacing that one file (packages/brand/README.md). This test
// keeps the name out of text people see in the web app, the Word
// add-in and the API: it parses each production source file and checks only
// string literals, template text and JSX text, so comments and identifiers
// are not its business. Text that needs the name reads it from the brand;
// most text reads better without it.
//
// It lives in the frontend suite because the backend's TypeScript 7 has no
// stable parser API; it reads backend/src as text and imports nothing from it.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const BRAND = JSON.parse(readFileSync(join(REPO, "packages/brand/brand.json"), "utf8")) as { name: string };
// The brand's current name, and the project's original one until the
// internal rename retires it.
const NAMES = [...new Set([BRAND.name, "Mike"])];

const ROOTS = ["frontend/src", "word-addin/src", "backend/src"];

// Text that is not shown to the people using an install: operator logs,
// configuration errors, and the upstream workflow catalog's name. They go
// with the internal rename.
const ALLOWED = new Set([
    "backend/src/index.ts",
    "backend/src/worker.ts",
    "backend/src/lib/processLifecycle.ts",
    "backend/src/lib/privateMode.ts",
    "backend/src/lib/observability/sentry.ts",
    "backend/src/lib/workflowCatalogSource.ts",
    "backend/src/jobs/syncWorkflows.ts",
]);

const isTest = (rel: string) =>
    /\.(test|spec|stories)\.[mc]?tsx?$/.test(rel) || /(^|\/)(__tests__|stories|spike)\//.test(rel);

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "node_modules") sourceFiles(path, out);
        } else if (/\.[mc]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
            out.push(path);
        }
    }
    return out;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// `X-Mike-*` response headers are protocol identifiers, not text.
const NAME = new RegExp(`(?<!X-)\\b(?:${NAMES.map(escape).join("|")})\\b`);

export function textMentioningName(fileName: string, source: string): string[] {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
    const hits: string[] = [];
    const visit = (node: ts.Node) => {
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isJsxText(node)
        ) {
            if (NAME.test(node.text)) {
                const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
                hits.push(`${fileName}:${line + 1}: ${node.text.trim().slice(0, 100)}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return hits;
}

describe("brand name", () => {
    it("finds the name in strings, templates and JSX text, not comments or identifiers", () => {
        const source = [
            "// Mike in a comment",
            "const MikeIcon = 1;",
            'fetch(url, { headers: { "X-Mike-Audio-Cost": "1" } });',
            'const a = "Ask Mike";',
            "const b = `Hello ${who}, from Mike`;",
            "const c = <p>Mike says</p>;",
        ].join("\n");
        expect(textMentioningName("x.tsx", source)).toEqual([
            "x.tsx:4: Ask Mike",
            "x.tsx:5: , from Mike",
            "x.tsx:6: Mike says",
        ]);
    });

    it("no user-visible source text names the product outside packages/brand", () => {
        const hits: string[] = [];
        for (const root of ROOTS) {
            for (const path of sourceFiles(join(REPO, root))) {
                const rel = relative(REPO, path).split(sep).join("/");
                if (isTest(rel) || ALLOWED.has(rel)) continue;
                hits.push(...textMentioningName(rel, readFileSync(path, "utf8")));
            }
        }
        expect(
            hits,
            "Read the name from the brand (`@/app/lib/brand` in the web app, `@brand` " +
                "in the add-in, backend/src/lib/brand.ts in the API), or reword the text without it.",
        ).toEqual([]);
        // Parsing every source file takes a couple of seconds alone, far
        // longer under coverage instrumentation on a busy machine.
    }, 120_000);
});
