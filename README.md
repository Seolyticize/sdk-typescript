# @seolyticize/sdk

A typed TypeScript client for the Seolyticize API. Every tool the platform exposes is a
method, and the types come straight from the registry that validates the calls — so the
SDK cannot describe a tool differently from how the server runs it.

No runtime dependencies: it needs `fetch`, which Node 18+, Deno, Bun and browsers all
have.

## Install

```sh
npm install github:Seolyticize/sdk-typescript
# or: pnpm add github:Seolyticize/sdk-typescript · yarn add github:Seolyticize/sdk-typescript
```

It builds on install. Python: [sdk-python](https://github.com/Seolyticize/sdk-python) · Go: [sdk-go](https://github.com/Seolyticize/sdk-go)

## Get a key

Create one in the app under **Settings → API keys**, or with the `create_api_key` tool
from an existing admin key. A key is either agency-wide or pinned to one client, and
carries a role that decides which tools it may call — a read-only key cannot run a tool
that writes, spends or sends. The secret is shown once; store it somewhere safe.

## Quick start

```ts
import { createClient } from "@seolyticize/sdk";

const seo = createClient({ apiKey: process.env.SEOLYTICIZE_API_KEY! });

// Typed: the input is checked against the tool's schema at compile time.
const { clients } = await seo.tools.list_clients<{
  clients: Array<{ id: string; name: string }>;
}>();

const summary = await seo.tools.get_rank_summary({
  clientId: clients[0]!.id,
  trackerId: "tracker_123",
});
```

Results are typed `unknown` unless you pass a type argument: the API publishes input
schemas, not output schemas, and a guessed output type would be a promise nothing keeps.

### Tools newer than your SDK

Tools are added to the platform continuously. Call one this SDK version has never heard of
by name:

```ts
const result = await seo.call("some_new_tool", { clientId: "client_1" });
```

### What may this key do?

```ts
const { caller, tools } = await seo.listTools();
// caller.role, caller.clientIds ("all" or the one client), and every tool the key
// may call with its JSON Schema.
```

## Options

```ts
createClient({
  apiKey: "sk_seo_…",
  baseUrl: "https://seolyticize.com", // the default
  maxRetries: 2, // retries after the first attempt
  timeoutMs: 30_000, // per attempt
  maxRetryAfterSeconds: 60, // longest Retry-After the client will wait through
  fetch: customFetch, // optional
});
```

Pass `{ signal }` as the last argument of any call to cancel it.

## Errors

Every failure is a `SeolyticizeError` with `status`, `tool` and the server's own sentence
as `message`. Branch on the subclass:

| Class                 | Status | Meaning                                                         |
| --------------------- | ------ | --------------------------------------------------------------- |
| `ValidationError`     | 400    | Input did not match the tool's schema; the message names fields |
| `AuthenticationError` | 401    | Missing, unknown or revoked key                                 |
| `PermissionError`     | 403    | The key's role or client scope does not allow this              |
| `NotFoundError`       | 404    | No tool by that name                                            |
| `RefusedError`        | 422    | Well-formed, but declined — duplicate name, plan limit, …       |
| `RateLimitError`      | 429    | Window used up; `retryAfterSeconds` says how long to wait       |
| `ServerError`         | 5xx    | Could not be completed; the server never says why               |
| `NetworkError`        | —      | No response at all (DNS, TLS, timeout)                          |

```ts
import { RefusedError, RateLimitError } from "@seolyticize/sdk";

try {
  await seo.call("create_client", { name: "Acme", domain: "acme.com" });
} catch (error) {
  if (error instanceof RefusedError) console.log("Declined:", error.message);
  else if (error instanceof RateLimitError) console.log("Wait", error.retryAfterSeconds);
  else throw error;
}
```

## Retries

- **429** is always retried, waiting as long as `Retry-After` asks (up to
  `maxRetryAfterSeconds`; a longer wait throws `RateLimitError` immediately). Nothing ran,
  so repeating is safe.
- **5xx and network failures** are retried with exponential backoff and jitter **only for
  read-only tools**. A write that failed with a 500 may already have happened — repeating
  `create_client` could create two clients — so writes surface the error instead. A tool
  the SDK has never heard of is treated as a write.
- 400, 401, 403, 404 and 422 are never retried; they would fail the same way.

`client.lastRateLimit` holds the `X-RateLimit-*` headers from the latest response.
