package com.firm.mike.speech;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class ModelTest {
    private static final String TOKENIZER = "{\"model\":{\"type\":\"BPE\",\"vocab\":{\"<unk>\":0,\"<pad>\":2,\"▁Hello\":5,\",\":6,\"▁wor\":7,\"ld\":8,\"▁again\":9}},"
        + "\"added_tokens\":[{\"id\":0,\"content\":\"<unk>\",\"special\":true},{\"id\":2,\"content\":\"<pad>\",\"special\":true},{\"id\":3,\"content\":\"<|endoftext|>\",\"special\":true}],"
        + "\"decoder\":{\"type\":\"Metaspace\",\"replacement\":\"▁\"}}";

    @Test
    public void tokenizerDecodesAsTheReferenceScript() throws Exception {
        Tokenizer tokenizer = new Tokenizer(TOKENIZER, 10, 2);
        assertEquals("Hello, world", tokenizer.decode(Arrays.asList(5, 6, 10, 7, 8, 3, 2)));
        assertTrue(tokenizer.startsWord(7));
        assertFalse(tokenizer.startsWord(8));
        assertTrue(tokenizer.isSkipped(3));
        assertEquals("", tokenizer.decode(List.of()));
    }

    /** A joint network that plays back a script of (token, duration index) pairs. */
    private static final class ScriptedJoint implements Transducer.Joint {
        final int vocab;
        final int[][] script;
        final List<Integer> frames = new ArrayList<>();
        int at = 0;

        ScriptedJoint(int vocab, int[][] script) {
            this.vocab = vocab;
            this.script = script;
        }

        @Override
        public float[] logits(int frame, float[] prediction) {
            frames.add(frame);
            int[] step = script[Math.min(at++, script.length - 1)];
            float[] logits = new float[vocab + 5];
            logits[step[0]] = 1;
            logits[vocab + step[1]] = 1;
            return logits;
        }
    }

    private static final class CountingPrediction implements Transducer.Prediction {
        final List<Integer> fed = new ArrayList<>();

        @Override
        public float[] step(int token) {
            fed.add(token);
            return new float[] {token};
        }

        @Override
        public void reset() {
            fed.clear();
        }
    }

    @Test
    public void transducerFollowsTokensAndDurations() throws Exception {
        int vocab = 11;
        int blank = 10;
        Transducer transducer = new Transducer(vocab, blank, 3, new int[] {0, 1, 2, 3, 4}, 10);
        // token 5 staying on frame 0, token 6 then moving 2, blank with duration 0 (forced to 1), token 7 moving 4.
        ScriptedJoint joint = new ScriptedJoint(vocab, new int[][] {{5, 0}, {6, 2}, {blank, 0}, {7, 4}});
        CountingPrediction prediction = new CountingPrediction();
        List<Transducer.Token> tokens = transducer.decode(prediction, joint, 10, 7);
        assertEquals(List.of(new Transducer.Token(5, 0), new Transducer.Token(6, 0), new Transducer.Token(7, 3)), tokens);
        assertEquals(List.of(0, 0, 2, 3), joint.frames);
        // The blank starts the prediction network; each token but the last is fed back.
        assertEquals(List.of(blank, 5, 6), prediction.fed);
    }

    @Test
    public void transducerStopsAtEndOfTextAndAtItsBudget() throws Exception {
        Transducer transducer = new Transducer(11, 10, 3, new int[] {0, 1, 2, 3, 4}, 2);
        List<Transducer.Token> ended = transducer.decode(new CountingPrediction(), new ScriptedJoint(11, new int[][] {{5, 0}, {3, 0}, {6, 0}}), 10, 10);
        assertEquals(List.of(new Transducer.Token(5, 0), new Transducer.Token(3, 0)), ended);
        // A model that never moves on: 2 symbols per frame × 3 frames − 1.
        List<Transducer.Token> stuck = transducer.decode(new CountingPrediction(), new ScriptedJoint(11, new int[][] {{5, 0}}), 3, 3);
        assertEquals(5, stuck.size());
        assertTrue(transducer.decode(new CountingPrediction(), new ScriptedJoint(11, new int[][] {{5, 0}}), 0, 0).isEmpty());
    }

    /**
     * A recogniser over a fixed timeline of words: each word is a word-start
     * token, optionally followed by a continuation token 0.1 s later. It
     * returns the tokens inside the window, as the model would.
     */
    private static final class Timeline implements SlidingWindow.Recognizer {
        final List<SlidingWindow.Timed> tokens = new ArrayList<>();
        final List<int[]> calls = new ArrayList<>();

        Timeline word(int id, double seconds, Integer continuation) {
            tokens.add(new SlidingWindow.Timed(id, seconds, true));
            if (continuation != null) tokens.add(new SlidingWindow.Timed(continuation, seconds + 0.1, false));
            return this;
        }

        @Override
        public List<SlidingWindow.Timed> recognize(int offset, int length) {
            calls.add(new int[] {offset, length});
            double from = offset / 16_000.0;
            double to = (offset + length) / 16_000.0;
            List<SlidingWindow.Timed> out = new ArrayList<>();
            for (SlidingWindow.Timed token : tokens) {
                if (token.seconds() >= from && token.seconds() < to) {
                    out.add(new SlidingWindow.Timed(token.id(), token.seconds() - from, token.startsWord()));
                }
            }
            return out;
        }
    }

    private static int s(double seconds) {
        return SlidingWindow.samples(seconds);
    }

    @Test
    public void slidingWindowConfirmsChunksWithoutSplittingWords() throws Exception {
        // A word at 2.95 s whose second piece (3.05 s) falls past the first chunk.
        Timeline timeline = new Timeline().word(1, 0.5, null).word(2, 2.95, 20).word(3, 4.0, null).word(4, 6.5, 40).word(5, 8.2, null);
        SlidingWindow window = new SlidingWindow(timeline);

        // Nothing before a second of audio.
        assertEquals(null, window.step(s(0.5)));
        // A hypothesis pass for the volatile text.
        SlidingWindow.Update first = window.step(s(1.0));
        assertEquals(List.of(), first.confirmed());
        assertEquals(List.of(1), first.volatileTokens());

        // At 4.5 s the first chunk (0–3 s) is confirmed with the word it leaves open.
        SlidingWindow.Update chunk = window.step(s(4.5));
        assertEquals(List.of(1, 2, 20), chunk.confirmed());
        assertEquals(List.of(3), chunk.volatileTokens());
        assertEquals(s(3.0), window.confirmedUntil());

        // The next chunk starts 3 s back (0–7.5 s) and skips the finished word's piece.
        SlidingWindow.Update second = window.step(s(7.5));
        assertEquals(List.of(1, 2, 20, 3), second.confirmed());
        assertEquals(List.of(4, 40), second.volatileTokens());
        assertArrayEquals(new int[] {0, s(7.5)}, timeline.calls.get(timeline.calls.size() - 1));

        // Stopping confirms the rest.
        SlidingWindow.Update last = window.finish(s(9.0));
        assertEquals(List.of(1, 2, 20, 3, 4, 40, 5), last.confirmed());
        assertEquals(List.of(), last.volatileTokens());
        assertArrayEquals(new int[] {s(3.0), s(6.0)}, timeline.calls.get(timeline.calls.size() - 1));
    }

    @Test
    public void slidingWindowOnShortDictation() throws Exception {
        Timeline timeline = new Timeline().word(1, 0.2, 10).word(2, 0.8, null);
        SlidingWindow window = new SlidingWindow(timeline);
        assertEquals(List.of(1, 10, 2), window.finish(s(1.2)).confirmed());
        // Nothing heard: no pass at all.
        SlidingWindow empty = new SlidingWindow(timeline);
        assertEquals(List.of(), empty.finish(0).confirmed());
    }

    private static void assertArrayEquals(int[] expected, int[] actual) {
        org.junit.Assert.assertArrayEquals(expected, actual);
    }
}
