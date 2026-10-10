import { describe, expect, it } from "vitest";
import { newPasswordProblem } from "./passwordPolicy";

// bcrypt limits bytes; String.length counts UTF-16 units. The boundary must
// sit at exactly 72 UTF-8 bytes whatever the characters' width, matching the
// backend's rule in auth.service.ts.
describe("newPasswordProblem", () => {
    it("requires at least 10 characters", () => {
        expect(newPasswordProblem("nine char")).toMatch(/at least 10/);
        expect(newPasswordProblem("ten chars!")).toBeNull();
    });

    it.each([
        ["one-byte", "a", 72],
        ["two-byte", "é", 36],
        ["three-byte", "€", 24],
        ["four-byte", "\u{1F512}", 18],
    ])("accepts exactly 72 bytes of %s characters and refuses one more", (_label, char, count) => {
        expect(newPasswordProblem(char.repeat(count))).toBeNull();
        expect(newPasswordProblem(char.repeat(count) + "a")).toMatch(/72 bytes/);
    });
});
