/**
 * Server-side collection: report page views from the server, for sites that
 * cannot or will not run the tag, and — the reason most sites want it — for
 * the visitors that never run JavaScript at all, AI assistants above all.
 * ChatGPT-User, Claude-User and Perplexity-User fetch a page because somebody
 * asked about it; the browser tag never sees them, the server always does.
 *
 * Framework-agnostic at its core (a standard Request, or a few plain fields),
 * with thin adapters for Express-style middleware and Next.js middleware.
 * Needs the site's server key from issue_server_collect_key: with it the
 * collector may report the visitor's address and user agent rather than its
 * own, which is what makes a server-side visitor count mean anything.
 *
 * What leaves the site is the least the report needs: the path, the campaign
 * tags (other query parameters are stripped here, before sending), the
 * referrer, the visitor's address and user agent — which Seolyticize hashes
 * under a daily salt and never stores — and the country if a proxy said it.
 * Bots are dropped here too, so a crawler's thousand requests are not a
 * thousand calls to Seolyticize.
 *
 * Conversions that happen after the visit — a payment confirmed by a webhook
 * an hour later, a trial that converts next week — are credited to the visit
 * with a visit token: trackForVisit() reports an event for the visitor in
 * front of you and resolves with the token, which you keep on your server
 * with the account or order (never in a cookie or a page), and trackLater()
 * sends the later event with it.
 */
import { SDK_VERSION } from "./version.js";

export const DEFAULT_COLLECT_URL = "https://seolyticize.com/api/collect";

/** The query parameters kept by default: the campaign tags, which say where a visit came from. */
export const DEFAULT_ALLOWED_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
];

export type CollectorOptions = {
  /** The site key from set_up_web_analytics. */
  siteKey: string;
  /** The server key from issue_server_collect_key. Keep it out of client bundles. */
  serverKey: string;
  /** Another deployment's collect endpoint. */
  endpoint?: string;
  /** Paths never reported, "*" matching anything: ["/admin/*", "/api/*"]. */
  exclude?: string[];
  /** When given, only these paths are reported. */
  include?: string[];
  /** Query parameters to keep; everything else is stripped before sending. */
  allowParams?: string[];
  /**
   * "all" reports every page view; "agents" only AI assistants' (custom events
   * are always sent). Use "agents" when the browser tag is also installed, or
   * every person is counted twice.
   */
  only?: "all" | "agents";
  /** How long a report may take before it is abandoned. Never delays the page. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Called with a failed report; by default failures are silent. */
  onError?: (error: unknown) => void;
  /** Names the package sending, as get_web_analytics_setup's clients list shows it. Default "sdk/<version>". */
  client?: string;
};

export type PageView = {
  /** The full URL of the page served. */
  url: string;
  referrer?: string | null | undefined;
  userAgent?: string | null | undefined;
  /** The visitor's address as your proxy reported it. */
  ip?: string | null | undefined;
  /** ISO 3166-1 alpha-2, e.g. from Cloudflare's cf-ipcountry. */
  country?: string | null | undefined;
  /** Sec-CH-UA, if the browser sent it. */
  clientHints?: string | null | undefined;
  /** The Signature-Agent header, which signing agents such as ChatGPT's send. */
  signatureAgent?: string | null | undefined;
  /** "pageview" (the default) or a custom event's name. */
  name?: string | undefined;
  props?: Record<string, string | number | boolean> | undefined;
  /** Your hashed id for a signed-in user (hashUserId), sent only with their consent. */
  uid?: string | undefined;
};

/*
 * An event with neither the visitor's address and user agent nor a visit
 * token cannot be joined to any visit: it is stored, counted as unattributed.
 * Said once per process, since the sender usually means to attribute it.
 */
let warnedNoContext = false;
function warnNoContext(name: string) {
  if (warnedNoContext) return;
  warnedNoContext = true;
  console.warn(
    `[seolyticize] "${name}" was sent with no ip, userAgent or visit token, so it cannot be credited to a visit and counts as unattributed. Pass the visitor's ip and userAgent, or a visit token (trackLater). Said once per process.`,
  );
}

/** Why a 202 stored the event joined to no visit ("credited": "none"), or null. */
async function unattributed(response: Response): Promise<string | null> {
  if (!response.headers.get("content-type")?.includes("json")) return null;
  const answer = (await response
    .clone()
    .json()
    .catch(() => null)) as { credited?: unknown; unattributed?: unknown } | null;
  if (answer?.credited !== "none") return null;
  return typeof answer.unattributed === "string" ? answer.unattributed : "unattributed";
}

const notCredited = (name: string, why: string) =>
  new Error(`Seolyticize stored "${name}" as unattributed (${why}): it joined no visit.`);

