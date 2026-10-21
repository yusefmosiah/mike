import assert from "node:assert/strict";
import { test } from "node:test";

import {
  abisFrom,
  configureAppGradle,
  configureMainActivity,
  configureManifest,
  configureStrings,
  configureVariables,
  networkSecurityConfig,
} from "./configure-android.mjs";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher">

        <activity
            android:name=".MainActivity"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>
    </application>

    <!-- Permissions -->

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

test("variables.gradle gets minSdk 29 and targetSdk 36", () => {
  const out = configureVariables("ext {\n    minSdkVersion = 24\n    compileSdkVersion = 35\n    targetSdkVersion = 35\n}");
  assert.match(out, /minSdkVersion = 29/);
  assert.match(out, /targetSdkVersion = 36/);
  assert.match(out, /compileSdkVersion = 36/);
  assert.equal(configureVariables(out), out);
});

test("strings.xml takes the brand's name, escaped for Android resources", () => {
  const source = '<resources>\n    <string name="app_name">Old</string>\n    <string name="title_activity_main">Old</string>\n</resources>';
  const out = configureStrings(source, "Ann's <Desk>");
  assert.match(out, /<string name="app_name">Ann\\'s &lt;Desk&gt;<\/string>/);
  assert.match(out, /<string name="title_activity_main">Ann\\'s &lt;Desk&gt;<\/string>/);
});

test("the manifest gets permissions, the URL scheme and no backups, once", () => {
  const out = configureManifest(MANIFEST, { cleartext: false });
  for (const permission of ["INTERNET", "RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS", "CAMERA"]) {
    assert.equal(out.split(`android.permission.${permission}"`).length, 2, permission);
  }
  assert.match(out, /android:allowBackup="false"/);
  assert.doesNotMatch(out, /android:allowBackup="true"/);
  assert.match(out, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(out, /<data android:scheme="mike" \/>/);
  assert.doesNotMatch(out, /networkSecurityConfig/);
  assert.equal(configureManifest(out, { cleartext: false }), out);
});

test("cleartext is allowed only for an http development server, and removed again", () => {
  const dev = configureManifest(MANIFEST, { cleartext: true });
  assert.match(dev, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.doesNotMatch(configureManifest(dev, { cleartext: false }), /networkSecurityConfig/);
  const config = networkSecurityConfig("10.0.2.2");
  assert.match(config, /<base-config cleartextTrafficPermitted="false" \/>/);
  assert.match(config, /<domain includeSubdomains="false">10\.0\.2\.2<\/domain>/);
});

test("MainActivity hides the recents snapshot unless the preview is allowed", () => {
  const generated = "package com.firm.mike;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n";
  const covered = configureMainActivity(generated, { preview: false });
  assert.match(covered, /setRecentsScreenshotEnabled\(false\)/);
  assert.match(covered, /FLAG_SECURE/);
  assert.equal(configureMainActivity(covered, { preview: false }), covered);
  const open = configureMainActivity(covered, { preview: true });
  assert.doesNotMatch(open, /FLAG_SECURE|setRecentsScreenshotEnabled/);
  assert.equal(configureMainActivity(open, { preview: false }), covered);
  // Either way, cookies are saved and a crashed page recovers.
  for (const activity of [covered, open]) {
    assert.match(activity, /CookieManager\.getInstance\(\)\.flush\(\)/);
    assert.match(activity, /public void onPause\(\)/);
    assert.match(activity, /public void onResume\(\)[\s\S]*postDelayed\(saveCookies, 5000\)/);
    assert.match(activity, /onPause\(\)[\s\S]*removeCallbacks\(saveCookies\)/);
    assert.match(activity, /onRenderProcessGone[\s\S]*recreate\(\);\s*return true;/);
  }
});

const APP_GRADLE = `android {
    namespace = "com.firm.mike"
    defaultConfig {
        applicationId "com.firm.mike"
        minSdkVersion rootProject.ext.minSdkVersion
    }
}
`;

test("app/build.gradle packages only the chosen ABIs, once", () => {
  const out = configureAppGradle(APP_GRADLE, ["arm64-v8a"]);
  assert.match(out, /defaultConfig \{\n        \/\/ MIKE_ABI_FILTERS[^\n]*\n        ndk \{\n            abiFilters 'arm64-v8a'\n        \}\n        applicationId/);
  assert.equal(configureAppGradle(out, ["arm64-v8a"]), out);
  const widened = configureAppGradle(out, ["arm64-v8a", "x86_64"]);
  assert.match(widened, /abiFilters 'arm64-v8a', 'x86_64'/);
  assert.equal(widened.split("MIKE_ABI_FILTERS").length, 2);
  assert.throws(() => configureAppGradle("android {}", ["arm64-v8a"]), /defaultConfig/);
});

test("MIKE_ANDROID_ABIS is read as a list, arm64 by default", () => {
  assert.deepEqual(abisFrom(undefined), ["arm64-v8a"]);
  assert.deepEqual(abisFrom(" "), ["arm64-v8a"]);
  assert.deepEqual(abisFrom("arm64-v8a, x86_64"), ["arm64-v8a", "x86_64"]);
  assert.throws(() => abisFrom("arm64'; evil"), /invalid ABI/);
});
