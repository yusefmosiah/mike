#!/usr/bin/env node
// Run what the gating CI workflow (.github/workflows/ci.yml) runs, before a
// push. A red CI on main skips the staging deploy, so run this first.
//
//   npm run verify                  everything ci.yml runs except the Docker images
//   npm run verify -- --full        also build the three Docker images
//   npm run verify -- backend       one package: backend or frontend
//   npm run verify -- --workers 2   cap the test workers (a shared machine)
//
// Quick checks (types, lint, builds) run before the test suites, the way CI
// reports them first, and the run stops at the first failure. Nothing here
// installs dependencies: run `npm ci` in a package whose lockfile changed.
// See docs/ci.md.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const full = args.includes("--full");
const workersAt = args.indexOf("--workers");
const workers = workersAt === -1 ? null : Number(args[workersAt + 1]);
if (workersAt !== -1 && !(workers > 0)) usage("--workers needs a positive number");
const packages = args.filter((arg, i) => !arg.startsWith("--") && (workersAt === -1 || i !== workersAt + 1));
for (const name of packages) if (!["backend", "frontend"].includes(name)) usage(`unknown package ${name}`);
const wants = (name) => packages.length === 0 || packages.includes(name);

const testArgs = workers ? ["--", `--maxWorkers=${workers}`] : [];
const steps = [];
const npm = (cwd, script, extra = []) => steps.push({ label: `${cwd}: npm run ${script}`, cwd, command: "npm", args: ["run", script, ...extra] });

// Quick checks first, in CI's order within each job.
if (packages.length === 0) steps.push({ label: "npm run typecheck:e2e", cwd: ".", command: "npm", args: ["run", "typecheck:e2e"] });
if (wants("backend")) {
    npm("backend", "typecheck:test");
    npm("backend", "typecheck:contracts");
    npm("backend", "build");
}
if (wants("frontend")) {
    npm("frontend", "typecheck");
    npm("frontend", "lint");
    npm("frontend", "build");
    npm("frontend", "catalog:build");
}
// Then the suites, with their coverage floors: judged by exit code.
if (wants("backend")) npm("backend", "test:coverage", testArgs);
if (wants("frontend")) npm("frontend", "test:coverage", testArgs);
if (full) {
    for (const image of ["frontend", "backend", "word-addin"]) {
        const buildArgs = image === "word-addin"
            ? ["--build-arg", "REACT_APP_WEB_APP_URL=https://app.example.com", "--build-arg", "WORD_ADDIN_PUBLIC_URL=https://word.example.com"]
            : [];
        steps.push({
            label: `docker build ${image}`,
            cwd: ".",
            command: "docker",
            args: ["build", "-f", `${image}/Dockerfile`, ...buildArgs, "."],
        });
    }
}

const started = Date.now();
for (const [index, step] of steps.entries()) {
    console.log(`\n▶ [${index + 1}/${steps.length}] ${step.label}`);
    const stepStarted = Date.now();
    const result = spawnSync(step.command, step.args, { cwd: path.join(root, step.cwd), stdio: "inherit" });
    const seconds = Math.round((Date.now() - stepStarted) / 1000);
    if (result.status !== 0) {
        console.error(`\n✗ ${step.label} failed after ${seconds}s. CI would fail the same way.`);
        process.exit(result.status ?? 1);
    }
    console.log(`✓ ${step.label} (${seconds}s)`);
}
console.log(`\n✓ All ${steps.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s.`);

function usage(message) {
    console.error(`${message}\nusage: npm run verify -- [backend|frontend] [--full] [--workers N]`);
    process.exit(2);
}
