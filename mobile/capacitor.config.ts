import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Mike for iPhone (and later Android): a native shell around the hosted web
 * app, the same pattern as the Mac app (desktop/) and the Word add-in.
 *
 * The shell loads the deployed Mike server (`server.url`), by default our
 * staging deployment, so every web change reaches the app without a new
 * build. A static export of the frontend is not possible (it uses server
 * routes; README.md, How the pieces fit). A firm build sets MIKE_SERVER_URL
 * to its host inside the VPN at `cap sync` time.
 *
 * `webDir` holds only the page shown when the server cannot be reached.
 */
const serverUrl = (process.env.MIKE_SERVER_URL ?? "https://choir-ip.com").replace(/\/+$/, "");

const config: CapacitorConfig = {
    appId: "com.firm.mike",
    appName: "Mike",
    webDir: "www",
    server: {
        url: serverUrl,
        // Only the Mike server renders in the app; other links open in Safari.
        allowNavigation: [new URL(serverUrl).hostname],
        errorPath: "offline.html",
    },
    // Matter text must not reach native device logs (Xcode/Logcat capture
    // console output forwarded by the WebView at other logging levels).
    loggingBehavior: "none",
    ios: {
        // The web view fills the screen, under the status bar and the home
        // indicator. The page pads itself with env(safe-area-inset-*), blurs
        // what scrolls under the clock, and scrolls the document on chat
        // threads so a tap on the status bar scrolls back to the top.
        contentInset: "never",
        // No inspection of the web view in release builds.
        webContentsDebuggingEnabled: false,
        backgroundColor: "#f9fafb",
    },
    android: {
        allowMixedContent: false,
        webContentsDebuggingEnabled: false,
    },
};

export default config;
