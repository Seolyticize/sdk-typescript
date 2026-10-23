export { createClient, DEFAULT_BASE_URL, SDK_VERSION } from "./client.js";
export type {
  ClientOptions,
  CallOptions,
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
