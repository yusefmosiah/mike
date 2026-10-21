package com.firm.mike.speech;

import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.res.Configuration;
import java.io.File;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Dictation with Fluid Speech Mini by FluidVoice (CC BY 4.0), English only,
 * on the phone's CPU through ONNX Runtime ({@link FluidModel}). Unlike the
 * iPhone, where the Core ML build ships in the app, the ONNX build (about
 * 300 MB) is downloaded on the person's request ({@link ModelPack#fluidSpeechMini()},
 * pinned and checked) into the app's no-backup files, and `remove` deletes it.
 * Nothing else leaves the phone, and neither audio nor text is logged.
 *
 * The model loads when a dictation starts (`prepare`) or at the latest when
 * it is transcribed, runs on one thread of its own, and is dropped after five
 * idle minutes, when the app goes to the background and when the system asks
 * for memory.
 */
final class FluidSpeechMini {
    /** The `engine` value the web app sends. */
    static final String ENGINE = "fluid-mini";
    static final long IDLE_MINUTES = 5;
    /** Threads for the front end and encoder: the four big cores of a typical phone. */
    static final int THREADS = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2));

    private static FluidSpeechMini shared;

    static synchronized FluidSpeechMini shared(Context context) {
        if (shared == null) shared = new FluidSpeechMini(context.getApplicationContext());
        return shared;
    }

    private final Context context;
    private final ModelPack pack = ModelPack.fluidSpeechMini();
    private final ModelInstaller installer;
    /** Loads and runs the model; one call at a time. */
    final ExecutorService worker = Executors.newSingleThreadExecutor((runnable) -> new Thread(runnable, "mike-fluid-speech"));
    private final ExecutorService downloads = Executors.newSingleThreadExecutor((runnable) -> new Thread(runnable, "mike-fluid-download"));
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor((runnable) -> new Thread(runnable, "mike-fluid-idle"));

    private FluidBackend model;
    /** Today the CPU; an accelerated backend chosen at install time can replace it. */
    static FluidBackend.Factory backend = FluidBackend.CPU;
    private int holds = 0;
    private ScheduledFuture<?> idle;
    private Future<?> install;
    private volatile double progress = 0;
    private volatile boolean cancelInstall = false;

    private FluidSpeechMini(Context context) {
        this.context = context;
        installer = new ModelInstaller(new File(context.getNoBackupFilesDir(), "speech-models"));
        context.registerComponentCallbacks(new ComponentCallbacks2() {
            @Override
            public void onTrimMemory(int level) {
                // In the background (UI_HIDDEN and above) or short of memory.
                if (level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW
                    || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
                    worker.execute(() -> unload(false));
                }
            }

            @Override
            public void onConfigurationChanged(Configuration configuration) {}

            @Override
            public void onLowMemory() {
                worker.execute(() -> unload(false));
            }
        });
    }

    /** What `status` reports for `engine: "fluid-mini"`. */
    record Status(String state, Double progress, long downloadBytes, boolean live) {}

    synchronized Status status() {
        if (install != null && !install.isDone()) return new Status("downloading", progress, pack.totalBytes(), false);
        if (!installer.isInstalled(pack)) return new Status("downloadable", null, pack.totalBytes(), false);
        return new Status("available", null, 0, true);
    }

    /** Where the model is installed (benchmarks). */
    File modelDirectory() {
        return installer.directory(pack);
    }

    boolean isInstalled() {
        return installer.isInstalled(pack);
    }

    /** Downloads the model (a second call joins the first); blocks until done. */
    void install() throws SpeechFailure {
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
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            throw new SpeechFailure(SpeechFailure.INSTALL_FAILED, cause);
        }
    }

    /** Cancels a download, drops the model and deletes its files. */
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
            worker.submit(() -> unload(true)).get();
        } catch (Exception ignored) {
            // The worker is gone; nothing is loaded.
        }
        installer.remove(pack);
    }

    /** Loads the model and runs it once on a second of silence. Fire and forget. */
    void prepare() {
        if (!isInstalled()) return;
        worker.execute(() -> {
            if (model != null) return;
            try {
                loaded().transcribe(new float[FluidModel.RATE]);
            } catch (Exception ignored) {
                // The transcription reports it, with its code.
            }
            scheduleUnload();
        });
    }

    /** Transcribes 16 kHz mono samples on the model's thread. */
    String transcribe(float[] audio) throws SpeechFailure {
        return run(() -> loaded().transcribe(audio));
    }

    /** Runs `work` on the model's thread with the model held, and maps failures. */
    <T> T run(Callable<T> work) throws SpeechFailure {
        Future<T> future = worker.submit(() -> {
            cancelIdle();
            try {
                return work.call();
            } finally {
                scheduleUnload();
            }
        });
        try {
            return future.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SpeechFailure(SpeechFailure.FAILED, e);
        } catch (Exception e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof SpeechFailure failure) throw failure;
            throw new SpeechFailure(SpeechFailure.FAILED, cause);
        }
    }

    /** The loaded model (worker thread only). */
    FluidBackend loaded() throws SpeechFailure {
        if (model != null) return model;
        if (!isInstalled()) throw new SpeechFailure(SpeechFailure.NOT_INSTALLED);
        try {
            model = backend.create(installer.directory(pack));
        } catch (Exception | OutOfMemoryError e) {
            throw new SpeechFailure(SpeechFailure.FAILED, e);
        }
        return model;
    }

    /** The loaded model's tokenizer, or null (worker thread only). */
    Tokenizer loadedTokenizer() {
        return model == null ? null : model.tokenizer();
    }

    /** Live dictation keeps the model until `endLive` (worker thread only). */
    void beginLive() {
        holds++;
        cancelIdle();
    }

    void endLive() {
        holds = Math.max(0, holds - 1);
        scheduleUnload();
    }

    private void cancelIdle() {
        if (idle != null) idle.cancel(false);
        idle = null;
    }

    private void scheduleUnload() {
        cancelIdle();
        if (model == null || holds > 0) return;
        idle = timers.schedule(() -> worker.execute(() -> unload(false)), IDLE_MINUTES, TimeUnit.MINUTES);
    }

    /** Drops the model unless live dictation holds it (or `force`). Worker thread only. */
    private void unload(boolean force) {
        if (model == null || (holds > 0 && !force)) return;
        cancelIdle();
        model.close();
        model = null;
    }

    /** Whether the model is in memory (tests). */
    boolean isLoaded() {
        try {
            return worker.submit(() -> model != null).get();
        } catch (Exception e) {
            return false;
        }
    }

    Context context() {
        return context;
    }
}
