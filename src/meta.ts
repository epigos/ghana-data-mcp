/**
 * Project identity, in one place.
 *
 * The name, version and repo URL are needed by the MCP handshake, the health
 * endpoint, and the User-Agent we present to the sites we scrape. Keeping them
 * here stops the three from drifting apart — a User-Agent still advertising an
 * old version is the kind of thing nobody notices for months.
 *
 * `VERSION` must match `package.json`. It is duplicated rather than imported
 * because importing package.json would embed the whole file — devDependencies
 * included — into the deployed Worker bundle.
 */

export const SERVER_NAME = "ghana-data-mcp";
export const SERVER_VERSION = "0.1.1";
export const REPO_URL = "https://github.com/epigos/ghana-data-mcp";
