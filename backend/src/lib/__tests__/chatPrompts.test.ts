import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../modules/chat/engine/prompts";
import { COURTLISTENER_SYSTEM_PROMPT } from "../../modules/chat/engine/tools/courtlistenerTools";
import { buildWordChatSystemPrompt } from "../../modules/chat/engine/wordPrompt";
import { buildTabularMessages } from "../../modules/tabular/tabular.chats";
import { MIKE_OPEN_SOURCE } from "../agentIdentity";

describe("buildSystemPrompt", () => {
    it("always contains the core identity and rules", () => {
        for (const prompt of [buildSystemPrompt(true), buildSystemPrompt(false)]) {
            expect(prompt).toContain(
                "This is the system prompt for Mike, an open-source AI agent for knowledge work",
            );
            expect(prompt).toContain("Do not fabricate document content.");
            expect(prompt).toContain(
                "In user-facing responses, use natural language only",
            );
            expect(prompt).toContain(
                "Never mention tool names or tool calls when reporting your work",
            );
            // No small round budget: the runtime's limit is a runaway backstop.
            expect(prompt).not.toMatch(/at most \d+ tool-use rounds/);
            expect(prompt).toContain("DOCX GENERATION:");
            expect(prompt).toContain("DOCUMENT EDITING:");
        }
    });

    it("always contains the citation contract the parser depends on", () => {
        for (const prompt of [buildSystemPrompt(true), buildSystemPrompt(false)]) {
            expect(prompt).toContain("<CITATIONS>");
            expect(prompt).toContain("</CITATIONS>");
            expect(prompt).toContain(
                `Every [N] marker must have exactly one matching entry with "ref": N.`,
            );
            expect(prompt).toContain(
                `"doc_id" must be the exact chat-local label you were given`,
            );
        }
    });

    it("requires renderable tables and formulas", () => {
        for (const prompt of [buildSystemPrompt(true), buildSystemPrompt(false)]) {
            expect(prompt).toContain("RESPONSE FORMATTING:");
            // The chat renders GFM pipe tables; grid tables show as raw text.
            expect(prompt).toContain("use Markdown pipe tables only");
            expect(prompt).toContain("Never draw tables with +, -, and | borders");
            // Single-dollar math is disabled in the renderer so prices stay text.
            expect(prompt).toContain("Do not use LaTeX for them.");
            expect(prompt).toContain(
                "wrap it in double dollar signs ($$ ... $$), never single dollar signs",
            );
            expect(prompt).toContain(
                String.raw`$$\text{Price} = \frac{\$7{,}000{,}000}{\text{Shares}}$$`,
            );
        }
    });

    it("never instructs the model to fabricate citation quotes", () => {
        for (const prompt of [buildSystemPrompt(true), buildSystemPrompt(false)]) {
            expect(prompt).not.toContain("TESTING ONLY");
            expect(prompt).not.toContain("deliberately false text");
            expect(prompt).not.toContain("Make 50% of document citation quotes");
        }
    });

    it("always contains the doc-label hygiene and reasoning-trace safety rules", () => {
        for (const prompt of [buildSystemPrompt(true), buildSystemPrompt(false)]) {
            expect(prompt).toContain("REASONING TRACE SAFETY:");
            expect(prompt).toContain(
                `Never show "doc-N" labels to the user in prose`,
            );
        }
    });

    it("separates workflows and Library Templates with copy-before-edit rules", () => {
        for (const prompt of [buildSystemPrompt(true), buildSystemPrompt(false)]) {
            expect(prompt).toContain("WORKFLOWS:");
            expect(prompt).toContain("LIBRARY TEMPLATES:");
            expect(prompt).toContain(
                "Workflow assets used as templates are immutable",
            );
            expect(prompt).toContain("Library Templates are immutable");
            expect(prompt).toContain(
                "call replicate_document with a descriptive new_filename",
            );
            expect(prompt).toContain(
                "open the relevant assets with read_document before continuing",
            );
            // edit_document only handles .docx, so the copy-then-edit
            // mandate is scoped to .docx copies in both sections, with a
            // generate-from-copy path for pdf/xlsx templates.
            expect(
                prompt.match(
                    /call edit_document on the returned copy rather than generating a replacement/g,
                ),
            ).toHaveLength(2);
            expect(
                prompt.match(
                    /produce the filled-in result as a new generated document/g,
                ),
            ).toHaveLength(2);
        }
    });

    it("puts the CourtListener instructions after the general sections, as one tool's instructions", () => {
        const prompt = buildSystemPrompt(true);
        expect(prompt).toContain(COURTLISTENER_SYSTEM_PROMPT);
        const toolsIdx = prompt.indexOf("TOOL INSTRUCTIONS:");
        const researchIdx = prompt.indexOf("US CASE LAW RESEARCH:");
        const generalIdx = prompt.indexOf("GENERAL GUIDANCE:");
        expect(generalIdx).toBeLessThan(toolsIdx);
        expect(toolsIdx).toBeLessThan(researchIdx);
    });

    it("omits the CourtListener instructions entirely when research is off", () => {
        const prompt = buildSystemPrompt(false);
        expect(prompt).not.toContain("US CASE LAW RESEARCH");
        expect(prompt).not.toContain("courtlistener");
        // Both base sections are still present and in order.
        const editingIdx = prompt.indexOf("DOCUMENT EDITING:");
        const afterIdx = prompt.indexOf("DOCUMENT NAMES IN PROSE:");
        expect(editingIdx).toBeGreaterThan(-1);
        expect(editingIdx).toBeLessThan(afterIdx);
    });

    it("defaults to including research tools", () => {
        expect(buildSystemPrompt()).toBe(buildSystemPrompt(true));
    });
});

