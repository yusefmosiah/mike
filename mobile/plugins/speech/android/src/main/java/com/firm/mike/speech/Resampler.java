package com.firm.mike.speech;

/**
 * Converts decoded audio to what Fluid Speech Mini reads: mono float samples
 * at 16 kHz. Channels are averaged; the rate is changed with a windowed-sinc
 * filter whose cutoff sits just below the lower of the two Nyquist rates, so
 * downsampling (48 kHz from the microphone, 44.1 kHz AAC) does not alias.
 * Pure Java (JVM tests).
 */
final class Resampler {
    /** Zero crossings of the sinc on each side of a sample. */
    static final int ZERO_CROSSINGS = 8;
    /** The cutoff as a fraction of the lower Nyquist rate. */
    static final double ROLLOFF = 0.94;
    /** Kernel table resolution: points per input sample (interpolated linearly between). */
    static final int TABLE_STEPS = 512;

    private Resampler() {}

    /** Interleaved samples of `channels` channels, averaged to one. */
    static float[] downmix(float[] interleaved, int channels) {
        if (channels <= 1) return interleaved;
        int frames = interleaved.length / channels;
        float[] mono = new float[frames];
        for (int frame = 0; frame < frames; frame++) {
            float sum = 0;
            for (int channel = 0; channel < channels; channel++) sum += interleaved[frame * channels + channel];
            mono[frame] = sum / channels;
        }
        return mono;
    }

    /** 16-bit PCM as floats in [-1, 1). */
    static float[] fromPcm16(short[] pcm, int length) {
        float[] out = new float[length];
        for (int i = 0; i < length; i++) out[i] = pcm[i] / 32768f;
        return out;
    }

    static float[] resample(float[] input, int fromRate, int toRate) {
        if (fromRate == toRate || input.length == 0) return input;
        Stream stream = new Stream(fromRate, toRate);
        FloatList out = new FloatList();
        stream.push(input, input.length, out);
        stream.flush(out);
        return out.toArray();
    }

    /**
     * The same conversion fed piece by piece (a decoder's buffers), keeping only
     * the input the filter still needs, so a long recording is never held at
     * its original rate.
     */
    static final class Stream {
        private final double step;
        private final double cutoff;
        private final double halfWidth;
        private final double ratio;
        /** The kernel at TABLE_STEPS points per input sample, from 0 to the half-width. */
        private final float[] table;
        private float[] buffer = new float[8192];
        /** Input index of buffer[0]. */
        private long bufferStart = 0;
        private int buffered = 0;
        private long nextOutput = 0;
        private long inputLength = 0;

        Stream(int fromRate, int toRate) {
            ratio = (double) toRate / fromRate;
            step = (double) fromRate / toRate;
            cutoff = Math.min(1.0, ratio) * ROLLOFF;
            halfWidth = ZERO_CROSSINGS / cutoff;
            table = new float[(int) Math.ceil(halfWidth * TABLE_STEPS) + 2];
            for (int i = 0; i < table.length; i++) table[i] = (float) kernel(i / (double) TABLE_STEPS, cutoff, halfWidth);
        }

        /** The kernel at distance `x`, interpolated from the table. */
        private double tap(double x) {
            double position = Math.abs(x) * TABLE_STEPS;
            int index = (int) position;
            if (index + 1 >= table.length) return 0;
            double fraction = position - index;
            return table[index] + (table[index + 1] - table[index]) * fraction;
        }

        void push(float[] input, int length, FloatList out) {
            if (buffered + length > buffer.length) {
                float[] grown = new float[Math.max(buffer.length * 2, buffered + length)];
                System.arraycopy(buffer, 0, grown, 0, buffered);
                buffer = grown;
            }
            System.arraycopy(input, 0, buffer, buffered, length);
            buffered += length;
            inputLength += length;
            emit(out, false);
        }

        void flush(FloatList out) {
            emit(out, true);
        }

        private void emit(FloatList out, boolean last) {
            long total = last ? (long) Math.floor(inputLength * ratio) : Long.MAX_VALUE;
            while (nextOutput < total) {
                double center = nextOutput * step;
                long first = (long) Math.ceil(center - halfWidth);
                long lastIndex = (long) Math.floor(center + halfWidth);
                if (!last && lastIndex >= inputLength) break;
                double sum = 0;
                long from = Math.max(Math.max(0, first), bufferStart);
                long to = Math.min(inputLength - 1, lastIndex);
                for (long k = from; k <= to; k++) {
                    sum += buffer[(int) (k - bufferStart)] * tap(center - k);
                }
                out.add((float) sum);
                nextOutput++;
            }
            // Drop the input no later output can reach.
            long keepFrom = (long) Math.ceil(nextOutput * step - halfWidth) - 1;
            int drop = (int) Math.max(0, Math.min(buffered, keepFrom - bufferStart));
            if (drop > 0) {
                System.arraycopy(buffer, drop, buffer, 0, buffered - drop);
                buffered -= drop;
                bufferStart += drop;
            }
        }
    }

    /** A growable float array. */
    static final class FloatList {
        private float[] values = new float[16_384];
        private int size = 0;

        void add(float value) {
            if (size == values.length) values = java.util.Arrays.copyOf(values, values.length * 2);
            values[size++] = value;
        }

        void addAll(float[] more, int length) {
            if (size + length > values.length) values = java.util.Arrays.copyOf(values, Math.max(values.length * 2, size + length));
            System.arraycopy(more, 0, values, size, length);
            size += length;
        }

        int size() {
            return size;
        }

        void clear() {
            values = new float[16];
            size = 0;
        }

        float[] toArray() {
            return java.util.Arrays.copyOf(values, size);
        }

        /** A copy of [from, from + length). */
        float[] copy(int from, int length) {
            return java.util.Arrays.copyOfRange(values, from, from + length);
        }
    }

    /** cutoff · sinc(cutoff · x), tapered by a Hann window of half-width `halfWidth`. */
    static double kernel(double x, double cutoff, double halfWidth) {
        if (Math.abs(x) >= halfWidth) return 0;
        double arg = Math.PI * cutoff * x;
        double sinc = arg == 0 ? 1 : Math.sin(arg) / arg;
        double window = 0.5 + 0.5 * Math.cos(Math.PI * x / halfWidth);
        return cutoff * sinc * window;
    }
}
