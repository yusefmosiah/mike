import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DeviceSpeechModule from "@/app/lib/voice/deviceSpeech";

const device = vi.hoisted(() => ({ install: vi.fn(), remove: vi.fn() }));
vi.mock("@/app/lib/voice/deviceSpeech", async (importOriginal) => ({
    ...(await importOriginal<typeof DeviceSpeechModule>()),
    installPhonon: device.install,
    removePhonon: device.remove,
}));

import { DeviceSpeechError } from "@/app/lib/voice/deviceSpeech";
import { PhononPhoneSetup } from "./PhononPhoneSetup";

beforeEach(() => {
    device.install.mockReset();
    device.remove.mockReset();
});

describe("PhononPhoneSetup", () => {
    it("shows the progress of a download that is already running", () => {
        render(<PhononPhoneSetup status={{ state: "installing", progress: 0.4 }} chosen onChange={vi.fn()} />);
        expect(screen.getByRole("progressbar", { name: "Downloading Phonon" })).toHaveAttribute("aria-valuenow", "40");
        expect(screen.queryByRole("button", { name: "Download Phonon" })).not.toBeInTheDocument();
    });

    it("shows an unknown progress as nothing yet", () => {
        render(<PhononPhoneSetup status={{ state: "installing" }} chosen onChange={vi.fn()} />);
        expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    });

    it("downloads on request, shows progress, and reads the status again", async () => {
        let report: (fraction: number) => void = () => {};
        let finish: () => void = () => {};
        device.install.mockImplementation(
            (onProgress: (fraction: number) => void) =>
                new Promise<void>((resolve) => {
                    report = onProgress;
                    finish = resolve;
                }),
        );
        const onChange = vi.fn();
        render(<PhononPhoneSetup status={{ state: "not-installed" }} chosen={false} onChange={onChange} />);
        fireEvent.click(screen.getByRole("button", { name: "Download Phonon" }));
        await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0"));
        report(0.5);
        await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50"));
        finish();
        await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("says so when the download fails, and offers it again", async () => {
        device.install.mockRejectedValueOnce(new DeviceSpeechError("Could not download the voice model."));
        render(<PhononPhoneSetup status={{ state: "not-installed" }} chosen onChange={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "Download Phonon" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not download the voice model.");
        expect(screen.getByRole("button", { name: "Download Phonon" })).toBeInTheDocument();
        device.install.mockRejectedValueOnce("odd");
        fireEvent.click(screen.getByRole("button", { name: "Download Phonon" }));
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The download did not finish."));
    });

    it("removes the model", async () => {
        device.remove.mockResolvedValue({ state: "not-installed" });
        const onChange = vi.fn();
        render(<PhononPhoneSetup status={{ state: "available" }} chosen onChange={onChange} />);
        fireEvent.click(screen.getByRole("button", { name: "Remove Phonon" }));
        await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
        expect(device.remove).toHaveBeenCalled();
    });
});
