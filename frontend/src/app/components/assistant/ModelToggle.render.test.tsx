import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    mergeConfiguredModelOptions,
    ModelToggle,
    openCodeGoModelOptions,
    openRouterModelOptions,
    vercelModelOptions,
} from "./ModelToggle";
import type {
    ApiKeyState,
    ConfiguredModelOption,
} from "@/app/lib/mikeApi";

const { configuredModels } = vi.hoisted(() => ({
    configuredModels: [] as ConfiguredModelOption[],
}));

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [],
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => configuredModels,
}));
vi.mock("@/app/hooks/useModelVision", () => ({
    useModelVision: () => ({ "gemini-3-flash-preview": true, "gemini-3.5-flash": false }),
}));

beforeEach(() => configuredModels.splice(0));

it("lets deployment configuration override a duplicate catalog id", () => {
    expect(
        mergeConfiguredModelOptions(
            [{ id: "same", label: "Configured", group: "Configured" }],
            [{ id: "same", label: "Static", group: "OpenAI" }],
        ),
    ).toEqual([{ id: "same", label: "Configured", group: "Configured" }]);
});

function keys(configured: Partial<Record<keyof ApiKeyState, boolean>>) {
    const providers = [
        "claude",
        "gemini",
        "openai",
        "openrouter",
        "vercel",
        "opencode-go",
        "courtlistener",
    ] as const;
    return Object.fromEntries(
        providers.map((provider) => [
            provider,
            {
                configured: configured[provider] ?? false,
                source: configured[provider] ? "user" : null,
            },
        ]),
    ) as ApiKeyState;
}

describe("ModelToggle vision", () => {
    it("says which models can see images, in plain text", async () => {
        const user = userEvent.setup();
        render(<ModelToggle value="gemini-3-flash-preview" onChange={vi.fn()} apiKeys={keys({ gemini: true })} />);

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        expect(screen.getByRole("menuitem", { name: /^Gemini 3 Flash,\s*Sees images$/ })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Gemini 3.5 Flash" })).not.toHaveTextContent("Sees images");
    });
});

describe("ModelToggle responsive trigger", () => {
    it("offers every supported reasoning level through a discrete slider", async () => {
        const user = userEvent.setup();
        const onReasoningChange = vi.fn();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
                reasoningLevel="high"
                onReasoningChange={onReasoningChange}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        const reasoning = screen.getByRole("slider", {
            name: "Reasoning level",
        });
        expect(reasoning).toHaveAttribute("min", "0");
        expect(reasoning).toHaveAttribute("max", "4");
        expect(reasoning).toHaveValue("3");
        expect(reasoning).toHaveAttribute("aria-valuetext", "High");

        fireEvent.change(reasoning, { target: { value: "4" } });

        expect(onReasoningChange).toHaveBeenLastCalledWith("xhigh");
        expect(
            screen.getByRole("slider", { name: "Reasoning level" }),
        ).toBeInTheDocument();
    });

    it("offers Max for GPT-5.6 without offering Minimal", async () => {
        const onReasoningChange = vi.fn();
        render(
            <ModelToggle
                value="gpt-5.6-terra"
                onChange={vi.fn()}
                apiKeys={keys({ openai: true })}
                reasoningLevel="low"
                onReasoningChange={onReasoningChange}
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Choose model" }),
        );
        const reasoning = screen.getByRole("slider", {
            name: "Reasoning level",
        });
        expect(reasoning).toHaveAttribute("max", "5");
        expect(reasoning).toHaveValue("1");
        expect(screen.queryByText("Minimal")).not.toBeInTheDocument();

        fireEvent.change(reasoning, { target: { value: "5" } });
        expect(onReasoningChange).toHaveBeenLastCalledWith("max");
    });

    it("uses the provider-supported GPT-5.5 levels", async () => {
        const onReasoningChange = vi.fn();
        render(
            <ModelToggle
                value="gpt-5.5"
                onChange={vi.fn()}
                apiKeys={keys({ openai: true })}
                reasoningLevel="low"
                onReasoningChange={onReasoningChange}
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Choose model" }),
        );
        const reasoning = screen.getByRole("slider", {
            name: "Reasoning level",
        });
        expect(reasoning).toHaveAttribute("max", "4");
        expect(reasoning).toHaveValue("1");
        expect(screen.queryByText("Minimal")).not.toBeInTheDocument();
    });

    it("reaches and changes reasoning with Radix keyboard navigation", async () => {
        const user = userEvent.setup();
        const onReasoningChange = vi.fn();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
                reasoningLevel="high"
                onReasoningChange={onReasoningChange}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        await user.keyboard("{End}");

        const reasoning = screen.getByRole("slider", {
            name: "Reasoning level",
        });
        expect(reasoning).toHaveFocus();

        await user.keyboard("{ArrowRight}");
        expect(onReasoningChange).toHaveBeenLastCalledWith("xhigh");
    });

    it("uses the Settings2 icon in a compact chat input", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                compact
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toHaveClass("w-8", "rounded-lg");
        expect(trigger).not.toHaveClass("rounded-full");
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger.querySelector("svg")).toBeInTheDocument();
    });

    it("allows a wider model label in the regular trigger", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        expect(screen.getByText("Gemini 3 Flash")).toHaveClass("max-w-[200px]");
    });

    it("does not add an inset shadow to the selected model row", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));

        const selectedRow = screen
            .getAllByText("Gemini 3 Flash")
            .find((element) => element.closest('[role="menuitem"]'))
            ?.closest('[role="menuitem"]');
        expect(selectedRow).toHaveClass("theme-dropdown-item", "text-gray-900");
        expect(selectedRow).toHaveClass("rounded-md");
        expect(selectedRow).not.toHaveClass("rounded-xl");
        expect(selectedRow).toHaveAttribute("data-selected", "true");
        expect(selectedRow?.className).not.toContain("shadow-[inset_");
    });

    it("shows a dot on model rows but not provider rows", async () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Choose model" }),
        );

        const modelRow = screen
            .getAllByText("Gemini 3 Flash")
            .find((element) => element.closest('[role="menuitem"]'))
            ?.closest('[role="menuitem"]');
        const providerRow = screen
            .getByText("Google")
            .closest('[role="menuitem"]');

        expect(modelRow?.querySelector("span.rounded-full")).toBeInTheDocument();
        expect(
            providerRow?.querySelector("span.rounded-full"),
        ).not.toBeInTheDocument();
    });
});

