import { describe, expect, it } from "vitest";
import { liveTextOf, spliceDictation } from "./liveComposer";

describe("liveTextOf", () => {
    it("joins the confirmed text and the tail", () => {
        expect(liveTextOf({ confirmed: "hello ", volatile: " wor" })).toBe("hello wor");
        expect(liveTextOf({ confirmed: "hello", volatile: "" })).toBe("hello");
        expect(liveTextOf({ confirmed: "", volatile: "hi" })).toBe("hi");
        expect(liveTextOf({ confirmed: "", volatile: "" })).toBe("");
    });
});

describe("spliceDictation", () => {
    it("inserts with spacing only where needed", () => {
        expect(spliceDictation("Summarize", "the contract", "")).toBe("Summarize the contract");
        expect(spliceDictation("Summarize ", "the contract", "")).toBe("Summarize the contract");
        expect(spliceDictation("", "hello", "")).toBe("hello");
        expect(spliceDictation("a ", "b", "c")).toBe("a b c");
        expect(spliceDictation("a ", "b", ".")).toBe("a b.");
        expect(spliceDictation("a ", "b", " c")).toBe("a b c");
    });

    it("leaves the text alone when there is nothing to insert", () => {
        expect(spliceDictation("a", "", " b")).toBe("a b");
    });
});
