/**
 * Server-side conversions credited to the visit they came from, without the
 * product carrying a token around by hand: a sign-up reported from the
 * request that made it, and a Stripe Checkout purchase joined to its visit
 * through the session's metadata.
 */
import {
  headersOf,
  visitorOf,
  type Collector,
  type RequestLike,
  type TrackResult,
} from "./collector.js";

/** The Checkout metadata key the visit token travels in (also what connect_external_events reads). */
export const VISIT_METADATA_KEY = "seolyticize_visit";

/** The header a page may send its seolyticize("visit") token in, with a sign-up or checkout POST. */
export const VISIT_HEADER = "x-seolyticize-visit";

/**
 * A user id as /api/collect's uid takes it: the SHA-256 hex of
 * "<siteKey>:<userId>", so the raw id never leaves the server and forget_user
 * can be called with the same hash later.
 */
export async function hashUserId(siteKey: string, userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${siteKey}:${userId}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** amountMinor in major units, by the currency's own minor-unit digits (JPY 0, USD 2, KWD 3). */
export function majorUnits(amountMinor: number, currency: string): number {
  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits;
  return amountMinor / 10 ** (digits ?? 2);
}

/**
 * The visitor behind a POST from a page: the page is the Referer (same-origin
 * POSTs send it whole), not the API route, which a site often excludes.
 */
function fromPage(request: RequestLike) {
  const visitor = visitorOf(request);
  return { ...visitor, url: visitor.referrer || request.url, referrer: null };
}

/**
 * Reports a sign-up for the visitor making this request and resolves with
 * its visit token (null when none could be had). With the page's own token in
 * X-Seolyticize-Visit it is credited to that visit; otherwise it joins the
 * visitor's recent visit by address and user agent. Any server's request
 * will do, not only a web Request: `{ url, headers, ip }` (RequestLike).
 * Never rejects.
 *
 *   // Fastify
 *   await reportSignup(collector, { url: `https://${req.hostname}${req.url}`, headers: req.headers, ip: req.ip });
 */
export async function reportSignup(
  collector: Collector,
  request: RequestLike,
  options: {
    uid?: string | undefined;
    props?: Record<string, string | number | boolean> | undefined;
    name?: string | undefined;
  } = {},
): Promise<string | null> {
  const name = options.name ?? "Signup";
  const visit = headersOf(request.headers).get(VISIT_HEADER);
  const page = fromPage(request);
  if (visit) {
    const credited = await collector.trackLater({
      visit,
      name,
      props: options.props,
      uid: options.uid,
      url: page.url,
    });
    if (credited) return visit;
  }
  return collector.trackForVisit({
    ...page,
    name,
    props: options.props,
    uid: options.uid,
  });
}

/**
 * { seolyticize_visit: "<token>" } for this visitor, to spread into Stripe
 * Checkout's metadata; {} when no token could be had. Without the page's token
 * in X-Seolyticize-Visit it reports a "Checkout" event for the visitor, whose
 * answer carries the token.
 */
export async function checkoutMetadata(
  collector: Collector,
  request: RequestLike,
): Promise<Record<string, string>> {
  const visit =
    headersOf(request.headers).get(VISIT_HEADER) ||
    (await collector.trackForVisit({ ...fromPage(request), name: "Checkout" }));
  return visit ? { [VISIT_METADATA_KEY]: visit } : {};
}

/** The parts of a Stripe event this reads (Stripe.Event fits). */
export type StripeEventLike = {
  type: string;
  data: { object: unknown };
};

/** A paid Checkout session as a purchase: amount in minor units, as Stripe gives it. */
export type StripePurchase = {
  orderId: string;
  amountMinor: number;
  currency: string;
  visit: string | null;
  url: string | null;
};

/**
 * The purchase a checkout.session.completed (paid) or
 * checkout.session.async_payment_succeeded event records, or null for any
 * other event, an unpaid session, or one without an amount.
 */
export function stripePurchase(event: StripeEventLike): StripePurchase | null {
  const session = event.data?.object as {
    id?: unknown;
    amount_total?: unknown;
    currency?: unknown;
    payment_status?: unknown;
    metadata?: Record<string, unknown> | null;
    success_url?: unknown;
    return_url?: unknown;
  } | null;
  const paid =
    (event.type === "checkout.session.completed" &&
      session?.payment_status !== "unpaid") ||
    event.type === "checkout.session.async_payment_succeeded";
  if (!paid || !session) return null;
  if (typeof session.id !== "string" || typeof session.amount_total !== "number")
    return null;
  if (typeof session.currency !== "string") return null;
  const visit = session.metadata?.[VISIT_METADATA_KEY];
  const url = [session.success_url, session.return_url].find(
    (value): value is string => typeof value === "string" && /^https?:\/\//.test(value),
  );
  return {
    orderId: session.id,
    amountMinor: session.amount_total,
    currency: session.currency.toUpperCase(),
    visit: typeof visit === "string" && visit ? visit : null,
    url: url ?? null,
  };
}

/**
 * Records a paid Checkout session as a Purchase: credited to the visit in its
 * metadata, deduplicated by the session id as orderId. When the token is
 * missing or no longer credits (expired, visit not found), the purchase is
 * still sent, unattributed, so revenue is never lost. Resolves null for an
 * event that records nothing; never rejects.
 */
export async function recordStripeEvent(
  collector: Collector,
  event: StripeEventLike,
): Promise<TrackResult | null> {
  const purchase = stripePurchase(event);
  if (!purchase) return null;
  let value: number;
  try {
    value = majorUnits(purchase.amountMinor, purchase.currency);
  } catch {
    // An unknown currency code: Intl throws a RangeError.
    return { accepted: false, dropped: "unknown_currency" };
  }
  const props = { orderId: purchase.orderId, currency: purchase.currency, value };
  if (
    purchase.visit &&
    (await collector.trackLater({ visit: purchase.visit, name: "Purchase", props }))
  ) {
    return { accepted: true };
  }
  if (!purchase.url) return { accepted: false, dropped: "no_url" };
  return collector.track({ url: purchase.url, name: "Purchase", props });
}
