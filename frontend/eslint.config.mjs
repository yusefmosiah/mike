import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Copied from node_modules by scripts/copy-phonon-tts.mjs.
    "public/phonon-tts/**",
    // Copied from node_modules by scripts/copy-voice-web.mjs.
    "public/voice-web/ort/**",
  ]),
]);

export default eslintConfig;
