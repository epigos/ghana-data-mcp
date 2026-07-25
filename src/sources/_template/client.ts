import { request, type RequestOptions } from "../../lib/http.js";
import { silentLogger, type Logger } from "../../lib/log.js";

/**
 * Upstream access for a new source. Keep this layer free of parsing and MCP
 * concerns: fetch bytes, hand them on.
 *
 * Always go through `request()` from lib/http rather than calling `fetch`
 * directly — it applies the project User-Agent, the timeout, the jittered retry
 * policy, and the request/response logging. A bare `fetch` skips all four.
 */

export const TEMPLATE_BASE_URL = "https://example.gov.gh";
const NAMESPACE = "template";

export interface TemplateClientOptions extends RequestOptions {
  baseUrl?: string;
  logger?: Logger;
}

export class TemplateClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly requestOptions: RequestOptions;

  constructor(options: TemplateClientOptions = {}) {
    const { baseUrl = TEMPLATE_BASE_URL, logger = silentLogger, ...requestOptions } = options;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    // Tagging every line with the source keeps it greppable apart from others.
    this.logger = logger.child({ source: NAMESPACE });
    // Handing the logger to request() is what makes each attempt show up.
    this.requestOptions = { ...requestOptions, logger: this.logger };
  }

  async fetchSomething(id: string): Promise<unknown> {
    this.logger.info(`${NAMESPACE}: fetching something`, { id });

    const response = await request(
      `${this.baseUrl}/some/path`,
      { headers: { accept: "application/json" } },
      { ...this.requestOptions, label: "GET /some/path" },
    );

    const payload = await response.json();
    this.logger.debug(`${NAMESPACE}: payload received`, { id });
    return payload;
  }
}