describe("ModelToggle availability states", () => {
    it("offers an authenticated deployment-configured model", async () => {
        configuredModels.push({
            id: "local-qwen",
            label: "Local Qwen",
            group: "Configured",
            location: "local",
            source: "Configured",
        });
        render(
            <ModelToggle
                value="local-qwen"
                onChange={vi.fn()}
                apiKeys={keys({})}
            />,
        );

        expect(
            screen.getByRole("button", { name: "Choose model" }),
        ).toHaveTextContent("Local Qwen");
        await userEvent.click(
            screen.getByRole("button", { name: "Choose model" }),
        );
        expect(screen.getByText("Configured")).toBeInTheDocument();
    });

    it("lists a declared model under the provider the deployment names", async () => {
        configuredModels.push(
            {
                id: "phala/glm-5.3",
                label: "GLM 5.3",
                group: "Phala (encrypted)",
                location: "cloud",
                source: "Configured",
            },
            {
                id: "river/glm-5.3-flash",
                label: "GLM 5.3 Flash",
                group: "River",
                location: "cloud",
                source: "Configured",
            },
        );
        render(
            <ModelToggle
                value="phala/glm-5.3"
                onChange={vi.fn()}
                apiKeys={keys({ claude: true })}
            />,
        );

        await userEvent.click(
            screen.getByRole("button", { name: "Choose model" }),
        );
        const headings = screen
            .getAllByRole("menuitem")
            .map((item) => item.textContent ?? "");
        const order = ["Anthropic", "Phala (encrypted)", "River"].map((name) =>
            headings.findIndex((text) => text.startsWith(name)),
        );
        expect(order.every((index) => index >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // The trigger and the selected group's open row.
        expect(screen.getAllByText("GLM 5.3")).toHaveLength(2);
    });

    it("renders a neutral disabled trigger while keys are loading", () => {
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeysLoading
            />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeDisabled();
        // The load-time flash: never claim "No API Key" before we know.
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger).toHaveTextContent("Gemini 3 Flash");
    });

    it("fails open when key state is unknown after a failed load", () => {
        render(
            <ModelToggle value="gemini-3-flash-preview" onChange={vi.fn()} />,
        );

        const trigger = screen.getByRole("button", { name: "Choose model" });
        expect(trigger).toBeEnabled();
        expect(trigger).not.toHaveTextContent("No API Key");
        expect(trigger).toHaveTextContent("Gemini 3 Flash");
    });

    it("shows No Models and invokes the API-key warning when no providers are configured", async () => {
        const user = userEvent.setup();
        const onNoModelsClick = vi.fn();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({})}
                onNoModelsClick={onNoModelsClick}
            />,
        );

        const trigger = screen.getByRole("button", {
            name: "No models available",
        });
        expect(trigger).toBeEnabled();
        expect(trigger).toHaveTextContent("No Models");
        expect(trigger.querySelector("svg")).not.toBeInTheDocument();
        await user.click(trigger);
        expect(onNoModelsClick).toHaveBeenCalledWith("api-keys");
    });

    it("invokes the router warning when a configured router has no saved models", async () => {
        const user = userEvent.setup();
        const onNoModelsClick = vi.fn();
        render(
            <ModelToggle
                value=""
                onChange={vi.fn()}
                apiKeys={keys({ openrouter: true })}
                openRouterModels={[]}
                onNoModelsClick={onNoModelsClick}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "No models available" }),
        );
        expect(onNoModelsClick).toHaveBeenCalledWith("router-models");
    });

    it("filters to configured providers when keys are loaded", () => {
        render(
            <ModelToggle
                value="claude-fable-5"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        // Claude has no key: the stored selection is not offered, so the
        // trigger falls back to the picker prompt.
        expect(
            screen.getByRole("button", { name: "Choose model" }),
        ).toHaveTextContent("Select model");
    });
});

