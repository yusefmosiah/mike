package com.firm.mike.speech;

import java.util.ArrayList;
import java.util.List;

/**
 * Greedy token-and-duration (TDT) decoding of Fluid Speech Mini's encoder
 * output, the loop of the reference script's `greedy_tdt`: the joint network
 * scores a token and how many encoder frames to move on; a non-blank token
 * feeds the prediction network. Each token keeps the frame it was emitted at
 * (80 ms apart), which live dictation uses to place it in time. The networks
 * are behind interfaces so the loop is tested without the model.
 */
final class Transducer {
    interface Prediction {
        /** The prediction network's output after `token`, advancing its state. */
        float[] step(int token) throws Exception;

        /** Back to the start state. */
        void reset();
    }

    interface Joint {
        /** Logits: `vocab` token scores, then one score per duration. */
        float[] logits(int frame, float[] predictionOut) throws Exception;
    }

    /** One emitted token and the encoder frame it was emitted at. */
    record Token(int id, int frame) {}

    final int vocab;
    final int blank;
    final int eos;
    final int[] durations;
    final int maxSymbolsPerStep;

    Transducer(int vocab, int blank, int eos, int[] durations, int maxSymbolsPerStep) {
        this.vocab = vocab;
        this.blank = blank;
        this.eos = eos;
        this.durations = durations;
        this.maxSymbolsPerStep = maxSymbolsPerStep;
    }

    /** The non-blank tokens for `frames` encoder frames of which `valid` hold audio. */
    List<Token> decode(Prediction prediction, Joint joint, int frames, int valid) throws Exception {
        List<Token> emitted = new ArrayList<>();
        if (frames <= 0 || valid <= 0) return emitted;
        prediction.reset();
        float[] predictionOut = prediction.step(blank);
        int budget = maxSymbolsPerStep * frames - 1;
        int steps = 0;
        int t = 0;
        while (true) {
            float[] logits = joint.logits(Math.min(t, frames - 1), predictionOut);
            int token = argmax(logits, 0, vocab);
            int step = durations[argmax(logits, vocab, logits.length) - vocab];
            if (token == blank && step == 0) step = 1;
            steps++;
            if (token != blank) emitted.add(new Token(token, Math.min(t, frames - 1)));
            t += step;
            if (t >= valid || steps >= budget || token == eos) return emitted;
            if (token != blank) predictionOut = prediction.step(token);
        }
    }

    static int argmax(float[] values, int from, int to) {
        int best = from;
        for (int i = from + 1; i < to; i++) {
            if (values[i] > values[best]) best = i;
        }
        return best;
    }
}
