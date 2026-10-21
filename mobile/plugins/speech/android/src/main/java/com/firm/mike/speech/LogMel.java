package com.firm.mike.speech;

/**
 * Fluid Speech Mini's input features: the log-mel spectrogram of the ONNX
 * build's reference script (transcribe.py, `log_mel`, the same as Hugging
 * Face's ParakeetFeatureExtractor): pre-emphasis, a 400-sample Hann window in
 * a 512-point FFT every 160 samples, 128 mel bands, log, then each band
 * normalised over the clip. Pure Java (JVM tests).
 */
final class LogMel {
    static final double LOG_ZERO_GUARD = Math.pow(2, -24);
    static final double NORM_EPS = 1e-5;

    final int nFft;
    final int hop;
    final int win;
    final float preemphasis;
    /** [mels][nFft / 2 + 1]. */
    final float[][] filters;
    private final double[] window;
    private final Fft fft;

    LogMel(int nFft, int hop, int win, float preemphasis, float[][] filters) {
        this.nFft = nFft;
        this.hop = hop;
        this.win = win;
        this.preemphasis = preemphasis;
        this.filters = filters;
        window = new double[nFft];
        int left = (nFft - win) / 2;
        for (int n = 0; n < win; n++) {
            window[left + n] = (float) (0.5 - 0.5 * Math.cos(2.0 * Math.PI * n / (win - 1)));
        }
        fft = new Fft(nFft);
    }

    /** The features. */
    static final class Features {
        /** Row-major [frames][mels]. */
        final float[] values;
        final int frames;
        final int mels;
        /** Frames before this one hold audio; the rest are zero. */
        final int valid;

        Features(float[] values, int frames, int mels, int valid) {
            this.values = values;
            this.frames = frames;
            this.mels = mels;
            this.valid = valid;
        }
    }

    Features compute(float[] audio) {
        int length = audio.length;
        float[] x = new float[length];
        if (length > 0) x[0] = audio[0];
        for (int i = 1; i < length; i++) x[i] = preemphasis != 0 ? audio[i] - preemphasis * audio[i - 1] : audio[i];
        int pad = nFft / 2;
        int frames = 1 + length / hop;
        int mels = filters.length;
        int bins = nFft / 2 + 1;
        float[] out = new float[frames * mels];
        double[] re = new double[nFft];
        double[] im = new double[nFft];
        float[] power = new float[bins];
        for (int frame = 0; frame < frames; frame++) {
            int start = frame * hop - pad;
            for (int k = 0; k < nFft; k++) {
                int index = start + k;
                re[k] = index >= 0 && index < length ? x[index] * window[k] : 0;
                im[k] = 0;
            }
            fft.transform(re, im);
            for (int k = 0; k < bins; k++) power[k] = (float) (re[k] * re[k] + im[k] * im[k]);
            for (int m = 0; m < mels; m++) {
                float[] row = filters[m];
                float sum = 0;
                for (int k = 0; k < bins; k++) sum += power[k] * row[k];
                out[frame * mels + m] = (float) Math.log(sum + LOG_ZERO_GUARD);
            }
        }
        int valid = Math.min(length / hop, frames);
        for (int m = 0; m < mels; m++) {
            double mean = 0;
            for (int f = 0; f < valid; f++) mean += out[f * mels + m];
            mean = valid > 0 ? mean / valid : 0;
            double variance = 0;
            for (int f = 0; f < valid; f++) {
                double d = out[f * mels + m] - mean;
                variance += d * d;
            }
            variance /= Math.max(valid - 1, 1);
            double scale = Math.sqrt(variance) + NORM_EPS;
            for (int f = 0; f < frames; f++) {
                out[f * mels + m] = f < valid ? (float) ((out[f * mels + m] - mean) / scale) : 0f;
            }
        }
        return new Features(out, frames, mels, valid);
    }

    /** An in-place radix-2 complex FFT of one size. */
    static final class Fft {
        private final int n;
        private final double[] cos;
        private final double[] sin;
        private final int[] reversed;

        Fft(int n) {
            if (Integer.bitCount(n) != 1) throw new IllegalArgumentException("FFT size must be a power of two");
            this.n = n;
            cos = new double[n / 2];
            sin = new double[n / 2];
            for (int i = 0; i < n / 2; i++) {
                cos[i] = Math.cos(-2 * Math.PI * i / n);
                sin[i] = Math.sin(-2 * Math.PI * i / n);
            }
            reversed = new int[n];
            int bits = Integer.numberOfTrailingZeros(n);
            for (int i = 0; i < n; i++) reversed[i] = Integer.reverse(i) >>> (32 - bits);
        }

        void transform(double[] re, double[] im) {
            for (int i = 0; i < n; i++) {
                int j = reversed[i];
                if (j > i) {
                    double t = re[i]; re[i] = re[j]; re[j] = t;
                    t = im[i]; im[i] = im[j]; im[j] = t;
                }
            }
            for (int size = 2; size <= n; size <<= 1) {
                int half = size / 2;
                int stride = n / size;
                for (int start = 0; start < n; start += size) {
                    for (int k = 0; k < half; k++) {
                        double wr = cos[k * stride];
                        double wi = sin[k * stride];
                        int a = start + k;
                        int b = a + half;
                        double tr = re[b] * wr - im[b] * wi;
                        double ti = re[b] * wi + im[b] * wr;
                        re[b] = re[a] - tr;
                        im[b] = im[a] - ti;
                        re[a] += tr;
                        im[a] += ti;
                    }
                }
            }
        }
    }
}
