import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// A phone: touch screen, narrow viewport. iOS Safari zooms into a focused
// field whose text is under 16px, and the zoomed page then scrolls sideways.
// Chromium cannot zoom like Safari, so this checks the cause (field font size)
// and the symptom it would produce (a page wider than the screen).
test.use({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 390, height: 664 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
});

const PAGES = [
    { name: "new assistant chat", path: "/assistant" },
    { name: "existing assistant chat", path: "/assistant/chat/mobile-chat" },
];

/** Answers the app's API calls in the page: a signed-in user with one chat. */
async function mockApi(page: Page, earlierTurns = 0) {
    await page.addInitScript((earlierTurns: number) => {
        const originalFetch = window.fetch.bind(window);
        const json = (body: unknown) =>
            Promise.resolve(new Response(JSON.stringify(body), {
                headers: { "Content-Type": "application/json" },
            }));
        const chat = {
            id: "mobile-chat",
            title: "A deliberately long chat title that would push a narrow header sideways",
            user_id: "mobile-user",
            project_id: null,
            model: "test-model",
            created_at: "2026-10-10T00:00:00Z",
            is_owner: true,
            access_role: "owner",
        };
        window.fetch = (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            const path = new URL(url, location.href).pathname;
            if (!path.startsWith("/api/")) return originalFetch(input, init);
            if (path === "/api/auth/session") {
                return json({ user: { id: "mobile-user", email: "phone@example.com" } });
            }
            if (path === "/api/user/profile") {
                return json({ onboardingComplete: true, displayName: "Phone", apiKeyStatus: {}, creditsRemaining: 100 });
            }
            if (path === "/api/models/configured") {
                return json({ models: [{ id: "test-model", label: "Test model", source: "Configured" }] });
            }
            if (path.startsWith("/api/models/")) return json({ models: [] });
            if (path === "/api/chat/mobile-chat") {
                return json({
                    chat,
                    is_owner: true,
                    access_role: "owner",
                    messages: [
                        ...Array.from({ length: earlierTurns }, (_, turn) => [
                            { id: `q${turn}`, role: "user", content: `Earlier question ${turn + 1}` },
                            { id: `a${turn}`, role: "assistant", content: [{ type: "content", text: `Earlier answer ${turn + 1}. `.repeat(12) }] },
                        ]).flat(),
                        { id: "q", role: "user", content: "Summarise https://example.com/a/very/long/unbroken/address/that/should/wrap/instead/of/widening/the/page" },
                        { id: "a", role: "assistant", content: [{ type: "content", text: "See https://example.com/another/very/long/unbroken/address/in/the/answer/that/must/wrap/too" }] },
                    ],
                });
            }
            if (path === "/api/chat") return json([chat]);
            return json([]);
        };
    }, earlierTurns);
}

for (const { name, path } of PAGES) {
    test(`${name}: the composer does not zoom or scroll sideways on a phone`, async ({ page }) => {
        await mockApi(page);

        await page.goto(path);
        const composer = page.getByPlaceholder("How can I help?");
        await expect(composer).toBeVisible();
        await composer.tap();
        await composer.fill("A question typed on a phone");

        const fields = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>("input, textarea, select"))
                .filter((field) => {
                    const type = field.getAttribute("type") ?? "";
                    if (["checkbox", "radio", "range", "color", "file", "hidden"].includes(type)) return false;
                    return field.getClientRects().length > 0;
                })
                .map((field) => ({
                    field: field.getAttribute("placeholder") ?? field.getAttribute("aria-label") ?? field.tagName,
                    fontSize: parseFloat(getComputedStyle(field).fontSize),
                })),
        );
        expect(fields.length).toBeGreaterThan(0);
        for (const { field, fontSize } of fields) {
            expect(fontSize, `font size of "${field}"`).toBeGreaterThanOrEqual(16);
        }

        const width = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth,
            screen: window.innerWidth,
        }));
        expect(width.page, "page width against the screen").toBeLessThanOrEqual(width.screen);

        // A long unbroken address wraps inside its message instead of being cut
        // off by a clipping ancestor.
        const clipped = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-message-id] p, [data-message-id] a"))
                .filter((element) => element.scrollWidth > element.clientWidth + 1
                    || element.getBoundingClientRect().right > window.innerWidth)
                .map((element) => element.textContent?.slice(0, 40)),
        );
        expect(clipped, "message text wider than its box or the screen").toEqual([]);
    });
}

