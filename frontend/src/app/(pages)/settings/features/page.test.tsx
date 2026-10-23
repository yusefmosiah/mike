import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FeaturesPage from "./page";

const state = vi.hoisted(() => ({
    source: "env" as "env" | "user" | null,
    backgroundAgents: false,
    updateBackgroundAgents: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            legalResearchUs: true,
            quickActionsVisible: true,
            backgroundAgents: state.backgroundAgents,
            apiKeys: {
                courtlistener: {
                    configured: state.source !== null,
                    source: state.source,
                },
            },
        },
        updateApiKey: vi.fn(),
        updateLegalResearchUs: vi.fn(),
        updateQuickActionsVisible: vi.fn(),
        updateBackgroundAgents: state.updateBackgroundAgents,
    }),
}));

vi.mock("@/app/components/settings/ApiKeyField", () => ({
    ApiKeyField: ({ hasSavedKey }: { hasSavedKey: boolean }) => (
        <div data-testid="courtlistener-key-state">
            {hasSavedKey ? "personal" : "server-or-empty"}
        </div>
    ),
}));

describe("FeaturesPage CourtListener key", () => {
    beforeEach(() => {
        state.source = "env";
        state.backgroundAgents = false;
        state.updateBackgroundAgents = vi.fn().mockResolvedValue(true);
    });

    it("does not offer removal for a server-configured token", () => {
        render(<FeaturesPage />);
        expect(screen.getByTestId("courtlistener-key-state")).toHaveTextContent(
            "server-or-empty",
        );
    });

    it("marks a personal token as saved", () => {
        state.source = "user";
        render(<FeaturesPage />);
        expect(screen.getByTestId("courtlistener-key-state")).toHaveTextContent(
            "personal",
        );
    });
});

describe("FeaturesPage background subagents", () => {
    beforeEach(() => {
        state.source = "env";
        state.backgroundAgents = false;
        state.updateBackgroundAgents = vi.fn().mockResolvedValue(true);
    });

    it("renders an off, named switch and turns it on", async () => {
        render(<FeaturesPage />);
        const toggle = screen.getByRole("switch", {
            name: "Background subagents",
        });
        expect(toggle).toHaveAttribute("aria-checked", "false");
        fireEvent.click(toggle);
        await waitFor(() =>
            expect(state.updateBackgroundAgents).toHaveBeenCalledWith(true),
        );
    });

    it("turns it off when it is on", async () => {
        state.backgroundAgents = true;
        render(<FeaturesPage />);
        const toggle = screen.getByRole("switch", {
            name: "Background subagents",
        });
        expect(toggle).toHaveAttribute("aria-checked", "true");
        fireEvent.click(toggle);
        await waitFor(() =>
            expect(state.updateBackgroundAgents).toHaveBeenCalledWith(false),
        );
    });

    it("shows an error when saving fails", async () => {
        state.updateBackgroundAgents = vi.fn().mockResolvedValue(false);
        render(<FeaturesPage />);
        fireEvent.click(
            screen.getByRole("switch", { name: "Background subagents" }),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Could not update",
        );
    });
});
