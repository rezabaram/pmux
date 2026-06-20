/**
 * Test that extension files parse correctly with Pi's jiti loader.
 *
 * Node --check passes TypeScript but jiti's parser is stricter.
 * This test catches parse errors before they reach Pi.
 *
 * Usage: node test/parse.mjs
 *
 * Expected: "Cannot find module" errors (runtime deps, fine)
 * Failure:  "ParseError" (broken syntax, must fix)
 */

import { createJiti } from "/home/reza/.nvm/versions/node/v24.3.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(__dirname, "..", "extension");
const jiti = createJiti(import.meta.url);

const files = readdirSync(extensionDir).filter((f) => f.endsWith(".ts"));
let failed = false;

for (const file of files) {
  const path = join(extensionDir, file);
  try {
    jiti(path);
    console.log(`  ✓ ${file}`);
  } catch (e) {
    const msg = e.message ?? "";
    if (msg.includes("ParseError") || msg.includes("Unexpected token")) {
      console.log(`  ✗ ${file}: ${msg.slice(0, 200)}`);
      failed = true;
    } else {
      // Module resolution errors are expected outside Pi
      console.log(`  ✓ ${file} (parsed, runtime dep expected)`);
    }
  }
}

if (failed) {
  console.log("\nFAILED: Fix parse errors above.");
  process.exit(1);
} else {
  console.log("\nAll files parse correctly.");
}
