package com.firm.mike.speech;

import java.util.ArrayList;
import java.util.List;

/**
 * Live dictation's windows over the audio heard so far, with the iPhone's
 * live configuration (LiveDictation.swift): the audio is confirmed in 3 s
 * chunks, each transcribed with 3 s of audio before it and 1.5 s after it, so
 * the first text arrives about 4.5 s in and then every 3 s; between chunks the
 * tail is transcribed again about once a second for the volatile text. A
 * token belongs to the chunk its time falls in; a word cut by the chunk's end
 * is finished from the same pass, and the next chunk skips its remaining
 * pieces, so no word is split or repeated at a seam. Pure Java (JVM tests).
 */
final class SlidingWindow {
    static final int RATE = 16_000;
    static final double CHUNK_SECONDS = 3.0;
    static final double LEFT_CONTEXT_SECONDS = 3.0;
    static final double RIGHT_CONTEXT_SECONDS = 1.5;
    static final double HYPOTHESIS_SECONDS = 1.0;
    /** Fluid Speech Mini's encoder frame: 8 × 10 ms. */
    static final double FRAME_SECONDS = 0.08;

    /** A token with its time in seconds from the start of the dictation. */
    record Timed(int id, double seconds, boolean startsWord) {}

    /** Transcribes `length` samples from `offset`; token times are relative to `offset`. */
    interface Recognizer {
        List<Timed> recognize(int offset, int length) throws Exception;
    }

    /** The text so far, as token ids. */
    record Update(List<Integer> confirmed, List<Integer> volatileTokens) {}

    private final Recognizer recognizer;
    private final List<Integer> confirmed = new ArrayList<>();
    private List<Integer> volatileTokens = new ArrayList<>();
    /** Samples up to here are confirmed. */
    private int confirmedUntil = 0;
    /** The end of the audio the last pass looked at. */
    private int lastPassEnd = 0;

    SlidingWindow(Recognizer recognizer) {
        this.recognizer = recognizer;
    }

    static int samples(double seconds) {
        return (int) Math.round(seconds * RATE);
    }

    /**
     * One step with `available` samples heard: confirms the next chunk when
     * its right context has arrived, otherwise refreshes the volatile tail
     * when a second of new audio has. Returns null when there was nothing to do.
     */
    Update step(int available) throws Exception {
        int chunkEnd = confirmedUntil + samples(CHUNK_SECONDS);
        if (available >= chunkEnd + samples(RIGHT_CONTEXT_SECONDS)) {
            int windowEnd = chunkEnd + samples(RIGHT_CONTEXT_SECONDS);
            List<Timed> tokens = pass(windowEnd);
            int boundary = acceptUntil(tokens, chunkEnd);
            volatileTokens = ids(tokens.subList(boundary, tokens.size()));
            confirmedUntil = chunkEnd;
            return snapshot();
        }
        if (available - lastPassEnd >= samples(HYPOTHESIS_SECONDS) && available > confirmedUntil) {
            volatileTokens = ids(pass(available));
            return snapshot();
        }
        return null;
    }

    /** The last pass: everything after the confirmed chunks becomes confirmed. */
    Update finish(int available) throws Exception {
        if (available > confirmedUntil) {
            List<Timed> tokens = pass(available);
            confirmed.addAll(ids(tokens));
            confirmedUntil = available;
        }
        volatileTokens = new ArrayList<>();
        return snapshot();
    }

    int confirmedUntil() {
        return confirmedUntil;
    }

    /**
     * Transcribes from `LEFT_CONTEXT` before the confirmed audio to `end` and
     * keeps the tokens at or after the confirmed audio, without the pieces of
     * a word the last chunk already finished.
     */
    private List<Timed> pass(int end) throws Exception {
        int start = Math.max(0, confirmedUntil - samples(LEFT_CONTEXT_SECONDS));
        lastPassEnd = end;
        double offsetSeconds = start / (double) RATE;
        double from = confirmedUntil / (double) RATE;
        List<Timed> kept = new ArrayList<>();
        boolean leading = !confirmed.isEmpty();
        for (Timed token : recognizer.recognize(start, end - start)) {
            double seconds = token.seconds() + offsetSeconds;
            if (seconds + 1e-9 < from) continue;
            if (leading && !token.startsWord()) continue;
            leading = false;
            kept.add(new Timed(token.id(), seconds, token.startsWord()));
        }
        return kept;
    }

    /** Confirms the tokens before `end` (and the rest of the word they leave open); returns how many. */
    private int acceptUntil(List<Timed> tokens, int end) {
        double limit = end / (double) RATE;
        int index = 0;
        while (index < tokens.size() && tokens.get(index).seconds() + 1e-9 < limit) index++;
        if (index > 0) {
            while (index < tokens.size() && !tokens.get(index).startsWord()) index++;
        }
        confirmed.addAll(ids(tokens.subList(0, index)));
        return index;
    }

    private Update snapshot() {
        return new Update(new ArrayList<>(confirmed), new ArrayList<>(volatileTokens));
    }

    private static List<Integer> ids(List<Timed> tokens) {
        List<Integer> ids = new ArrayList<>(tokens.size());
        for (Timed token : tokens) ids.add(token.id());
        return ids;
    }
}
