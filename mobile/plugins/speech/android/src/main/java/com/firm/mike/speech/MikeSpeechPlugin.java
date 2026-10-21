package com.firm.mike.speech;

import android.Manifest;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The Android side of MikeSpeech, for the web app's "This phone" engines
 * (frontend lib/voice/deviceSpeech.ts), with the iPhone plugin's contract
 * (../README.md): dictation with Fluid Speech Mini (downloaded on request)
 * from a clip or live, and read-aloud with Phonon (downloaded on request) or
 * the phone's own offline voices. Hands-free voice mode is not implemented
 * here, so `voiceStatus` is not listed and the web app hides voice mode.
 * Without an `engine`, dictation would be the platform recognizer, which this
 * plugin does not offer: `status` says `unavailable` and `transcribe` rejects.
 *
 * Audio exists only in memory and in a temporary file for the length of a
 * call; neither audio nor text is logged.
 */
@CapacitorPlugin(
    name = "MikeSpeech",
    permissions = {@Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = MikeSpeechPlugin.MICROPHONE)})
public class MikeSpeechPlugin extends Plugin {
    static final String MICROPHONE = "microphone";
    static final String LIVE_EVENT = "liveTranscript";
    /** About half an hour of the web view's recording. */
    static final int MAX_AUDIO_BYTES = 25 * 1024 * 1024;
    /** One read-aloud call; the web app sends a response in chunks. */
    static final int MAX_SPEECH_CHARACTERS = 20_000;

    /** Calls that block (downloads, transcription, speech) run here, off the bridge's thread. */
    private final ExecutorService calls = Executors.newCachedThreadPool((runnable) -> new Thread(runnable, "mike-speech-call"));
    private LiveDictation live;

    private FluidSpeechMini fluid() {
        return FluidSpeechMini.shared(getContext());
    }

    private PhononVoice phonon() {
        return PhononVoice.shared(getContext());
    }

    private synchronized LiveDictation live() {
        if (live == null) live = new LiveDictation(fluid());
        return live;
    }

    private static boolean usesFluid(PluginCall call) {
        return FluidSpeechMini.ENGINE.equals(call.getString("engine"));
    }

    private static boolean usesPhonon(PluginCall call) {
        return PhononVoice.ENGINE.equals(call.getString("engine"));
    }

    static JSObject fluidPayload(FluidSpeechMini.Status status) {
        JSObject result = new JSObject();
        result.put("state", status.state());
        result.put("engine", FluidSpeechMini.ENGINE);
        result.put("locale", "en");
        if (status.progress() != null) result.put("progress", status.progress());
        if (status.downloadBytes() > 0) result.put("downloadBytes", status.downloadBytes());
        if (status.live()) result.put("live", true);
        // Downloaded, unlike the iPhone's bundled model: Settings offers to delete it.
        if ("available".equals(status.state())) result.put("removable", true);
        return result;
    }

    static JSObject phononPayload(PhononVoice.Status status) {
        JSObject result = new JSObject();
        result.put("state", status.state());
        result.put("engine", PhononVoice.ENGINE);
        if (status.progress() != null) result.put("progress", status.progress());
        if (status.downloadBytes() > 0) result.put("downloadBytes", status.downloadBytes());
        return result;
    }

    private static JSObject unavailable() {
        JSObject result = new JSObject();
        result.put("state", "unavailable");
        return result;
    }

    private static void reject(PluginCall call, String message, Throwable error) {
        call.reject(message, SpeechFailure.codeOf(error));
    }

    @PluginMethod
    public void status(PluginCall call) {
        if (usesPhonon(call)) {
            call.resolve(phononPayload(phonon().status()));
        } else if (usesFluid(call)) {
            call.resolve(fluidPayload(fluid().status()));
        } else {
            call.resolve(unavailable());
        }
    }

    /** Downloads a model, from the person's click; the web app watches `status` meanwhile. */
    @PluginMethod
    public void install(PluginCall call) {
        if (!usesPhonon(call) && !usesFluid(call)) {
            call.resolve(unavailable());
            return;
        }
        boolean isPhonon = usesPhonon(call);
        calls.execute(() -> {
            try {
                if (isPhonon) {
                    phonon().install();
                    call.resolve(phononPayload(phonon().status()));
                } else {
                    fluid().install();
                    call.resolve(fluidPayload(fluid().status()));
                }
            } catch (SpeechFailure failure) {
                call.reject("The model could not be downloaded.", SpeechFailure.INSTALL_FAILED);
            }
        });
    }

    /** Starts loading Fluid Speech Mini while the person speaks. Answers at once. */
    @PluginMethod
    public void prepare(PluginCall call) {
        if (usesFluid(call)) fluid().prepare();
        call.resolve();
    }

    /** Deletes a downloaded model and resolves the new status. */
    @PluginMethod
    public void remove(PluginCall call) {
        if (!usesPhonon(call) && !usesFluid(call)) {
            call.reject("Nothing to remove.", SpeechFailure.UNAVAILABLE);
            return;
        }
        boolean isPhonon = usesPhonon(call);
        calls.execute(() -> {
            if (isPhonon) {
                phonon().remove();
                call.resolve(phononPayload(phonon().status()));
            } else {
                live().cancel();
                fluid().remove();
                call.resolve(fluidPayload(fluid().status()));
            }
        });
    }

