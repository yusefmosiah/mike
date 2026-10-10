import type { Workflow } from "../shared/types";
import {
    slashCommandQueryFromValue,
    withoutSlashCommand,
    workflowSlashCommandFromTitle,
} from "@/shared/ui/WorkflowSlashCommandUI";

export { withoutSlashCommand };

export function workflowSlashCommand(workflow: Workflow): string | null {
    return workflowSlashCommandFromTitle(workflow.metadata.title);
}

/** The composer's built-in command: `/nr` adds the message without a reply. */
export const NO_RESPONSE_COMMAND = "/nr";
const NO_RESPONSE = /^\/(?:nr|no-response)(?=\s|$)\s*/i;

/**
 * The message without its leading `/nr` (or `/no-response`), or null when
 * the draft does not start with one.
 */
export function noResponseContent(value: string): string | null {
    const trimmed = value.trimStart();
    return NO_RESPONSE.test(trimmed) ? trimmed.replace(NO_RESPONSE, "").trim() : null;
}

/** Whether the built-in command fits what is being typed: only at the start. */
export function matchesNoResponseCommand(value: string, query: string | null): boolean {
    if (query === null || value.trimStart().toLowerCase() !== query) return false;
    return NO_RESPONSE_COMMAND.startsWith(query) || "/no-response".startsWith(query);
}

export function slashCommandQuery(value: string): string | null {
    return slashCommandQueryFromValue(value);
}

export function matchingSlashWorkflows(
    workflows: Workflow[],
    query: string | null,
): Workflow[] {
    if (query === null) return [];
    return workflows.filter((workflow) =>
        workflowSlashCommand(workflow)?.startsWith(query),
    );
}

export function exactSlashWorkflow(
    workflows: Workflow[],
    query: string,
): Workflow | undefined {
    const normalized = query.toLowerCase();
    return workflows.find(
        (workflow) => workflowSlashCommand(workflow) === normalized,
    );
}
