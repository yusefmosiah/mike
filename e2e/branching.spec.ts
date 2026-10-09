/**
 * Branching E2E (Mission 3, goals/station-5-pi-tree-branching.md): each flow
 * runs through the real backend, database and Pi runtime. Answers come from
 * the "E2E placeholder" model, whose endpoint is e2e/stubModel.mjs: numbered,
 * scripted text with no provider key, network or spend, so this spec runs in
 * CI as well as locally.
 *
 *   1. Regenerate re-answers in place: a second answer becomes a sibling,
 *      "‹ 2/2 ›" steps between them, and a reload keeps the chosen one.
 *   2. Editing a prompt saves a sibling version with its own answer; stepping
 *      back shows the original prompt and answer; a reload keeps the choice.
 *   3. "Branch into new thread" opens a new chat holding the history; a prompt
 *      sent there does not appear in the original chat.
 *   4. The same edit flow in a project chat.
 *
 * Auth: runs signed in as this worker's account (e2e/fixtures.ts).
 */
import { test, expect, type Page } from "./fixtures";
import { createProject } from "./helpers";

const STUB_MODEL_LABEL = "E2E placeholder";

async function selectStubModel(page: Page) {
    const trigger = page.getByRole("button", { name: "Choose model", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await page.getByRole("menuitem", { name: STUB_MODEL_LABEL }).click();
    await expect(trigger).toHaveAttribute("title", `Choose model — ${STUB_MODEL_LABEL}`);
}

/** The answer to `prompt`, matched by the stub's "Stub answer N to: ..." text. */
function answerTo(page: Page, prompt: string) {
    return page.getByText(new RegExp(`^Stub answer \\d+ to: ${escapeRegExp(prompt)}$`));
}

async function answerNumber(page: Page, prompt: string): Promise<number> {
    const text = (await answerTo(page, prompt).first().textContent()) ?? "";
    const match = /^Stub answer (\d+)/.exec(text.trim());
    if (!match) throw new Error(`no stub answer number in ${JSON.stringify(text)}`);
    return Number(match[1]);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sends the first prompt of a new assistant chat and waits for its answer. */
async function startAssistantChat(page: Page, prompt: string) {
    await page.goto("/assistant");
    const input = page.getByPlaceholder("How can I help?");
    await expect(input).toBeVisible();
    await selectStubModel(page);
    await input.fill(prompt);
    await input.press("Enter");
    await page.waitForURL(/\/assistant\/chat\/[^/]+$/, { timeout: 45_000 });
    await expect(answerTo(page, prompt)).toBeVisible({ timeout: 30_000 });
}

async function editPrompt(page: Page, from: string, to: string) {
    const prompt = page.getByText(from, { exact: true });
    await prompt.hover();
    // The edit control sits in the prompt's own row; with one prompt on the
    // page there is exactly one.
    await page.getByRole("button", { name: "Edit prompt" }).click();
    const editor = page.getByRole("textbox", { name: "Edit message" });
    await editor.fill(to);
    await page.getByRole("button", { name: "Save", exact: true }).click();
}

test.describe("branching", () => {
    test.setTimeout(120_000);

    test("regenerate keeps both answers as siblings and the choice survives a reload", async ({ page }) => {
        const prompt = `Regenerate marker ${Date.now()}`;
        await startAssistantChat(page, prompt);
        const first = await answerNumber(page, prompt);

        await page.getByRole("button", { name: "Regenerate response" }).click();
        const responses = page.getByRole("group", { name: "Response branches" });
        await expect(responses).toContainText("2/2", { timeout: 30_000 });
        const second = await answerNumber(page, prompt);
        expect(second).toBeGreaterThan(first);
        // In place: still one prompt, one answer on screen.
        await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
        await expect(answerTo(page, prompt)).toHaveCount(1);

        await responses.getByRole("button", { name: "Previous branch" }).click();
        await expect(responses).toContainText("1/2");
        await expect(page.getByText(`Stub answer ${first} to: ${prompt}`, { exact: true })).toBeVisible();

        await page.reload();
        await expect(page.getByText(`Stub answer ${first} to: ${prompt}`, { exact: true })).toBeVisible();
        await expect(page.getByRole("group", { name: "Response branches" })).toContainText("1/2");
    });

    test("editing a prompt saves a sibling version with its own answer", async ({ page }) => {
        const original = `Original prompt ${Date.now()}`;
        const edited = `Edited prompt ${Date.now()}`;
        await startAssistantChat(page, original);

        await editPrompt(page, original, edited);
        await expect(answerTo(page, edited)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(original, { exact: true })).toHaveCount(0);
        const versions = page.getByRole("group", { name: "Message branches" });
        await expect(versions).toContainText("2/2");

        await versions.getByRole("button", { name: "Previous branch" }).click();
        await expect(page.getByText(original, { exact: true })).toBeVisible();
        await expect(answerTo(page, original)).toBeVisible();
        await expect(answerTo(page, edited)).toHaveCount(0);
        await expect(versions).toContainText("1/2");

        await page.reload();
        await expect(page.getByText(original, { exact: true })).toBeVisible();
        await expect(page.getByRole("group", { name: "Message branches" })).toContainText("1/2");

        await page.getByRole("group", { name: "Message branches" })
            .getByRole("button", { name: "Next branch" }).click();
        await expect(answerTo(page, edited)).toBeVisible();
    });

    test("branch into new thread opens an independent chat", async ({ page }) => {
        const prompt = `Fork marker ${Date.now()}`;
        const followUp = `Only in the branch ${Date.now()}`;
        await startAssistantChat(page, prompt);
        const originalUrl = page.url();

        await page.getByRole("button", { name: "Branch into new thread" }).click();
        await page.waitForURL((url) => url.href !== originalUrl && /\/assistant\/chat\/[^/]+$/.test(url.pathname), {
            timeout: 30_000,
        });
        await expect(page.getByText(prompt, { exact: true })).toBeVisible();
        await expect(answerTo(page, prompt)).toBeVisible();

        const input = page.getByPlaceholder("How can I help?");
        await input.fill(followUp);
        await input.press("Enter");
        await expect(answerTo(page, followUp)).toBeVisible({ timeout: 30_000 });

        await page.goto(originalUrl);
        await expect(answerTo(page, prompt)).toBeVisible();
        await expect(page.getByText(followUp, { exact: true })).toHaveCount(0);
    });

    test("editing a prompt works in a project chat", async ({ page }) => {
        const original = `Project prompt ${Date.now()}`;
        const edited = `Project edit ${Date.now()}`;
        await createProject(page, `Branching ${Date.now()}`);
        // A new project's assistant tab shows "Create", which opens a composer
        // (no chat exists until the first send).
        await page.goto(`${page.url()}/assistant`);
        await page.getByRole("button", { name: "Create", exact: true }).click();
        await page.waitForURL(/\/projects\/[^/]+\/assistant\/chat$/, { timeout: 20_000 });

        const input = page.getByPlaceholder("How can I help?");
        await expect(input).toBeVisible();
        await selectStubModel(page);
        await input.fill(original);
        await input.press("Enter");
        await page.waitForURL(/\/projects\/[^/]+\/assistant\/chat\/[^/]+$/, { timeout: 45_000 });
        await expect(answerTo(page, original)).toBeVisible({ timeout: 30_000 });

        await editPrompt(page, original, edited);
        await expect(answerTo(page, edited)).toBeVisible({ timeout: 30_000 });
        const versions = page.getByRole("group", { name: "Message branches" });
        await expect(versions).toContainText("2/2");

        await page.reload();
        await expect(answerTo(page, edited)).toBeVisible();
        await versions.getByRole("button", { name: "Previous branch" }).click();
        await expect(answerTo(page, original)).toBeVisible();
    });
});

test.describe("branching on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    test.setTimeout(120_000);

    test("edit, regenerate and step between branches at phone width", async ({ page }) => {
        const original = `Phone prompt ${Date.now()}`;
        const edited = `Phone edit ${Date.now()}`;
        await startAssistantChat(page, original);

        await editPrompt(page, original, edited);
        await expect(answerTo(page, edited)).toBeVisible({ timeout: 30_000 });
        const versions = page.getByRole("group", { name: "Message branches" });
        await expect(versions).toContainText("2/2");
        await expect(versions.getByRole("button", { name: "Previous branch" })).toBeInViewport();

        await page.getByRole("button", { name: "Regenerate response" }).click();
        const responses = page.getByRole("group", { name: "Response branches" });
        await expect(responses).toContainText("2/2", { timeout: 30_000 });
        await expect(responses.getByRole("button", { name: "Previous branch" })).toBeInViewport();

        await versions.getByRole("button", { name: "Previous branch" }).click();
        await expect(answerTo(page, original)).toBeVisible();
        // Nothing on the page scrolls sideways at phone width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
    });
});
