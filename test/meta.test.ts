import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { USER_AGENT } from "../src/lib/http.js";
import { REPO_URL, SERVER_NAME, SERVER_VERSION } from "../src/meta.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; version: string; repository: { url: string } };

describe("project identity", () => {
  // SERVER_VERSION is duplicated from package.json (importing the file would
  // bundle devDependencies into the Worker), so something has to catch the drift.
  it("keeps SERVER_VERSION in step with package.json", () => {
    expect(SERVER_VERSION).toBe(packageJson.version);
  });

  it("keeps SERVER_NAME in step with package.json", () => {
    expect(SERVER_NAME).toBe(packageJson.name);
  });

  it("points REPO_URL at the same repository package.json declares", () => {
    expect(packageJson.repository.url).toContain(REPO_URL.replace("https://", ""));
  });
});

describe("USER_AGENT", () => {
  it("is built from the single source of identity", () => {
    expect(USER_AGENT).toBe(`${SERVER_NAME}/${SERVER_VERSION} (+${REPO_URL})`);
  });

  // The contact link is the whole point: a gse.com.gh admin seeing this traffic
  // should be able to find out what it is and ask us to stop.
  it("carries a reachable contact link", () => {
    expect(USER_AGENT).toMatch(/\(\+https:\/\/github\.com\/[^/]+\/[^)]+\)$/);
  });
});
