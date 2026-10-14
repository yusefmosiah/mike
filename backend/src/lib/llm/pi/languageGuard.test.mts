import { describe, expect, it } from "vitest";
import { answerLanguageDrift } from "./languageGuard.mjs";

const english = "They are fooling unsophisticated investors, and the launch was aimed at them.";

describe("the answer-language check", () => {
  it("catches an answer that slid into another script partway through", () => {
    const answer = `Yes, and the separation of audiences is the design. ${"技术用户能看穿基准测试，但投资者看不到。".repeat(8)}`;
    expect(answerLanguageDrift(english, answer)).toBe(true);
  });

  it("leaves an answer in the person's language alone, even with a quoted foreign term", () => {
    const answer = `${"The tracked deletion removes the stray word 本章 from the draft. ".repeat(4)}\n> 原文：本章讨论网络效应\n\`\`\`python\nprint("中文")\n\`\`\``;
    expect(answerLanguageDrift(english, answer)).toBe(false);
  });

  it("follows the person's script, whatever it is", () => {
    const chinese = "请总结一下这个播客的要点。";
    expect(answerLanguageDrift(chinese, "这个播客的核心论点是网络效应。".repeat(10))).toBe(false);
    expect(answerLanguageDrift(chinese, "The core argument of the podcast is network effects. ".repeat(4))).toBe(true);
  });

  it("does not judge a short answer or a message without letters", () => {
    expect(answerLanguageDrift(english, "好的。")).toBe(false);
    expect(answerLanguageDrift(".", "这个播客的核心论点是网络效应。".repeat(10))).toBe(false);
  });
});