describe("ModelToggle provider grouping", () => {
    it("lists router models under the router, whoever made them", () => {
        expect(
            openCodeGoModelOptions(["kimi-k3", "glm-5"]).map((m) => m.group),
        ).toEqual(["OpenCode Go", "OpenCode Go"]);
        expect(
            openRouterModelOptions(["anthropic/claude-fable-5"])[0]?.group,
        ).toBe("OpenRouter");
        expect(vercelModelOptions(["openai/gpt-5.5"])[0]?.group).toBe(
            "Vercel AI Gateway",
        );
    });

    it("offers the user's saved OpenCode Go models once the key is configured", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true, "opencode-go": true })}
                openCodeGoModels={["glm-5", "kimi-k3"]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));
        await user.click(await screen.findByText("OpenCode Go"));

        expect(await screen.findByText("Glm 5")).toBeInTheDocument();
        expect(screen.getByText("Kimi K3")).toBeInTheDocument();
        expect(screen.queryByText("Zhipu AI")).not.toBeInTheDocument();
    });

    it("hides the group when the OpenCode Go key is missing", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
                openCodeGoModels={["glm-5"]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));

        expect(screen.queryByText("OpenCode Go")).not.toBeInTheDocument();
    });

    it("lists a model under each provider that serves it", async () => {
        const user = userEvent.setup();
        render(
            <ModelToggle
                value="claude-fable-5"
                onChange={vi.fn()}
                apiKeys={keys({ claude: true, openrouter: true })}
                openRouterModels={["anthropic/claude-fable-5"]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Choose model" }));

        expect(screen.getByText("Anthropic")).toBeInTheDocument();
        expect(screen.getByText("OpenRouter")).toBeInTheDocument();
        // Each heading already names the route, so no "Direct" tag.
        expect(screen.queryByText("Direct")).not.toBeInTheDocument();
    });
});

describe("ModelToggle tone", () => {
    it("uses the toolbar button colour for the default tone", () => {
        render(
            <ModelToggle
                tone="default"
                value="gemini-3-flash-preview"
                onChange={vi.fn()}
                apiKeys={keys({ gemini: true })}
            />,
        );

        expect(screen.getByRole("button", { name: "Choose model" })).toHaveClass(
            "text-gray-700",
        );
    });
});
