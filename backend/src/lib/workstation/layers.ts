/**
 * The backend's mirror of infra/workstation/layers.json — the manifest the
 * guest's `layer` command checks tools out against. One source lives in the
 * flake (the guest reads it at /etc/layers.json); this copy exists because the
 * backend image does not ship infra/. layers.test.ts fails when the two
 * drift apart, so edit the JSON and mirror the change here.
 */

export interface WorkstationLayer {
    /** The nixpkgs attribute, or "symlinkJoin" for a package set. */
    attr: string;
    /** For symlinkJoin layers: the attributes joined into one closure. */
    packages?: string[];
    purpose: string;
    /** What entering the layer makes possible, in the agent's terms. */
    unlocks: string;
    /** Environment variables the entry line exports. */
    env?: Record<string, string>;
    note?: string;
}

export const WORKSTATION_LAYERS: Record<string, WorkstationLayer> = {
    python: {
        attr: "python3",
        purpose: "a throwaway virtualenv for wheels the base interpreter does not carry",
        unlocks: "python3 -m venv ~/venv && ~/venv/bin/pip install <wheel>",
        note: "The base interpreter already has pandas/matplotlib/etc. for code mode; wheels that cannot come from nixpkgs go in the venv, never in the base image.",
    },
    ocr: {
        attr: "tesseract",
        purpose: "read text out of images and scanned pages",
        unlocks: "tesseract <image> out",
        note: "Interim engine pending the corpus benchmark in the mission file (RapidOCR/PP-OCRv6, Indra, LightOnOCR candidates); swap this attr when the measurement lands.",
    },
    browser: {
        attr: "chromium",
        purpose: "render JavaScript pages and print HTML to PDF",
        unlocks: "chromium --headless --print-to-pdf=out.pdf <url>",
        note: "Heavy and slow to start; deliberately on-demand.",
    },
    fonts: {
        attr: "symlinkJoin",
        packages: [
            "inter",
            "source-serif",
            "source-sans",
            "jetbrains-mono",
            "liberation_ttf",
            "dejavu_fonts",
        ],
        purpose: "six text faces (~20 MB) for documents produced here",
        unlocks: "any tool that honours fontconfig, once FONTCONFIG_FILE is exported",
        env: { FONTCONFIG_FILE: "/etc/layers/fonts.conf" },
        note: "fonts.conf points fontconfig at the layer's share/fonts plus the base DejaVu.",
    },
};
