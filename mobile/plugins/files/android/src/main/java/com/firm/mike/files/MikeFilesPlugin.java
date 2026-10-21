package com.firm.mike.files;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The Android side of MikeFiles: registered so the app builds with the
 * plugin, but without "share" yet. The web app hands a download to the
 * plugin only when it lists that method (frontend lib/nativeFiles.ts); until
 * then it falls back to a blob link, which the Android web view ignores.
 */
@CapacitorPlugin(name = "MikeFiles")
public class MikeFilesPlugin extends Plugin {}