/*
 * The AI assistants that read pages on somebody's behalf. Kept in step with
 * packages/logs on the server, which decides how each is reported.
 */
const AGENT_PATTERN = /chatgpt-user|claude-user|perplexity-user|mistralai-user/i;

/*
 * Automated clients, dropped before anything is sent. The same families the
 * server drops, so filtering here only saves the request; the server would
 * have refused them anyway.
 */
const BOT_PATTERN = new RegExp(
  [
    "bot\\b",
    "crawl",
    "spider",
    "slurp",
    "mediapartners",
    "facebookexternalhit",
    "embedly",
    "whatsapp",
    "headless",
    "phantomjs",
    "selenium",
    "webdriver",
    "puppeteer",
    "playwright",
    "lighthouse",
    "pagespeed",
    "gtmetrix",
    "pingdom",
    "uptime",
    "monitor",
    "preview",
    "prerender",
    "curl/",
    "wget/",
    "httpie",
    "python-requests",
    "python-urllib",
    "aiohttp",
    "httpx",
    "go-http-client",
    "java/",
    "okhttp",
    "apache-httpclient",
    "node-fetch",
    "undici",
    "axios/",
    "libwww",
    "scrapy",
    "feedfetcher",
  ].join("|"),
  "i",
);

/** What a request's user agent says it is: a person, an AI assistant, or a bot. */
export function classifyAgent(
  userAgent: string,
  signatureAgent?: string | null,
): "person" | "agent" | "bot" {
  if (signatureAgent && /chatgpt\.com/i.test(signatureAgent)) return "agent";
  if (AGENT_PATTERN.test(userAgent)) return "agent";
  if (userAgent.length < 20) return "bot";
  if (BOT_PATTERN.test(userAgent.replace(/cubot/gi, ""))) return "bot";
  return "person";
}

