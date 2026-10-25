import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] }, actionTimeout: 30_000 });

// How a streamed answer scrolls, against a scripted backend in the browser:
// the view follows the newest text, stays where the reader scrolled to, and
// never jumps when the answer finishes; a short answer ends right above the
// composer; a streaming thought opens in full from its line; Enter in
// the composer starts a new line.

const CHUNKS = 90;

async function stubBackend(page: Page, { reasoning = false, chunks = CHUNKS } = {}) {
    await page.addInitScript(({ CHUNKS, reasoning }) => {
        const originalFetch = window.fetch.bind(window);
        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const json = async (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
        const chat = {
            id: "scroll-chat",
            title: "Scrolling",
            user_id: "scroll-user",
            project_id: null,
            model: "test-model",
            created_at: "2026-10-12T00:00:00Z",
            is_owner: true,
            access_role: "owner",
        };
        const history: unknown[] = Array.from({ length: 4 }, (_, i) => [
            { id: `seed-user-${i}`, role: "user", content: `Seed question ${i}` },
            {
                id: `seed-answer-${i}`,
                role: "assistant",
                content: [{ type: "content", text: Array.from({ length: 12 }, (_, j) => `Earlier point ${i}/${j}.`).join("\n\n") }],
            },
        ]).flat();
        const state = window as Window & { streamDone?: boolean; sent?: number };
        state.sent = 0;
        window.fetch = (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            const path = new URL(url, location.href).pathname;
            if (!path.startsWith("/api/")) return originalFetch(input, init);
            if (path === "/api/auth/session") return json({ user: { id: "scroll-user", email: "scroll@example.com" } });
            if (path === "/api/user/profile") {
                return json({ onboardingComplete: true, displayName: "Scroll", apiKeyStatus: {}, creditsRemaining: 100 });
            }
            if (path === "/api/models/configured") return json({ models: [{ id: "test-model", label: "Test model", source: "Configured" }] });
            if (path.startsWith("/api/models/")) return json({ models: [] });
            if (path === "/api/chat/scroll-chat") return json({ chat, is_owner: true, access_role: "owner", messages: history });
            if (path === "/api/chat" && init?.method === "POST") {
                state.sent! += 1;
                state.streamDone = false;
                const body = JSON.parse(String(init.body ?? "{}")) as { messages?: { content?: string }[] };
                const prompt = body.messages?.at(-1)?.content ?? "";
                const encoder = new TextEncoder();
                const parts: string[] = [];
                const thoughts: string[] = [];
                const stream = new ReadableStream({
                    async start(controller) {
                        const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                        send({ type: "chat_id", chatId: chat.id, assistantMessageId: `answer-${state.sent}` });
                        if (reasoning) {
                            for (let chunk = 0; chunk < CHUNKS; chunk++) {
                                const text = `Thought ${chunk} weighs the clause.\n\n`;
                                thoughts.push(text);
                                send({ type: "reasoning_delta", text });
                                await delay(45);
                            }
                            send({ type: "reasoning_block_end" });
                        }
                        for (let chunk = 0; chunk < CHUNKS; chunk++) {
                            const text = `Sentence ${chunk} of the answer.\n\n`;
                            parts.push(text);
                            send({ type: "content_delta", text });
                            await delay(45);
                        }
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                        // As the server would: the finished turn is now history.
                        history.push(
                            { id: `user-${state.sent}`, role: "user", content: prompt },
                            {
                                id: `answer-${state.sent}`,
                                role: "assistant",
                                content: [
                                    ...(reasoning ? [{ type: "reasoning", text: thoughts.join("") }] : []),
                                    { type: "content", text: parts.join("") },
                                ],
                            },
                        );
                        state.streamDone = true;
                    },
                });
                return Promise.resolve(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
            }
            if (path === "/api/chat") return json([chat]);
            return json([]);
        };
    }, { CHUNKS: chunks, reasoning });
}

/**
 * What the reader sees, measured after a painted frame: how far the thread is
 * from its end, whether the newest answer sentence is above the composer, and
 * the first answer sentence on screen with its position.
 */
async function scrollState(page: Page) {
    return page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
        const box = document.querySelector<HTMLElement>('[data-slot="chat-messages-scroller"]')!;
        const boxScrolls = box.scrollHeight > box.clientHeight + 1;
        const el = boxScrolls ? box : (document.scrollingElement as HTMLElement);
        const height = boxScrolls ? box.clientHeight : window.innerHeight;
        const sentences = [...document.querySelectorAll("p")].filter((p) => /^Sentence \d+ of the answer\.$/.test(p.textContent ?? ""));
        const composer = document.querySelector('[data-slot="chat-composer"]')!.getBoundingClientRect();
        const rect = sentences.at(-1)?.getBoundingClientRect();
        const anchor = sentences.find((p) => p.getBoundingClientRect().top >= 0);
        return {
            fromBottom: el.scrollHeight - el.scrollTop - height,
            newestVisible: rect ? rect.top >= 0 && rect.bottom <= composer.top + 2 : null,
            anchor: anchor ? { text: anchor.textContent!, top: anchor.getBoundingClientRect().top } : null,
        };
    });
}

