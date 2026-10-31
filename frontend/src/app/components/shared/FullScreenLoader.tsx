/**
 * The single full-screen loading state. Every gate in the provider/layout
 * chain (Suspense fallback, MFA gate, auth-loading layout) must render this
 * exact markup: the server and client can resolve those gates differently on
 * first paint, and identical DOM is what keeps that from being a hydration
 * mismatch.
 */
export function FullScreenLoader() {
    return (
        <div
            role="status"
            aria-label="Loading"
            className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-gray-50/80"
        >
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-700" />
            {/*
             * Hidden until loading has taken 12 seconds (`slow-load-notice` in
             * globals.css). CSS reveals it, not a timer, so it also appears
             * when the page's scripts never ran. The empty href reloads the
             * page as a plain navigation.
             */}
            <div className="slow-load-notice flex flex-col items-center gap-2 px-4 text-center text-sm text-gray-500">
                <p>This is taking longer than usual.</p>
                <a
                    href=""
                    className="rounded font-medium text-gray-700 underline underline-offset-2 transition-colors hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                >
                    Try again
                </a>
            </div>
        </div>
    );
}
