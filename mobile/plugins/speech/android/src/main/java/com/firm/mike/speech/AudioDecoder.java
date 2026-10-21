package com.firm.mike.speech;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;

/**
 * Decodes the web view's recording (AAC in MP4, Opus in WebM, WAV, MP3:
 * whatever the phone's codecs read) to 16 kHz mono float samples with
 * MediaExtractor and MediaCodec. The audio exists only in memory and in the
 * plugin's temporary file, which the caller deletes.
 */
final class AudioDecoder {
    private static final long TIMEOUT_US = 10_000;

    private AudioDecoder() {}

    static float[] decode(File file, int targetRate) throws SpeechFailure {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        try {
            try {
                extractor.setDataSource(file.getPath());
            } catch (Exception e) {
                throw new SpeechFailure(SpeechFailure.UNSUPPORTED_AUDIO, e);
            }
            int track = -1;
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat candidate = extractor.getTrackFormat(i);
                String mime = candidate.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    track = i;
                    format = candidate;
                    break;
                }
            }
            if (format == null) throw new SpeechFailure(SpeechFailure.UNSUPPORTED_AUDIO);
            extractor.selectTrack(track);
            try {
                codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
                codec.configure(format, null, null, 0);
            } catch (Exception e) {
                throw new SpeechFailure(SpeechFailure.UNSUPPORTED_AUDIO, e);
            }
            codec.start();

            int rate = format.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? format.getInteger(MediaFormat.KEY_SAMPLE_RATE) : targetRate;
            int channels = format.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 1;
            int encoding = AudioFormat.ENCODING_PCM_16BIT;
            Resampler.Stream resampler = null;
            Resampler.FloatList out = new Resampler.FloatList();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean outputDone = false;
            float[] scratch = new float[0];
            while (!outputDone) {
                if (!inputDone) {
                    int index = codec.dequeueInputBuffer(TIMEOUT_US);
                    if (index >= 0) {
                        ByteBuffer input = codec.getInputBuffer(index);
                        int size = input == null ? -1 : extractor.readSampleData(input, 0);
                        if (size < 0) {
                            codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(index, 0, size, extractor.getSampleTime(), 0);
                            extractor.advance();
                        }
                    }
                }
                int index = codec.dequeueOutputBuffer(info, TIMEOUT_US);
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat changed = codec.getOutputFormat();
                    rate = changed.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = changed.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (changed.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = changed.getInteger(MediaFormat.KEY_PCM_ENCODING);
                } else if (index >= 0) {
                    ByteBuffer output = codec.getOutputBuffer(index);
                    if (output != null && info.size > 0) {
                        output.position(info.offset);
                        output.limit(info.offset + info.size);
                        ByteBuffer pcm = output.slice().order(ByteOrder.nativeOrder());
                        int count;
                        if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
                            count = pcm.remaining() / 4;
                            if (scratch.length < count) scratch = new float[count];
                            pcm.asFloatBuffer().get(scratch, 0, count);
                        } else {
                            ShortBuffer shorts = pcm.asShortBuffer();
                            count = shorts.remaining();
                            if (scratch.length < count) scratch = new float[count];
                            for (int i = 0; i < count; i++) scratch[i] = shorts.get(i) / 32768f;
                        }
                        float[] mono = Resampler.downmix(java.util.Arrays.copyOf(scratch, count), channels);
                        if (resampler == null) resampler = rate == targetRate ? null : new Resampler.Stream(rate, targetRate);
                        if (resampler == null) out.addAll(mono, mono.length);
                        else resampler.push(mono, mono.length, out);
                    }
                    codec.releaseOutputBuffer(index, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                }
            }
            if (resampler != null) resampler.flush(out);
            if (out.size() == 0) throw new SpeechFailure(SpeechFailure.INVALID_AUDIO);
            return out.toArray();
        } catch (SpeechFailure failure) {
            throw failure;
        } catch (RuntimeException e) {
            throw new SpeechFailure(SpeechFailure.UNSUPPORTED_AUDIO, e);
        } finally {
            if (codec != null) {
                try {
                    codec.stop();
                } catch (RuntimeException ignored) {
                    // Never started.
                }
                codec.release();
            }
            extractor.release();
        }
    }
}
