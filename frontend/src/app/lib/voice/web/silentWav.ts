/** A WAV file of `samples` of 16 kHz mono silence. */
export function silentWavBytes(samples = 160): Uint8Array<ArrayBuffer> {
    const count = Math.max(0, Math.round(samples));
    const bytes = new Uint8Array(44 + count * 2);
    const view = new DataView(bytes.buffer);
    const text = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + count * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, 16_000, true);
    view.setUint32(28, 32_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, count * 2, true);
    return bytes;
}

/** The same as a data URL. */
export function silentWavUrl(samples = 160): string {
    let binary = "";
    for (const byte of silentWavBytes(samples)) binary += String.fromCharCode(byte);
    return `data:audio/wav;base64,${btoa(binary)}`;
}

/** 10 ms of silence: what priming plays inside the tap to unlock an `<audio>` element. */
export const SILENT_WAV = silentWavUrl();
