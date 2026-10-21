package com.firm.mike.speech;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AudioTest {
    private static float[] tone(double hz, int rate, double seconds, double amplitude) {
        float[] out = new float[(int) (rate * seconds)];
        for (int i = 0; i < out.length; i++) out[i] = (float) (amplitude * Math.sin(2 * Math.PI * hz * i / rate));
        return out;
    }

    private static double rms(float[] values, int from, int to) {
        double sum = 0;
        for (int i = from; i < to; i++) sum += values[i] * values[i];
        return Math.sqrt(sum / (to - from));
    }

    private static int zeroCrossings(float[] values, int from, int to) {
        int count = 0;
        for (int i = from + 1; i < to; i++) {
            if ((values[i - 1] < 0) != (values[i] < 0)) count++;
        }
        return count;
    }

    @Test
    public void downsamplesFrom48kKeepingSpeechBand() {
        float[] out = Resampler.resample(tone(1000, 48_000, 1.0, 0.5), 48_000, 16_000);
        assertEquals(16_000, out.length);
        // Away from the edges: same level, same frequency (2 crossings a cycle).
        assertEquals(0.5 / Math.sqrt(2), rms(out, 1000, 15_000), 0.01);
        assertEquals(2 * 1000 * 14_000 / 16_000.0, zeroCrossings(out, 1000, 15_000), 2);
    }

    @Test
    public void downsamplingRemovesWhatWouldAlias() {
        // 10 kHz is above 16 kHz's Nyquist rate: it must not fold back to 6 kHz.
        float[] out = Resampler.resample(tone(10_000, 48_000, 1.0, 0.5), 48_000, 16_000);
        assertTrue(rms(out, 1000, 15_000) < 0.01);
    }

    @Test
    public void convertsTheFixtureRate() {
        // The iOS fixture is 22.05 kHz AAC.
        float[] out = Resampler.resample(tone(440, 22_050, 2.0, 0.8), 22_050, 16_000);
        assertEquals(32_000, out.length);
        assertEquals(0.8 / Math.sqrt(2), rms(out, 2000, 30_000), 0.01);
    }

    @Test
    public void upsamplesWithoutLoss() {
        float[] out = Resampler.resample(tone(300, 8_000, 1.0, 0.5), 8_000, 16_000);
        assertEquals(16_000, out.length);
        assertEquals(0.5 / Math.sqrt(2), rms(out, 1000, 15_000), 0.01);
    }

    @Test
    public void streamingMatchesOneShot() {
        float[] input = tone(700, 44_100, 1.3, 0.4);
        float[] whole = Resampler.resample(input, 44_100, 16_000);
        Resampler.Stream stream = new Resampler.Stream(44_100, 16_000);
        Resampler.FloatList out = new Resampler.FloatList();
        for (int at = 0; at < input.length; at += 1024) {
            int length = Math.min(1024, input.length - at);
            float[] piece = new float[length];
            System.arraycopy(input, at, piece, 0, length);
            stream.push(piece, length, out);
        }
        stream.flush(out);
        assertArrayEquals(whole, out.toArray(), 1e-6f);
    }

    @Test
    public void sameRateIsUntouched() {
        float[] input = {0.1f, -0.2f, 0.3f};
        assertArrayEquals(input, Resampler.resample(input, 16_000, 16_000), 0f);
    }

    @Test
    public void downmixAveragesChannels() {
        assertArrayEquals(new float[] {0.5f, 0f}, Resampler.downmix(new float[] {1f, 0f, 0.5f, -0.5f}, 2), 1e-6f);
        float[] mono = {0.1f};
        assertArrayEquals(mono, Resampler.downmix(mono, 1), 0f);
        assertArrayEquals(new float[] {0.5f, -1f}, Resampler.fromPcm16(new short[] {16_384, -32_768, 7}, 2), 1e-6f);
    }

    @Test
    public void wavHeaderAndSamples() {
        byte[] wav = Wav.encode(new float[] {0f, 1f, -1f, 2f}, 24_000);
        assertEquals(44 + 8, wav.length);
        assertEquals("RIFF", new String(wav, 0, 4));
        assertEquals("WAVE", new String(wav, 8, 4));
        assertEquals("data", new String(wav, 36, 4));
        assertEquals(24_000, (wav[24] & 0xff) | (wav[25] & 0xff) << 8 | (wav[26] & 0xff) << 16);
        assertEquals(8, wav[40]);
        // 1.0 → 32767, -1.0 → -32767, 2.0 clamped.
        assertEquals(32767, (short) ((wav[46] & 0xff) | wav[47] << 8));
        assertEquals(-32767, (short) ((wav[48] & 0xff) | wav[49] << 8));
        assertEquals(32767, (short) ((wav[50] & 0xff) | wav[51] << 8));
    }

    @Test
    public void logMelMatchesTheReferenceScript() {
        // Reference values from transcribe.py's log_mel on the same signal and
        // filters (8 synthetic bands), computed with numpy.
        float[][] filters = new float[8][257];
        for (int m = 0; m < 8; m++) {
            for (int k = m * 30; k < Math.min(257, m * 30 + 40); k++) filters[m][k] = 1f / (1 + k - m * 30);
        }
        float[] wav = new float[4000];
        for (int n = 0; n < wav.length; n++) {
            wav[n] = (float) (0.5 * Math.sin(2 * Math.PI * 440 * n / 16000) + 0.25 * Math.sin(2 * Math.PI * 3000 * n / 16000 + 0.3) + 0.01 * Math.cos(n * 0.37));
        }
        LogMel.Features features = new LogMel(512, 160, 400, 0.97f, filters).compute(wav);
        assertEquals(26, features.frames);
        assertEquals(25, features.valid);
        float[][] expected = {
            {-4.79967f, -4.77963f, -4.79968f, -4.79966f, 3.53313f, 3.38211f, 3.39871f, 3.40609f},
            {0.19521f, -0.12725f, 0.19547f, 0.19811f, 2.12961f, 2.23415f, 2.20264f, 2.17317f},
            {0.20027f, 0.23204f, 0.20037f, 0.20012f, -0.35031f, -0.35430f, -0.35438f, -0.35431f},
            {0.19852f, -0.07888f, 0.19623f, 0.19857f, 2.06559f, 2.19074f, 2.19816f, 2.21658f},
            {0f, 0f, 0f, 0f, 0f, 0f, 0f, 0f},
        };
        int[] frames = {0, 1, 12, 24, 25};
        for (int i = 0; i < frames.length; i++) {
            float[] row = new float[8];
            System.arraycopy(features.values, frames[i] * 8, row, 0, 8);
            assertArrayEquals("frame " + frames[i], expected[i], row, 2e-3f);
        }
    }

    @Test
    public void longAudioIsCutAtTheQuietestPoint() {
        int rate = 16_000;
        float[] audio = new float[rate * 70];
        for (int i = 0; i < audio.length; i++) audio[i] = (float) (0.3 * Math.sin(i * 0.05));
        // Silence at 31.0–31.4 s: inside the 25–35 s search range of the first cut.
        for (int i = (int) (31.0 * rate); i < (int) (31.4 * rate); i++) audio[i] = 0;
        var pieces = LongAudio.pieces(audio, rate, 40, 30, 5 * 2);
        assertEquals(2, pieces.size());
        int cut = pieces.get(0)[1];
        assertTrue(cut >= 31.0 * rate && cut <= 31.4 * rate);
        assertEquals(0, pieces.get(0)[0]);
        assertEquals(cut, pieces.get(1)[0]);
        assertEquals(audio.length, pieces.get(1)[1]);
        assertEquals(1, LongAudio.pieces(new float[rate * 10], rate, 40, 30, 10).size());
    }
}
