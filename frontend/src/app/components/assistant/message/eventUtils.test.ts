import { describe, expect, it } from "vitest";

import { toolCallLabel } from "./eventUtils";

describe("toolCallLabel", () => {
    it("names scripts, workstation commands and web tools in plain words", () => {
        expect(toolCallLabel("run_python")).toBe("Computing...");
        expect(toolCallLabel("run_command")).toBe(
            "Running command in workstation...",
        );
        expect(toolCallLabel("web_search")).toBe("Searching the web...");
        expect(toolCallLabel("fetch_web_page")).toBe("Reading web page...");
    });

    it("falls back for unknown and empty names", () => {
        expect(toolCallLabel("mcp_github_x")).toBe("Using connector...");
        expect(toolCallLabel("something_new")).toBe("Running something_new...");
        expect(toolCallLabel("")).toBe("Working...");
    });
});
