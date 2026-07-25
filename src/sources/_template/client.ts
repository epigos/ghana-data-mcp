import { request, type RequestOptions } from "../../lib/http.js";

/**
 * Upstream access for a new source. Keep this layer free of parsing and MCP
 * concerns: fetch bytes, hand them on.
 *
 * Always go through `request()` from lib/http rather than calling `fetch`
 * directly — it applies the project User-Agent, the timeout, and the jittered
 * retry policy that keeps us a good citizen toward the sites we read.
 */

export const TEMPLATE_BASE_URL = "https://example.gov.gh";

export interface TemplateClientOptions extends RequestOptions {
  baseUrl?: string;
}

export class TemplateClient {
  private readonly baseUrl: string;
  private readonly requestOptions: RequestOptions;

  constructor(options: TemplateClientOptions = {}) {
    const { baseUrl = TEMPLATE_BASE_URL, ...requestOptions } = options;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.requestOptions = requestOptions;
  }

  async fetchSomething(): Promise<unknown> {
    const response = await request(
      `${this.baseUrl}/some/path`,
      { headers: { accept: "application/json" } },
      { ...this.requestOptions, label: "GET /some/path" },
    );
    return response.json();
  }
}
