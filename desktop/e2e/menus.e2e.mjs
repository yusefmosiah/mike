// The app menu, driven from the packaged app's main process. CDP reaches only
// the window's page, so this suite also opens Node's inspector on the main
// process (--inspect; the EnableNodeCliInspectArguments fuse is on in this
// build) and, from there:
//
//   * lists every menu item and its shortcut;
//   * clicks each item the shell defines (navigation, Settings, Home, Help,
//     Change Server) and checks the result over CDP;
//   * puts the window in and out of full screen and checks the title-bar
//     strip follows it (24px, 0px, 24px).
//
// Prereqs as for app.e2e.mjs: the local stack is up and the app is packaged.
//   MIKE_E2E_URL=http://localhost:3100 node e2e/menus.e2e.mjs
//
// Still by hand: pressing the shortcuts, and the role items (Edit, zoom,
// Toggle Full Screen), which are native menu actions. A key event sent to the
// page (webContents.sendInputEvent) never reaches the menu, and
// MenuItem.click() does not run a role. Also by hand: the traffic lights and
// dragging the window by its strip.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appPage,
  completeOnboardingIfRequired,
  dismissFirstRunOverlay,
  packagedAppBinary,
  signUpThroughUi,
  waitForAppTarget,
} from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_BINARY = packagedAppBinary(path.join(here, ".."));
const ARTIFACTS = path.join(here, "artifacts");
const SERVER_URL = (process.env.MIKE_E2E_URL ?? "http://localhost:3000").replace(/\/$/, "");
const RUN_ID = Date.now().toString(36);
const USER_DATA_DIR = path.join(ARTIFACTS, `userdata-menus-${RUN_ID}`);
const CAPTURE_FILE = path.join(ARTIFACTS, `external-menus-${RUN_ID}.txt`);
const CDP_PORT = 9225;
const INSPECT_PORT = 9339;
const EMAIL = `desktop-menus-${RUN_ID}@example.com`;
const PASSWORD = `E2e!${RUN_ID}aA1`;

mkdirSync(ARTIFACTS, { recursive: true });

