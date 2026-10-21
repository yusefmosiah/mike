package com.firm.mike.speech;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ModelInstallerTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    /** A minimal HTTP/1.1 file server (android.jar hides the JDK's own). */
    private ServerSocket server;
    private Thread serving;
    private final Map<String, byte[]> served = new ConcurrentHashMap<>();
    private final List<String> ranges = new CopyOnWriteArrayList<>();
    /** Paths whose next response is cut off after this many bytes. */
    private final Map<String, Integer> cutOff = new ConcurrentHashMap<>();
    /** Paths that ignore Range and send the whole file. */
    private final Set<String> noRanges = ConcurrentHashMap.newKeySet();

    @Before
    public void start() throws IOException {
        server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        serving = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    respond(socket);
                } catch (IOException ignored) {
                    // Closed, or the client went away.
                }
            }
        });
        serving.start();
    }

    private void respond(Socket socket) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
        String request = in.readLine();
        if (request == null) return;
        String path = request.split(" ")[1];
        String range = null;
        for (String line = in.readLine(); line != null && !line.isEmpty(); line = in.readLine()) {
            if (line.toLowerCase().startsWith("range:")) range = line.substring(6).trim();
        }
        OutputStream out = socket.getOutputStream();
        byte[] body = served.get(path);
        if (body == null) {
            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
            return;
        }
        ranges.add(path + " " + range);
        int from = 0;
        String status = "200 OK";
        if (range != null && !noRanges.contains(path)) {
            from = Integer.parseInt(range.replace("bytes=", "").replace("-", ""));
            status = "206 Partial Content";
        }
        int length = body.length - from;
        out.write(("HTTP/1.1 " + status + "\r\nContent-Length: " + length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        Integer cut = cutOff.remove(path);
        out.write(body, from, cut == null ? length : Math.min(cut, length));
        out.flush();
    }

    @After
    public void stop() throws Exception {
        server.close();
        serving.join(2_000);
    }

    private String url(String path) {
        return "http://127.0.0.1:" + server.getLocalPort() + path;
    }

    private static String sha256(byte[] bytes) throws Exception {
        return ModelInstaller.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static byte[] bytes(int size, int seed) {
        byte[] out = new byte[size];
        for (int i = 0; i < size; i++) out[i] = (byte) (i * 31 + seed);
        return out;
    }

    private ModelPack pack(byte[] a, byte[] b) throws Exception {
        served.put("/a.bin", a);
        served.put("/voices/b.bin", b);
        return new ModelPack("model", "rev1", Arrays.asList(
            new ModelPack.File("a.bin", url("/a.bin"), a.length, sha256(a)),
            new ModelPack.File("voices/b.bin", url("/voices/b.bin"), b.length, sha256(b))));
    }

    @Test
    public void installsChecksAndReportsProgress() throws Exception {
        byte[] a = bytes(700_000, 1);
        byte[] b = bytes(1_000, 2);
        ModelPack pack = pack(a, b);
        ModelInstaller installer = new ModelInstaller(folder.getRoot());
        assertFalse(installer.isInstalled(pack));
        List<Double> progress = new ArrayList<>();
        installer.install(pack, progress::add, () -> false);
        assertTrue(installer.isInstalled(pack));
        assertTrue(Arrays.equals(a, Files.readAllBytes(new File(installer.directory(pack), "a.bin").toPath())));
        assertTrue(Arrays.equals(b, Files.readAllBytes(new File(installer.directory(pack), "voices/b.bin").toPath())));
        assertFalse(installer.staging(pack).exists());
        assertEquals(1.0, progress.get(progress.size() - 1), 0);
        for (int i = 1; i < progress.size(); i++) assertTrue(progress.get(i) >= progress.get(i - 1));

        // Another revision is not this one.
        ModelPack newer = new ModelPack("model", "rev2", pack.files());
        assertFalse(installer.isInstalled(newer));

        installer.remove(pack);
        assertFalse(installer.directory(pack).exists());
        assertFalse(installer.isInstalled(pack));
    }

    @Test
    public void resumesAnInterruptedDownload() throws Exception {
        byte[] a = bytes(500_000, 3);
        byte[] b = bytes(10, 4);
        ModelPack pack = pack(a, b);
        ModelInstaller installer = new ModelInstaller(folder.getRoot(), 2_000, 2_000);
        cutOff.put("/a.bin", 200_000);
        try {
            installer.install(pack, (fraction) -> {}, () -> false);
            fail("the cut-off download should fail");
        } catch (SpeechFailure failure) {
            assertEquals(SpeechFailure.INSTALL_FAILED, failure.code);
        }
        long kept = new File(installer.staging(pack), "a.bin").length();
        assertTrue(kept > 0 && kept < a.length);
        installer.install(pack, (fraction) -> {}, () -> false);
        assertTrue(installer.isInstalled(pack));
        assertTrue(ranges.contains("/a.bin bytes=" + kept + "-"));
        assertTrue(Arrays.equals(a, Files.readAllBytes(new File(installer.directory(pack), "a.bin").toPath())));
    }

    @Test
    public void startsOverWhenTheServerIgnoresTheRange() throws Exception {
        byte[] a = bytes(300_000, 5);
        ModelPack pack = pack(a, bytes(10, 6));
        ModelInstaller installer = new ModelInstaller(folder.getRoot());
        File staged = new File(installer.staging(pack), "a.bin");
        staged.getParentFile().mkdirs();
        Files.write(staged.toPath(), Arrays.copyOf(a, 1000));
        noRanges.add("/a.bin");
        installer.install(pack, (fraction) -> {}, () -> false);
        assertTrue(Arrays.equals(a, Files.readAllBytes(new File(installer.directory(pack), "a.bin").toPath())));
    }

    @Test
    public void refusesAFileWhoseHashIsWrong() throws Exception {
        byte[] a = bytes(1_000, 7);
        served.put("/a.bin", a);
        ModelPack pack = new ModelPack("model", "rev1", Arrays.asList(
            new ModelPack.File("a.bin", url("/a.bin"), a.length, sha256("something else".getBytes(StandardCharsets.UTF_8)))));
        ModelInstaller installer = new ModelInstaller(folder.getRoot());
        try {
            installer.install(pack, (fraction) -> {}, () -> false);
            fail("a wrong hash must be refused");
        } catch (SpeechFailure failure) {
            assertEquals(SpeechFailure.INSTALL_FAILED, failure.code);
        }
        assertFalse(installer.isInstalled(pack));
        assertFalse(installer.directory(pack).exists());
        // Fetched twice (once more after the first mismatch), then given up.
        assertEquals(2, ranges.size());
    }

    @Test
    public void refusesAFileLargerThanExpected() throws Exception {
        byte[] a = bytes(2_000, 8);
        served.put("/a.bin", a);
        ModelPack pack = new ModelPack("model", "rev1", Arrays.asList(new ModelPack.File("a.bin", url("/a.bin"), 1_000, sha256(Arrays.copyOf(a, 1_000)))));
        try {
            new ModelInstaller(folder.getRoot()).install(pack, (fraction) -> {}, () -> false);
            fail("an oversized file must be refused");
        } catch (SpeechFailure failure) {
            assertEquals(SpeechFailure.INSTALL_FAILED, failure.code);
        }
    }

    @Test
    public void cancels() throws Exception {
        ModelPack pack = pack(bytes(2_000_000, 9), bytes(10, 10));
        ModelInstaller installer = new ModelInstaller(folder.getRoot());
        try {
            installer.install(pack, (fraction) -> {}, () -> true);
            fail("a cancelled download must stop");
        } catch (SpeechFailure failure) {
            assertEquals(SpeechFailure.CANCELLED, failure.code);
        }
        assertFalse(installer.isInstalled(pack));
    }

    @Test
    public void aMissingFileFails() throws Exception {
        ModelPack pack = new ModelPack("model", "rev1", Arrays.asList(new ModelPack.File("a.bin", url("/missing"), 10, "00")));
        try {
            new ModelInstaller(folder.getRoot()).install(pack, (fraction) -> {}, () -> false);
            fail("a missing file must fail");
        } catch (SpeechFailure failure) {
            assertEquals(SpeechFailure.INSTALL_FAILED, failure.code);
        }
    }

    @Test
    public void thePinnedPacksAreComplete() {
        for (ModelPack pack : Arrays.asList(ModelPack.fluidSpeechMini(), ModelPack.phonon())) {
            Set<String> paths = new HashSet<>();
            for (ModelPack.File file : pack.files()) {
                assertTrue(file.url(), file.url().startsWith("https://huggingface.co/"));
                assertTrue(file.url(), file.url().contains("/resolve/") && file.url().matches(".*/resolve/[0-9a-f]{40}/.*"));
                assertTrue(file.sha256().matches("[0-9a-f]{64}"));
                assertTrue(file.size() > 0);
                assertTrue(paths.add(file.path()));
            }
        }
        assertTrue(ModelPack.fluidSpeechMini().totalBytes() > 290_000_000L);
        assertEquals(12, ModelPack.phonon().files().size());
    }
}
