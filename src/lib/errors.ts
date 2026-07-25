/**
 * Error types shared by every data source.
 *
 * The rule (see plan §9): `UpstreamError` means "the remote site let us down"
 * and is worth retrying; `ParseError` means "the markup/JSON was not what we
 * expected" and is *not* retryable — retrying the same broken page just wastes
 * an upstream request.
 */

export interface UpstreamErrorOptions {
  status?: number;
  retryable?: boolean;
  cause?: unknown;
}

/** Non-2xx response, network failure, or a missing nonce/cookie. Retryable. */
export class UpstreamError extends Error {
  override readonly name = "UpstreamError";
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: UpstreamErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.retryable = options.retryable ?? true;
  }
}

/** The response arrived but did not have the shape we can read. Not retryable. */
export class ParseError extends Error {
  override readonly name = "ParseError";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
  }
}

/**
 * Human-readable one-liner for a thrown value, with a retry hint where one
 * applies. This is the text that ends up in an MCP `isError` result, so it is
 * written for a model to read and act on.
 */
export function describeError(error: unknown): string {
  if (error instanceof UpstreamError) {
    const status = error.status ? ` (HTTP ${error.status})` : "";
    const hint = error.retryable
      ? " This is usually transient — retrying in a few seconds often works."
      : "";
    return `Upstream request failed${status}: ${error.message}.${hint}`;
  }
  if (error instanceof ParseError) {
    return `Could not parse the upstream response: ${error.message}. The source site's markup may have changed; retrying will not help.`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
