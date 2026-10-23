/**
 * The shapes the API publishes, restated here rather than imported.
 *
 * The SDK ships with no dependencies, so it cannot reach into the server's
 * packages for these. They are small and stable, and the generated-file test
 * fails the moment the catalogue grows a tool this package has not seen.
 */

/** One tool as discovery describes it. */
export type ToolDescriptor = {
  name: string;
  title: string;
  description: string;
  /** The permission the server checks, e.g. "data:read" or "client:manage". */
  permission: string;
  /** Whether the tool addresses one client, named by `clientId` in its input. */
  clientScoped: boolean;
  /** True when the tool only reads, so it is safe to retry and to run unprompted. */
  readOnly: boolean;
  /** The REST path that invokes it, relative to the API origin. */
  path: string;
  /** JSON Schema (draft 2020-12) for the input. */
  inputSchema: Record<string, unknown>;
};

/** Who the presented key is, as far as the API will say. */
export type Caller = {
  role: string;
  /** "all" for an agency-wide key; the one client a client-scoped key may reach. */
  clientIds: "all" | string[];
};

/** GET /api/v1/tools: the catalogue as this key sees it. */
export type Discovery = {
  tools: ToolDescriptor[];
  caller: Caller;
};

/** What the generator records about each tool for the client's own decisions. */
export type ToolMeta = {
  permission: string;
  clientScoped: boolean;
  readOnly: boolean;
};
