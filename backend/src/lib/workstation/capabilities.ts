/**
 * What the model is told the workstation can do (Mission 20 item 9): the
 * surfaces' accepted inputs and the on-demand layer mechanism, at the point
 * of use rather than in help text it would have to hunt for. Kept terse —
 * turn context is re-sent only when it changes, but every token in it is
 * paid every turn.
 */
import { WORKSTATION_LAYERS } from "./layers";

/** The file types save_to_mike accepts; one list, quoted by name elsewhere. */
export const DOCUMENT_FORMATS = {
    office: "PDF, Word, Excel, PowerPoint",
    image: "PNG, JPEG, WebP, GIF",
    text: ".txt, .md, .csv",
    html: ".html",
    audio: ".mp3, .m4a, .wav, .ogg",
    video: ".mp4, .webm, .mov",
} as const;

export function workstationCapabilitiesSection(): string {
    const layers = Object.entries(WORKSTATION_LAYERS)
        .map(
            ([name, layer]) =>
                `- ${name}: ${layer.purpose} (enter with \`layer use ${name}\`, e.g. ${layer.unlocks})`,
        )
        .join("\n");
    return `# Workstation capabilities
Shell tools on PATH: bash, git, Node 22, ffmpeg, jq, yt-dlp. Python 3 with pandas, matplotlib, Pillow, pypdf, pdfplumber, openpyxl, python-docx and friends for data and documents.
save_to_mike accepts: ${DOCUMENT_FORMATS.office}; images (${DOCUMENT_FORMATS.image}); plain text (${DOCUMENT_FORMATS.text}); HTML pages (${DOCUMENT_FORMATS.html}); audio (${DOCUMENT_FORMATS.audio}); video (${DOCUMENT_FORMATS.video}).
Heavier tools are not installed; check them out of the Nix store on demand — they download through the proxy the first time and are instant after. \`layer list\` shows every entry:
${layers}
If \`layer\` is missing the VM predates layers: say so and ask instead of hand-installing.`;
}
