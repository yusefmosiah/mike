package com.firm.mike.speech;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Bundle;
import android.os.Debug;
import android.os.SystemClock;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.FileOutputStream;
import java.util.Locale;
import org.junit.FixMethodOrder;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.MethodSorters;

/**
 * Runs the plugin's engines on a real phone with the iOS tests' fixture clip
 * (a synthetic voice reading a fixed sentence; no personal audio) and reports
 * load time, warm-up, real-time factor and memory. Downloads the models from
 * their pinned sources the first time (about 370 MB); they stay in the test
 * app's files until it is uninstalled. Not part of `./gradlew test`:
 *
 *   ./gradlew :mike-speech:assembleDebugAndroidTest
 *   adb install -r -t ../plugins/speech/android/build/outputs/apk/androidTest/debug/mike-speech-debug-androidTest.apk
 *   adb shell am instrument -w -e class com.firm.mike.speech.SpeechOnDeviceTest \
 *       com.firm.mike.speech.test/androidx.test.runner.AndroidJUnitRunner
 *
 * Results go to the instrumentation output and to Logcat (tag MikeSpeechBench).
 */
@RunWith(AndroidJUnit4.class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
public class SpeechOnDeviceTest {
    private static final String TAG = "MikeSpeechBench";
    private static final String SENTENCE = "Hello, this is a test of dictation.";
    /** Seconds to wait with both models loaded, so `adb shell dumpsys meminfo` can be read from the host. */
    private static final int HOLD_SECONDS = 20;

    private static Context context() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    private static void report(String key, String value) {
        Log.i(TAG, key + "=" + value);
        Bundle bundle = new Bundle();
        bundle.putString("stream", key + "=" + value + "\n");
        InstrumentationRegistry.getInstrumentation().sendStatus(0, bundle);
    }

    private static String mb(long kb) {
        return String.format(Locale.ROOT, "%.0f MB", kb / 1024.0);
    }

    private static void memory(String label) {
        Debug.MemoryInfo info = new Debug.MemoryInfo();
        Debug.getMemoryInfo(info);
        report(label + ".pss", mb(info.getTotalPss()));
        report(label + ".native", mb(Long.parseLong(info.getMemoryStat("summary.native-heap"))));
        // Peak resident memory of the process so far (VmHWM), and now (VmRSS).
        try {
            for (String line : java.nio.file.Files.readAllLines(new File("/proc/self/status").toPath())) {
                if (line.startsWith("VmHWM:") || line.startsWith("VmRSS:")) {
                    long kb = Long.parseLong(line.replaceAll("[^0-9]", ""));
                    report(label + (line.startsWith("VmHWM") ? ".peakRss" : ".rss"), mb(kb));
                }
            }
        } catch (Exception ignored) {
            // Not readable on this phone.
        }
    }

    private static float[] fixture() throws Exception {
        File clip = new File(context().getCacheDir(), "dictation.m4a");
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("dictation.m4a");
             OutputStream out = new FileOutputStream(clip)) {
            byte[] buffer = new byte[16_384];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }
        long start = SystemClock.elapsedRealtime();
        float[] samples = AudioDecoder.decode(clip, FluidModel.RATE);
        report("decode.ms", String.valueOf(SystemClock.elapsedRealtime() - start));
        clip.delete();
        return samples;
    }

    @Test
    public void a_fluidSpeechMini() throws Exception {
        FluidSpeechMini fluid = FluidSpeechMini.shared(context());
        long start = SystemClock.elapsedRealtime();
        if (!fluid.isInstalled()) {
            fluid.install();
            report("fluid.download.s", String.valueOf((SystemClock.elapsedRealtime() - start) / 1000));
        }
        assertEquals("available", fluid.status().state());
        assertTrue(fluid.status().live());
        float[] samples = fixture();
        double seconds = samples.length / (double) FluidModel.RATE;
        report("fixture.s", String.format(Locale.ROOT, "%.2f", seconds));
        memory("before");

        start = SystemClock.elapsedRealtime();
        fluid.run(() -> fluid.loaded());
        report("fluid.load.ms", String.valueOf(SystemClock.elapsedRealtime() - start));
        start = SystemClock.elapsedRealtime();
        fluid.transcribe(new float[FluidModel.RATE]);
        report("fluid.warmup.ms", String.valueOf(SystemClock.elapsedRealtime() - start));
        memory("fluid.loaded");

        String text = "";
        for (int run = 0; run < 3; run++) {
            start = SystemClock.elapsedRealtime();
            text = fluid.transcribe(samples);
            long ms = SystemClock.elapsedRealtime() - start;
            report("fluid.run" + run + ".ms", ms + String.format(Locale.ROOT, " (RTF %.3f)", ms / 1000.0 / seconds));
        }
        report("fluid.text", text);
        memory("fluid.after");
        assertTrue(text, text.toLowerCase(Locale.ROOT).contains("this is a test of dictation"));
        assertTrue(text, text.contains("London"));
    }

    @Test
    public void b_liveDictation() throws Exception {
        FluidSpeechMini fluid = FluidSpeechMini.shared(context());
        float[] samples = fixture();
        String clip = fluid.transcribe(samples);
        // Eight seconds of speech plus three of silence, at real time.
        float[] padded = java.util.Arrays.copyOf(samples, samples.length + 3 * FluidModel.RATE);
        LiveDictation live = new LiveDictation(fluid);
        LiveDictation.Recorded events = new LiveDictation.Recorded();
        LiveDictation.Clip source = new LiveDictation.Clip(padded, 1.0);
        long start = SystemClock.elapsedRealtime();
        live.start(source, events);
        long firstText = -1;
        while (!source.done()) {
            synchronized (events) {
                if (firstText < 0 && !events.transcripts.isEmpty()) firstText = SystemClock.elapsedRealtime() - start;
            }
            Thread.sleep(20);
        }
        long stopAt = SystemClock.elapsedRealtime();
        String text = live.stop();
        report("live.firstText.ms", String.valueOf(firstText));
        report("live.updates", String.valueOf(events.transcripts.size()));
        report("live.levels", String.valueOf(events.levels));
        report("live.stopToText.ms", String.valueOf(SystemClock.elapsedRealtime() - stopAt));
        report("live.text", text);
        report("clip.text", clip);
        assertTrue(events.levels > 50);
        assertTrue(firstText > 0);
        assertEquals(words(clip), words(text));
    }

    private static String words(String text) {
        return text.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9$ ]", "").replaceAll("\\s+", " ").trim();
    }

    @Test
    public void c_phonon() throws Exception {
        assertTrue("libptts_ffi.so is missing: run npm run phonon:android", PhononVoice.canSpeak());
        PhononVoice phonon = PhononVoice.shared(context());
        long start = SystemClock.elapsedRealtime();
        if (!"available".equals(phonon.status().state())) {
            phonon.install();
            report("phonon.download.s", String.valueOf((SystemClock.elapsedRealtime() - start) / 1000));
        }
        assertEquals("available", phonon.status().state());
        start = SystemClock.elapsedRealtime();
        byte[] first = phonon.render(SENTENCE, null);
        report("phonon.loadAndFirst.ms", String.valueOf(SystemClock.elapsedRealtime() - start));
        report("phonon.voices", String.join(",", phonon.voices()));
        String paragraph = "The court granted the motion in part. Counsel should file the amended brief by Friday, "
            + "and the hearing on the remaining issues will be set for the first week of March.";
        for (int run = 0; run < 3; run++) {
            start = SystemClock.elapsedRealtime();
            byte[] wav = phonon.render(paragraph, run == 2 ? "Hugh" : "Harper");
            long ms = SystemClock.elapsedRealtime() - start;
            double audio = (wav.length - 44) / 2.0 / PhononVoice.SAMPLE_RATE;
            report("phonon.run" + run, String.format(Locale.ROOT, "%d ms for %.2f s of audio (%.1fx real time)", ms, audio, audio / (ms / 1000.0)));
        }
        assertTrue(first.length > 44 + PhononVoice.SAMPLE_RATE);
        memory("phonon.loaded");

        // Both models in memory at once, as when a dictated answer is read aloud.
        FluidSpeechMini fluid = FluidSpeechMini.shared(context());
        fluid.transcribe(fixture());
        memory("both.loaded");
        report("hold", "pid " + android.os.Process.myPid() + " for " + HOLD_SECONDS + " s");
        Thread.sleep(HOLD_SECONDS * 1000L);
    }

    /** Thread counts and XNNPACK, each with a model of its own (not the app's configuration). */
    @Test
    public void e_variants() throws Exception {
        FluidSpeechMini fluid = FluidSpeechMini.shared(context());
        float[] samples = fixture();
        double seconds = samples.length / (double) FluidModel.RATE;
        Object[][] variants = {{2, false}, {4, false}, {6, false}, {4, true}};
        for (Object[] variant : variants) {
            int threads = (Integer) variant[0];
            boolean xnnpack = (Boolean) variant[1];
            long start = SystemClock.elapsedRealtime();
            try (FluidModel model = new FluidModel(fluid.modelDirectory(), threads, xnnpack)) {
                long load = SystemClock.elapsedRealtime() - start;
                model.transcribe(new float[FluidModel.RATE]);
                long best = Long.MAX_VALUE;
                String text = "";
                for (int run = 0; run < 3; run++) {
                    start = SystemClock.elapsedRealtime();
                    text = model.transcribe(samples);
                    best = Math.min(best, SystemClock.elapsedRealtime() - start);
                }
                report("variant." + threads + (xnnpack ? ".xnnpack" : ".cpu"),
                    String.format(Locale.ROOT, "load %d ms, best %d ms (RTF %.3f) %s", load, best, best / 1000.0 / seconds,
                        text.contains("London") ? "ok" : "WRONG: " + text));
            }
        }
    }

    @Test
    public void d_systemVoice() throws Exception {
        SystemVoice voices = SystemVoice.shared(context());
        report("system.voices", String.valueOf(voices.voices().size()));
        long start = SystemClock.elapsedRealtime();
        byte[] wav = voices.render(SENTENCE, null, "en-US");
        report("system.render.ms", String.valueOf(SystemClock.elapsedRealtime() - start));
        assertEquals("RIFF", new String(wav, 0, 4));
        assertTrue(wav.length > 10_000);
    }
}
