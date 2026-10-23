/**
 * What the API said when it said no, as classes a caller can branch on.
 *
 * One class per thing a caller would do differently: fix the key, ask for a
 * different role, fix the input, take the refusal to a person, wait, or try
 * again later. A single error with a status number would push every caller
 * into re-deriving that table, and most would get 422 and 400 the wrong way
 * round.
 */
export type RateLimitInfo = {
  limit: number | null;
  remaining: number | null;
  /** Seconds until the window resets. */
  resetSeconds: number | null;
};

export type SeolyticizeErrorOptions = {
  /** HTTP status, or null when no response arrived at all. */
  status: number | null;
  /** The tool being called, when the request was a tool call. */
  tool?: string | undefined;
  rateLimit?: RateLimitInfo | undefined;
  /** The server's stable reason, e.g. "search_console_no_access". Branch on this. */
  code?: string | undefined;
  /** The call or step that fixes it, when the server named one. */
  next?: string | undefined;
  /** Quote this when asking for help: it matches the server's log line. */
  requestId?: string | undefined;
  cause?: unknown;
};

export class SeolyticizeError extends Error {
  readonly status: number | null;
  readonly tool: string | undefined;
  readonly rateLimit: RateLimitInfo | undefined;
  readonly code: string | undefined;
  readonly next: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, options: SeolyticizeErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SeolyticizeError";
    this.status = options.status;
    this.tool = options.tool;
    this.rateLimit = options.rateLimit;
    this.code = options.code;
    this.next = options.next;
    this.requestId = options.requestId;
  }
}

/** 401: no key, or one that is unknown or revoked. The server does not say which. */
export class AuthenticationError extends SeolyticizeError {
  constructor(message: string, options: SeolyticizeErrorOptions) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

/** 403: the key's role may not run this tool, or the key may not reach this client. */
export class PermissionError extends SeolyticizeError {
  constructor(message: string, options: SeolyticizeErrorOptions) {
    super(message, options);
    this.name = "PermissionError";
  }
}

/** 404: no tool by that name — usually a typo, or a client older than the tool. */
export class NotFoundError extends SeolyticizeError {
  constructor(message: string, options: SeolyticizeErrorOptions) {
    super(message, options);
    this.name = "NotFoundError";
  }
}

/** 400: the body did not match the tool's input schema. The message names the field. */
export class ValidationError extends SeolyticizeError {
  constructor(message: string, options: SeolyticizeErrorOptions) {
    super(message, options);
    this.name = "ValidationError";
  }
}

/**
 * 422: a well-formed request the product declined — a duplicate name, a plan
 * limit, nothing configured to run. Retrying the same call will be refused the
 * same way; the message says what has to change.
 */
export class RefusedError extends SeolyticizeError {
  constructor(message: string, options: SeolyticizeErrorOptions) {
    super(message, options);
    this.name = "RefusedError";
  }
}

/** 429: this key has used its window. Thrown once retries are exhausted. */
export class RateLimitError extends SeolyticizeError {
  /** What the server asked for, in seconds, or null when it did not say. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: SeolyticizeErrorOptions & { retryAfterSeconds: number | null },
  ) {
    super(message, options);
    this.name = "RateLimitError";
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** 5xx: the request could not be completed. The server never says why, by design. */
export class ServerError extends SeolyticizeError {
  constructor(message: string, options: SeolyticizeErrorOptions) {
    super(message, options);
    this.name = "ServerError";
  }
}

/**
 * No response: DNS, TLS, a dropped connection or our own timeout. For a write
 * this is the uncomfortable case — the server may have done the work — which is
 * why writes are not retried on it.
 */
export class NetworkError extends SeolyticizeError {
  constructor(message: string, options: Omit<SeolyticizeErrorOptions, "status">) {
    super(message, { ...options, status: null });
    this.name = "NetworkError";
  }
}

/** Builds the error a response with this status should become. */
export function errorForStatus(
  status: number,
  message: string,
  options: Omit<SeolyticizeErrorOptions, "status"> & {
    retryAfterSeconds?: number | null;
  },
): SeolyticizeError {
  const base = { ...options, status };
  if (status === 400) return new ValidationError(message, base);
  if (status === 401) return new AuthenticationError(message, base);
  if (status === 403) return new PermissionError(message, base);
  if (status === 404) return new NotFoundError(message, base);
  if (status === 422) return new RefusedError(message, base);
  if (status === 429) {
    return new RateLimitError(message, {
      ...base,
      retryAfterSeconds: options.retryAfterSeconds ?? null,
    });
  }
  if (status >= 500) return new ServerError(message, base);
  return new SeolyticizeError(message, base);
}
