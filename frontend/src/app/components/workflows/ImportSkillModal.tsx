"use client";

import { useRef, useState } from "react";
import { FileArchive } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import {
    importSkillFromUrl,
    importSkillZip,
    type ImportedSkill,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

interface Props {
    open: boolean;
    onClose: () => void;
    onImported: (skill: ImportedSkill) => void;
}

/**
 * Imports a skill in the standard format (goals/mission-17-skills.md): a
 * GitHub link to a folder with a SKILL.md, or a zip of one. Importing copies
 * the files; nothing runs.
 */
export function ImportSkillModal(props: Props) {
    // Mounted only while open, so each opening starts empty.
    return props.open ? <ImportSkillForm {...props} /> : null;
}

function ImportSkillForm({ open, onClose, onImported }: Props) {
    const [url, setUrl] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const formId = "import-skill-form";
    const ready = !!file || !!url.trim();

    async function submit() {
        if (!ready || importing) return;
        setImporting(true);
        setError("");
        try {
            const skill = file
                ? await importSkillZip(file)
                : await importSkillFromUrl(url.trim());
            onImported(skill);
        } catch (caught) {
            setError(
                userFacingApiError(caught, "The skill could not be imported."),
            );
            setImporting(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="sm"
            className="h-auto"
            breadcrumbs={["Workflows", "Import skill"]}
            cancelAction={{ label: "Cancel", onClick: onClose, disabled: importing }}
            primaryAction={{
                label: importing ? "Importing..." : "Import",
                type: "submit",
                form: formId,
                disabled: !ready || importing,
            }}
        >
            <form
                id={formId}
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                }}
            >
                <p className="text-sm text-gray-600">
                    A skill is a folder with a SKILL.md and, often, scripts
                    and references. Importing copies its files; nothing runs
                    until a chat uses it.
                </p>
                <div>
                    <FieldLabel htmlFor="import-skill-url">GitHub link</FieldLabel>
                    <FormTextInput
                        id="import-skill-url"
                        type="url"
                        autoFocus
                        placeholder="https://github.com/owner/repo/tree/main/skills/name"
                        value={url}
                        disabled={!!file}
                        onChange={(event) => setUrl(event.target.value)}
                    />
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-gray-600">
                    <span>Or a zip of the folder:</span>
                    <input
                        ref={fileInput}
                        type="file"
                        accept=".zip,.skill,application/zip"
                        className="sr-only"
                        id="import-skill-file"
                        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    />
                    <TextButtonUI
                        type="button"
                        onClick={() => fileInput.current?.click()}
                    >
                        <FileArchive className="h-3.5 w-3.5" aria-hidden />
                        {file ? "Choose another" : "Choose a zip"}
                    </TextButtonUI>
                    {file && (
                        <span className="min-w-0 [overflow-wrap:anywhere] text-gray-900">
                            {file.name}
                        </span>
                    )}
                </div>
                {error && (
                    <p role="alert" className="text-sm text-red-600">
                        {error}
                    </p>
                )}
            </form>
        </Modal>
    );
}
