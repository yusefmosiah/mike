package com.firm.mike.speech;

import com.sun.jna.Callback;
import com.sun.jna.Library;
import com.sun.jna.Native;
import com.sun.jna.Pointer;
import com.sun.jna.Structure;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Phonon's C library (libptts_ffi.so, xn-ptts 0.4.0's `ptts-ffi`, built for
 * arm64 by `npm run phonon:android`) called through JNA: the Java counterpart
 * of xn-ptts's Kotlin wrapper (android/PhononTTS.kt). Calls block and must
 * come from one thread at a time.
 */
final class Phonon implements AutoCloseable {
    /** ptts.h. A C `bool` return is one byte. */
    @SuppressWarnings("unused")
    interface Lib extends Library {
        Pointer ptts_new(String dir, int unit, String lang);
        byte ptts_speak(Pointer handle, String text, FrameFn callback, Pointer user, Result out);
        Pointer ptts_voices(Pointer handle);
        byte ptts_set_voice(Pointer handle, String name);
        String ptts_last_error(Pointer handle);
        void ptts_free(Pointer handle);

        /** `PttsFrameFn`: `n` is a size_t, 64 bits on arm64. */
        interface FrameFn extends Callback {
            boolean invoke(Pointer pcm, long n, Pointer user);
        }
    }

    /** `PttsResult`. */
    @Structure.FieldOrder({"frames", "samples", "ttfaMs", "totalMs"})
    public static class Result extends Structure {
        public int frames;
        public long samples;
        public double ttfaMs;
        public double totalMs;
    }

    private static Lib lib;
    private static boolean loadFailed;

    /** The library, or null when this build has none (or the phone cannot load it). */
    static synchronized Lib library() {
        if (lib == null && !loadFailed) {
            try {
                lib = Native.load("ptts_ffi", Lib.class);
            } catch (Throwable e) {
                loadFailed = true;
            }
        }
        return lib;
    }

    private Pointer handle;
    private final Lib api;
    private Resampler.FloatList sink;
    // A field, so the callback outlives every call that hands it to native code.
    private final Lib.FrameFn onFrame = (pcm, n, user) -> {
        sink.addAll(pcm.getFloatArray(0, (int) n), (int) n);
        return true;
    };

    Phonon(String directory, String language) throws SpeechFailure {
        api = library();
        if (api == null) throw new SpeechFailure(SpeechFailure.UNAVAILABLE);
        handle = api.ptts_new(directory, 0, language);
        if (handle == null) throw new SpeechFailure(SpeechFailure.FAILED);
    }

    List<String> voices() {
        List<String> names = new ArrayList<>();
        Pointer block = api.ptts_voices(open());
        long offset = 0;
        while (true) {
            String name = block.getString(offset, "UTF-8");
            if (name.isEmpty()) return names;
            names.add(name);
            offset += name.getBytes(StandardCharsets.UTF_8).length + 1;
        }
    }

    void setVoice(String name) throws SpeechFailure {
        if (api.ptts_set_voice(open(), name) == 0) throw new SpeechFailure(SpeechFailure.FAILED);
    }

    /** `text` as 24 kHz mono float samples. */
    float[] speak(String text) throws SpeechFailure {
        sink = new Resampler.FloatList();
        try {
            if (api.ptts_speak(open(), text, onFrame, null, new Result()) == 0) throw new SpeechFailure(SpeechFailure.FAILED);
            return sink.toArray();
        } finally {
            sink = null;
        }
    }

    private Pointer open() {
        if (handle == null) throw new IllegalStateException("closed");
        return handle;
    }

    @Override
    public void close() {
        if (handle != null) api.ptts_free(handle);
        handle = null;
    }
}
