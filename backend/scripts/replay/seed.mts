/**
 * `seed`: gives the simulation account the Mike-side state the thread started
 * from: copies of the documents the owner attached (uploaded through the API
 * as the simulation account, so the documents module creates the versions and
 * authorization stays honest) and the owner's memory file.
 *
 * The memory_files table keeps no history (only a revision counter), so the
 * memory as of T0 cannot be recovered; the current content is used unless a
 * file with the T0 content is given.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MikeClient } from "./client.mts";
import type { ExtractedThread, MessageFileRef, SeedMap } from "./types.mts";

export type SeedOptions = {
    thread: ExtractedThread;
    /** Files named <version_id>, <document_id> or <filename>. */
    attachmentsDir?: string;
    /** A logged-in owner session, used to download attachments not found locally and to read memory. */
    owner?: MikeClient;
    memoryFile?: string;
    /** Copy the owner's current memory when no memory file is given. */
    copyOwnerMemory: boolean;
    workflowMap?: Record<string, { id: string; title: string } | null>;
    existing?: SeedMap | null;
    log: (message: string) => void;
};

/** Every attachment the replayed prompts carry, once per version. */
export function uniqueAttachments(thread: ExtractedThread): MessageFileRef[] {
    const seen = new Map<string, MessageFileRef>();
    for (const turn of thread.turns) {
        for (const file of turn.files) {
            const key = file.version_id ?? file.document_id;
            if (key && !seen.has(key)) seen.set(key, file);
        }
    }
    return [...seen.values()];
}

/** Where a local copy of `file` would be, by the names the README documents. */
export function localAttachment(dir: string, file: MessageFileRef): string | null {
    for (const name of [file.version_id, file.document_id, file.filename]) {
        if (!name || name.includes("/") || name.startsWith(".")) continue;
        const candidate = path.join(dir, name);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

export async function seedSimulation(sim: MikeClient, opts: SeedOptions): Promise<SeedMap> {
    const map: SeedMap = opts.existing ?? {
        format: "mike-replay-seed/1",
        documents: {},
        workflows: {},
        memory: null,
    };
    Object.assign(map.workflows, opts.workflowMap ?? {});

    for (const file of uniqueAttachments(opts.thread)) {
        const key = (file.version_id ?? file.document_id)!;
        if (map.documents[key]) {
            opts.log(`attachment ${file.filename}: already seeded`);
            continue;
        }
        let data: Uint8Array<ArrayBuffer> | null = null;
        const local = opts.attachmentsDir ? localAttachment(opts.attachmentsDir, file) : null;
        if (local) data = new Uint8Array(readFileSync(local));
        else if (opts.owner && file.document_id) {
            const query = file.version_id ? `?version_id=${encodeURIComponent(file.version_id)}` : "";
            data = (await opts.owner.bytes(`/single-documents/${file.document_id}/file${query}`)).data;
        }
        if (!data) {
            opts.log(`attachment ${file.filename}: no local copy and no owner session; the replay will send the prompt without it`);
            continue;
        }
        const doc = await sim.uploadDocument(file.filename, data);
        const seeded: MessageFileRef & { document_id: string } = {
            filename: typeof doc.filename === "string" ? doc.filename : file.filename,
            document_id: doc.id,
            ...(typeof doc.current_version_id === "string" ? { version_id: doc.current_version_id } : {}),
            ...(typeof doc.active_version_number === "number" ? { version_number: doc.active_version_number } : {}),
        };
        map.documents[key] = seeded;
        if (file.document_id && file.version_id) map.documents[file.document_id] ??= seeded;
        opts.log(`attachment ${file.filename}: uploaded (${data.byteLength} bytes)`);
    }

    let memory: { content: string; source: string } | null = null;
    if (opts.memoryFile) memory = { content: readFileSync(opts.memoryFile, "utf8"), source: path.basename(opts.memoryFile) };
    else if (opts.copyOwnerMemory && opts.owner) {
        const current = await opts.owner.json<{ content?: string }>("GET", "/user/memory");
        memory = { content: current.content ?? "", source: "owner's current memory" };
    }
    if (memory) {
        const target = await sim.json<{ revision?: number }>("GET", "/user/memory");
        await sim.json("PUT", "/user/memory", {
            content: memory.content,
            expected_revision: target.revision ?? 0,
        });
        map.memory = { applied: true, source: memory.source, bytes: Buffer.byteLength(memory.content) };
        opts.log(`memory: ${map.memory.bytes} bytes from ${memory.source}`);
    }
    return map;
}
