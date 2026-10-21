package com.firm.mike.speech;

/** Mono float samples as a 16-bit PCM WAV file, as the iPhone plugin returns them. */
final class Wav {
    private Wav() {}

    static byte[] encode(float[] samples, int sampleRate) {
        int dataBytes = samples.length * 2;
        byte[] out = new byte[44 + dataBytes];
        ascii(out, 0, "RIFF");
        le32(out, 4, 36 + dataBytes);
        ascii(out, 8, "WAVEfmt ");
        le32(out, 16, 16);
        le16(out, 20, 1);
        le16(out, 22, 1);
        le32(out, 24, sampleRate);
        le32(out, 28, sampleRate * 2);
        le16(out, 32, 2);
        le16(out, 34, 16);
        ascii(out, 36, "data");
        le32(out, 40, dataBytes);
        int at = 44;
        for (float sample : samples) {
            float clamped = Math.max(-1f, Math.min(1f, sample));
            int value = Math.round(clamped * 32767f);
            out[at++] = (byte) value;
            out[at++] = (byte) (value >> 8);
        }
        return out;
    }

    private static void ascii(byte[] out, int at, String text) {
        for (int i = 0; i < text.length(); i++) out[at + i] = (byte) text.charAt(i);
    }

    private static void le16(byte[] out, int at, int value) {
        out[at] = (byte) value;
        out[at + 1] = (byte) (value >> 8);
    }

    private static void le32(byte[] out, int at, int value) {
        le16(out, at, value);
        le16(out, at + 2, value >> 16);
    }
}
