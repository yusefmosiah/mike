package com.firm.mike.speech;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Fluid Speech Mini's ONNX build on ONNX Runtime's CPU provider: the port of
 * the model's reference script (transcribe.py in the model repository). The
 * log-mel features go through the convolutional front end in time chunks (far
 * smaller activations), then the encoder, then greedy TDT decoding with the
 * prediction and joint networks. Not thread-safe: one call at a time.
 */
final class FluidModel implements FluidBackend {
    static final int RATE = 16_000;

    private final OrtEnvironment env = OrtEnvironment.getEnvironment();
    private final OrtSession frontend;
    private final OrtSession encoder;
    private final OrtSession decoder;
    private final OrtSession joint;
    private final LogMel mel;
    private final Tokenizer tokenizer;
    private final Transducer transducer;
    private final int decoderLayers;
    private final int decoderHidden;
    private final int subsamplingKernel;
    private final int subsamplingStride;
    private final int subsamplingLayers;
    private final int frontendChunk;
    private final double maxSinglePassSeconds;
    private final int blank;
    private final int hop;

    FluidModel(File directory, int threads) throws Exception {
        this(directory, threads, false);
    }

    /**
     * `xnnpack` adds ONNX Runtime's XNNPACK provider ahead of the CPU one (on
     * this model it can take only the front end's convolutions: the encoder's
     * 2- and 4-bit MatMulNBits layers run on the CPU provider either way).
     */
    FluidModel(File directory, int threads, boolean xnnpack) throws Exception {
        JSONObject config = new JSONObject(read(new File(directory, "config.json")));
        blank = config.getInt("blank_token_id");
        hop = config.getInt("hop_length");
        decoderLayers = config.getInt("decoder_layers");
        decoderHidden = config.getInt("decoder_hidden_size");
        subsamplingKernel = config.getInt("subsampling_kernel");
        subsamplingStride = config.getInt("subsampling_stride");
        subsamplingLayers = config.getInt("subsampling_layers");
        frontendChunk = config.getInt("frontend_chunk_frames");
        maxSinglePassSeconds = config.getDouble("max_single_pass_seconds");
        JSONArray durations = config.getJSONArray("durations");
        int[] steps = new int[durations.length()];
        for (int i = 0; i < steps.length; i++) steps[i] = durations.getInt(i);
        transducer = new Transducer(config.getInt("vocab_size"), blank, config.optInt("eos_token_id", -1), steps, config.getInt("max_symbols_per_step"));
        tokenizer = new Tokenizer(read(new File(directory, "tokenizer.json")), blank, config.getInt("pad_token_id"));
        mel = new LogMel(config.getInt("n_fft"), hop, config.getInt("win_length"), (float) config.optDouble("preemphasis", 0), readFilters(new File(directory, "mel_filters.npy")));

        // No telemetry from ONNX Runtime (see the plugin's AndroidManifest.xml).
        env.setTelemetry(false);
        // As the reference script: no arena and no memory pattern, so the
        // front end's activations are handed back between runs.
        OrtSession.SessionOptions big = new OrtSession.SessionOptions();
        big.setIntraOpNumThreads(threads);
        big.setCPUArenaAllocator(false);
        big.setMemoryPatternOptimization(false);
        if (xnnpack) {
            Map<String, String> xnn = new HashMap<>();
            xnn.put("intra_op_num_threads", String.valueOf(threads));
            big.addXnnpack(xnn);
            // XNNPACK has its own thread pool; ONNX Runtime's would compete with it.
            big.setIntraOpNumThreads(1);
        }
        OrtSession.SessionOptions small = new OrtSession.SessionOptions();
        small.setIntraOpNumThreads(1);
        small.setCPUArenaAllocator(false);
        small.setMemoryPatternOptimization(false);
        frontend = env.createSession(new File(directory, "frontend.onnx").getPath(), big);
        encoder = env.createSession(new File(directory, "encoder.onnx").getPath(), big);
        decoder = env.createSession(new File(directory, "decoder.onnx").getPath(), small);
        joint = env.createSession(new File(directory, "joint.onnx").getPath(), small);
    }

    @Override
    public Tokenizer tokenizer() {
        return tokenizer;
    }

    @Override
    public String name() {
        return "ort-cpu";
    }

    @Override
    public String transcribe(float[] audio) throws Exception {
        List<Integer> ids = new ArrayList<>();
        for (SlidingWindow.Timed token : recognize(audio, 0, audio.length)) ids.add(token.id());
        return tokenizer.decode(ids).trim();
    }

    /**
     * The tokens of `length` samples from `offset`, each with its time in
     * seconds from `offset`. Audio longer than one pass is cut at quiet points.
     */
    List<SlidingWindow.Timed> recognize(float[] audio, int offset, int length) throws Exception {
        return recognize(audio, offset, length, null);
    }

    /**
     * Stops a pass in flight from another thread (live dictation's stop):
     * the pass throws instead of finishing, and the next one starts at once.
     */
    static final class Cancel {
        private volatile boolean cancelled;
        private volatile OrtSession.RunOptions running;

