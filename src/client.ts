import {
  NetworkError,
  SeolyticizeError,
  errorForStatus,
  type RateLimitInfo,
} from "./errors.js";
import {
  toolMeta,
  type ToolInputs,
  type ToolMethods,
  type ToolName,
} from "./generated.js";
import type { Discovery } from "./types.js";

export const DEFAULT_BASE_URL = "https://seolyticize.com";

/** The SDK's own version, sent as the user agent so a support ticket can name it. */
export const SDK_VERSION = "0.1.0";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ClientOptions = {
  /** An sk_seo_ key, created under Settings or with the create_api_key tool. */
  apiKey: string;
  /** The API origin. Defaults to the hosted Seolyticize instance. */
  baseUrl?: string;
  /** Injected for tests, proxies, or runtimes without a global fetch. */
  fetch?: FetchLike;
  /** Retries after the first attempt. Default 2; 0 disables retrying. */
  maxRetries?: number;
  /** Per-attempt timeout. Default 30 seconds. */
  timeoutMs?: number;
  /**
   * The longest Retry-After the client will sit through, in seconds. A server
   * asking for longer gets a RateLimitError straight away rather than a
   * process that appears to hang. Default 60.
   */
  maxRetryAfterSeconds?: number;
  /** Injected for tests so a retry does not have to wait in real time. */
  sleep?: (ms: number) => Promise<void>;
};

export type CallOptions = {
  /** Aborts the call, including any wait between retries. */
  signal?: AbortSignal;
};

/**
 * Which failures a request may be retried on.
 *
 * A 429 was refused before anything ran, so it is always safe to repeat. A 5xx
 * or a dropped connection is not: the server may have created the client or
 * sent the report before failing to say so, and repeating a write would do it
 * twice. Only calls known to be reads are retried on those.
 */
type RetryPolicy = "rate-limit-only" | "transient";

export type SeolyticizeClient = {
  /** Calls any tool by name. Typed for tools this SDK knows; open for newer ones. */
  call<N extends ToolName, T = unknown>(
    name: N,
    input: ToolInputs[N],
    options?: CallOptions,
  ): Promise<T>;
  call<T = unknown>(name: string, input?: unknown, options?: CallOptions): Promise<T>;
  /** The catalogue as this key sees it, and who the key is. */
  listTools(options?: CallOptions): Promise<Discovery>;
  /** One typed method per tool known when this SDK was generated. */
  tools: ToolMethods;
  /** The rate-limit headers from the most recent response, when it carried any. */
  readonly lastRateLimit: RateLimitInfo | null;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Retry-After is either seconds or an HTTP date; both become seconds. */
function retryAfterSeconds(headers: Headers, now: number): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

function rateLimitFrom(headers: Headers): RateLimitInfo | null {
  const info = {
    limit: numberHeader(headers, "x-ratelimit-limit"),
    remaining: numberHeader(headers, "x-ratelimit-remaining"),
    resetSeconds: numberHeader(headers, "x-ratelimit-reset"),
  };
  return info.limit === null && info.remaining === null && info.resetSeconds === null
    ? null
    : info;
}

/**
 * Exponential backoff with full jitter: a fleet of agents that all hit the
 * same 503 should not all come back on the same millisecond and cause the
 * next one.
 */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(8_000, 500 * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

type FailureBody = {
  message: string;
  code: string | undefined;
  next: string | undefined;
  requestId: string | undefined;
};

/** The API's error body: the sentence, and the code, next step and request id beside it. */
async function failureFrom(response: Response): Promise<FailureBody> {
  const text = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return {
      message: text(body["error"]) ?? `HTTP ${response.status}`,
      code: text(body["code"]),
      next: text(body["next"]),
      requestId:
        text(body["requestId"]) ?? response.headers.get("x-request-id") ?? undefined,
    };
  } catch {
    // A proxy in front of the API can answer with HTML; the status still speaks.
    return {
      message: `HTTP ${response.status}`,
      code: undefined,
      next: undefined,
      requestId: response.headers.get("x-request-id") ?? undefined,
    };
  }
}

export function createClient(options: ClientOptions): SeolyticizeClient {
  if (!options.apiKey) {
    throw new SeolyticizeError("An apiKey is required.", { status: null });
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl: FetchLike =
    options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetryAfter = options.maxRetryAfterSeconds ?? 60;
  const sleep = options.sleep ?? defaultSleep;
  let lastRateLimit: RateLimitInfo | null = null;

  async function attempt(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        "user-agent": `seolyticize-sdk/${SDK_VERSION}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    };
    if (method === "POST") init.body = JSON.stringify(body ?? {});
    return fetchImpl(`${baseUrl}${path}`, init);
  }

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    policy: RetryPolicy,
    tool: string | undefined,
    callOptions: CallOptions | undefined,
  ): Promise<T> {
    for (let tries = 0; ; tries += 1) {
      const canRetry = tries < maxRetries;
      let response: Response;
      try {
        response = await attempt(method, path, body, callOptions?.signal);
      } catch (cause) {
        // A caller's own abort is an instruction, not a fault to retry past.
        if (callOptions?.signal?.aborted) throw cause;
        if (policy === "transient" && canRetry) {
          await sleep(backoffMs(tries));
          continue;
        }
        throw new NetworkError(
          `Could not reach ${baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { tool, cause },
        );
      }

      lastRateLimit = rateLimitFrom(response.headers) ?? lastRateLimit;

      if (response.ok) {
        return (await response.json()) as T;
      }

      const status = response.status;
      const waitSeconds = retryAfterSeconds(response.headers, Date.now());

      if (status === 429 && canRetry) {
        // Waiting less than the server asked for only earns another 429, and
        // waiting much longer looks like a hang — so past the cap, give up and
        // let the caller decide.
        if (waitSeconds === null || waitSeconds <= maxRetryAfter) {
          await sleep(waitSeconds === null ? backoffMs(tries) : waitSeconds * 1000);
          continue;
        }
      }
      if (status >= 500 && policy === "transient" && canRetry) {
        await sleep(waitSeconds === null ? backoffMs(tries) : waitSeconds * 1000);
        continue;
      }

      const failure = await failureFrom(response);
      throw errorForStatus(status, failure.message, {
        code: failure.code,
        next: failure.next,
        requestId: failure.requestId,
        tool,
        rateLimit: rateLimitFrom(response.headers) ?? undefined,
        retryAfterSeconds: waitSeconds,
      });
    }
  }

  async function call<T>(name: string, input?: unknown, callOptions?: CallOptions) {
    // A tool this SDK has never heard of may be a read or a write; it is
    // treated as a write, because guessing wrong the other way repeats a write.
    const meta = (toolMeta as Record<string, { readOnly: boolean } | undefined>)[name];
    const policy: RetryPolicy = meta?.readOnly ? "transient" : "rate-limit-only";
    const envelope = await request<{ data: T }>(
      "POST",
      `/api/v1/tools/${encodeURIComponent(name)}`,
      input ?? {},
      policy,
      name,
      callOptions,
    );
    return envelope.data;
  }

  const tools = Object.fromEntries(
    Object.keys(toolMeta).map((name) => [
      name,
      (input?: unknown, callOptions?: CallOptions) => call(name, input, callOptions),
    ]),
  ) as unknown as ToolMethods;

  return {
    call: call as SeolyticizeClient["call"],
    listTools: (callOptions) =>
      request<Discovery>(
        "GET",
        "/api/v1/tools",
        undefined,
        "transient",
        undefined,
        callOptions,
      ),
    tools,
    get lastRateLimit() {
      return lastRateLimit;
    },
  };
}
