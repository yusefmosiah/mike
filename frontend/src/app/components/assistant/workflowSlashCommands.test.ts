import { describe, expect, it } from "vitest";
import type { Workflow } from "../shared/types";
import {
    exactSlashWorkflow,
    matchesNoResponseCommand,
    matchingSlashWorkflows,
    noResponseContent,
    slashCommandQuery,
    withoutSlashCommand,
    workflowSlashCommand,
} from "./workflowSlashCommands";

const workflow = {
    id: "workflow-1",
    metadata: {
        name: "ignored-machine-name",
        title: "Contract Intake",
    },
} as Workflow;

describe("workflow slash commands", () => {
    it("derives the command from the workflow title", () => {
        expect(workflowSlashCommand(workflow)).toBe("/contract-intake");
    });

    it("strips punctuation and replaces whitespace with hyphens", () => {
        const titledWorkflow = {
            ...workflow,
            metadata: {
                ...workflow.metadata,
                title: "  Contract & Intake   2026!  ",
            },
        } as Workflow;

        expect(workflowSlashCommand(titledWorkflow)).toBe(
            "/contract-intake-2026",
        );
    });

    it("preserves and normalizes hyphens in the workflow title", () => {
        const titledWorkflow = {
            ...workflow,
            metadata: {
                ...workflow.metadata,
                title: "Pre-Merger - Review",
            },
        } as Workflow;

        expect(workflowSlashCommand(titledWorkflow)).toBe(
            "/pre-merger-review",
        );
    });

    it("supports alphabetical and numeric characters outside ASCII", () => {
        const titledWorkflow = {
            ...workflow,
            metadata: {
                ...workflow.metadata,
                title: "Révision 合同 2",
            },
        } as Workflow;

        expect(workflowSlashCommand(titledWorkflow)).toBe("/révision-合同-2");
    });

    it("does not create a command when the title has no letters or numbers", () => {
        const titledWorkflow = {
            ...workflow,
            metadata: { ...workflow.metadata, title: " --- !!! " },
        } as Workflow;

        expect(workflowSlashCommand(titledWorkflow)).toBeNull();
    });

    it("recognizes a command being typed anywhere in the draft", () => {
        expect(slashCommandQuery("/contract")).toBe("/contract");
        // A command can start mid-message, as long as it starts a word.
        expect(slashCommandQuery("please run /contract")).toBe("/contract");
        expect(slashCommandQuery("please run\n/contract")).toBe("/contract");
        // Not a command: mid-word, already finished, or followed by prose.
        expect(slashCommandQuery("and/or")).toBeNull();
        expect(slashCommandQuery("/contract ")).toBeNull();
        expect(slashCommandQuery("/contract run this")).toBeNull();
    });

    it("removes only the command when a workflow is chosen", () => {
        expect(withoutSlashCommand("/contract")).toBe("");
        expect(withoutSlashCommand("please run /contract")).toBe("please run ");
        expect(withoutSlashCommand("nothing to strip")).toBe(
            "nothing to strip",
        );
    });

    it("matches workflows by trigger prefix", () => {
        expect(matchingSlashWorkflows([workflow], "/cont")).toEqual([workflow]);
        expect(matchingSlashWorkflows([workflow], "/other")).toEqual([]);
    });

    it("resolves an exact trigger", () => {
        expect(exactSlashWorkflow([workflow], "/CONTRACT-INTAKE")).toBe(
            workflow,
        );
    });
});

describe("the /nr command", () => {
    it("reads a leading /nr or /no-response, and nothing else", () => {
        expect(noResponseContent("/nr  Noted ")).toBe("Noted");
        expect(noResponseContent("  /No-Response\nline two")).toBe("line two");
        expect(noResponseContent("/nr")).toBe("");
        expect(noResponseContent("/nrx hello")).toBeNull();
        expect(noResponseContent("hello /nr")).toBeNull();
    });

    it("is offered only while the command itself is being typed at the start", () => {
        expect(matchesNoResponseCommand("/", "/")).toBe(true);
        expect(matchesNoResponseCommand("/no", "/no")).toBe(true);
        expect(matchesNoResponseCommand("/NR", "/nr")).toBe(true);
        expect(matchesNoResponseCommand("note /n", "/n")).toBe(false);
        expect(matchesNoResponseCommand("/x", "/x")).toBe(false);
    });
});
