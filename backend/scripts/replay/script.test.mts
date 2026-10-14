import { describe, expect, it } from "vitest";
import { proseOnly, scriptMismatch, scriptProfile } from "./script.mts";

describe("script detection", () => {
    it("counts letters by script and picks the dominant one", () => {
        expect(scriptProfile("Hello world").dominant).toBe("latin");
        expect(scriptProfile("用户正在利用一名 AI 助手").dominant).toBe("cjk");
        expect(scriptProfile("Привет, как дела?").dominant).toBe("cyrillic");
        expect(scriptProfile("12345 !!!")).toEqual({ letters: 0, counts: {}, dominant: null });
    });

    it("ignores code, inline code and links", () => {
        expect(proseOnly("see `код` and ```\n中文代码\n``` at https://例子.cn/x [l](http://a.b)")).not.toMatch(/[код中文例]/);
    });

    it("flags a Chinese answer to an English prompt", () => {
        const m = scriptMismatch("Review this for delusion.", "## 目标\n用户（一名私人/个人用户）正在利用一名 AI 助手作为批评性思维伙伴和分析引擎。");
        expect(m?.dominant).toBe("cjk");
        expect(m?.expected).toBe("latin");
    });

    it("flags a Cyrillic paragraph inside an otherwise English answer", () => {
        const answer = `${"The argument holds up well. ".repeat(10)}Это предложение написано по-русски и не должно быть здесь вообще.`;
        const m = scriptMismatch("What do you think?", answer);
        expect(m?.dominant).toBe("latin");
        expect(m?.foreign[0]).toMatchObject({ script: "cyrillic" });
    });

    it("lets a short quoted term through, and a prompt's own script", () => {
        expect(scriptMismatch("Explain the term", `${"The word ".repeat(30)}日本 means Japan.`)).toBeNull();
        expect(scriptMismatch("Translate 你好世界 please", "你好世界 means hello world")).toBeNull();
        expect(scriptMismatch("https://youtu.be/x", "Saved the transcript.")).toBeNull();
        expect(scriptMismatch("hi", "")).toBeNull();
    });
});
