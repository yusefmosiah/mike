"use client";

import { Suspense } from "react";
import { AuthProvider } from "@/app/contexts/AuthContext";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";
import { MfaLoginGate } from "@/app/components/shared/MfaLoginGate";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useInputModality } from "@/app/hooks/useInputModality";

export function Providers({ children }: { children: React.ReactNode }) {
    useInputModality();
    return (
        <AuthProvider>
            <UserProfileProvider>
                <Suspense fallback={<FullScreenLoader />}>
                    <MfaLoginGate>
                        {children}
                    </MfaLoginGate>
                </Suspense>
            </UserProfileProvider>
        </AuthProvider>
    );
}
