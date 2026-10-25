import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectSummaries } from "@/app/lib/mikeApi";
import { beginAssistantTurn } from "@/app/lib/assistantTurns";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { AppSidebar } from "./AppSidebar";

const state = vi.hoisted(() => ({
  signOut: vi.fn(),
  push: vi.fn(),
  pathname: "/assistant",
  chats: [] as Array<{
    id: string;
    title: string;
    user_id: string;
    created_at: string;
    is_owner: boolean;
  }>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push }),
  usePathname: () => state.pathname,
}));

vi.mock("next/image", () => ({
  default: ({ className, src }: { className?: string; src?: string }) => (
    <span aria-hidden="true" className={className} data-src={src} />
  ),
}));

vi.mock("@/app/lib/mikeApi", () => ({
  listProjectSummaries: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "memory-menu-user", email: "alice@example.com" },
    signOut: state.signOut,
  }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({
    profile: { displayName: "Alice", tier: "Free" },
  }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    chats: state.chats,
    loadingMoreChats: false,
    loadMoreChats: vi.fn(),
    setCurrentChatId: vi.fn(),
  }),
}));

vi.mock("@/app/components/chat/mike-icon", () => ({
  MikeIcon: () => <span aria-hidden="true" />,
}));

describe("AppSidebar account dropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProjectSummaries).mockResolvedValue([]);
    state.signOut.mockResolvedValue(undefined);
    state.pathname = "/assistant";
    state.chats = [];
  });

  it("keeps memory navigation inside Settings", async () => {
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await user.click(screen.getByText("Alice").closest("button")!);

    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Memory" })).toBeNull();
  });

  it("shows the IDE navigation directly below Assistant", () => {
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    const assistant = screen.getByRole("button", { name: "Assistant" });
    const ide = screen.getByRole("button", { name: "IDE" });

    expect(assistant.parentElement?.nextElementSibling).toContainElement(ide);
  });

  it("leaves a strip for the Mac app's title bar that has no height in a browser", () => {
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    const strip = screen.getByTestId("titlebar-inset");
    expect(strip).toHaveAttribute("aria-hidden", "true");
    expect(strip.style.height).toBe("var(--mike-titlebar-inset, 0px)");
    expect(strip.nextElementSibling).toContainElement(screen.getByRole("button", { name: "Close sidebar" }));
  });

  it("shows a warning popup when sign out fails", async () => {
    state.signOut.mockRejectedValue(new Error("network unavailable"));
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await user.click(screen.getByText("Alice").closest("button")!);
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Sign out failed")).toBeInTheDocument();
    expect(
      screen.getByText("Unable to sign out. Please try again."),
    ).toBeInTheDocument();
  });

  it("shows responses loading while selected and detached, then marks a detached response complete until opened", async () => {
    const user = userEvent.setup();
    state.pathname = "/assistant/chat/chat-1";
    state.chats = [
      {
        id: "chat-1",
        title: "Quarterly filing",
        user_id: "memory-menu-user",
        created_at: new Date().toISOString(),
        is_owner: true,
      },
    ];
    const view = render(<AppSidebar isOpen onToggle={vi.fn()} />);
    const turn = beginAssistantTurn("chat-1", {
      userMessage: { role: "user", content: "Summarize" },
      assistant: { role: "assistant", content: "" },
      cancel: vi.fn(),
    });

    expect(
      await screen.findByRole("status", {
        name: "Quarterly filing response loading",
      }),
    ).toBeInTheDocument();

    state.pathname = "/assistant/chat/chat-2";
    view.rerender(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(
      await screen.findByRole("status", {
        name: "Quarterly filing response loading",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Quarterly filing (Response loading)",
      }),
    ).toBeInTheDocument();

    act(() => turn.finish());

    const completedRow = await screen.findByRole("button", {
      name: "Quarterly filing (Response complete)",
    });
    expect(
      completedRow.parentElement?.querySelector("span[aria-hidden='true']"),
    ).toHaveAttribute(
      "data-src",
      expect.stringContaining("features/chat-complete"),
    );

    await user.click(completedRow);

    expect(
      screen.getByRole("button", { name: "Quarterly filing" }),
    ).toBeInTheDocument();
    expect(
      completedRow.parentElement?.querySelector("span[aria-hidden='true']"),
    ).not.toHaveAttribute(
      "data-src",
      expect.stringContaining("features/chat-complete"),
    );
  });

  it("does not mark a selected response green when it completes", async () => {
    state.pathname = "/assistant/chat/chat-1";
    state.chats = [
      {
        id: "chat-1",
        title: "Quarterly filing",
        user_id: "memory-menu-user",
        created_at: new Date().toISOString(),
        is_owner: true,
      },
    ];
    render(<AppSidebar isOpen onToggle={vi.fn()} />);
    const turn = beginAssistantTurn("chat-1", {
      userMessage: { role: "user", content: "Summarize" },
      assistant: { role: "assistant", content: "" },
      cancel: vi.fn(),
    });

    expect(
      await screen.findByRole("status", {
        name: "Quarterly filing response loading",
      }),
    ).toBeInTheDocument();

    act(() => turn.finish());

    const selectedRow = await screen.findByRole("button", {
      name: "Quarterly filing",
    });
    expect(
      selectedRow.parentElement?.querySelector("span[aria-hidden='true']"),
    ).not.toHaveAttribute(
      "data-src",
      expect.stringContaining("features/chat-complete"),
    );
  });

  it.each([
    { isOpen: true, toggleName: "Close sidebar" },
    { isOpen: false, toggleName: "Open sidebar" },
  ])(
    "keeps the header row at a fixed height when isOpen is $isOpen",
    ({ isOpen, toggleName }) => {
      render(<AppSidebar isOpen={isOpen} onToggle={vi.fn()} />);

      expect(
        screen.getByRole("button", { name: toggleName }).parentElement,
      ).toHaveClass("h-11", "shrink-0");
    },
  );

  it.each([true, false])(
    "keeps the account button at a fixed height when isOpen is %s",
    (isOpen) => {
      render(<AppSidebar isOpen={isOpen} onToggle={vi.fn()} />);

      expect(screen.getByRole("button", { name: "Account menu" })).toHaveClass(
        "h-12",
        "shrink-0",
      );
    },
  );
});

