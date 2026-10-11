// Importing a published skill (goals/mission-17-skills.md): a GitHub folder
// with a SKILL.md, resolved to a commit so the source is exact, or an
// uploaded zip. Import only reads files; it never runs them.

import path from "node:path";
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  SKILL_FILE,
  SkillFormatError,
  skillFromFiles,
  unpackSkillZip,
  type Skill,
} from "../../lib/skillFormat";

const TIMEOUT_MS = 30_000;
const COMMIT = /^[0-9a-f]{40}$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export type ImportedSkill = { skill: Skill; sourceUrl: string | null };

type GithubLocation = { owner: string; repo: string; rest: string[]; kind: "tree" | "blob" | "root" };

/** owner, repository and what follows, from a github.com or raw URL. */
export function parseGithubUrl(raw: string): GithubLocation | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "raw.githubusercontent.com") {
    const [owner, repo, ...rest] = parts;
    if (!owner || !repo || !rest.length) return null;
    return SEGMENT.test(owner) && SEGMENT.test(repo) ? { owner, repo, rest, kind: "blob" } : null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const [owner, repoPart, kind, ...rest] = parts;
  const repo = repoPart?.replace(/\.git$/, "");
  if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo)) return null;
  if (!kind) return { owner, repo, rest: [], kind: "root" };
  if ((kind === "tree" || kind === "blob") && rest.length) return { owner, repo, rest, kind };
  return null;
}

type Fetch = typeof fetch;

function headers(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "mike-skill-import",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function getJson(fetchImpl: Fetch, url: string, token?: string): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, { headers: headers(token), signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: response.status, body: response.ok ? await response.json() : null };
}

/**
 * The commit a URL's ref names, and the path after it. A branch name may hold
 * slashes ("feature/x/skills/a"), so longer refs are tried in turn.
 */
async function resolveRef(
  fetchImpl: Fetch,
  location: GithubLocation,
  token?: string,
): Promise<{ commit: string; dir: string }> {
  const api = `https://api.github.com/repos/${location.owner}/${location.repo}`;
  if (location.kind === "root") {
    const repo = await getJson(fetchImpl, api, token);
    const branch = (repo.body as { default_branch?: string } | null)?.default_branch;
    if (!branch) throw new SkillFormatError("That GitHub repository could not be found, or it is private.");
    location = { ...location, rest: [branch], kind: "tree" };
  }
  for (let length = 1; length <= Math.min(location.rest.length, 5); length += 1) {
    const ref = location.rest.slice(0, length).join("/");
    const rest = location.rest.slice(length).join("/");
    if (COMMIT.test(ref)) return { commit: ref, dir: rest };
    const result = await getJson(fetchImpl, `${api}/commits/${encodeURIComponent(ref)}`, token);
    const sha = (result.body as { sha?: string } | null)?.sha;
    if (sha && COMMIT.test(sha)) return { commit: sha, dir: rest };
    if (result.status !== 404 && result.status !== 422) {
      throw new SkillFormatError("GitHub did not answer; try again in a minute.");
    }
  }
  throw new SkillFormatError("That GitHub branch or commit could not be found.");
}

type TreeEntry = { path: string; mode: string; type: string; size?: number };

export async function importSkillFromGithub(
  url: string,
  opts: { fetchImpl?: Fetch; token?: string } = {},
): Promise<ImportedSkill> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token ?? process.env.MIKE_WORKFLOWS_GITHUB_TOKEN;
  const location = parseGithubUrl(url);
  if (!location) {
    throw new SkillFormatError("Give a GitHub link to a skill's folder, like github.com/owner/repo/tree/main/skills/name.");
  }
  const { commit, dir: rawDir } = await resolveRef(fetchImpl, location, token);
  // A link to the SKILL.md itself means its folder.
  const dir = path.posix.basename(rawDir) === SKILL_FILE ? path.posix.dirname(rawDir).replace(/^\.$/, "") : rawDir;

  const tree = await getJson(
    fetchImpl,
    `https://api.github.com/repos/${location.owner}/${location.repo}/git/trees/${commit}?recursive=1`,
    token,
  );
  const entries = ((tree.body as { tree?: TreeEntry[] } | null)?.tree ?? []) as TreeEntry[];
  if (!entries.length) throw new SkillFormatError("That GitHub repository could not be read.");
  const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
  const inside = entries.filter((entry) => entry.path.startsWith(prefix));
  if (!inside.some((entry) => entry.type === "blob" && entry.path === `${prefix}${SKILL_FILE}`)) {
    const nested = entries
      .filter((entry) => entry.path.startsWith(prefix) && entry.path.endsWith(`/${SKILL_FILE}`))
      .map((entry) => path.posix.dirname(entry.path))
      .slice(0, 10);
    throw new SkillFormatError(
      nested.length
        ? `That folder has no SKILL.md. Skills inside it: ${nested.join(", ")}. Import one of those.`
        : "That folder has no SKILL.md, so it is not a skill.",
    );
  }
  const blobs: TreeEntry[] = [];
  let total = 0;
  for (const entry of inside) {
    if (entry.mode === "120000") throw new SkillFormatError(`The skill contains a symbolic link: ${entry.path}.`);
    if (entry.type !== "blob") continue;
    blobs.push(entry);
    total += entry.size ?? 0;
    if ((entry.size ?? 0) > MAX_SKILL_FILE_BYTES) throw new SkillFormatError(`${entry.path} is larger than 5 MB.`);
  }
  if (blobs.length > MAX_SKILL_FILES) throw new SkillFormatError(`A skill can have at most ${MAX_SKILL_FILES} files.`);
  if (total > MAX_SKILL_BYTES) throw new SkillFormatError("The skill is larger than 20 MB.");

  const files = await Promise.all(
    blobs.map(async (entry) => {
      const encoded = entry.path.split("/").map(encodeURIComponent).join("/");
      const response = await fetchImpl(
        `https://raw.githubusercontent.com/${location.owner}/${location.repo}/${commit}/${encoded}`,
        { headers: { "User-Agent": "mike-skill-import" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!response.ok) throw new SkillFormatError(`GitHub did not return ${entry.path}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_SKILL_FILE_BYTES) throw new SkillFormatError(`${entry.path} is larger than 5 MB.`);
      return { path: entry.path.slice(prefix.length), bytes };
    }),
  );
  const folderName = dir ? path.posix.basename(dir) : location.repo;
  return {
    skill: skillFromFiles(files, folderName),
    sourceUrl: `https://github.com/${location.owner}/${location.repo}/tree/${commit}${dir ? `/${dir}` : ""}`,
  };
}

export async function importSkillFromZip(bytes: Buffer, filename?: string): Promise<ImportedSkill> {
  const files = await unpackSkillZip(bytes);
  const fallback = filename ? path.posix.basename(filename).replace(/\.(zip|skill)$/i, "") : undefined;
  return { skill: skillFromFiles(files, fallback), sourceUrl: null };
}
