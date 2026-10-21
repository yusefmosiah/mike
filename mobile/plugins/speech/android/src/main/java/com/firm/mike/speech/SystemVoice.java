package com.firm.mike.speech;

import android.content.Context;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Read-aloud with the phone's own text-to-speech engine (Android's
 * counterpart of Apple's voices on the iPhone): the text is rendered to a WAV
 * file with `synthesizeToFile` instead of being spoken, so the web app plays
 * it in its own player. Only voices that need no network are offered or used,
 * so the text stays on the phone. The file is deleted as soon as it is read;
 * neither text nor audio is logged.
 */
final class SystemVoice {
    record Entry(String id, String name, String language, String quality) {}

    private static final long INIT_SECONDS = 10;
    private static final long RENDER_SECONDS = 120;

    private static SystemVoice shared;

    static synchronized SystemVoice shared(Context context) {
        if (shared == null) shared = new SystemVoice(context.getApplicationContext());
        return shared;
    }

    private final Context context;
    private TextToSpeech tts;
    private boolean ready;

    private SystemVoice(Context context) {
        this.context = context;
    }

    /** The engine, started on first use (it binds to the engine's service). */
    private synchronized TextToSpeech engine() throws SpeechFailure {
        if (tts != null && ready) return tts;
        CountDownLatch started = new CountDownLatch(1);
        int[] status = {TextToSpeech.ERROR};
        TextToSpeech created = new TextToSpeech(context, (result) -> {
            status[0] = result;
            started.countDown();
        });
        try {
            if (!started.await(INIT_SECONDS, TimeUnit.SECONDS) || status[0] != TextToSpeech.SUCCESS) {
                created.shutdown();
                throw new SpeechFailure(SpeechFailure.FAILED);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            created.shutdown();
            throw new SpeechFailure(SpeechFailure.FAILED, e);
        }
        tts = created;
        ready = true;
        return tts;
    }

    /** The voices that need no network, best quality first within each language. */
    List<Entry> voices() {
        Set<Voice> all;
        try {
            all = engine().getVoices();
        } catch (SpeechFailure e) {
            return Collections.emptyList();
        }
        List<Entry> out = new ArrayList<>();
        if (all == null) return out;
        for (Voice voice : all) {
            if (voice.isNetworkConnectionRequired()) continue;
            Set<String> features = voice.getFeatures();
            if (features != null && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
            out.add(new Entry(voice.getName(), voice.getName(), voice.getLocale().toLanguageTag(), quality(voice.getQuality())));
        }
        out.sort((a, b) -> {
            int byLanguage = a.language().compareTo(b.language());
            if (byLanguage != 0) return byLanguage;
            int byQuality = Integer.compare(rank(a.quality()), rank(b.quality()));
            return byQuality != 0 ? byQuality : a.name().compareTo(b.name());
        });
        return out;
    }

    static String quality(int quality) {
        if (quality >= Voice.QUALITY_VERY_HIGH) return "premium";
        if (quality >= Voice.QUALITY_HIGH) return "enhanced";
        return "default";
    }

    private static int rank(String quality) {
        return switch (quality) {
            case "premium" -> 0;
            case "enhanced" -> 1;
            default -> 2;
        };
    }

    /** `text` read by the voice named `voiceId` (or the best for `language`, or the phone's own), as a WAV. */
    byte[] render(String text, String voiceId, String language) throws SpeechFailure {
        String trimmed = text == null ? "" : text.trim();
        if (trimmed.isEmpty()) throw new SpeechFailure(SpeechFailure.EMPTY_TEXT);
        if (trimmed.length() > TextToSpeech.getMaxSpeechInputLength()) throw new SpeechFailure(SpeechFailure.TOO_LONG);
        File file = new File(context.getCacheDir(), "mike-speech-" + UUID.randomUUID() + ".wav");
        String utterance = UUID.randomUUID().toString();
        CountDownLatch done = new CountDownLatch(1);
        boolean[] failed = {false};
        try {
            synchronized (this) {
                TextToSpeech engine = engine();
                choose(engine, voiceId, language);
                engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String id) {}

                    @Override
                    public void onDone(String id) {
                        if (utterance.equals(id)) done.countDown();
                    }

                    @Override
                    @SuppressWarnings("deprecation")
                    public void onError(String id) {
                        if (utterance.equals(id)) {
                            failed[0] = true;
                            done.countDown();
                        }
                    }

                    @Override
                    public void onError(String id, int code) {
                        onError(id);
                    }
                });
                if (engine.synthesizeToFile(trimmed, null, file, utterance) != TextToSpeech.SUCCESS) {
                    throw new SpeechFailure(SpeechFailure.FAILED);
                }
                if (!done.await(RENDER_SECONDS, TimeUnit.SECONDS) || failed[0]) throw new SpeechFailure(SpeechFailure.FAILED);
            }
            byte[] audio = Files.readAllBytes(file.toPath());
            if (audio.length <= 44) throw new SpeechFailure(SpeechFailure.FAILED);
            return audio;
        } catch (SpeechFailure failure) {
            throw failure;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SpeechFailure(SpeechFailure.FAILED, e);
        } catch (Exception e) {
            throw new SpeechFailure(SpeechFailure.FAILED, e);
        } finally {
            file.delete();
        }
    }

    private static void choose(TextToSpeech engine, String voiceId, String language) {
        Set<Voice> voices = engine.getVoices();
        if (voiceId != null && voices != null) {
            for (Voice voice : voices) {
                if (voice.getName().equals(voiceId) && !voice.isNetworkConnectionRequired()) {
                    engine.setVoice(voice);
                    return;
                }
            }
        }
        Locale locale = language != null && !language.isEmpty() ? Locale.forLanguageTag(language) : Locale.getDefault();
        if (engine.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) {
            engine.setLanguage(locale);
        } else {
            engine.setLanguage(Locale.getDefault());
        }
        Voice current = engine.getVoice();
        // The language's default voice may need the network: pick an offline one of the same language.
        if (current != null && current.isNetworkConnectionRequired() && voices != null) {
            for (Voice voice : voices) {
                if (!voice.isNetworkConnectionRequired() && voice.getLocale().getLanguage().equals(current.getLocale().getLanguage())) {
                    engine.setVoice(voice);
                    return;
                }
            }
        }
    }
}
