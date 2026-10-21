package com.firm.mike.speech;

import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.res.Configuration;
import android.system.Os;
import java.io.File;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Read-aloud with Phonon 31m by Gradium (Apache-2.0), English, on the phone's
 * CPU through xn-ptts's C library ({@link Phonon}). The model is downloaded on
 * the person's request ({@link ModelPack#phonon()}: the upstream q8 weights
 * and the eight voices the web app offers, pinned and checked, about 67 MB)
 * into the app's no-backup files, and `remove` deletes it. Nothing leaves the
 * phone except the model's own download; neither text nor audio is logged.
 *
 * The model loads on the first reading (under a second; there is no Core ML
 * compilation step on Android), and is dropped on memory pressure and after
 * five idle minutes, but not in the background, where a reading may continue.
 */
final class PhononVoice {
    /** The `engine` value the web app sends. */
    static final String ENGINE = "phonon";
    static final int SAMPLE_RATE = 24_000;
    static final long IDLE_MINUTES = 5;
    /** Phonon's own default: one thread per core is too many on phones with mixed cores. */
    static final String THREADS = "4";

    private static PhononVoice shared;

    static synchronized PhononVoice shared(Context context) {
        if (shared == null) shared = new PhononVoice(context.getApplicationContext());
        return shared;
    }

    private final ModelPack pack = ModelPack.phonon();
    private final ModelInstaller installer;
    private final ExecutorService worker = Executors.newSingleThreadExecutor((runnable) -> new Thread(runnable, "mike-phonon"));
    private final ExecutorService downloads = Executors.newSingleThreadExecutor((runnable) -> new Thread(runnable, "mike-phonon-download"));
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor((runnable) -> new Thread(runnable, "mike-phonon-idle"));

    private Phonon phonon;
    private String voice;
    private ScheduledFuture<?> idle;
    private Future<?> install;
    private volatile double progress = 0;
    private volatile boolean cancelInstall = false;

    private PhononVoice(Context context) {
        installer = new ModelInstaller(new File(context.getNoBackupFilesDir(), "speech-models"));
        context.registerComponentCallbacks(new ComponentCallbacks2() {
            @Override
            public void onTrimMemory(int level) {
                if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL
                    || level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) {
                    worker.execute(PhononVoice.this::unload);
                }
            }

            @Override
            public void onConfigurationChanged(Configuration configuration) {}

            @Override
            public void onLowMemory() {
                worker.execute(PhononVoice.this::unload);
            }
        });
    }

    /** Whether this build carries the library and the phone can load it. */
    static boolean canSpeak() {
        return Phonon.library() != null;
    }

    /** What `status` reports for `engine: "phonon"`. */
    record Status(String state, Double progress, long downloadBytes) {}

    synchronized Status status() {
        if (!canSpeak()) return new Status("unavailable", null, 0);
        if (install != null && !install.isDone()) return new Status("installing", progress, pack.totalBytes());
        if (!installer.isInstalled(pack)) return new Status("not-installed", null, pack.totalBytes());
        return new Status("available", null, 0);
    }

    void install() throws SpeechFailure {
        if (!canSpeak()) throw new SpeechFailure(SpeechFailure.INSTALL_FAILED);
        Future<?> running;
        synchronized (this) {
            if (install == null || install.isDone()) {
                progress = 0;
                cancelInstall = false;
                install = downloads.submit(() -> {
                    installer.install(pack, (fraction) -> progress = Math.max(progress, fraction), () -> cancelInstall);
                    return null;
                });
            }
            running = install;
        }
        try {
            running.get();
        } catch (Exception e) {
            throw new SpeechFailure(SpeechFailure.INSTALL_FAILED, e.getCause() != null ? e.getCause() : e);
        }
    }

    void remove() {
        Future<?> running;
        synchronized (this) {
            cancelInstall = true;
            running = install;
        }
        if (running != null) {
            try {
                running.get(30, TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // Cancelled, as asked.
            }
        }
        try {
            worker.submit(this::unload).get();
        } catch (Exception ignored) {
            // Nothing loaded.
        }
        installer.remove(pack);
    }

    /** `text` read by the voice named `voiceName` (or the model's default), as a 16-bit mono WAV at 24 kHz. */
    byte[] render(String text, String voiceName) throws SpeechFailure {
        String trimmed = text == null ? "" : text.trim();
        if (trimmed.isEmpty()) throw new SpeechFailure(SpeechFailure.EMPTY_TEXT);
        if (!canSpeak() || !installer.isInstalled(pack)) throw new SpeechFailure(SpeechFailure.NOT_INSTALLED);
        Future<float[]> future = worker.submit(() -> {
            cancelIdle();
            try {
                Phonon tts = loaded();
                String wanted = voiceName != null && tts.voices().contains(voiceName) ? voiceName : null;
                if (wanted != null && !wanted.equals(voice)) {
                    tts.setVoice(wanted);
                    voice = wanted;
                }
                return tts.speak(trimmed);
            } finally {
                scheduleUnload();
            }
        });
        try {
            return Wav.encode(future.get(), SAMPLE_RATE);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SpeechFailure(SpeechFailure.FAILED, e);
        } catch (Exception e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof SpeechFailure failure) throw failure;
            throw new SpeechFailure(SpeechFailure.FAILED, cause);
        }
    }

    /** The voices of the loaded model (tests). */
    List<String> voices() throws Exception {
        return worker.submit(() -> loaded().voices()).get();
    }

    private Phonon loaded() throws SpeechFailure {
        if (phonon != null) return phonon;
        try {
            // Read by the library's thread pool when the first model loads.
            Os.setenv("RAYON_NUM_THREADS", THREADS, false);
        } catch (Exception ignored) {
            // The library's default then applies.
        }
        try {
            phonon = new Phonon(installer.directory(pack).getPath(), "en");
        } catch (SpeechFailure failure) {
            throw failure;
        } catch (Throwable e) {
            throw new SpeechFailure(SpeechFailure.FAILED, e);
        }
        voice = null;
        return phonon;
    }

    private void cancelIdle() {
        if (idle != null) idle.cancel(false);
        idle = null;
    }

    private void scheduleUnload() {
        cancelIdle();
        if (phonon == null) return;
        idle = timers.schedule(() -> worker.execute(this::unload), IDLE_MINUTES, TimeUnit.MINUTES);
    }

    private void unload() {
        cancelIdle();
        if (phonon != null) phonon.close();
        phonon = null;
        voice = null;
    }
}
