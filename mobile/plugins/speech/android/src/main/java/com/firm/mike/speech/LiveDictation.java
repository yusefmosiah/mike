package com.firm.mike.speech;

import android.annotation.SuppressLint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Future;

/**
 * One live dictation at a time: the microphone (AudioRecord, the
 * VOICE_RECOGNITION source, 16 kHz mono) feeds an in-memory buffer, and
 * Fluid Speech Mini transcribes it in sliding windows ({@link SlidingWindow},
 * the iPhone's live configuration) on the model's thread, reporting the text
 * so far after each pass. Audio is never written to disk or logged, and
 * neither is the text.
 */
final class LiveDictation {
    /** What the plugin forwards as `liveTranscript` events. */
    interface Events {
        void transcript(String confirmed, String volatileText, boolean ended);

        void level(float level);
    }

    /** Where the audio comes from: the microphone in the app, a clip in tests. */
    interface Source {
        /** Starts delivering 16 kHz mono samples; `lost` is called once if the input stops on its own. */
        void start(Sink sink) throws SpeechFailure;

        void stop();
    }

    interface Sink {
        void samples(float[] samples, int length);

        void lost();
    }

    static final double LEVEL_INTERVAL_SECONDS = 0.1;

    private final FluidSpeechMini runtime;
    private Session session;
    /** The text of a dictation that ended on its own, until `stop` collects it. */
    private String endedText;

    LiveDictation(FluidSpeechMini runtime) {
        this.runtime = runtime;
    }

    synchronized void start(Source source, Events events) throws SpeechFailure {
        cancel();
        endedText = null;
        if (!runtime.isInstalled()) throw new SpeechFailure(SpeechFailure.NOT_INSTALLED);
        Session created = new Session(source, events);
        session = created;
        try {
            created.start();
        } catch (SpeechFailure failure) {
            session = null;
            throw failure;
        }
    }

    /** Stops and returns the whole text; after an interruption, the text kept then. */
    String stop() throws SpeechFailure {
        Session current;
        synchronized (this) {
            current = session;
            session = null;
            if (current == null) {
                String text = endedText;
                endedText = null;
                if (text != null) return text;
                throw new SpeechFailure(SpeechFailure.FAILED);
            }
        }
        return current.finish();
    }

    void cancel() {
        Session current;
        synchronized (this) {
            endedText = null;
            current = session;
            session = null;
        }
        if (current != null) current.cancel();
    }

    /** The app went to the background: end as if stopped, keep the text and tell the web app. */
    void interrupt() {
        Session current;
        synchronized (this) {
            current = session;
        }
        if (current != null) current.interrupted();
    }

    private synchronized void ended(Session ending, String text) {
        if (session == ending) {
            session = null;
            endedText = text;
        }
    }

    private final class Session implements Sink {
        private final Source source;
        private final Events events;
        private final Resampler.FloatList audio = new Resampler.FloatList();
        private final Object lock = new Object();
        /** Stops the loop's pass in flight when the dictation stops. */
        private final FluidModel.Cancel loopCancel = new FluidModel.Cancel();
        /** Set for the last pass, which must not be stopped. */
        private volatile boolean lastPass = false;
        private SlidingWindow window;
        private Future<?> loop;
        private volatile boolean running = true;
        private volatile boolean cancelled = false;
        private boolean finishing = false;
        private String finalText;
        private long lastLevelAt = 0;
        private int levelSamples = 0;
        private double levelSum = 0;

        Session(Source source, Events events) {
            this.source = source;
            this.events = events;
        }

        void start() throws SpeechFailure {
            // Load (or keep) the model before the microphone opens.
            runtime.run(() -> {
                runtime.loaded();
                runtime.beginLive();
                return null;
            });
            FluidBackend[] model = new FluidBackend[1];
            window = new SlidingWindow((offset, length) -> {
                float[] copy;
                synchronized (lock) {
                    copy = audio.copy(offset, length);
                }
                return model[0].recognize(copy, 0, copy.length, lastPass ? null : loopCancel);
            });
            try {
                source.start(this);
            } catch (SpeechFailure failure) {
                runtime.worker.execute(runtime::endLive);
                throw failure;
            }
            loop = runtime.worker.submit(() -> {
                try {
                    model[0] = runtime.loaded();
                    while (running) {
                        int available;
                        synchronized (lock) {
                            available = audio.size();
                        }
                        SlidingWindow.Update update = window.step(available);
                        if (update != null && running) send(update, false);
                        if (update == null) Thread.sleep(50);
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } catch (FluidModel.Cancelled e) {
                    // Stopped: the last pass below takes over.
                } catch (Exception e) {
                    running = false;
                }
                return null;
            });
        }

        @Override
        public void samples(float[] samples, int length) {
            synchronized (lock) {
                audio.addAll(samples, length);
            }
            for (int i = 0; i < length; i++) levelSum += samples[i] * samples[i];
            levelSamples += length;
            long now = System.nanoTime();
            if (now - lastLevelAt >= LEVEL_INTERVAL_SECONDS * 1e9 && levelSamples > 0) {
                lastLevelAt = now;
                float rms = (float) Math.sqrt(levelSum / levelSamples);
                levelSum = 0;
                levelSamples = 0;
                events.level(Math.min(1f, rms * 6f));
            }
        }

        @Override
        public void lost() {
            interrupted();
        }

        private void send(SlidingWindow.Update update, boolean ended) {
            Tokenizer tokenizer = runtime.loadedTokenizer();
            if (tokenizer == null) return;
            events.transcript(tokenizer.decode(update.confirmed()).trim(), tokenizer.decode(update.volatileTokens()).trim(), ended);
        }

        /** Stops listening, finishes the transcription and returns the whole text. */
        String finish() throws SpeechFailure {
            synchronized (this) {
                if (finalText != null) return finalText;
                if (finishing) throw new SpeechFailure(SpeechFailure.FAILED);
                finishing = true;
            }
            source.stop();
            running = false;
            // A pass in flight would only delay the last one, which covers its audio too.
            loopCancel.cancel();
            try {
                if (loop != null) loop.get();
            } catch (Exception ignored) {
                // The last pass below reports a failure.
            }
            try {
                lastPass = true;
                String text = runtime.run(() -> {
                    int available;
                    synchronized (lock) {
                        available = audio.size();
                    }
                    SlidingWindow.Update update = window.finish(available);
                    return runtime.loaded().tokenizer().decode(update.confirmed()).trim();
                });
                synchronized (this) {
                    finalText = text;
                }
                return text;
            } finally {
                release();
            }
        }

        void cancel() {
            cancelled = true;
            running = false;
            loopCancel.cancel();
            source.stop();
            if (loop != null) loop.cancel(false);
            release();
        }

        void interrupted() {
            if (cancelled) return;
            synchronized (this) {
                if (finishing) return;
            }
            // Off the audio thread: finishing waits for the model.
            new Thread(() -> {
                try {
                    String text = finish();
                    ended(this, text);
                    events.transcript(text, "", true);
                } catch (SpeechFailure failure) {
                    ended(this, "");
                    events.transcript("", "", true);
                }
            }, "mike-live-ended").start();
        }

        private boolean released = false;

        private void release() {
            synchronized (this) {
                if (released) return;
                released = true;
            }
            runtime.worker.execute(runtime::endLive);
            synchronized (lock) {
                audio.clear();
            }
        }
    }

