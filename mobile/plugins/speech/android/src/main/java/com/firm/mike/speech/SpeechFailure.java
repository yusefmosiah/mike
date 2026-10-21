package com.firm.mike.speech;

/**
 * A failure with the rejection code the web app maps to its own message
 * (frontend lib/voice/deviceSpeech.ts). Never carries audio or text.
 */
final class SpeechFailure extends Exception {
    static final String UNAVAILABLE = "unavailable";
    static final String NOT_INSTALLED = "not-installed";
    static final String INVALID_AUDIO = "invalid-audio";
    static final String UNSUPPORTED_AUDIO = "unsupported-audio";
    static final String TOO_LONG = "too-long";
    static final String EMPTY_TEXT = "empty-text";
    static final String INSTALL_FAILED = "install-failed";
    static final String PERMISSION_DENIED = "permission-denied";
    static final String CANCELLED = "cancelled";
    static final String FAILED = "failed";

    final String code;

    SpeechFailure(String code) {
        super(code);
        this.code = code;
    }

    SpeechFailure(String code, Throwable cause) {
        super(code, cause);
        this.code = code;
    }

    /** The code of any error: a SpeechFailure's own, otherwise "failed". */
    static String codeOf(Throwable error) {
        return error instanceof SpeechFailure failure ? failure.code : FAILED;
    }
}
