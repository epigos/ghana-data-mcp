/**
 * A very small structured logger.
 *
 * Workers captures `console.*` into Workers Logs, so there is nothing to install
 * — the value this adds is a consistent line format that stays readable in
 * `wrangler dev` and greppable in production:
 *
 *   info  | gse: table fetched | table=39 rows=58 ms=412
 *
 * Two levels of verbosity, split by what they cost:
 *
 *  - `info`/`warn`/`error` are always on. One line per *upstream* request is
 *    cheap, because the cache absorbs repeats — and knowing which scrapes
 *    actually left the Worker is the first thing you want when a tool misbehaves.
 *  - `debug` is off unless `DEBUG=1`. This is where the noisy detail goes:
 *    headers, nonces, request bodies, retry delays.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line — e.g. one bound to a symbol. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Emit `debug` lines. Driven by the DEBUG binding. */
  debug?: boolean;
  /** Fields added to every line. */
  base?: LogFields;
  /** Override the output, for tests. */
  sink?: (level: LogLevel, line: string) => void;
}

const consoleSink = (level: LogLevel, line: string): void => {
  // Workers routes each of these to Workers Logs with the matching severity.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const { debug: debugEnabled = false, base = {}, sink = consoleSink } = options;

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (level === "debug" && !debugEnabled) return;
    sink(level, formatLine(level, message, { ...base, ...fields }));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) =>
      createLogger({ debug: debugEnabled, base: { ...base, ...fields }, sink }),
  };
}

/** Discards everything. The default wherever a logger is optional. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

function formatLine(level: LogLevel, message: string, fields: LogFields): string {
  const rendered = Object.entries(fields)
    // A field that is absent should not clutter the line with `key=undefined`.
    .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(" ");

  return rendered ? `${level.padEnd(5)} | ${message} | ${rendered}` : `${level.padEnd(5)} | ${message}`;
}

function renderValue(value: string | number | boolean | null): string {
  if (typeof value !== "string") return String(value);
  // Quote anything that would otherwise break `key=value` parsing.
  return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
}

/** Reads the DEBUG binding, which is a string because wrangler vars always are. */
export function debugEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
