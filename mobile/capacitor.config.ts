import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Enterprise mobile shell for Mike (iOS/Android).
 *
 * Distribution policy: firm MDM only, inside the firm's WireGuard VPN — there
 * is no public App Store / Google Play track, and none is planned (see
 * goals/station-10-mobile-client-and-ocr.md and README.md in this directory
 * for the deployment and device-hardening guide).
 *
 * `webDir` expects a STATIC EXPORT of the Next.js frontend at
 * ../frontend/out. A plain `next build` emits .next/, which Capacitor cannot
 * serve, so the operator must enable static export in frontend/next.config.ts
 * (`output: "export"`) before the shells are synced. That frontend change is
 * deliberately not made here.
 *
 * No `server.url` is configured: the shell serves bundled assets and talks
 * only to the firm backend, over the VPN.
 */
const config: CapacitorConfig = {
    appId: "com.firm.mike",
    appName: "Mike",
    webDir: "../frontend/out",
    // Matter text must not reach native device logs (Xcode/Logcat capture
    // console output forwarded by the WebView at other logging levels).
    loggingBehavior: "none",
    android: {
        // The shell talks to the firm backend over HTTPS only; plaintext mixed
        // content stays off and remote WebView debugging stays off in release.
        allowMixedContent: false,
        webContentsDebuggingEnabled: false,
    },
};

export default config;
