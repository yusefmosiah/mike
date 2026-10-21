package com.firm.mike.speech;

import java.util.ArrayList;
import java.util.List;

/**
 * Splits a recording longer than the encoder takes in one pass (40 s) into
 * pieces of about 30 s, each cut at the quietest point within 5 s of its
 * target, as the reference script's `split_long` does. Pure Java (JVM tests).
 */
final class LongAudio {
    private LongAudio() {}

    /** [start, end) sample ranges covering the whole of `audio`. */
    static List<int[]> pieces(float[] audio, int rate, double maxSeconds, double targetSeconds, double searchSeconds) {
        List<int[]> pieces = new ArrayList<>();
        int hop = rate / 50;
        int blocks = (audio.length + hop - 1) / hop;
        double[] energy = new double[blocks];
        for (int b = 0; b < blocks; b++) {
            int from = b * hop;
            int to = Math.min(audio.length, from + hop);
            double sum = 0;
            for (int i = from; i < to; i++) sum += (double) audio[i] * audio[i];
            energy[b] = Math.sqrt(sum / hop);
        }
        // A centred moving average over ten blocks (numpy's "same" convolution).
        double[] smooth = new double[blocks];
        for (int b = 0; b < blocks; b++) {
            double sum = 0;
            for (int k = b - 5; k < b + 5; k++) {
                if (k >= 0 && k < blocks) sum += energy[k];
            }
            smooth[b] = sum / 10;
        }
        int start = 0;
        while (audio.length - start > maxSeconds * rate) {
            int lo = (start + (int) ((targetSeconds - searchSeconds / 2) * rate)) / hop;
            int hi = (start + (int) ((targetSeconds + searchSeconds / 2) * rate)) / hop;
            int best = lo;
            for (int b = lo; b < Math.min(hi, blocks); b++) {
                if (smooth[b] < smooth[best]) best = b;
            }
            int cut = best * hop;
            pieces.add(new int[] {start, cut});
            start = cut;
        }
        pieces.add(new int[] {start, audio.length});
        return pieces;
    }
}