    /** The microphone. */
    static final class Microphone implements Source {
        private AudioRecord record;
        private Thread reader;
        private volatile boolean reading;

        @Override
        @SuppressLint("MissingPermission") // The plugin asks for RECORD_AUDIO first.
        public void start(Sink sink) throws SpeechFailure {
            int rate = SlidingWindow.RATE;
            int minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) throw new SpeechFailure(SpeechFailure.UNAVAILABLE);
            try {
                record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, rate / 5 * 2));
            } catch (SecurityException e) {
                throw new SpeechFailure(SpeechFailure.PERMISSION_DENIED, e);
            } catch (RuntimeException e) {
                throw new SpeechFailure(SpeechFailure.FAILED, e);
            }
            if (record.getState() != AudioRecord.STATE_INITIALIZED) {
                record.release();
                record = null;
                throw new SpeechFailure(SpeechFailure.FAILED);
            }
            try {
                record.startRecording();
            } catch (RuntimeException e) {
                record.release();
                record = null;
                throw new SpeechFailure(SpeechFailure.FAILED, e);
            }
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                record.release();
                record = null;
                throw new SpeechFailure(SpeechFailure.FAILED);
            }
            reading = true;
            AudioRecord active = record;
            reader = new Thread(() -> {
                short[] pcm = new short[rate / 10];
                float[] samples = new float[pcm.length];
                while (reading) {
                    int read = active.read(pcm, 0, pcm.length);
                    if (read < 0) {
                        if (reading) sink.lost();
                        return;
                    }
                    for (int i = 0; i < read; i++) samples[i] = pcm[i] / 32768f;
                    sink.samples(samples, read);
                }
            }, "mike-live-microphone");
            reader.start();
        }

        @Override
        public synchronized void stop() {
            reading = false;
            if (record != null) {
                try {
                    record.stop();
                } catch (RuntimeException ignored) {
                    // Already stopped.
                }
            }
            if (reader != null && reader != Thread.currentThread()) {
                try {
                    reader.join(1_000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            if (record != null) record.release();
            record = null;
            reader = null;
        }
    }

    /** A clip played into the session at `speed` × real time (tests). */
    static final class Clip implements Source {
        private final float[] clip;
        private final double speed;
        private Thread player;
        private volatile boolean playing;

        Clip(float[] clip, double speed) {
            this.clip = clip;
            this.speed = speed;
        }

        @Override
        public void start(Sink sink) {
            playing = true;
            player = new Thread(() -> {
                int step = SlidingWindow.RATE / 10;
                for (int at = 0; at < clip.length && playing; at += step) {
                    int length = Math.min(step, clip.length - at);
                    float[] piece = new float[length];
                    System.arraycopy(clip, at, piece, 0, length);
                    sink.samples(piece, length);
                    try {
                        Thread.sleep((long) (100 / speed));
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }, "mike-live-clip");
            player.start();
        }

        @Override
        public void stop() {
            playing = false;
            if (player != null) {
                try {
                    player.join(1_000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }

        /** Whether the whole clip has been delivered. */
        boolean done() {
            return player != null && !player.isAlive();
        }
    }

    /** For tests: events collected in order. */
    static final class Recorded implements Events {
        final List<String[]> transcripts = new ArrayList<>();
        int levels = 0;

        @Override
        public synchronized void transcript(String confirmed, String volatileText, boolean ended) {
            transcripts.add(new String[] {confirmed, volatileText, ended ? "ended" : ""});
        }

        @Override
        public synchronized void level(float level) {
            levels++;
        }
    }
}
