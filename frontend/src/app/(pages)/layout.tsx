"use client";

import { useCallback, useMemo, useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";
import { AppSidebar } from "@/app/components/shared/AppSidebar";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { HeaderButtonUI, HeaderButtonsUI } from "@/shared/ui/HeaderButtonsUI";
import { cn } from "@/app/lib/utils";
import { watchDisplayEdge } from "@/app/lib/displayEdge";
import { watchHorizontalSwipe } from "@/app/lib/horizontalSwipe";

export default function MikeLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated, authLoading } = useAuth();
    const [hasMounted, setHasMounted] = useState(false);
    useEffect(() => {
        // An outer auth provider may settle before this streamed boundary
        // hydrates. Its first client render must still match the SSR loader.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one hydration transition, independent of auth or streamed content
        setHasMounted(true);
    }, []);
    const router = useRouter();
    const pathname = usePathname();
    const isChatPage =
        /^\/assistant\/chat\/[^/]+\/?$/.test(pathname) ||
        /^\/projects\/[^/]+\/assistant\/chat\/[^/]+\/?$/.test(pathname);
    // On a phone these pages scroll the document itself (globals.css), so a
    // tap on the status bar scrolls the thread to the top.
    const scrollsDocument = /^\/assistant\/chat\/[^/]+\/?$/.test(pathname);
    useEffect(() => watchDisplayEdge(), []);
    const [mobileActionsContainer, setMobileActionsContainer] =
        useState<HTMLDivElement | null>(null);

    const [isSidebarOpenDesktop, setIsSidebarOpenDesktop] = useState(() => {
        if (typeof window !== "undefined") {
            const saved = localStorage.getItem("sidebarOpen");
            return saved !== null ? saved === "true" : true;
        }
        return true;
    });

    const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
        if (typeof window !== "undefined" && window.innerWidth < 768) {
            return false;
        }
        return true;
    });

    // Persist what is actually on screen. The mount initializer above reads
    // this key back but `isSidebarOpen` starts open on desktop regardless, so
    // storing anything else leaves the restored preference disagreeing with
    // the rendered sidebar and the first toggle click is spent re-syncing
    // them. Remembering a collapsed sidebar across reloads needs the mount
    // path to apply the stored value too — a separate change.
    useEffect(() => {
        if (typeof window !== "undefined" && window.innerWidth >= 768) {
            localStorage.setItem("sidebarOpen", isSidebarOpen.toString());
        }
    }, [isSidebarOpenDesktop]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const handleResize = () => {
            const isSmall = window.innerWidth < 768;
            if (isSmall && isSidebarOpen) setIsSidebarOpen(false);
            else if (!isSmall && !isSidebarOpen)
                setIsSidebarOpen(isSidebarOpenDesktop);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, [isSidebarOpen, isSidebarOpenDesktop]);

    const handleSidebarToggle = () => {
        if (window.innerWidth >= 768) {
            setIsSidebarOpenDesktop(!isSidebarOpenDesktop);
            setIsSidebarOpen(!isSidebarOpenDesktop);
        } else {
            setIsSidebarOpen(!isSidebarOpen);
        }
    };

    // On a phone, a swipe right across the page reveals the sidebar and a
    // swipe left puts it away, as in other chat apps.
    const [mainElement, setMainElement] = useState<HTMLElement | null>(null);
    useEffect(() => {
        if (!mainElement || isSidebarOpen) return;
        return watchHorizontalSwipe(mainElement, {
            direction: "right",
            enabled: () => window.innerWidth < 768,
            onSwipe: () => setIsSidebarOpen(true),
        });
    }, [mainElement, isSidebarOpen]);
    useEffect(() => {
        if (!isSidebarOpen) return;
        return watchHorizontalSwipe(window, {
            direction: "left",
            enabled: () => window.innerWidth < 768,
            onSwipe: () => setIsSidebarOpen(false),
        });
    }, [isSidebarOpen]);

    const handleMobileActionsContainerRef = useCallback(
        (node: HTMLDivElement | null) => {
            setMobileActionsContainer(node);
        },
        [],
    );

    const setSidebarOpen = useCallback((open: boolean) => {
        const isSmall =
            typeof window !== "undefined" && window.innerWidth < 768;
        if (isSmall) {
            if (!open) setIsSidebarOpen(false);
            return;
        }
        setIsSidebarOpen(open);
        setIsSidebarOpenDesktop(open);
    }, []);

    const pageChromeValue = useMemo(
        () => ({ mobileActionsContainer }),
        [mobileActionsContainer],
    );

    const sidebarValue = useMemo(() => ({ setSidebarOpen }), [setSidebarOpen]);

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [authLoading, isAuthenticated, router]);

    if (!hasMounted || authLoading) {
        return <FullScreenLoader />;
    }

    if (!isAuthenticated) return null;

    return (
        <ChatHistoryProvider>
            <PageChromeContext.Provider value={pageChromeValue}>
                <SidebarContext.Provider value={sidebarValue}>
                    <div
                        data-document-scroll={scrollsDocument || undefined}
                        className={cn(
                            "flex flex-col bg-app-background",
                            scrollsDocument ? "min-h-dvh md:h-dvh" : "h-dvh",
                        )}
                    >
                        <div
                            aria-hidden="true"
                            className="status-bar-scrim pointer-events-none fixed inset-x-0 top-0 z-20 md:hidden"
                        />
                        <div className="flex-1 flex min-w-0 overflow-visible">
                            <AppSidebar
                                isOpen={isSidebarOpen}
                                onToggle={handleSidebarToggle}
                            />
                            <div
                                className={cn(
                                    "flex-1 flex flex-col md:overflow-hidden relative w-full",
                                    scrollsDocument ? "min-h-dvh md:h-dvh" : "h-dvh",
                                )}
                            >
                                {/* Mobile header */}
                                <div
                                    data-slot="mobile-header"
                                    className={cn(
                                        "z-30 flex items-center gap-3 overflow-visible px-4 md:hidden",
                                        isChatPage
                                            ? "pointer-events-none fixed inset-x-0 top-0 bg-transparent pb-2 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]"
                                            : "relative shrink-0 pb-2 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]",
                                    )}
                                >
                                    <HeaderButtonsUI className="pointer-events-auto">
                                        <HeaderButtonUI
                                            iconOnly
                                            onClick={handleSidebarToggle}
                                            title="Open sidebar"
                                            aria-label="Open sidebar"
                                        >
                                            <PanelLeft className="h-4 w-4" />
                                        </HeaderButtonUI>
                                    </HeaderButtonsUI>
                                    <div
                                        ref={handleMobileActionsContainerRef}
                                        className="pointer-events-auto ml-auto flex min-w-0 flex-1 items-center justify-end"
                                    />
                                </div>
                                <main
                                    ref={setMainElement}
                                    className={cn(
                                        "flex w-full flex-1 flex-col md:h-full md:overflow-hidden",
                                        scrollsDocument ? "overflow-visible" : "h-full overflow-y-auto",
                                    )}
                                >
                                    {children}
                                </main>
                            </div>
                        </div>
                    </div>
                </SidebarContext.Provider>
            </PageChromeContext.Provider>
        </ChatHistoryProvider>
    );
}