describe("AppSidebar on a phone", () => {
  const setSidebarOpen = vi.fn();
  const tree = (isOpen: boolean) => (
    <SidebarContext.Provider value={{ setSidebarOpen }}>
      <AppSidebar isOpen={isOpen} onToggle={vi.fn()} />
    </SidebarContext.Provider>
  );
  const renderOpen = () => render(tree(true));
  const panel = () => document.querySelector("[data-open], .max-md\\:fixed");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProjectSummaries).mockResolvedValue([]);
    state.pathname = "/assistant";
    state.chats = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.innerWidth = 1024;
  });

  it("asks to close once a destination is chosen", () => {
    window.innerWidth = 390;
    renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "IDE" }));

    expect(state.push).toHaveBeenCalledWith("/ide");
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("closes from the account menu and the logo too", () => {
    window.innerWidth = 390;
    renderOpen();

    fireEvent.click(screen.getByText("Alice").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(state.push).toHaveBeenCalledWith("/settings");
    expect(setSidebarOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("link", { name: /mike/i }));
    expect(setSidebarOpen).toHaveBeenCalledTimes(2);
  });

  it("stays open on a wider screen", () => {
    window.innerWidth = 1024;
    renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "IDE" }));

    expect(state.push).toHaveBeenCalledWith("/ide");
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });

  it("rests off-screen and out of reach while closed, and slides in when open", () => {
    window.innerWidth = 390;
    const view = render(tree(false));
    const closedClasses = [
      "max-md:invisible",
      "max-md:pointer-events-none",
      "max-md:-translate-x-[calc(100%+1rem)]",
    ];
    expect(panel()).toHaveClass(...closedClasses, "max-md:duration-500", "motion-reduce:transition-none");
    expect(screen.getByTestId("sidebar-scrim")).toHaveClass("opacity-0", "pointer-events-none");

    view.rerender(tree(true));
    expect(panel()).not.toHaveClass("max-md:invisible");
    expect(panel()).not.toHaveClass("max-md:-translate-x-[calc(100%+1rem)]");
    expect(screen.getByTestId("sidebar-scrim")).not.toHaveClass("opacity-0");
  });

  it("keeps its open layout while it slides away, then settles into the rail", () => {
    window.innerWidth = 390;
    const view = render(tree(true));

    view.rerender(tree(false));
    expect(panel()).toHaveClass("max-md:-translate-x-[calc(100%+1rem)]");
    expect(screen.getByRole("button", { name: "Close sidebar" })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
  });

  it("does not linger when motion is reduced", () => {
    window.innerWidth = 390;
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
    const view = render(tree(true));

    view.rerender(tree(false));

    expect(screen.getByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
  });
});