/** Where a sentence sits on screen now. */
const topOf = (page: Page, text: string) =>
    page.getByText(text, { exact: true }).evaluate((el) => el.getBoundingClientRect().top);

async function openChat(page: Page) {
    await page.goto("/assistant/chat/scroll-chat");
    const input = page.getByPlaceholder("How can I help?");
    await expect(input).toBeVisible();
    await expect(page.getByText("Earlier point 3/11.")).toBeVisible();
    // Behave like WebKit, which does not keep the view steady when content
    // above it changes size: Chromium's scroll anchoring would hide a shift.
    await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" });
    return input;
}

async function send(page: Page, text: string) {
    const input = page.getByPlaceholder("How can I help?");
    await input.fill(text);
    await page.getByRole("button", { name: "Send message" }).click();
}

const streamDone = (page: Page) =>
    page.waitForFunction(() => (window as Window & { streamDone?: boolean }).streamDone === true, undefined, { timeout: 60_000 });

for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
] as const) {
    test.describe(`chat scrolling (${name})`, () => {
        test.use({ viewport });

        test("follows the newest text while the answer streams, and stays put when it ends", async ({ page }) => {
            await stubBackend(page);
            await openChat(page);
            await send(page, "Walk me through it.");
            await expect(page.getByText("Sentence 30 of the answer.")).toBeAttached({ timeout: 30_000 });
            // Check every frame the answer grows in, just before it paints:
            // this observer runs after the app's own, which was created first.
            const frames = await page.evaluate(() => new Promise<{ frames: number; behind: string[] }>((resolve) => {
                const box = document.querySelector<HTMLElement>('[data-slot="chat-messages-scroller"]')!;
                const content = document.querySelector<HTMLElement>('[data-slot="chat-messages-content"]')!;
                const behind: string[] = [];
                let frames = 0;
                const observer = new ResizeObserver(() => {
                    frames++;
                    const boxScrolls = box.scrollHeight > box.clientHeight + 1;
                    const el = boxScrolls ? box : (document.scrollingElement as HTMLElement);
                    const height = boxScrolls ? box.clientHeight : window.innerHeight;
                    const fromBottom = el.scrollHeight - el.scrollTop - height;
                    const sentences = [...document.querySelectorAll("p")].filter((p) => /^Sentence \d+ of the answer\.$/.test(p.textContent ?? ""));
                    const composer = document.querySelector('[data-slot="chat-composer"]')!.getBoundingClientRect();
                    const rect = sentences.at(-1)!.getBoundingClientRect();
                    if (fromBottom > 4 || rect.top < 0 || rect.bottom > composer.top + 2) {
                        behind.push(`${sentences.at(-1)!.textContent} ${Math.round(fromBottom)}px from the end`);
                    }
                });
                observer.observe(content);
                setTimeout(() => { observer.disconnect(); resolve({ frames, behind }); }, 2_000);
            }));
            expect(frames.frames, "the answer kept growing").toBeGreaterThan(10);
            expect(frames.behind, "frames painted without the newest text in view").toEqual([]);
            await streamDone(page);
            await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
            const ended = (await scrollState(page)).anchor!;
            await page.waitForTimeout(1_500);
            expect(await topOf(page, ended.text), "no jump when the answer ends").toBeCloseTo(ended.top, 0);
            expect((await scrollState(page)).fromBottom).toBeLessThanOrEqual(4);
            await expect(page.getByText(`Sentence ${CHUNKS - 1} of the answer.`)).toBeInViewport();
        });

        test("leaves the view where the reader scrolled, during the answer and after it", async ({ page }) => {
            await stubBackend(page);
            await openChat(page);
            await send(page, "Walk me through it.");
            await expect(page.getByText("Sentence 30 of the answer.")).toBeAttached({ timeout: 30_000 });
            await page.mouse.move(viewport.width / 2, viewport.height / 3);
            await page.mouse.wheel(0, -500);
            await page.waitForTimeout(300);
            const held = (await scrollState(page)).anchor!;
            await page.waitForTimeout(1_000);
            expect(await topOf(page, held.text), "not pulled back down while streaming").toBeCloseTo(held.top, 0);
            await streamDone(page);
            await page.waitForTimeout(1_500);
            expect(await topOf(page, held.text), "not moved when the answer ends").toBeCloseTo(held.top, 0);
        });

        test("a short answer ends right above the composer, with no empty space below it", async ({ page }) => {
            await stubBackend(page, { chunks: 1 });
            await openChat(page);
            await send(page, "Hi.");
            await streamDone(page);
            await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
            await page.waitForTimeout(500);
            const gap = await page.evaluate(() => {
                const answer = [...document.querySelectorAll("p")].find((p) => p.textContent === "Sentence 0 of the answer.")!;
                const composer = document.querySelector('[data-slot="chat-composer"]')!.getBoundingClientRect();
                return composer.top - answer.getBoundingClientRect().bottom;
            });
            // The answer's actions and the thread's bottom padding sit between
            // them; the space reserved while it streamed is gone.
            expect(gap).toBeGreaterThan(0);
            expect(gap).toBeLessThan(260);
            expect((await scrollState(page)).fromBottom).toBeLessThanOrEqual(4);
        });

        test("opens a streaming thought in full from its line", async ({ page }) => {
            await stubBackend(page, { reasoning: true });
            await openChat(page);
            await send(page, "Think it through.");
            // A thought starts closed; its line opens it in full.
            const disclosure = page.getByRole("button", { name: /^(Thinking|Pondering|Analyzing|Reviewing|Reasoning)\.\.\./ });
            await disclosure.click();
            await expect(disclosure).toHaveAttribute("aria-expanded", "true");
            await expect(page.getByText("Thought 40 weighs the clause.")).toBeAttached({ timeout: 30_000 });
            // Opened, the whole thought shows: no height cap, no second level.
            await expect(page.getByText("Thought 0 weighs the clause.")).toBeVisible();
            await expect(page.getByRole("button", { name: /show (more|less)|thought process/i })).toHaveCount(0);
        });
                observer.observe(content);
                setTimeout(() => { observer.disconnect(); resolve({ frames, hidden }); }, 1_500);
            }));
            expect(result.frames, "the thought kept growing").toBeGreaterThan(10);
            expect(result.hidden, "frames painted with the newest thought outside the window").toEqual([]);
        });

        test("Enter starts a new line and Cmd/Ctrl+Enter sends", async ({ page }) => {
            await stubBackend(page);
            const input = await openChat(page);
            await input.fill("First line");
            await input.press("Enter");
            await input.pressSequentially("Second line");
            await expect(input).toHaveValue("First line\nSecond line");
            expect(await page.evaluate(() => (window as Window & { sent?: number }).sent)).toBe(0);
            await input.press("ControlOrMeta+Enter");
            await expect(input).toHaveValue("");
            expect(await page.evaluate(() => (window as Window & { sent?: number }).sent)).toBe(1);
        });
    });
}
