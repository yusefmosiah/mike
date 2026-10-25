import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/*
 * Hands-free voice mode in a plain browser (docs/voice-web.md), end to end in
 * Chromium with a fake microphone: the real capture worklet, listening worker,
 * turn policy, clause queue and <audio> playback, the real chat thread and
 * voice hook. A synthetic WAV stands in for speech: a short burst of sound,
 * then a long silence (Chromium loops the file). Silero does not take a tone
 * for speech, so the test seam (window.__mikeVoiceTest, webBackend.ts)
 * detects speech by loudness, stands in for the transcription and renders
 * each clause as silence of about its spoken length. The API is mocked in the
 * page, as in the other synthetic specs.
 */

/** 16 kHz mono 16-bit: 0.5 s quiet, 1 s of a 220 Hz tone with harmonics, 8 s quiet. */
function writeFixture(): string {
    const rate = 16_000;
    const seconds = { before: 0.5, sound: 1, after: 8 };
    const count = Math.round(rate * (seconds.before + seconds.sound + seconds.after));
    const data = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) {
        const t = i / rate - seconds.before;
        const inSound = t >= 0 && t < seconds.sound;
        const value = inSound
            ? 0.3 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.25 * Math.sin(2 * Math.PI * 880 * t)) / 1.75
            : 0;
        data.writeInt16LE(Math.round(value * 32767), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mike-voice-")), "turn.wav");
    fs.writeFileSync(file, Buffer.concat([header, data]));
    return file;
}

const FIXTURE = writeFixture();

