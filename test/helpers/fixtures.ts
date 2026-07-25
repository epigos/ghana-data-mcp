import { readFileSync } from "node:fs";

/** Reads a saved upstream response from test/fixtures. */
export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

export function fixtureJson<T>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}
