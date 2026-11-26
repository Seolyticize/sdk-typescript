export { createClient, DEFAULT_BASE_URL, SDK_VERSION } from "./client.js";
export type {
  ClientOptions,
  CallOptions,
  ResponseMeta,
  Outcome,
  CallResult,
  FetchLike,
  SeolyticizeClient,
} from "./client.js";
export {
  SeolyticizeError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  ValidationError,
  RefusedError,
  RateLimitError,
  ServerError,
  NetworkError,
} from "./errors.js";
export type { RateLimitInfo, SeolyticizeErrorOptions } from "./errors.js";
export { toolMeta } from "./generated.js";
export type { ToolInputs, ToolName, ToolMethods } from "./generated.js";
export type { Caller, Discovery, ToolDescriptor, ToolMeta } from "./types.js";
export {
  createCollector,
  expressCollector,
  collectInMiddleware,
  classifyAgent,
  stripQuery,
  addressFrom,
  isPageRequest,
  visitorOf,
  privacySignalsFrom,
  DEFAULT_COLLECT_URL,
  DEFAULT_ALLOWED_PARAMS,
} from "./collector.js";
export {
  VISIT_HEADER,
  VISIT_METADATA_KEY,
  checkoutMetadata,
  hashUserId,
  majorUnits,
  recordStripeEvent,
  reportSignup,
  stripePurchase,
} from "./attribution.js";
export type { StripeEventLike, StripePurchase } from "./attribution.js";
export type {
  Collector,
  CollectorOptions,
  PageView,
  LaterEvent,
  RequestLike,
  TrackResult,
} from "./collector.js";