function pattern(patterns: string[] | undefined): RegExp | null {
  const parts = (patterns ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  return parts.length > 0 ? new RegExp(`^(?:${parts.join("|")})$`) : null;
}

/** The path as the server stores it: no trailing slash except the root. */
function bare(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The URL with only the allowed query parameters and no fragment. */
export function stripQuery(
  url: string,
  allowed: string[] = DEFAULT_ALLOWED_PARAMS,
): string {
  const parsed = new URL(url);
  const keep = new Set(allowed.map((name) => name.toLowerCase()));
  // Copied first: deleting from the params while iterating them skips keys.
  const names = Array.from(parsed.searchParams.keys());
  for (const name of names) {
    if (!keep.has(name.toLowerCase())) parsed.searchParams.delete(name);
  }
  parsed.hash = "";
  return parsed.toString();
}

/** The referrer's origin only: the rest of a referring URL can carry anything. */
function referrerOrigin(referrer: string | null | undefined): string | undefined {
  if (!referrer) return undefined;
  try {
    const parsed = new URL(referrer);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}/` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The visitor's address from the usual proxy headers: Cloudflare's, then
 * X-Real-IP, then the first X-Forwarded-For entry — the client end, as your
 * own proxy wrote it. Pass `ip` yourself when your proxy says it another way.
 */
export function addressFrom(headers: Headers): string | undefined {
  const direct = headers.get("cf-connecting-ip") ?? headers.get("x-real-ip");
  if (direct) return direct.trim();
  const forwarded = headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0]?.trim() || undefined : undefined;
}

/**
 * Whether a request is somebody opening a page, rather than an asset, an API
 * call or a prefetch. Only GET and HEAD, only HTML, and never a speculative
 * fetch the visitor did not ask for.
 */
export function isPageRequest(method: string, headers: Headers): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const purpose = `${headers.get("purpose") ?? ""} ${headers.get("sec-purpose") ?? ""}`;
  if (/prefetch|prerender/i.test(purpose)) return false;
  if (headers.get("next-router-prefetch")) return false;
  const dest = headers.get("sec-fetch-dest");
  if (dest && dest !== "document") return false;
  const accept = headers.get("accept") ?? "";
  // Agents often send */* or nothing; a person's browser always asks for HTML.
  return accept === "" || /text\/html|\*\/\*/.test(accept);
}

/** An event that happened after the visit, credited to it by its token. */
export type LaterEvent = {
  /** The token trackForVisit() resolved with. */
  visit: string;
  /** The event's name, as a goal matches it: "Top-up", "Trial converted". */
  name: string;
  /** Its properties; `value`, in major units (42 for 42.00, in the site's currency), is what a goal without a fixed worth sums. */
  props?: Record<string, string | number | boolean> | undefined;
  /** The page it happened on, if it happened on one. */
  url?: string | undefined;
  /** Your hashed id for the signed-in user (hashUserId), sent only with their consent. */
  uid?: string | undefined;
};

/** What became of one report; dropped is the collector's reason (X-Seolyticize-Dropped). */
export type TrackResult = {
  accepted: boolean;
  dropped?: string;
  /** Stored, but joined to no visit: "no_visitor_context" or "no_recent_visit". */
  unattributed?: string;
};

export type Collector = {
  /** Reports one page view (or event). Resolves when sent, never rejects. */
  track(view: PageView): Promise<TrackResult>;
  /**
   * Reports an event for the visitor in front of you — a sign-up, a checkout
   * started — whatever `only` says, and resolves with that visit's token, or
   * null when none was issued (a bot, an agent, an excluded path, a failure).
   * Keep the token server-side with the account or order.
   */
  trackForVisit(view: PageView & { name: string }): Promise<string | null>;
  /**
   * Reports an event that happened after the visit, credited to that visit's
   * landing page and source. Resolves true when it was credited; never
   * rejects (onError hears why it was not).
   */
  trackLater(event: LaterEvent): Promise<boolean>;
  /** Reports a standard Request, if it is a page view worth reporting. */
  trackRequest(request: Request): Promise<void>;
  /** Whether a path would be reported under the include and exclude lists. */
  reports(path: string): boolean;
};

export function createCollector(options: CollectorOptions): Collector {
  const endpoint = options.endpoint ?? DEFAULT_COLLECT_URL;
  const exclude = pattern(options.exclude);
  const include = pattern(options.include);
  const allowed = options.allowParams ?? DEFAULT_ALLOWED_PARAMS;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;

  const reports = (path: string) => {
    const value = bare(path);
    if (exclude?.test(value)) return false;
    return !include || include.test(value);
  };

  /** What is sent for a view, or null when nothing should be. */
  function bodyFor(view: PageView, everyone: boolean): Record<string, unknown> | null {
    const page = new URL(view.url);
    if (!reports(page.pathname)) return null;
    // No user agent given: the site's own server reporting an event, not a bot.
    const kind =
      view.userAgent === undefined || view.userAgent === ""
        ? "person"
        : classifyAgent(view.userAgent ?? "", view.signatureAgent);
    if (kind === "bot") return null;
    // "agents" is about page views; a server's own event (a purchase) always goes.
    const pageview = (view.name ?? "pageview") === "pageview";
    if (!everyone && pageview && options.only === "agents" && kind !== "agent")
      return null;
    if (!view.ip && !view.userAgent) warnNoContext(view.name ?? "pageview");

    const body: Record<string, unknown> = {
      k: options.siteKey,
      n: view.name ?? "pageview",
      u: stripQuery(view.url, allowed),
      ua: (view.userAgent ?? "").slice(0, 1024),
    };
    const referrer = referrerOrigin(view.referrer);
    if (referrer) body.r = referrer;
    if (view.ip) body.ip = view.ip.slice(0, 64);
    if (view.country) body.c = view.country.slice(0, 2);
    if (view.clientHints) body.h = view.clientHints.slice(0, 512);
    if (view.signatureAgent) body.sa = view.signatureAgent.slice(0, 256);
    if (view.props && Object.keys(view.props).length > 0) body.p = view.props;
    if (view.uid) body.uid = view.uid;
    return body;
  }

  /** Posts a body with the server key; the answer, or a thrown refusal. */
  async function send(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.serverKey}`,
          "x-seolyticize-client": options.client ?? `sdk/${SDK_VERSION}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 401) {
        throw new Error("Seolyticize refused the server key. Issue a new one.");
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Why an answer other than 202 came back, for onError. */
  const refused = (status: number) =>
    new Error(
      status === 404
        ? `Seolyticize has no site with the key ${options.siteKey}.`
        : `Seolyticize answered HTTP ${status}.`,
    );

  async function track(view: PageView): Promise<TrackResult> {
    try {
      const body = bodyFor(view, false);
      if (!body) return { accepted: false, dropped: "not_reported" };
      const response = await send(body);
      const dropped = response.headers.get("x-seolyticize-dropped");
      if (dropped) {
        // The visitor's choice or the site's own settings are not faults.
        if (!/^(gpc|excluded_|outside_)/.test(dropped)) {
          options.onError?.(new Error(`Seolyticize dropped the event: ${dropped}.`));
        }
        return { accepted: false, dropped };
      }
      if (response.status === 202) {
        const why = view.name ? await unattributed(response) : null;
        if (!why) return { accepted: true };
        options.onError?.(notCredited(view.name!, why));
        return { accepted: true, unattributed: why };
      }
      options.onError?.(refused(response.status));
      return { accepted: false };
    } catch (error) {
      options.onError?.(error);
      return { accepted: false };
    }
  }

  async function trackForVisit(
    view: PageView & { name: string },
  ): Promise<string | null> {
    try {
      const body = bodyFor(view, true);
      if (!body) return null;
      const response = await send(body);
      if (response.status !== 202) {
        options.onError?.(refused(response.status));
        return null;
      }
      const why = await unattributed(response);
      if (why) options.onError?.(notCredited(view.name, why));
      const answer = (await response.json().catch(() => null)) as {
        visit?: unknown;
      } | null;
      return typeof answer?.visit === "string" ? answer.visit : null;
    } catch (error) {
      options.onError?.(error);
      return null;
    }
  }

  async function trackLater(event: LaterEvent): Promise<boolean> {
    try {
      const body: Record<string, unknown> = {
        k: options.siteKey,
        n: event.name,
        visit: event.visit,
      };
      if (event.url) body.u = stripQuery(event.url, allowed);
      if (event.props && Object.keys(event.props).length > 0) body.p = event.props;
      if (event.uid) body.uid = event.uid;
      const response = await send(body);
      if (response.status === 202) return true;
      // 410: the token outlived its 35 days; 404: its visit was not found;
      // 400: not a token for this site.
      throw new Error(`Seolyticize did not credit the event (HTTP ${response.status}).`);
    } catch (error) {
      options.onError?.(error);
      return false;
    }
  }

  return {
    track,
    trackForVisit,
    trackLater,
    reports,
    async trackRequest(request) {
      if (!isPageRequest(request.method, request.headers)) return;
      await track(visitorOf(request));
    },
  };
}

/** The visitor behind a standard Request: its page, address, user agent and the rest. */
export function visitorOf(request: Request): PageView {
  return {
    url: request.url,
    referrer: request.headers.get("referer"),
    // An empty header is still a request with no browser named, not a server event.
    userAgent: request.headers.get("user-agent") || null,
    ip: addressFrom(request.headers),
    country: request.headers.get("cf-ipcountry"),
    clientHints: request.headers.get("sec-ch-ua"),
    signatureAgent: request.headers.get("signature-agent"),
  };
}

/** The parts of an Express (or Connect, or Node http) request this reads. */
type NodeRequest = {
  method?: string | undefined;
  originalUrl?: string | undefined;
  url?: string | undefined;
  protocol?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | undefined;
  ip?: string | undefined;
};
type NodeResponse = {
  statusCode: number;
  on(event: "finish", listener: () => void): unknown;
};

const header = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.join(", ") : (value ?? null);

/**
 * Express, Connect or plain Node http middleware. Reports after the response
 * is sent, and only a successful page: a 404 or a redirect is not a page view.
 *
 *   app.use(expressCollector(createCollector({ siteKey, serverKey })));
 */
export function expressCollector(
  collector: Collector,
  options: { trustProxy?: boolean } = {},
): (req: NodeRequest, res: NodeResponse, next: () => void) => void {
  return (req, res, next) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      const joined = header(value);
      if (joined !== null) headers.set(name, joined);
    }
    if (isPageRequest(req.method ?? "GET", headers)) {
      res.on("finish", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        const host =
          headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost";
        const scheme =
          req.protocol ?? headers.get("x-forwarded-proto")?.split(",")[0] ?? "https";
        void collector.track({
          url: `${scheme}://${host.split(",")[0]!.trim()}${req.originalUrl ?? req.url ?? "/"}`,
          referrer: headers.get("referer"),
          userAgent: headers.get("user-agent") || null,
          ip:
            (options.trustProxy === false ? undefined : addressFrom(headers)) ??
            req.ip ??
            req.socket?.remoteAddress,
          country: headers.get("cf-ipcountry"),
          clientHints: headers.get("sec-ch-ua"),
          signatureAgent: headers.get("signature-agent"),
        });
      });
    }
    next();
  };
}

/**
 * Next.js middleware (middleware.ts), or any edge function with waitUntil.
 * The report is handed to waitUntil so the page is never held up for it.
 *
 *   const collector = createCollector({ siteKey, serverKey: process.env.SEOLYTICIZE_SERVER_COLLECT_KEY!, only: "agents" });
 *   export function middleware(request: NextRequest, event: NextFetchEvent) {
 *     collectInMiddleware(collector, request, event);
 *   }
 */
export function collectInMiddleware(
  collector: Collector,
  request: Request,
  event?: { waitUntil(promise: Promise<unknown>): void },
): void {
  const pending = collector.trackRequest(request);
  if (event) event.waitUntil(pending);
}