        void cancel() {
            cancelled = true;
            OrtSession.RunOptions options = running;
            if (options != null) {
                try {
                    options.setTerminate(true);
                } catch (OrtException ignored) {
                    // The run has ended.
                }
            }
        }

        boolean cancelled() {
            return cancelled;
        }
    }

    /** Thrown by a cancelled pass. */
    static final class Cancelled extends Exception {}

    private OrtSession.Result run(OrtSession session, Map<String, OnnxTensor> inputs, Cancel cancel) throws Exception {
        if (cancel == null) return session.run(inputs);
        if (cancel.cancelled) throw new Cancelled();
        OrtSession.RunOptions options = new OrtSession.RunOptions();
        cancel.running = options;
        try {
            if (cancel.cancelled) throw new Cancelled();
            return session.run(inputs, options);
        } catch (OrtException e) {
            if (cancel.cancelled) throw new Cancelled();
            throw e;
        } finally {
            cancel.running = null;
            options.close();
        }
    }

    @Override
    public List<SlidingWindow.Timed> recognize(float[] audio, int offset, int length, Cancel cancel) throws Exception {
        List<SlidingWindow.Timed> out = new ArrayList<>();
        if (length < hop * 2) return out;
        float[] clip = offset == 0 && length == audio.length ? audio : java.util.Arrays.copyOfRange(audio, offset, offset + length);
        List<int[]> pieces = clip.length <= maxSinglePassSeconds * RATE
            ? java.util.Collections.singletonList(new int[] {0, clip.length})
            : LongAudio.pieces(clip, RATE, maxSinglePassSeconds, 30, 10);
        for (int[] piece : pieces) {
            float[] part = pieces.size() == 1 ? clip : java.util.Arrays.copyOfRange(clip, piece[0], piece[1]);
            if (part.length < hop * 2) continue;
            double start = piece[0] / (double) RATE;
            for (Transducer.Token token : pass(part, cancel)) {
                out.add(new SlidingWindow.Timed(token.id(), start + token.frame() * SlidingWindow.FRAME_SECONDS, tokenizer.startsWord(token.id())));
            }
        }
        return out;
    }

    private List<Transducer.Token> pass(float[] audio, Cancel cancel) throws Exception {
        LogMel.Features features = mel.compute(audio);
        Encoded encoded = encode(features, cancel);
        return transducer.decode(new Prediction(), (frame, predictionOut) -> {
            if (cancel != null && cancel.cancelled) throw new Cancelled();
            return jointLogits(encoded, frame, predictionOut);
        }, encoded.frames, encoded.valid);
    }

    private record Encoded(float[] values, int frames, int width, int valid) {}

    int subsampled(int frames) {
        int pad = (subsamplingKernel - 1) / 2 * 2 - subsamplingKernel;
        double value = frames;
        for (int i = 0; i < subsamplingLayers; i++) value = Math.floor((value + pad) / subsamplingStride + 1.0);
        return (int) value;
    }

    /** The reference script's `encode`: the front end in chunks with one frame of context each side. */
    private Encoded encode(LogMel.Features features, Cancel cancel) throws Exception {
        int factor = (int) Math.pow(subsamplingStride, subsamplingLayers);
        int frames = features.frames;
        int mels = features.mels;
        int total = subsampled(frames);
        int width = 0;
        float[] hidden = null;
        for (int a = 0; a < total; a += frontendChunk) {
            int b = Math.min(a + frontendChunk, total);
            int s = a > 0 ? factor * (a - 1) : 0;
            int e = Math.min(frames, factor * (b + 1));
            int span = e - s;
            FloatBuffer input = FloatBuffer.wrap(features.values, s * mels, span * mels).slice();
            long[] mask = new long[span];
            for (int i = 0; i < span; i++) mask[i] = s + i < features.valid ? 1 : 0;
            try (OnnxTensor x = OnnxTensor.createTensor(env, input, new long[] {1, span, mels});
                 OnnxTensor m = OnnxTensor.createTensor(env, LongBuffer.wrap(mask), new long[] {1, span});
                 OrtSession.Result result = run(frontend, inputs("input_features", x, "attention_mask", m), cancel)) {
                OnnxTensor y = (OnnxTensor) result.get(0);
                long[] shape = y.getInfo().getShape();
                width = (int) shape[2];
                if (hidden == null) hidden = new float[total * width];
                FloatBuffer values = y.getFloatBuffer();
                int skip = a > 0 ? 1 : 0;
                int count = Math.min(b - a, (int) shape[1] - skip);
                values.position(skip * width);
                values.get(hidden, a * width, count * width);
            }
        }
        int valid = subsampled(features.valid);
        try (OnnxTensor h = OnnxTensor.createTensor(env, FloatBuffer.wrap(hidden), new long[] {1, total, width});
             OnnxTensor length = OnnxTensor.createTensor(env, LongBuffer.wrap(new long[] {valid}), new long[] {1});
             OrtSession.Result result = run(encoder, inputs("hidden_states", h, "length", length), cancel)) {
            OnnxTensor out = (OnnxTensor) result.get(0);
            long[] shape = out.getInfo().getShape();
            float[] values = new float[(int) (shape[1] * shape[2])];
            out.getFloatBuffer().get(values);
            return new Encoded(values, (int) shape[1], (int) shape[2], valid);
        }
    }

