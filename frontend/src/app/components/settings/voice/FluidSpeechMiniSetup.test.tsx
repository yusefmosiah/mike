import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DeviceSpeechModule from "@/app/lib/voice/deviceSpeech";

const device = vi.hoisted(() => ({ install: vi.fn(), remove: vi.fn() }));
vi.mock("@/app/lib/voice/deviceSpeech", async (importOriginal) => ({
    ...(await importOriginal<typeof DeviceSpeechModule>()),
    installFluidSpeechMini: device.install,
    removeFluidSpeechMini: device.remove,
}));

import { DeviceSpeechError } from "@/app/lib/voice/deviceSpeech";
import { FluidSpeechMiniSetup } from "./FluidSpeechMiniSetup";

beforeEach(() => {
    device.install.mockReset();
    device.remove.mockReset();
});

describe("FluidSpeechMiniSetup", () => {
    it("says what the download is before it starts", () => {
        render(<FluidSpeechMiniSetup status={{ state: "downloadable", downloadBytes: 300_166_787 }} onChange={vi.fn()} />);
        expect(screen.getByText(/not on this phone yet/)).toHaveTextContent("Download it once (about 300 MB) to dictate");
        render(<FluidSpeechMiniSetup status={{ state: "downloadable" }} onChange={vi.fn()} />);
        expect(screen.getAllByText(/not on this phone yet/)[1]).toHaveTextContent("Download it once to dictate");
    });

    it("shows the progress of a download that is already running", () => {
        render(<FluidSpeechMiniSetup status={{ state: "downloading", progress: 0.4 }} onChange={vi.fn()} />);
        expect(screen.getByRole("progressbar", { name: "Downloading Fluid Speech Mini" })).toHaveAttribute("aria-valuenow", "40");
        expect(screen.queryByRole("button", { name: "Download Fluid Speech Mini" })).not.toBeInTheDocument();
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
        render(<FluidSpeechMiniSetup status={{ state: "downloadable" }} onChange={onChange} />);
        fireEvent.click(screen.getByRole("button", { name: "Download Fluid Speech Mini" }));
        await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0"));
        report(0.5);
        await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50"));
        finish();
        await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("says so when the download fails, and offers it again", async () => {
        device.install.mockRejectedValueOnce(new DeviceSpeechError("Could not download the speech model."));
        render(<FluidSpeechMiniSetup status={{ state: "downloadable" }} onChange={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "Download Fluid Speech Mini" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not download the speech model.");
        device.install.mockRejectedValueOnce("odd");
        fireEvent.click(screen.getByRole("button", { name: "Download Fluid Speech Mini" }));
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The download did not finish."));
    });

    it("removes the downloaded model", async () => {
        let finish: () => void = () => {};
        device.remove.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
        const onChange = vi.fn();
        render(<FluidSpeechMiniSetup status={{ state: "available", removable: true }} onChange={onChange} />);
        expect(screen.getByText(/works offline/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Remove Fluid Speech Mini" }));
        await waitFor(() => expect(device.remove).toHaveBeenCalledTimes(1));
        finish();
        await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    });
});
