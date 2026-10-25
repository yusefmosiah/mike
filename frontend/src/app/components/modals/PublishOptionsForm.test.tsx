import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
    PublishOptionsForm,
    initialPublishOptions,
    publishOptionsToInput,
    publishOptionsValid,
    type PublishOptions,
} from "./PublishOptionsForm";

describe("initialPublishOptions", () => {
    it("defaults to the first allowed audience, no sign-in and 30 days", () => {
        expect(initialPublishOptions(["password", "public"])).toEqual({
            audience: "password", password: "", requireSignIn: false, expiry: "30",
        });
        expect(initialPublishOptions([]).audience).toBe("public");
    });

    it("takes the suggestions it can honour", () => {
        expect(
            initialPublishOptions(["public", "password"], { audience: "password", require_sign_in: true, expires_in_days: 7 }),
        ).toEqual({ audience: "password", password: "", requireSignIn: true, expiry: "7" });
        expect(initialPublishOptions(["public", "password"], { expires_in_days: null }).expiry).toBe("never");
    });

    it("drops an audience or expiry the install does not offer", () => {
        const options = initialPublishOptions(["public"], { audience: "password", expires_in_days: 12 });
        expect(options.audience).toBe("public");
        expect(options.expiry).toBe("30");
    });
});

describe("publish options to input", () => {
    const base: PublishOptions = { audience: "public", password: "ignored", requireSignIn: false, expiry: "90" };

    it("sends a password only for password links and the flag only when set", () => {
        expect(publishOptionsToInput({ documentId: "d1" }, base)).toEqual({
            document_id: "d1", version_id: null, audience: "public", expires_in_days: 90,
        });
        expect(
            publishOptionsToInput({ documentId: "d1", versionId: "v1" }, {
                ...base, audience: "password", password: "pw", requireSignIn: true, expiry: "never",
            }),
        ).toEqual({
            document_id: "d1", version_id: "v1", audience: "password", password: "pw", require_sign_in: true, expires_in_days: null,
        });
    });

    it("needs a long enough password for password links", () => {
        expect(publishOptionsValid(base)).toBe(true);
        expect(publishOptionsValid({ ...base, audience: "password", password: "short" })).toBe(false);
        expect(publishOptionsValid({ ...base, audience: "password", password: "twelve-chars" })).toBe(true);
    });
});

function Harness({ disabled }: { disabled?: boolean }) {
    const [value, setValue] = useState<PublishOptions>(initialPublishOptions(["public", "password"]));
    return (
        <>
            <PublishOptionsForm value={value} onChange={setValue} audiences={["public", "password"]} disabled={disabled} />
            <output>{JSON.stringify(value)}</output>
        </>
    );
}

describe("PublishOptionsForm", () => {
    it("edits every option", async () => {
        render(<Harness />);
        await userEvent.click(screen.getByRole("button", { name: /With a password/ }));
        await userEvent.click(screen.getByRole("button", { name: "Generate" }));
        await userEvent.click(screen.getByRole("switch"));
        await userEvent.click(screen.getByRole("button", { name: "7 days" }));
        const value = JSON.parse(screen.getByRole("status").textContent!);
        expect(value).toMatchObject({ audience: "password", requireSignIn: true, expiry: "7" });
        expect(value.password.length).toBeGreaterThanOrEqual(12);
    });

    it("disables the controls while busy", async () => {
        render(<Harness disabled />);
        expect(screen.getByRole("switch")).toBeDisabled();
        expect(screen.getByRole("button", { name: "7 days" })).toBeDisabled();
    });
});