    @PluginMethod
    public void transcribe(PluginCall call) {
        String encoded = call.getString("audio");
        byte[] audio;
        try {
            audio = encoded == null ? new byte[0] : Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            audio = new byte[0];
        }
        if (audio.length == 0) {
            call.reject("No audio to transcribe.", SpeechFailure.INVALID_AUDIO);
            return;
        }
        if (audio.length > MAX_AUDIO_BYTES) {
            call.reject("The recording is too long.", SpeechFailure.TOO_LONG);
            return;
        }
        String extension = fileExtension(call.getString("mimeType"));
        if (extension == null) {
            call.reject("This recording format cannot be transcribed.", SpeechFailure.UNSUPPORTED_AUDIO);
            return;
        }
        if (!usesFluid(call)) {
            call.reject("This phone cannot transcribe this language on the device.", SpeechFailure.UNAVAILABLE);
            return;
        }
        if (!fluid().isInstalled()) {
            call.reject("Fluid Speech Mini is not downloaded.", SpeechFailure.NOT_INSTALLED);
            return;
        }
        byte[] clip = audio;
        calls.execute(() -> {
            File file = new File(getContext().getCacheDir(), "mike-dictation-" + UUID.randomUUID() + "." + extension);
            try {
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(clip);
                }
                float[] samples = AudioDecoder.decode(file, FluidModel.RATE);
                file.delete();
                JSObject result = new JSObject();
                result.put("text", fluid().transcribe(samples));
                call.resolve(result);
            } catch (Exception e) {
                reject(call, "On-device transcription failed.", e);
            } finally {
                file.delete();
            }
        });
    }

    /**
     * Starts recording and transcribing with Fluid Speech Mini as the person
     * speaks; resolves once recording has started. Text arrives as
     * `liveTranscript` events, as on the iPhone.
     */
    @PluginMethod
    public void startLive(PluginCall call) {
        if (!usesFluid(call)) {
            call.reject("Live dictation needs Fluid Speech Mini.", SpeechFailure.UNAVAILABLE);
            return;
        }
        if (getPermissionState(MICROPHONE) != PermissionState.GRANTED) {
            requestPermissionForAlias(MICROPHONE, call, "microphoneAnswered");
            return;
        }
        beginLive(call);
    }

    @PermissionCallback
    private void microphoneAnswered(PluginCall call) {
        if (getPermissionState(MICROPHONE) != PermissionState.GRANTED) {
            call.reject("The microphone is off for this app.", SpeechFailure.PERMISSION_DENIED);
            return;
        }
        beginLive(call);
    }

    private void beginLive(PluginCall call) {
        calls.execute(() -> {
            try {
                live().start(new LiveDictation.Microphone(), new LiveDictation.Events() {
                    @Override
                    public void transcript(String confirmed, String volatileText, boolean ended) {
                        JSObject data = new JSObject();
                        data.put("confirmed", confirmed);
                        data.put("volatile", volatileText);
                        if (ended) data.put("ended", true);
                        notifyListeners(LIVE_EVENT, data);
                    }

                    @Override
                    public void level(float level) {
                        JSObject data = new JSObject();
                        data.put("level", (double) level);
                        notifyListeners(LIVE_EVENT, data);
                    }
                });
                call.resolve();
            } catch (SpeechFailure failure) {
                reject(call, "Live dictation could not start.", failure);
            }
        });
    }

    @PluginMethod
    public void stopLive(PluginCall call) {
        calls.execute(() -> {
            try {
                JSObject result = new JSObject();
                result.put("text", live().stop());
                call.resolve(result);
            } catch (SpeechFailure failure) {
                reject(call, "On-device transcription failed.", failure);
            }
        });
    }

    @PluginMethod
    public void cancelLive(PluginCall call) {
        calls.execute(() -> {
            live().cancel();
            call.resolve();
        });
    }

    /** The app left the foreground: a live dictation ends and keeps its text, as on the iPhone. */
    @Override
    protected void handleOnPause() {
        if (live != null) live.interrupt();
    }

    @PluginMethod
    public void voices(PluginCall call) {
        calls.execute(() -> {
            JSArray voices = new JSArray();
            for (SystemVoice.Entry voice : SystemVoice.shared(getContext()).voices()) {
                JSObject entry = new JSObject();
                entry.put("id", voice.id());
                entry.put("name", voice.name());
                entry.put("language", voice.language());
                entry.put("quality", voice.quality());
                voices.put(entry);
            }
            JSObject result = new JSObject();
            result.put("voices", voices);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.trim().isEmpty()) {
            call.reject("No text to read aloud.", SpeechFailure.EMPTY_TEXT);
            return;
        }
        if (text.length() > MAX_SPEECH_CHARACTERS) {
            call.reject("The text is too long to read aloud at once.", SpeechFailure.TOO_LONG);
            return;
        }
        String voice = call.getString("voice");
        String language = call.getString("language");
        boolean isPhonon = usesPhonon(call);
        calls.execute(() -> {
            try {
                byte[] wav = isPhonon
                    ? phonon().render(text, voice)
                    : SystemVoice.shared(getContext()).render(text, voice, language);
                JSObject result = new JSObject();
                result.put("audio", Base64.encodeToString(wav, Base64.NO_WRAP));
                result.put("mimeType", "audio/wav");
                call.resolve(result);
            } catch (SpeechFailure failure) {
                reject(call, "Reading aloud on this phone failed.", failure);
            }
        });
    }

    /**
     * The extension for the web view's recording. Android's decoders read
     * WebM (Opus) as well as MP4 (AAC), which the iPhone cannot.
     */
    static String fileExtension(String mimeType) {
        String type = mimeType == null ? "" : mimeType.split(";")[0].trim().toLowerCase(java.util.Locale.ROOT);
        return switch (type) {
            case "", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "video/mp4" -> "m4a";
            case "audio/webm", "video/webm" -> "webm";
            case "audio/ogg", "audio/opus" -> "ogg";
            case "audio/wav", "audio/wave", "audio/x-wav" -> "wav";
            case "audio/mpeg", "audio/mp3" -> "mp3";
            case "audio/3gpp" -> "3gp";
            default -> null;
        };
    }
}
