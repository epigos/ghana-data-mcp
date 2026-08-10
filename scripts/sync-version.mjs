#!/usr/bin/env node
/**
 * Rewrites `SERVER_VERSION` in src/meta.ts to match package.json.
 *
 * Run by npm's `version` lifecycle hook, which fires *after* npm writes the new
 * version to package.json but *before* it makes the version commit. That timing
 * is the whole point: package.json's `version` script stages src/meta.ts, so both
 * files land in the same commit and therefore under the same tag. They cannot be
 * released apart.
 *
 * src/meta.ts hardcodes the version rather than importing package.json on purpose
 * — the import would pull the whole file, devDependencies included, into the
 * deployed Worker bundle. This script is what keeps that copy honest, and
 * test/meta.test.ts is the backstop for when someone edits by hand instead.
 *
 * Safe to run on its own at any time; it is idempotent.
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const metaUrl = new URL("src/meta.ts", root);

// Read from disk rather than from npm_package_version, so the script behaves the
// same whether npm invoked it or a human did.
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

const ASSIGNMENT = /^(export const SERVER_VERSION = ")([^"]*)(";)$/m;

const source = readFileSync(metaUrl, "utf8");
const found = source.match(ASSIGNMENT);

if (!found) {
  // Loud, never silent. Skipping would tag a Worker that reports the old version
  // from /health, the ping tool, the MCP handshake and the outbound User-Agent.
  console.error(
    'sync-version: no `export const SERVER_VERSION = "...";` line in src/meta.ts.\n' +
      "If that declaration was renamed or reformatted, update the pattern in this script to match.",
  );
  process.exit(1);
}

if (found[2] === version) {
  console.log(`sync-version: src/meta.ts already at ${version}`);
  process.exit(0);
}

// Function replacer, so a version string containing `$` can never be interpreted
// as a replacement pattern.
writeFileSync(metaUrl, source.replace(ASSIGNMENT, (_match, lead, _old, tail) => lead + version + tail));
console.log(`sync-version: src/meta.ts ${found[2]} -> ${version}`);