    private float[] jointLogits(Encoded encoded, int frame, float[] predictionOut) throws OrtException {
        FloatBuffer row = FloatBuffer.wrap(encoded.values, frame * encoded.width, encoded.width).slice();
        try (OnnxTensor f = OnnxTensor.createTensor(env, row, new long[] {1, encoded.width});
             OnnxTensor d = OnnxTensor.createTensor(env, FloatBuffer.wrap(predictionOut), new long[] {1, predictionOut.length});
             OrtSession.Result result = joint.run(inputs("encoder_frame", f, "decoder_out", d))) {
            FloatBuffer logits = ((OnnxTensor) result.get(0)).getFloatBuffer();
            float[] out = new float[logits.remaining()];
            logits.get(out);
            return out;
        }
    }

    /** The prediction network (an LSTM) and its state. */
    private final class Prediction implements Transducer.Prediction {
        private float[] h = new float[decoderLayers * decoderHidden];
        private float[] c = new float[decoderLayers * decoderHidden];

        @Override
        public void reset() {
            h = new float[decoderLayers * decoderHidden];
            c = new float[decoderLayers * decoderHidden];
        }

        @Override
        public float[] step(int token) throws OrtException {
            long[] stateShape = {decoderLayers, 1, decoderHidden};
            Map<String, OnnxTensor> inputs = new HashMap<>();
            try (OnnxTensor t = OnnxTensor.createTensor(env, LongBuffer.wrap(new long[] {token}), new long[] {1, 1});
                 OnnxTensor hIn = OnnxTensor.createTensor(env, FloatBuffer.wrap(h), stateShape);
                 OnnxTensor cIn = OnnxTensor.createTensor(env, FloatBuffer.wrap(c), stateShape)) {
                inputs.put("token", t);
                inputs.put("h_in", hIn);
                inputs.put("c_in", cIn);
                try (OrtSession.Result result = decoder.run(inputs)) {
                    float[] out = new float[decoderHidden];
                    ((OnnxTensor) result.get(0)).getFloatBuffer().get(out);
                    float[] nextH = new float[h.length];
                    float[] nextC = new float[c.length];
                    ((OnnxTensor) result.get(1)).getFloatBuffer().get(nextH);
                    ((OnnxTensor) result.get(2)).getFloatBuffer().get(nextC);
                    h = nextH;
                    c = nextC;
                    return out;
                }
            }
        }
    }

    /** Map.of needs Android 11. */
    private static Map<String, OnnxTensor> inputs(String a, OnnxTensor x, String b, OnnxTensor y) {
        Map<String, OnnxTensor> map = new HashMap<>();
        map.put(a, x);
        map.put(b, y);
        return map;
    }

    @Override
    public void close() {
        for (OrtSession session : new OrtSession[] {frontend, encoder, decoder, joint}) {
            try {
                session.close();
            } catch (OrtException ignored) {
                // Already closed.
            }
        }
    }

    private static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    /** A little-endian float32 or float64 2-D array in NumPy's .npy format. */
    static float[][] readFilters(File file) throws IOException {
        byte[] bytes = Files.readAllBytes(file.toPath());
        return parseNpy(bytes);
    }

    static float[][] parseNpy(byte[] bytes) throws IOException {
        if (bytes.length < 10 || bytes[0] != (byte) 0x93 || bytes[1] != 'N') throw new IOException("not a .npy file");
        int major = bytes[6];
        ByteBuffer buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        int headerLength;
        int headerStart;
        if (major == 1) {
            headerLength = buffer.getShort(8) & 0xffff;
            headerStart = 10;
        } else {
            headerLength = buffer.getInt(8);
            headerStart = 12;
        }
        String header = new String(bytes, headerStart, headerLength, StandardCharsets.ISO_8859_1);
        boolean doubles = header.contains("'<f8'");
        if (!doubles && !header.contains("'<f4'")) throw new IOException("unsupported dtype");
        if (header.contains("'fortran_order': True")) throw new IOException("unsupported order");
        java.util.regex.Matcher shape = java.util.regex.Pattern.compile("'shape': \\((\\d+), (\\d+)\\)").matcher(header);
        if (!shape.find()) throw new IOException("unsupported shape");
        int rows = Integer.parseInt(shape.group(1));
        int cols = Integer.parseInt(shape.group(2));
        int at = headerStart + headerLength;
        float[][] out = new float[rows][cols];
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                out[r][c] = doubles ? (float) buffer.getDouble(at) : buffer.getFloat(at);
                at += doubles ? 8 : 4;
            }
        }
        return out;
    }
}
