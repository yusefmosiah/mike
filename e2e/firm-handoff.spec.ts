/**
 * Firm thread handoff E2E (Mission 5, goals/mission-5-firm-thread-handoff.md):
 * three signed-in browsers carry one chat through the real backend, database
 * and Pi runtime, answered by the scripted stub model (e2e/stubModel.mjs).
 *
 *   1. The colleagues sign in once (sharing is with Mike users). The partner
 *      (this worker's account) starts a chat and shares it from the chat's
 *      Share dialog: the associate as Editor, a third member as Viewer.
 *   2. The associate opens the thread, sees the partner's prompt attributed to
 *      the partner, and sends a slow continuation.
 *   3. While it generates, a send from the partner's idle view is refused
 *      with that explanation, and nothing of it is stored. Reopened, the
 *      partner's thread says who is generating; once the associate's turn
 *      ends it shows the associate's prompt and answer without a reload.
 *   4. The third member reads the whole thread with both senders named, and
 *      has no composer to send with.
 *
 * Expected labels come from the chat read itself (its `authors` map), so the
 * spec checks that each prompt names the person who sent it, whatever display
 * name an earlier spec gave that account.
 */
import type { Browser, BrowserContext, Response } from "@playwright/test";
import { test, expect, type Page } from "./fixtures";
import { completeOnboardingIfRequired } from "./onboarding";
import { ensureUser, type E2eAccount } from "./users";

const STUB_MODEL_LABEL = "E2E placeholder";
const REFUSED =
    "Someone else is generating a response in this chat. Nothing was sent; send again once it finishes.";

type ChatRead = {
    authors?: Record<string, { name: string | null; email: string | null }>;
};

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function answerTo(page: Page, prompt: string) {
    return page.getByText(new RegExp(`^Stub answer \\d+ to: ${escapeRegExp(prompt)}$`));
}

/** The column holding one prompt: its sender label, then its bubble. */
function promptRow(page: Page, prompt: string) {
    return page
        .getByText(prompt, { exact: true })
        .locator("xpath=ancestor::div[contains(@class,'flex-col')][1]");
}

async function signIn(
    browser: Browser,
    baseURL: string,
    account: E2eAccount,
): Promise<BrowserContext> {
    await ensureUser(account.email, account.password);
    const context = await browser.newContext({
        baseURL,
        storageState: undefined,
    });
    const page = await context.newPage();
    await page.goto("/login");
    await page.fill("#email", account.email);
    await page.fill("#password", account.password);
    await page.click('button[type="submit"]');
    await completeOnboardingIfRequired(page);
    await page.close();
    return context;
}

/** Opens a chat and returns the label each account's prompts should carry. */
async function openChat(page: Page, chatId: string) {
    const read = page.waitForResponse(
        (response: Response) =>
            response.request().method() === "GET" &&
            new URL(response.url()).pathname === `/api/chat/${chatId}`,
    );
    await page.goto(`/assistant/chat/${chatId}`);
    const body = (await (await read).json()) as ChatRead;
    return (email: string) => {
        const person = Object.values(body.authors ?? {}).find((entry) => entry.email === email);
        return person?.name ?? email;
    };
}

async function share(page: Page, email: string, role: "Editor" | "Viewer") {
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Add by email...").fill(email);
    await dialog.getByRole("button", { name: /Role for the new recipient/ }).click();
    await page.getByRole("menuitem", { name: role }).click();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByText(email, { exact: true })).toBeVisible();
}