let failures = 0;
const ok = (msg) => console.log(`✓ ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL ${msg}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

/** Runtime.evaluate in the main process, through Node's inspector. */
async function mainProcess() {
  const targets = await poll(async () => {
    const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json();
    return list.length ? list : null;
  }, 20_000);
  if (!targets) throw new Error("the main process inspector never came up");
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("could not attach to the main process"));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) => {
        const result = message.result;
        if (message.error || result?.exceptionDetails) {
          reject(new Error(JSON.stringify(message.error ?? result.exceptionDetails.exception?.description)));
        } else resolve(result.result.value);
      });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  return { evaluate, close: () => socket.close() };
}

// Main-process snippets. `require` comes from the inspector's command line API.
const MENU_ITEMS = `(() => {
  const { Menu } = require("electron");
  const out = [];
  const walk = (items, top) => items.forEach((item) => {
    if (item.type === "separator") return;
    out.push({ top, label: item.label, role: item.role || null, accelerator: item.accelerator || null });
    if (item.submenu) walk(item.submenu.items, top || item.label);
  });
  walk(Menu.getApplicationMenu().items, null);
  return out;
})()`;

const clickItem = (top, label) => `(() => {
  const { Menu, BrowserWindow } = require("electron");
  const menu = Menu.getApplicationMenu().items.find((item) => item.label === ${JSON.stringify(top)});
  const item = menu.submenu.items.find((entry) => entry.label === ${JSON.stringify(label)} || entry.role === ${JSON.stringify(label)});
  const win = BrowserWindow.getAllWindows()[0];
  item.click(undefined, win, win.webContents);
  return true;
})()`;

const WINDOW_STATE = `(() => {
  const { BrowserWindow } = require("electron");
  const win = BrowserWindow.getAllWindows()[0];
  return { fullScreen: win.isFullScreen() };
})()`;

const app = spawn(
  APP_BINARY,
  [`--inspect=${INSPECT_PORT}`, `--remote-debugging-port=${CDP_PORT}`, `--server-url=${SERVER_URL}`],
  {
    stdio: "ignore",
    env: {
      ...process.env,
      MIKE_DOWNLOAD_DIR: path.join(ARTIFACTS, "downloads"),
      MIKE_E2E_CAPTURE_EXTERNAL: CAPTURE_FILE,
      MIKE_USER_DATA_DIR: USER_DATA_DIR,
    },
  },
);

let main;
try {
  await waitForAppTarget(CDP_PORT);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const page = await appPage(browser.contexts()[0]);
  main = await mainProcess();

  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await signUpThroughUi(page, { email: EMAIL, password: PASSWORD });
  await page.waitForURL((url) => !/\/(login|signup)/.test(url.href), { timeout: 30_000 });
  await completeOnboardingIfRequired(page, { name: "Desktop Menus", organisation: "Mike Desktop CI" });
  await page.getByRole("button", { name: "Assistant", exact: true }).first().waitFor({ timeout: 20_000 });
  await dismissFirstRunOverlay(page);
  ok("signed up and in");

  const items = await main.evaluate(MENU_ITEMS);
  const shortcuts = items.filter((item) => item.accelerator).map((item) => `${item.label} ${item.accelerator}`);
  ok(`menu shortcuts: ${shortcuts.join(", ")}`);

  const pathOf = () => new URL(page.url()).pathname;
  const reaches = async (wanted) => (await poll(() => pathOf().startsWith(wanted) && pathOf(), 15_000)) !== null;

  // Each item the shell defines, clicked. The window starts elsewhere, so an
  // item that does nothing cannot pass.
  const routes = [
    ["File", "Projects", "/projects"],
    ["File", "Library", "/library"],
    ["File", "Tabular Review", "/tabular-reviews"],
    ["File", "Workflows", "/workflows"],
    ["File", "History", "/history"],
    ["File", "Assistant", "/assistant"],
    ["File", "New Chat", "/assistant"],
    ["Mike", "Settings…", "/settings"],
  ];
  for (const [top, label, wanted] of routes) {
    await page.goto(`${SERVER_URL}${wanted === "/history" ? "/projects" : "/history"}`);
    await main.evaluate(clickItem(top, label));
    if (await reaches(wanted)) ok(`${top} › ${label} → ${pathOf()}`);
    else fail(`${top} › ${label} stayed on ${pathOf()}`);
  }

  await page.goto(`${SERVER_URL}/projects`);
  await main.evaluate(clickItem("View", "Home"));
  if (await poll(() => pathOf() !== "/projects" && pathOf(), 15_000)) ok(`View › Home → ${pathOf()}`);
  else fail(`View › Home stayed on ${pathOf()}`);

  // Full screen hides the title-bar strip; leaving brings it back.
  const strip = () => page.getByTestId("titlebar-inset").evaluate((el) => el.getBoundingClientRect().height);
  const setFullScreen = (on) =>
    main.evaluate(`(require("electron").BrowserWindow.getAllWindows()[0].setFullScreen(${on}), true)`);
  const windowed = await strip();
  await setFullScreen(true);
  const inFull = await poll(async () => (await main.evaluate(WINDOW_STATE)).fullScreen, 10_000);
  const fullStrip = inFull ? await poll(async () => ((await strip()) === 0 ? "0" : null), 5_000) : null;
  await sleep(1_000);
  await setFullScreen(false);
  const left = await poll(async () => !(await main.evaluate(WINDOW_STATE)).fullScreen, 10_000);
  const backStrip = left ? await poll(async () => ((await strip()) === windowed ? String(windowed) : null), 5_000) : null;
  if (windowed === 24 && fullStrip && backStrip) ok(`full screen: strip ${windowed}px → ${fullStrip}px → ${backStrip}px`);
  else fail(`full screen: windowed ${windowed}, full ${fullStrip}, back ${backStrip}`);

  // Help opens GitHub in the default browser; the e2e run captures it.
  await main.evaluate(clickItem("Help", "Mike on GitHub"));
  const captured = await poll(() => readFileSync(CAPTURE_FILE, "utf8").includes("github.com/yusefmosiah/mike"));
  if (captured) ok("Help › Mike on GitHub → default browser (captured)");
  else fail("Help › Mike on GitHub captured nothing");

  // Change Server… leaves the product for the shell's connect page; last.
  await main.evaluate(clickItem("Mike", "Change Server…"));
  if (await poll(() => page.url().startsWith("file:"), 10_000)) ok("Mike › Change Server… → connect page");
  else fail(`Change Server… stayed on ${page.url()}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  main?.close();
  app.kill();
  await sleep(500);
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
}

console.log(failures ? `MENUS E2E FAILED (${failures})` : "MENUS E2E PASSED");
process.exitCode = failures ? 1 : 0;
