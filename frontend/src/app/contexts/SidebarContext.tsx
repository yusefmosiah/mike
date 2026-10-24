"use client";

import { createContext, useContext } from "react";

interface SidebarContextValue {
    setSidebarOpen: (open: boolean) => void;
    /** Whether the sidebar is showing (on a phone, over the page). */
    isSidebarOpen?: boolean;
}

export const SidebarContext = createContext<SidebarContextValue>({
    setSidebarOpen: () => {},
});

export function useSidebar() {
    return useContext(SidebarContext);
}
