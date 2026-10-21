package com.firm.mike.speech;

import java.io.File;
import java.util.List;

/**
 * How Fluid Speech Mini runs on this phone. Today there is one backend,
 * {@link FluidModel} (ONNX Runtime's CPU provider). The seam is here so an
 * accelerated one can slot in (ONNX Runtime's QNN provider on Snapdragon,
 * LiteRT elsewhere), chosen by a benchmark at install time: each candidate
 * transcribes the fixture, its text must match the CPU backend's, and the
 * fastest is kept per device and model revision. Not thread-safe: the
 * runtime calls a backend from its one worker thread.
 */
interface FluidBackend extends AutoCloseable {
    /** The text of 16 kHz mono samples. */
    String transcribe(float[] audio) throws Exception;

    /**
     * The tokens of `length` samples from `offset`, each with its time in
     * seconds from `offset`; `cancel` (may be null) stops a pass in flight.
     */
    List<SlidingWindow.Timed> recognize(float[] audio, int offset, int length, FluidModel.Cancel cancel) throws Exception;

    Tokenizer tokenizer();

    /** A short name for reports and the benchmark cache ("ort-cpu"). */
    String name();

    @Override
    void close();

    /** Creates the backend for an installed model folder. */
    interface Factory {
        FluidBackend create(File modelDirectory) throws Exception;
    }

    /** The backend used today: ONNX Runtime on the CPU, four threads at most. */
    Factory CPU = (directory) -> new FluidModel(directory, FluidSpeechMini.THREADS);
}
