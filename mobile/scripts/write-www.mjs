// Writes www/server.js: the server URL the offline page retries, the same
// one capacitor.config.ts loads (MIKE_SERVER_URL, default staging).
import { writeFileSync } from "node:fs";

const url = (process.env.MIKE_SERVER_URL ?? "https://choir-ip.com").replace(/\/+$/, "");
new URL(url); // refuse anything that is not a URL
writeFileSync(new URL("../www/server.js", import.meta.url), `window.MIKE_SERVER_URL = ${JSON.stringify(url)};\n`);
console.log(`www/server.js -> ${url}`);
