"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import type { Workflow } from "@/app/components/shared/types";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { textButtonUIClassName } from "@/shared/ui/TextButtonUI.styles";
import { downloadBlob } from "@/app/lib/downloadDocument";
import {
    exportSkill,
    listWorkflowVersions,
    restoreWorkflowVersion,
    type WorkflowVersion,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

interface Props {
    workflow: Workflow;
    readOnly: boolean;
    /** Called after a restore, to reload the workflow. */
    onRestored: () => void;
}

const SOURCE_LABEL: Record<WorkflowVersion["source"], string> = {
    original: "Before versions were kept",
    edit: "Edited here",
    chat: "Saved from a chat",
    import: "Imported",
    restore: "Restored",
};

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? value
        : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The skill behind an assistant workflow (goals/mission-17-skills.md): its
 * description, where it came from, its other files, and every saved version.
 */
export function WorkflowSkillPanel({ workflow, readOnly, onRestored }: Props) {
    const [versions, setVersions] = useState<WorkflowVersion[] | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [restoring, setRestoring] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        try {
            setVersions(await listWorkflowVersions(workflow.id));
            setLoadFailed(false);
        } catch {
            setLoadFailed(true);
        }
    }, [workflow.id]);

    useEffect(() => {
        let cancelled = false;
        listWorkflowVersions(workflow.id)
            .then((rows) => {
                if (!cancelled) setVersions(rows);
            })
            .catch(() => {
                if (!cancelled) setLoadFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [workflow.id]);

    async function restore(version: WorkflowVersion) {
        setRestoring(version.id);
        setError("");
        try {
            await restoreWorkflowVersion(workflow.id, version.id);
            await load();
            onRestored();
        } catch (caught) {
            setError(userFacingApiError(caught, "That version could not be restored."));
        } finally {
            setRestoring(null);
        }
    }

    async function download() {
        setExporting(true);
        setError("");
        try {
            const file = await exportSkill(workflow.id);
            await downloadBlob(file.blob, file.filename || "skill.zip");
        } catch (caught) {
            setError(userFacingApiError(caught, "The skill could not be downloaded."));
        } finally {
            setExporting(false);
        }
    }

    const files = workflow.files ?? [];
    const latest = versions?.[0]?.version_number;

    return (
        <div className="mx-4 mb-2 min-h-0 min-w-0 flex-1 overflow-auto md:mx-8 md:mb-3">
            <div className="max-w-3xl space-y-6 py-2 text-sm text-gray-700">
                <section aria-labelledby="skill-description">
                    <h2 id="skill-description" className="mb-1 text-xs font-medium text-gray-500">
                        Description
                    </h2>
                    <p className="[overflow-wrap:anywhere]">
                        {workflow.metadata.description ?? "No description. Chats see its title and the start of its instructions."}
                    </p>
                </section>

                {workflow.source_url && (
                    <section aria-labelledby="skill-source">
                        <h2 id="skill-source" className="mb-1 text-xs font-medium text-gray-500">
                            Imported from
                        </h2>
                        <a
                            href={workflow.source_url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className={textButtonUIClassName({
                                size: "xs",
                                className: "inline shrink px-0 text-left text-sm [overflow-wrap:anywhere]",
                            })}
                        >
                            {workflow.source_url}
                            <ExternalLink className="ml-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
                        </a>
                    </section>
                )}

                <section aria-labelledby="skill-files">
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                        <h2 id="skill-files" className="text-xs font-medium text-gray-500">
                            Files
                        </h2>
                        <TextButtonUI loading={exporting} onClick={() => void download()}>
                            <Download className="h-3.5 w-3.5" aria-hidden />
                            Download skill folder
                        </TextButtonUI>
                    </div>
                    <ul className="space-y-0.5">
                        <li>SKILL.md</li>
                        {files.map((file) => (
                            <li key={file.path} className="flex min-w-0 flex-wrap gap-x-2">
                                <span className="min-w-0 [overflow-wrap:anywhere]">{file.path}</span>
                                <span className="text-gray-500">{formatSize(file.size)}</span>
                            </li>
                        ))}
                    </ul>
                </section>

                <section aria-labelledby="skill-versions">
                    <h2 id="skill-versions" className="mb-1 text-xs font-medium text-gray-500">
                        Versions
                    </h2>
                    {loadFailed ? (
                        <p role="alert">The versions could not be loaded.</p>
                    ) : versions === null ? (
                        <div role="status" aria-label="Loading versions" className="space-y-2">
                            <SkeletonLine className="w-64" />
                            <SkeletonLine className="w-56" />
                        </div>
                    ) : versions.length === 0 ? (
                        <p>No earlier versions yet. Each change from now on is kept.</p>
                    ) : (
                        <ol className="space-y-2">
                            {versions.map((version) => (
                                <li key={version.id} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                                    <span className="font-medium text-gray-900">
                                        Version {version.version_number}
                                        {version.version_number === latest ? " (current)" : ""}
                                    </span>
                                    <span>{SOURCE_LABEL[version.source]}</span>
                                    <span className="text-gray-500">{formatDate(version.created_at)}</span>
                                    {!readOnly && version.version_number !== latest && (
                                        <TextButtonUI
                                            loading={restoring === version.id}
                                            disabled={restoring !== null}
                                            onClick={() => void restore(version)}
                                        >
                                            Restore
                                        </TextButtonUI>
                                    )}
                                </li>
                            ))}
                        </ol>
                    )}
                </section>

                {error && (
                    <p role="alert" className="text-red-600">
                        {error}
                    </p>
                )}
            </div>
        </div>
    );
}