// Mike is a general knowledge-work agent; legal tools are part of its tool
// set, not its identity. A legal-only identity made models refuse ordinary
// questions ("what are the baseball scores?"). Every surface introduces
// Mike honestly, as the prompt of an open-source agent, rather than casting
// the model in a role, and says the source is public so the model explains
// how it works when asked.
describe("assistant identity", () => {
    const tabularSystem = () => {
        const [system] = buildTabularMessages(
            [],
            { documents: [], columns: [], cells: new Map() },
            "Review",
        ) as { content: string }[];
        return system.content;
    };
    const surfaces: [string, () => string][] = [
        ["assistant", () => buildSystemPrompt(true)],
        ["assistant without research", () => buildSystemPrompt(false)],
        ["Word", () => buildWordChatSystemPrompt(false)],
        ["Word client tools", () => buildWordChatSystemPrompt(true)],
        ["tabular", tabularSystem],
    ];

    it.each(surfaces)("%s introduces Mike as an open-source agent, without role-play", (_name, build) => {
        const prompt = build();
        expect(prompt).toMatch(/^This is the system prompt for Mike, an open-source AI agent for knowledge work/);
        expect(prompt).toContain(MIKE_OPEN_SOURCE);
        expect(prompt).not.toMatch(/\byou are (mike|an? )/i);
        expect(prompt).not.toMatch(/legal assistant|legal document analyst|strength in legal/i);
        expect(prompt).not.toContain("for lawyers and legal professionals");
    });

    it("treats legal tools as part of the tool set, not the subject", () => {
        const prompt = buildSystemPrompt(true);
        expect(prompt).toContain("they are part of the tool set, not the limit of what you help with");
        expect(prompt).toContain("answer from general knowledge, whatever the subject");
        expect(prompt).not.toMatch(/Guth v\. Loft|demand letters|the NDA draft|statutory links/);
    });

    it("tells the model to look up current facts instead of declining", () => {
        const prompt = buildSystemPrompt(false);
        expect(prompt).toContain("sports scores");
        expect(prompt).toContain("rather than declining");
    });
});