// On a phone a chat thread scrolls the page itself, not a box inside it: a
// tap on the status bar (Safari, the iPhone app) only ever scrolls the page.
test("a chat thread scrolls the page on a phone, under a composer that stays put", async ({ page }) => {
    await mockApi(page, 8);
    await page.goto("/assistant/chat/mobile-chat");
    const composer = page.getByPlaceholder("How can I help?");
    await expect(composer).toBeVisible();
    await expect(page.getByText("Earlier question 1", { exact: true })).toBeAttached();

    const surface = page.locator('[data-slot="chat-input-surface"]');
    const before = await surface.boundingBox();
    const scroll = await page.evaluate(() => {
        window.scrollTo(0, 0);
        const top = window.scrollY;
        window.scrollTo(0, 600);
        return { top, scrolled: window.scrollY, page: document.documentElement.scrollHeight, screen: window.innerHeight };
    });
    expect(scroll.page, "the thread is taller than the screen").toBeGreaterThan(scroll.screen);
    expect(scroll.scrolled, "the page scrolls").toBeGreaterThan(scroll.top);

    // The composer keeps its place at the bottom of the screen.
    const after = await surface.boundingBox();
    expect(after?.y).toBeCloseTo(before!.y, 0);
    expect(before!.y + before!.height).toBeLessThanOrEqual(scroll.screen);

    // The sidebar opens on screen, not at the top of the scrolled page.
    await page.getByRole("button", { name: "Open sidebar" }).tap();
    const sidebar = await page.getByRole("button", { name: "Close sidebar" }).boundingBox();
    expect(sidebar!.y).toBeGreaterThanOrEqual(0);
    expect(sidebar!.y).toBeLessThan(scroll.screen / 2);
});

// An iPad in portrait sits just above the phone layout. The sidebar starts
// as the icon rail there; opened, it is a column that leaves the chat about
// 500px. A long model name once held the composer at its full width there,
// so the send button ran off the screen.
for (const [width, height] of [[768, 1024], [834, 1194]] as const) {
    test(`the composer fits beside the open sidebar at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.addInitScript(() => localStorage.setItem("sidebarOpen", "true"));
        // Installed after mockApi's, so this answers these two paths first.
        await mockApi(page);
        await page.addInitScript(() => {
            const originalFetch = window.fetch.bind(window);
            window.fetch = (input, init) => {
                const url = input instanceof Request ? input.url : String(input);
                const path = new URL(url, location.href).pathname;
                const reply = (body: unknown) =>
                    Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
                if (path === "/api/user/profile") {
                    return reply({ onboardingComplete: true, displayName: "Tablet", apiKeyStatus: {}, creditsRemaining: 100, lastSelectedChatModel: "test-model" });
                }
                if (path === "/api/models/configured") {
                    return reply({ models: [{ id: "test-model", label: "A Configured Model With A Long Name 1017", source: "Configured" }] });
                }
                return originalFetch(input, init);
            };
        });

        await page.goto("/assistant/chat/mobile-chat");
        await expect(page.getByPlaceholder("How can I help?")).toBeVisible();
        // The rail, even though the sidebar was last left open at a wider size.
        await page.getByRole("button", { name: "Open sidebar" }).click();
        await expect(page.getByRole("button", { name: "Close sidebar" })).toBeVisible();

        const send = await page.getByRole("button", { name: /^Send/ }).boundingBox();
        expect(send, "the send button is on screen").not.toBeNull();
        expect(send!.x + send!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
}

// Crossing 1024px is what opens or rails the sidebar; resizing within a
// range (Stage Manager, Split View, unfolding) leaves it as it is.
test("the sidebar is a rail from 768 to 1023px and open from 1024px", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await mockApi(page);
    await page.goto("/assistant/chat/mobile-chat");
    const close = page.getByRole("button", { name: "Close sidebar" });
    const open = page.getByRole("button", { name: "Open sidebar" });
    await expect(close).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 820 });
    await expect(close).toBeVisible();
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(open).toBeVisible();
    await open.click();
    await expect(close).toBeVisible();
    await page.setViewportSize({ width: 900, height: 1180 });
    await expect(close).toBeVisible();
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(close).toBeVisible();
});

// iPad and folding-phone screen sizes in points: iPad mini and 11-inch iPad
// in both orientations, and the folding iPhone's outer screen and inner
// screen held either way (third-party measurements of the latter two).
for (const [label, width, height] of [
    ["folding phone, outer screen", 466, 678],
    ["folding phone, inner screen", 669, 951],
    ["folding phone, inner screen sideways", 951, 669],
    ["iPad mini portrait", 744, 1133],
    ["iPad mini landscape", 1133, 744],
    ["11-inch iPad portrait", 820, 1180],
    ["11-inch iPad landscape", 1180, 820],
] as const) {
    test(`the composer fits on a ${label} (${width}x${height})`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await mockApi(page);
        await page.goto("/assistant/chat/mobile-chat");
        await expect(page.getByPlaceholder("How can I help?")).toBeVisible();
        const send = await page.getByRole("button", { name: /^Send/ }).boundingBox();
        expect(send, "the send button is on screen").not.toBeNull();
        expect(send!.x + send!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
}
