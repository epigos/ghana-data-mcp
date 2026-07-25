import { describe, expect, it, vi } from "vitest";

import { createLogger, debugEnabled, silentLogger, type LogLevel } from "../../src/lib/log.js";

/** Collects emitted lines instead of writing to the console. */
function recorder() {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  return {
    lines,
    sink: (level: LogLevel, line: string) => lines.push({ level, line }),
    at: (index: number) => lines[index]?.line ?? "",
  };
}

describe("createLogger", () => {
  it("formats a line with its level, message and fields", () => {
    const log = recorder();
    createLogger({ sink: log.sink }).info("gse: table fetched", { table: 39, rows: 58 });

    expect(log.at(0)).toBe("info  | gse: table fetched | table=39 rows=58");
  });

  it("emits a bare line when there are no fields", () => {
    const log = recorder();
    createLogger({ sink: log.sink }).info("hello");

    expect(log.at(0)).toBe("info  | hello");
  });

  it("routes each level to the sink with its severity", () => {
    const log = recorder();
    const logger = createLogger({ debug: true, sink: log.sink });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(log.lines.map((entry) => entry.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  // The point of the split: one line per upstream request is affordable in
  // production, the noisy detail is not.
  it("suppresses debug unless it is switched on", () => {
    const off = recorder();
    createLogger({ sink: off.sink }).debug("nonce", { value: "abc" });
    expect(off.lines).toHaveLength(0);

    const on = recorder();
    createLogger({ debug: true, sink: on.sink }).debug("nonce", { value: "abc" });
    expect(on.lines).toHaveLength(1);
  });

  it("still emits info and above when debug is off", () => {
    const log = recorder();
    const logger = createLogger({ sink: log.sink });

    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(log.lines).toHaveLength(3);
  });

  it("omits undefined fields rather than printing key=undefined", () => {
    const log = recorder();
    createLogger({ sink: log.sink }).info("msg", { kept: 1, dropped: undefined });

    expect(log.at(0)).toBe("info  | msg | kept=1");
  });

  it("keeps null and false, which are real values", () => {
    const log = recorder();
    createLogger({ sink: log.sink }).info("msg", { a: null, b: false, c: 0 });

    expect(log.at(0)).toBe("info  | msg | a=null b=false c=0");
  });

  // Without quoting, a value containing a space would look like two fields.
  it("quotes values that would break key=value parsing", () => {
    const log = recorder();
    createLogger({ sink: log.sink }).info("msg", {
      reason: "gse.com.gh returned 503",
      range: "01/01/2026|31/01/2026",
    });

    expect(log.at(0)).toBe(
      'info  | msg | reason="gse.com.gh returned 503" range=01/01/2026|31/01/2026',
    );
  });

  describe("child", () => {
    it("adds its fields to every line", () => {
      const log = recorder();
      createLogger({ sink: log.sink }).child({ source: "gse" }).info("msg", { table: 39 });

      expect(log.at(0)).toBe("info  | msg | source=gse table=39");
    });

    it("lets a call-site field override an inherited one", () => {
      const log = recorder();
      createLogger({ sink: log.sink }).child({ table: 39 }).info("msg", { table: 34 });

      expect(log.at(0)).toBe("info  | msg | table=34");
    });

    it("inherits the debug setting", () => {
      const log = recorder();
      createLogger({ debug: true, sink: log.sink }).child({ a: 1 }).debug("msg");

      expect(log.lines).toHaveLength(1);
    });

    it("nests", () => {
      const log = recorder();
      createLogger({ sink: log.sink }).child({ a: 1 }).child({ b: 2 }).info("msg");

      expect(log.at(0)).toBe("info  | msg | a=1 b=2");
    });
  });
});

describe("silentLogger", () => {
  it("discards everything without touching the console", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    silentLogger.info("nope");
    silentLogger.error("nope");
    silentLogger.child({ a: 1 }).warn("nope");

    expect(spy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("debugEnabled", () => {
  // wrangler vars are always strings, so "0" must not be truthy.
  it("treats 1 and true as on", () => {
    expect(debugEnabled("1")).toBe(true);
    expect(debugEnabled("true")).toBe(true);
    expect(debugEnabled("TRUE")).toBe(true);
  });

  it("treats everything else as off", () => {
    for (const value of ["0", "false", "", "yes", undefined]) {
      expect(debugEnabled(value), `expected ${String(value)} to be off`).toBe(false);
    }
  });
});