test.describe("firm thread handoff", () => {
    test.setTimeout(180_000);

    test("a partner starts, an associate continues, a third member reads", async ({
        page,
        browser,
        e2eAccount,
    }, testInfo) => {
        const baseURL = String(testInfo.project.use.baseURL);
        const password = process.env.E2E_PASSWORD ?? "E2eTestPass1!";
        const associate = {
            email: `e2e-handoff-associate-w${testInfo.parallelIndex}@mike.local`,
            password,
        };
        const third = {
            email: `e2e-handoff-third-w${testInfo.parallelIndex}@mike.local`,
            password,
        };
        const stamp = Date.now();
        const opening = `Handoff opening ${stamp}`;
        const continuation = `Handoff continuation ${stamp} (slow)`;
        const interjection = `Handoff interjection ${stamp}`;

        // Sharing is with Mike users, so the colleagues have signed in once.
        const associateContext = await signIn(browser, baseURL, associate);
        const thirdContext = await signIn(browser, baseURL, third);
        try {
            // 1. The partner starts the thread and shares it.
            await page.goto("/assistant");
            const firstInput = page.getByPlaceholder("How can I help?");
            await expect(firstInput).toBeVisible();
            const modelTrigger = page.getByRole("button", {
                name: "Choose model",
                exact: true,
            });
            await modelTrigger.click();
            await page.getByRole("menuitem", { name: STUB_MODEL_LABEL }).click();
            await firstInput.fill(opening);
            await firstInput.press("Enter");
            await page.waitForURL(/\/assistant\/chat\/[^/]+$/, { timeout: 45_000 });
            await expect(answerTo(page, opening)).toBeVisible({ timeout: 30_000 });
            const chatId = new URL(page.url()).pathname.split("/").pop()!;

            await page.getByRole("button", { name: "Chat actions" }).click();
            await page.getByRole("menuitem", { name: "Share" }).click();
            await share(page, associate.email, "Editor");
            await share(page, third.email, "Viewer");
            await page.keyboard.press("Escape");
            await expect(page.getByRole("dialog")).toHaveCount(0);

            // 2. The associate sees who started it and carries it on.
            const associatePage = await associateContext.newPage();
            const associateSees = await openChat(associatePage, chatId);
            await expect(answerTo(associatePage, opening)).toBeVisible();
            await expect(promptRow(associatePage, opening)).toContainText(
                associateSees(e2eAccount.email),
            );
            const reply = associatePage.getByPlaceholder("How can I help?");
            await expect(reply).toBeEnabled();
            await reply.fill(continuation);
            await reply.press("Enter");
            await expect(associatePage.getByText(continuation, { exact: true })).toBeVisible();
            // The answer is streaming and the turn is held open: the associate
            // holds the thread. (The view keeps the last chunk back until the
            // stream ends, so match the start of the answer.)
            await expect(
                associatePage.getByText(/^Stub answer \d+ to: Handoff continuation/),
            ).toBeVisible({ timeout: 15_000 });

            // 3. The partner's view, idle since sharing, sends meanwhile: the
            // send is refused rather than run a second time.
            const partnerInput = page.getByPlaceholder("How can I help?");
            await partnerInput.fill(interjection);
            await partnerInput.press("Enter");
            await expect(page.getByText(REFUSED)).toBeVisible({ timeout: 15_000 });

            // Reopened, the thread says who is generating and streams it live.
            const partnerSees = await openChat(page, chatId);
            const associateName = partnerSees(associate.email);
            const generatingNotice = page
                .getByRole("status")
                .filter({ hasText: "is generating a response" });
            await expect(generatingNotice).toContainText(associateName, { timeout: 15_000 });

            // The partner's thread catches up on its own once the turn ends.
            await expect(generatingNotice).toHaveCount(0, { timeout: 45_000 });
            await expect(answerTo(page, continuation)).toBeVisible({ timeout: 20_000 });
            await expect(promptRow(page, continuation)).toContainText(associateName, {
                timeout: 20_000,
            });

            // 4. The third member reads it all, attributed, and cannot send.
            const thirdPage = await thirdContext.newPage();
            const thirdSees = await openChat(thirdPage, chatId);
            await expect(answerTo(thirdPage, opening)).toBeVisible();
            await expect(answerTo(thirdPage, continuation)).toBeVisible();
            await expect(promptRow(thirdPage, opening)).toContainText(thirdSees(e2eAccount.email));
            await expect(promptRow(thirdPage, continuation)).toContainText(
                thirdSees(associate.email),
            );
            // The refused interjection was never stored.
            await expect(thirdPage.getByText(interjection, { exact: true })).toHaveCount(0);
            await expect(thirdPage.getByPlaceholder("How can I help?")).toHaveCount(0);
        } finally {
            await associateContext.close();
            await thirdContext.close();
        }
    });
});
