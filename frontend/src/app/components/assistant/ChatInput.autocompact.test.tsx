import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    getAutocompactSetting,
    listWorkflows,
    MikeApiError,
    setAutocompactTokens,
} from "@/app/lib/mikeApi";
import { ChatInput } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", async () => {
    const actual = await vi.importActual<typeof import("@/app/lib/mikeApi")>("@/app/lib/mikeApi");
    return {
        MikeApiError: actual.MikeApiError,
        reportedUpstreamMessage: actual.reportedUpstreamMessage,
        listWorkflows: vi.fn(),
        getAutocompactSetting: vi.fn(),
        setAutocompactTokens: vi.fn(),
        uploadProjectDocuments: vi.fn(),
        uploadStandaloneDocuments: vi.fn(),
    };
});

vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["gemini-3-flash-preview", vi.fn()],
    useSelectedReasoning: () => ["high", vi.fn()],
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));
vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));
vi.mock("@/app/hooks/useModelVision", () => ({ useModelVision: () => ({}) }));

vi.mock("./AddDocButton", () => ({ AddDocButton: () => null }));
vi.mock("./UploadOverlay", () => ({ UploadOverlay: () => null }));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({ AddDocumentsModal: () => null }));
vi.mock("./AssistantWorkflowModal", () => ({ AssistantWorkflowModal: () => null }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({ ApiKeyMissingPopup: () => null }));
// The real model names; only the picker itself is stubbed.
vi.mock("./ModelToggle", async () => ({
    ...(await vi.importActual<typeof import("./ModelToggle")>("./ModelToggle")),
    ModelToggle: () => null,
}));

const SETTING = {
    model: "gemini-3-flash-preview",
    tokens: null,
    defaultTokens: 500_000,
    effectiveTokens: 500_000,
    contextWindow: 1_000_000,
    minTokens: 20_000,
    maxTokens: 1_000_000,
};

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

function renderInput() {
    const onSubmit = vi.fn();
    render(<ChatInput onSubmit={onSubmit} onCancel={vi.fn()} isLoading={false} />);
    return { onSubmit, input: screen.getByRole("combobox") };
}

describe("ChatInput /autocompact", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        vi.mocked(listWorkflows).mockResolvedValue([]);
        vi.mocked(setAutocompactTokens).mockImplementation(async (_model, tokens) => ({
            ...SETTING,
            tokens,
            effectiveTokens: tokens ?? SETTING.defaultTokens,
        }));
        vi.mocked(getAutocompactSetting).mockResolvedValue(SETTING);
    });

    it("sets the threshold for the selected model and never sends the command to the model", async () => {
        const user = userEvent.setup();
        const { onSubmit, input } = renderInput();

        await user.type(input, "/autocompact 421k");
        await user.keyboard("{Meta>}{Enter}{/Meta}");

        expect(await screen.findByRole("status")).toHaveTextContent(
            "Auto-compact for Gemini 3 Flash set to 421k tokens.",
        );
        expect(setAutocompactTokens).toHaveBeenCalledWith("gemini-3-flash-preview", 421_000);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(input).toHaveValue("");

        // The notice is ephemeral: the next edit clears it.
        await user.type(input, "h");
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("reports the current value for a bare /autocompact", async () => {
        const user = userEvent.setup();
        const { onSubmit, input } = renderInput();

        await user.type(input, "/autocompact ");
        await user.keyboard("{Meta>}{Enter}{/Meta}");

        expect(await screen.findByRole("status")).toHaveTextContent(
            "Auto-compact for Gemini 3 Flash uses the default, 500k tokens.",
        );
        expect(getAutocompactSetting).toHaveBeenCalledWith("gemini-3-flash-preview");
        expect(setAutocompactTokens).not.toHaveBeenCalled();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("keeps the draft and explains a value the server refuses", async () => {
        vi.mocked(setAutocompactTokens).mockRejectedValueOnce(
            new MikeApiError({ status: 400, message: "Choose a value from 20k to 1m tokens for this model." }),
        );
        const user = userEvent.setup();
        const { onSubmit, input } = renderInput();

        await user.type(input, "/autocompact 5k");
        await user.keyboard("{Meta>}{Enter}{/Meta}");

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Choose a value from 20k to 1m tokens for this model.",
        );
        expect(input).toHaveValue("/autocompact 5k");
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("explains how to use it for a value it cannot read", async () => {
        const user = userEvent.setup();
        const { input } = renderInput();

        await user.type(input, "/autocompact lots");
        await user.keyboard("{Meta>}{Enter}{/Meta}");

        expect(await screen.findByRole("alert")).toHaveTextContent("/autocompact 500k");
        expect(setAutocompactTokens).not.toHaveBeenCalled();
    });

    it("offers the command in the slash menu", async () => {
        const user = userEvent.setup();
        const { input } = renderInput();

        await user.type(input, "/auto");

        expect(await screen.findByText("/autocompact")).toBeInTheDocument();
    });
});
