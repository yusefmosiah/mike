package com.firm.mike.speech;

import java.util.Arrays;
import java.util.List;

/**
 * A model the app downloads on request: every file at a URL pinned to one
 * commit, with its size and SHA-256, so a later change to a repository never
 * reaches a phone unannounced and a damaged or altered file is refused.
 *
 * @param name the folder the files are installed into (under the app's no-backup files)
 * @param revision written into the folder once every file has been checked; a
 *     folder from another revision is not installed
 */
record ModelPack(String name, String revision, List<File> files) {
    /** One file: where it goes in the folder, where it comes from, and what it must be. */
    record File(String path, String url, long size, String sha256) {}

    long totalBytes() {
        long total = 0;
        for (File file : files) total += file.size();
        return total;
    }

    /**
     * Fluid Speech Mini's ONNX build (CC BY 4.0) by FluidVoice: the FP32 CPU
     * graphs with 2- and 4-bit MatMulNBits weights, about 300 MB.
     */
    static final String FLUID_REPO = "https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-onnx/resolve/";
    static final String FLUID_REVISION = "fc592620325027419883cf272e70588d8a788c0a";

    static ModelPack fluidSpeechMini() {
        String base = FLUID_REPO + FLUID_REVISION + "/";
        return new ModelPack("fluid-speech-mini-onnx", FLUID_REVISION, Arrays.asList(
            new File("config.json", base + "config.json", 508, "0c4d0c84dadc0d439dfe3c843a4b482bf3ebb50421f781fcbafc7236903234f4"),
            new File("tokenizer.json", base + "tokenizer.json", 1_159_959, "7c200d88ac60da4de246cbd38e981a732f2e82580fdd285cb757d8d1f4af9627"),
            new File("mel_filters.npy", base + "mel_filters.npy", 131_712, "ce607f7ae1ce68fd01c02e1177fb1d11ee209c6176d35e47011917ca7d9cd4f2"),
            new File("frontend.onnx", base + "frontend.onnx", 8_697_130, "cdbea06631920f25f6183e1389129e9c37106a766c6e130b7f0389b9531b43b7"),
            new File("encoder.onnx", base + "encoder.onnx", 426_102, "f8b3a45e71a33b44179a21ef6d6474779747846c4b01c9fd690abcebb88bea86"),
            new File("encoder.onnx.data", base + "encoder.onnx.data", 253_429_760, "f865c582bec1bd57aa7f2242f3739f38987b7bf471fee4dca7d5c2714eec0747"),
            new File("decoder.onnx", base + "decoder.onnx", 24_461_296, "9ac7e6c22952c242d56df0992ba19489a05b87a8ed37e23798469b9316099af8"),
            new File("joint.onnx", base + "joint.onnx", 11_840_320, "2e704908834b9f8cc7db88757b8966bac266e19bc00a527c46e9950281205253")));
    }

    /**
     * Phonon 31m (Apache-2.0) by Gradium for xn-ptts's CPU runtime: the q8
     * weights from gradium/phonon-31m-en and the eight English voices the web
     * app offers (frontend lib/voice/browserModels.spec.ts, same commits),
     * about 67 MB. The iPhone's mirror holds Core ML files the CPU runtime cannot read.
     */
    static final String PHONON_REVISION = "52433c46975bfa13144c56204c9f4ee1c5b148aa";
    static final String PHONON_VOICES_REVISION = "0ee17205f254b5abc43b266c8a0f215565c352f7";

    static ModelPack phonon() {
        String base = "https://huggingface.co/gradium/phonon-31m-en/resolve/" + PHONON_REVISION + "/";
        String voices = "https://huggingface.co/gradium/phonon-voices/resolve/" + PHONON_VOICES_REVISION + "/voices/";
        return new ModelPack("phonon-31m-en", PHONON_REVISION + "+" + PHONON_VOICES_REVISION, Arrays.asList(
            new File("config.json", base + "config.json", 2_851, "7062ea376e6b158543c8abec8e5af67df171c49ad70eb7e2a0fb25c16f265e06"),
            new File("tokenizer.json", base + "tokenizer.json", 277_967, "691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936"),
            new File("model.q8.gguf", base + "model.q8.gguf", 64_512_352, "a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae"),
            new File("default-voice.safetensors", base + "default-voice.safetensors", 256_136, "f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18"),
            voice(voices, "Harper", "4SZHfMpw-p46Ywgs", "6b3da6e2d796a20c51af892c482bd6509fb88267a221aff83c870843dee2a123"),
            voice(voices, "Hadley", "bXwrkHhURL1VFJdG", "a879938aa9a2df0a8220bdadef88137929f71e887bd91e7db205bd5fa11661d2"),
            voice(voices, "Miles", "d9XCyhjo4JhkHF1d", "eab20e4f159b48cfbc01b1885804e24f681f80e7a64f909182763a4e3361bee8"),
            voice(voices, "Preston", "qIxlZ7Ei8KvWlyQH", "6e04b84d3ae8751b22bca0a4f63936f9cb648f4f2182b2d0788071ea1c0b68a1"),
            voice(voices, "Maeve", "6PWnV0Nq4wu7RVBT", "56494ee67d533ad227ff0dfd0b1c13ff5aa91f1ad6e596e66c2986ba3005e844"),
            voice(voices, "Bryony", "gfP44RlHwr2kEwk7", "bcc207a73b7885e45b49ab633d3377a10158292e3a7cef9cd6764ad107f1cb9b"),
            voice(voices, "Edwin", "zUCxzrOrugTSis03", "ff1d0735b8b45710462b1d1f846da040f970c6eb62c7c2f36dbfb8e5bde74f1e"),
            voice(voices, "Hugh", "YyKcxPG7iIgS3jsK", "3169d74b47a54d1eb15e4c243f56393abe9fe90c7e1c308ecf96ee67618b152a")));
    }

    private static File voice(String base, String name, String id, String sha256) {
        return new File("voices/" + name + ".safetensors", base + id + ".safetensors", 256_136, sha256);
    }
}
