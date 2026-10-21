package com.firm.mike.speech;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.function.BooleanSupplier;
import java.util.function.DoubleConsumer;

/**
 * Downloads a {@link ModelPack} into a folder of its own, resuming an
 * interrupted download, and checks every file's size and SHA-256 before the
 * folder counts as installed. Files are fetched into `<name>.partial` beside
 * the folder and moved into place only when all of them have passed, so a
 * half-finished or tampered download is never loaded. Pure Java (JVM tests).
 */
final class ModelInstaller {
    /** Written into the folder last; holds the pack's revision. */
    static final String MARKER = ".mike-model";
    /** Free space kept beyond the download itself. */
    static final long SPARE_BYTES = 64L * 1024 * 1024;

    private final File root;
    private final int connectTimeoutMs;
    private final int readTimeoutMs;

    ModelInstaller(File root) {
        this(root, 15_000, 30_000);
    }

    ModelInstaller(File root, int connectTimeoutMs, int readTimeoutMs) {
        this.root = root;
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
    }

    File directory(ModelPack pack) {
        return new File(root, pack.name());
    }

    File staging(ModelPack pack) {
        return new File(root, pack.name() + ".partial");
    }

    /**
     * Whether the folder holds this revision with every file at its size. The
     * hashes were checked when it was installed; they are not read again here.
     */
    boolean isInstalled(ModelPack pack) {
        File directory = directory(pack);
        File marker = new File(directory, MARKER);
        try {
            if (!marker.isFile() || !pack.revision().equals(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8).trim())) {
                return false;
            }
        } catch (IOException e) {
            return false;
        }
        for (ModelPack.File file : pack.files()) {
            File target = new File(directory, file.path());
            if (!target.isFile() || target.length() != file.size()) return false;
        }
        return true;
    }

    /**
     * Downloads what is missing, checks it and moves the folder into place.
     * `progress` hears the fraction of the pack's bytes on disk, 0 to 1.
     * Throws {@link SpeechFailure} `cancelled` when `cancelled` turns true,
     * and `install-failed` for anything else (network, space, a wrong file).
     */
    void install(ModelPack pack, DoubleConsumer progress, BooleanSupplier cancelled) throws SpeechFailure {
        if (isInstalled(pack)) {
            progress.accept(1);
            return;
        }
        File staging = staging(pack);
        if (!staging.isDirectory() && !staging.mkdirs()) throw new SpeechFailure(SpeechFailure.INSTALL_FAILED);
        long total = pack.totalBytes();
        long have = 0;
        for (ModelPack.File file : pack.files()) {
            have += Math.min(file.size(), new File(staging, file.path()).length());
        }
        if (root.getUsableSpace() < total - have + SPARE_BYTES) throw new SpeechFailure(SpeechFailure.INSTALL_FAILED);

        long[] done = {0};
        for (ModelPack.File file : pack.files()) {
            File target = new File(staging, file.path());
            long before = done[0];
            fetchVerified(file, target, (bytes) -> {
                done[0] = before + bytes;
                progress.accept(total == 0 ? 1 : Math.min(1, done[0] / (double) total));
            }, cancelled);
            done[0] = before + file.size();
        }
        try {
            Files.write(new File(staging, MARKER).toPath(), pack.revision().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new SpeechFailure(SpeechFailure.INSTALL_FAILED, e);
        }
        File directory = directory(pack);
        deleteRecursively(directory);
        if (!staging.renameTo(directory)) throw new SpeechFailure(SpeechFailure.INSTALL_FAILED);
        progress.accept(1);
    }

    /** Deletes the folder and any download in progress. */
    void remove(ModelPack pack) {
        deleteRecursively(directory(pack));
        deleteRecursively(staging(pack));
    }

    interface ByteProgress {
        void bytes(long onDisk);
    }

    /**
     * One file: resumed from what is already on disk, then hashed. A file
     * whose hash is wrong is deleted and fetched once more from the start.
     */
    void fetchVerified(ModelPack.File file, File target, ByteProgress progress, BooleanSupplier cancelled) throws SpeechFailure {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new SpeechFailure(SpeechFailure.INSTALL_FAILED);
        for (int attempt = 0; attempt < 2; attempt++) {
            if (target.length() > file.size()) target.delete();
            if (target.length() < file.size()) fetch(file, target, progress, cancelled);
            if (target.length() == file.size() && file.sha256().equalsIgnoreCase(sha256(target))) {
                progress.bytes(file.size());
                return;
            }
            target.delete();
        }
        throw new SpeechFailure(SpeechFailure.INSTALL_FAILED);
    }

    private void fetch(ModelPack.File file, File target, ByteProgress progress, BooleanSupplier cancelled) throws SpeechFailure {
        long offset = target.length();
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(file.url()).openConnection();
            connection.setConnectTimeout(connectTimeoutMs);
            connection.setReadTimeout(readTimeoutMs);
            connection.setInstanceFollowRedirects(true);
            if (offset > 0) connection.setRequestProperty("Range", "bytes=" + offset + "-");
            int status = connection.getResponseCode();
            boolean append;
            if (status == HttpURLConnection.HTTP_PARTIAL && offset > 0) {
                append = true;
            } else if (status == HttpURLConnection.HTTP_OK) {
                append = false;
                offset = 0;
            } else {
                throw new SpeechFailure(SpeechFailure.INSTALL_FAILED);
            }
            try (InputStream in = connection.getInputStream();
                 RandomAccessFile out = new RandomAccessFile(target, "rw")) {
                out.setLength(append ? offset : 0);
                out.seek(append ? offset : 0);
                byte[] buffer = new byte[64 * 1024];
                long written = offset;
                long reported = 0;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (cancelled.getAsBoolean()) throw new SpeechFailure(SpeechFailure.CANCELLED);
                    if (written + read > file.size()) throw new SpeechFailure(SpeechFailure.INSTALL_FAILED);
                    out.write(buffer, 0, read);
                    written += read;
                    if (written - reported >= 256 * 1024) {
                        reported = written;
                        progress.bytes(written);
                    }
                }
                // The connection ended early: keep what arrived for the next attempt.
                if (written < file.size()) throw new SpeechFailure(SpeechFailure.INSTALL_FAILED);
            }
        } catch (SpeechFailure failure) {
            throw failure;
        } catch (IOException | RuntimeException e) {
            if (cancelled.getAsBoolean()) throw new SpeechFailure(SpeechFailure.CANCELLED, e);
            throw new SpeechFailure(SpeechFailure.INSTALL_FAILED, e);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static String sha256(File file) {
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[256 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
            return hex(digest.digest());
        } catch (IOException | NoSuchAlgorithmException e) {
            return "";
        }
    }

    static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        file.delete();
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        return out.toString();
    }
}