test.use({
    storageState: { cookies: [], origins: [] },
    launchOptions: {
        args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${FIXTURE}`,
        ],
    },
});

const SPOKEN = "What does clause four say";
const ANSWER = "Clause four says the rent is due on the first of the month. Late payment costs five percent.";

/** The signed-in user, one chat, and a streamed answer to each voice turn; the seam in place. */
async function mockApi(page: Page) {
    await page.addInitScript(
        ({ spoken, answer }) => {
            const log: { transcribed: number[]; bodies: unknown[] } = { transcribed: [], bodies: [] };
            (window as unknown as { __voiceLog: typeof log }).__voiceLog = log;
            (window as unknown as { __mikeVoiceTest: unknown }).__mikeVoiceTest = {
                vad: "energy",
                speak: "silent",
                models: "missing",
                transcribe: ({ audioMs }: { audioMs: number }) => {
                    log.transcribed.push(audioMs);
                    return spoken;
                },
            };
            const originalFetch = window.fetch.bind(window);
            const json = (body: unknown) =>
                Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
            const chat = {
                id: "voice-chat",
                title: "Voice chat",
                user_id: "voice-user",
                project_id: null,
                model: "test-model",
                created_at: "2026-10-25T00:00:00Z",
                is_owner: true,
                access_role: "owner",
            };
            let turn = 0;
            window.fetch = (input, init) => {
                const url = input instanceof Request ? input.url : String(input);
                const pathname = new URL(url, location.href).pathname;
                if (!pathname.startsWith("/api/")) return originalFetch(input, init);
                if (pathname === "/api/auth/session") return json({ user: { id: "voice-user", email: "voice@example.com" } });
                if (pathname === "/api/user/profile") {
                    return json({ onboardingComplete: true, displayName: "Voice", apiKeyStatus: {}, creditsRemaining: 100 });
                }
                if (pathname === "/api/models/configured") {
                    return json({ models: [{ id: "test-model", label: "Test model", source: "Configured" }] });
                }
                if (pathname.startsWith("/api/models/")) return json({ models: [] });
                if (pathname === "/api/chat/voice-chat") {
                    return json({
                        chat,
                        is_owner: true,
                        access_role: "owner",
                        messages: [
                            { id: "q0", role: "user", content: "Earlier question" },
                            { id: "a0", role: "assistant", content: [{ type: "content", text: "Earlier answer." }] },
                        ],
                    });
                }
                if (pathname === "/api/chat" && init?.method === "POST") {
                    log.bodies.push(JSON.parse(String(init.body)));
                    const answerId = `voice-answer-${++turn}`;
                    const encoder = new TextEncoder();
                    const stream = new ReadableStream({
                        async start(controller) {
                            const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                            send({ type: "chat_id", chatId: chat.id, assistantMessageId: answerId });
                            for (const word of answer.split(" ")) {
                                send({ type: "content_delta", text: `${word} ` });
                                await new Promise((resolve) => setTimeout(resolve, 10));
                            }
                            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                            controller.close();
                        },
                    });
                    return Promise.resolve(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
                }
                if (pathname === "/api/chat") return json([chat]);
                return json([]);
            };
        },
        { spoken: SPOKEN, answer: ANSWER },
    );
}

test("voice mode in the browser: set up, hear a turn, send it, speak the answer, listen again", async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockApi(page);
    await page.goto("/assistant/chat/voice-chat");
    await expect(page.getByPlaceholder("How can I help?")).toBeVisible();

    await page.getByRole("button", { name: "Start voice mode" }).click();
    // The models are asked for first, as minutes and how voice mode runs here; nothing downloads yet.
    const panel = page.locator("[data-slot='voice-mode-panel']");
    await expect(panel).toContainText("Voice mode needs speech models in this browser (about 1 minute to download, once).");
    await expect(panel).not.toContainText(/\bphone\b|MB/);

    await page.getByRole("button", { name: "Download" }).click();
    await expect(page.getByTestId("voice-activity")).toHaveText("Listening", { timeout: 20_000 });

    // The sound in the fake microphone becomes a turn after the silence, and is sent as a voice message.
    await expect(page.getByText(SPOKEN, { exact: true })).toBeVisible({ timeout: 20_000 });
    const log = await page.evaluate(() => (window as unknown as { __voiceLog: { transcribed: number[]; bodies: { voice?: boolean; messages?: unknown }[] } }).__voiceLog);
    expect(log.transcribed[0]).toBeGreaterThan(700);
    expect(log.transcribed[0]).toBeLessThan(1600);
    expect(log.bodies[0]?.voice).toBe(true);

    // The answer is spoken (Tap to interrupt is offered meanwhile), then voice mode listens again.
    await expect(page.getByText("Late payment costs five percent.", { exact: false })).toBeVisible();
    await expect(page.getByTestId("voice-activity")).toHaveText("Speaking", { timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Tap to interrupt" })).toBeVisible();
    await expect(page.getByTestId("voice-activity")).toHaveText("Listening", { timeout: 15_000 });

    await page.getByRole("button", { name: "End" }).click();
    await expect(page.getByPlaceholder("How can I help?")).toBeVisible();
    expect(errors).toEqual([]);
});

test("voice mode in the browser: tap to interrupt stops the answer and records what was heard", async ({ page }) => {
    test.setTimeout(90_000);
    await mockApi(page);
    // What was heard is recorded through the page's fetch (recordSpokenAnswer); keep it.
    await page.addInitScript(() => {
        const mocked = window.fetch;
        window.fetch = (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.includes("/spoken")) {
                (window as unknown as { __spoken: unknown[] }).__spoken ??= [];
                (window as unknown as { __spoken: unknown[] }).__spoken.push(JSON.parse(String(init?.body ?? "{}")));
                return Promise.resolve(new Response(null, { status: 204 }));
            }
            return mocked(input, init);
        };
    });
    await page.goto("/assistant/chat/voice-chat");
    await page.getByRole("button", { name: "Start voice mode" }).click();
    await page.getByRole("button", { name: "Download" }).click();
    await expect(page.getByTestId("voice-activity")).toHaveText("Speaking", { timeout: 30_000 });
    await page.getByRole("button", { name: "Tap to interrupt" }).click();
    await expect(page.getByTestId("voice-activity")).toHaveText("Listening", { timeout: 10_000 });
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { __spoken?: { spokenText: string }[] }).__spoken ?? []))
        .toHaveLength(1);
    const [record] = await page.evaluate(() => (window as unknown as { __spoken: { spokenText: string }[] }).__spoken);
    // What was heard is a beginning of the answer, never all of it.
    expect(ANSWER.startsWith(record.spokenText.trim()) || record.spokenText === "").toBe(true);
    expect(record.spokenText.length).toBeLessThan(ANSWER.length);
});
