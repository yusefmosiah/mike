import { expect, test } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

const SNAPSHOT = "6f783e59-35c4-4ddc-896a-94aa4d05a768";
const SCREENSHOTS = process.env.E2E_SCREENSHOT_DIR;

// A web citation opens the page Mike saved when it wrote the answer, as a
// reader view in the document panel, and links on to the live site from
// there. Every /api call is answered in the browser: no backend is needed.
test.beforeEach(async ({ page }) => {
    await page.addInitScript((snapshotId) => {
        const json = (body: unknown) =>
            Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
        const chat = {
            id: "web-reader",
            title: "Business judgment rule",
            user_id: "reader-user",
            project_id: null,
            model: "test-model",
            created_at: "2026-10-12T00:00:00Z",
            is_owner: true,
            access_role: "owner",
        };
        const citation = {
            type: "citation_data",
            kind: "web",
            ref: 1,
            url: "https://www.law.cornell.edu/wex/business_judgment_rule",
            title: "business judgment rule",
            site: "law.cornell.edu",
            quotes: [{ quote: "immunity from liability when a plaintiff sues", verification: { verified: true } }],
            verified: true,
            snapshot_id: snapshotId,
            retrieved_at: "2026-10-12T09:00:00.000Z",
            snapshot_source: "fetch",
        };
        const markdown = [
            "## Business judgment rule",
            "",
            "The business judgment rule provides a [director](https://www.law.cornell.edu/wex/director) of a corporation immunity from liability when a plaintiff sues on grounds that the director violated the duty of care to the corporation.",
            "",
            "In suits alleging a director violated their duty of care, courts will evaluate the case based on the following:",
            "",
            "- whether the director acted in good faith;",
            "- whether the director acted with the care that a reasonably prudent person would use;",
            "- whether the director reasonably believed they were acting in the best interests of the corporation.",
            "",
            "| Element | Burden |",
            "| --- | --- |",
            "| Good faith | Plaintiff |",
            "| Due care | Plaintiff |",
        ].join("\n");
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            const path = new URL(url, location.href).pathname;
            if (!path.startsWith("/api/")) return originalFetch(input, init);
            if (path === "/api/auth/session") return json({ user: { id: "reader-user", email: "reader@example.com" } });
            if (path === "/api/user/profile") return json({ onboardingComplete: true, displayName: "Reader", apiKeyStatus: {}, creditsRemaining: 100 });
            if (path === "/api/models/configured") return json({ models: [{ id: "test-model", label: "Test model", source: "Configured" }] });
            if (path === `/api/chat/web-reader/web-pages/${snapshotId}`) {
                return json({ id: snapshotId, url: citation.url, text: "", markdown, retrieved_at: citation.retrieved_at });
            }
            if (path === "/api/chat/web-reader") {
                return json({
                    chat,
                    is_owner: true,
                    access_role: "owner",
                    messages: [
                        { id: "q", role: "user", content: "What protects directors from liability?" },
                        {
                            id: "a",
                            role: "assistant",
                            content: [{ type: "content", text: "The business judgment rule gives directors immunity from liability for decisions made in good faith.[1]" }],
                            citations: [citation],
                        },
                    ],
                });
            }
            if (path === "/api/chat") return json([chat]);
            return json([]);
        };
    }, SNAPSHOT);
});

test("a web citation opens the saved page in the reader and links to the original", async ({ page }) => {
    const opened: string[] = [];
    page.on("popup", (popup) => opened.push(popup.url()));
    await page.goto("/assistant/chat/web-reader");

    await page.getByRole("button", { name: /Citation 1/ }).first().click();

    const reader = page.getByRole("article", { name: "business judgment rule" });
    await expect(reader.getByRole("heading", { name: "Business judgment rule" })).toBeVisible();
    await expect(reader.locator(".case-quote-highlight").first()).toContainText("immunity from liability");
    await expect(reader.getByRole("table")).toBeVisible();
    await expect(page.getByText("Site: law.cornell.edu")).toBeVisible();
    await expect(page.getByText("Saved: October 12, 2026")).toBeVisible();
    await expect(page.getByRole("link", { name: /Open original/ })).toHaveAttribute(
        "href",
        "https://www.law.cornell.edu/wex/business_judgment_rule#:~:text=immunity%20from%20liability%20when%20a%20plaintiff%20sues",
    );
    // Opening the citation never left the app.
    expect(opened).toEqual([]);
    // The panel has finished sliding in, its link to the original on screen.
    await expect(page.getByRole("link", { name: /Open original/ })).toBeInViewport({ ratio: 1 });
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/web-reader-desktop.png` });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(reader.getByRole("heading", { name: "Business judgment rule" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Open original/ })).toBeInViewport({ ratio: 1 });
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/web-reader-phone.png` });
});
