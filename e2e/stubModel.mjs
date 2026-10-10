#!/usr/bin/env node
/**
 * A scripted OpenAI-compatible chat endpoint for the e2e stack.
 *
 * The local e2e backend offers one configured model, "E2E placeholder", whose
 * base URL points here (scripts/e2e-local-stack.sh). With this server running,
 * a spec can send a real chat turn through the real backend, database and Pi
 * runtime without a provider key, a network call or any spend. Each answer is
 * numbered, so two answers to the same prompt differ:
 *
 *     Stub answer 3 to: <the last user message>
 *
 * Streaming (`stream: true`) and plain JSON completions are both served; tools
 * are ignored. A prompt containing "(slow)" sends its answer at once and then
 * holds the stream open for about twenty seconds before finishing, so a spec
 * can watch a turn while it is still generating. Usage: `node e2e/stubModel.mjs [port]` (default 21434).
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.E2E_STUB_MODEL_PORT ?? 21434);
let answers = 0;

function lastUserText(messages) {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.role !== "user") continue;
        if (typeof message.content === "string") return message.content;
        if (Array.isArray(message.content)) {
            return message.content
                .filter((part) => part?.type === "text")
                .map((part) => part.text)
                .join(" ");
        }
    }
    return "";
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
    }
    let body;
    try {
        body = JSON.parse(await readBody(req));
    } catch {
        res.writeHead(400).end();
        return;
    }
    // Mike prefixes each prompt with when it was sent ("[Sent: Fri 9 Oct ...] ");
    // the answer quotes the prompt without it, and only its start, so specs
    // can match on what they typed.
    const prompt = lastUserText(body.messages)
        .trim()
        .replace(/^\[Sent:[^\]]*\]\s*/, "")
        .replace(/\s+/g, " ")
        .slice(0, 200);
    answers += 1;
    const text = `Stub answer ${answers} to: ${prompt}`;
    const id = `stub-${answers}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? "e2e-placeholder";
    const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };

    if (!body.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            id, object: "chat.completion", created, model,
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage,
        }));
        return;
    }

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    const send = (chunk) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, ...chunk })}\n\n`);
    send({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    // A few chunks, so the client exercises its streaming path.
    for (const piece of text.match(/.{1,16}/gs) ?? [text]) {
        send({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    if (prompt.includes("(slow)")) await new Promise((resolve) => setTimeout(resolve, 20_000));
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({ choices: [], usage });
    res.end("data: [DONE]\n\n");
});

server.listen(port, "127.0.0.1", () => {
    console.log(`stub model listening on http://127.0.0.1:${port}/v1`);
});
