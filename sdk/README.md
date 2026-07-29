# @hasna/instructions-sdk

Zero-dependency TypeScript clients for Instructions HTTP services. The package
works anywhere a standards-compatible `fetch` implementation is available.

## Install

```bash
bun add @hasna/instructions-sdk
```

## Supported `/v1` client

`InstructionsV1Client` is generated from `src/server/openapi.ts` and calls the
authenticated `/v1` API exposed by `instructions-serve`.

```typescript
import {
  InstructionsV1Client,
  InstructionsV1ApiError,
} from "@hasna/instructions-sdk";

const client = new InstructionsV1Client({
  baseUrl: "https://instructions.example.com",
  apiKey: process.env.HASNA_INSTRUCTIONS_API_KEY,
});

const { configs = [] } = await client.listConfigs({ category: "rules" });
const { config } = await client.getConfig(configs[0]!.slug!);

try {
  await client.updateConfig(config!.id!, { description: "Canonical rules" });
} catch (error) {
  if (error instanceof InstructionsV1ApiError) {
    console.error(error.status, error.body);
  }
}
```

The API key is sent as `x-api-key`. You can provide a custom `fetch` and extra
headers:

```typescript
const client = new InstructionsV1Client({
  baseUrl: "http://localhost:3457",
  apiKey: "...",
  fetch: globalThis.fetch,
  headers: { "x-request-source": "automation" },
});
```

The generated client currently exposes the operations present in the served
OpenAPI document:

| Method | HTTP operation |
| --- | --- |
| `listConfigs(query?, init?)` | `GET /v1/configs` |
| `createConfig(body, init?)` | `POST /v1/configs` |
| `getConfig(id, init?)` | `GET /v1/configs/:id` |
| `updateConfig(id, body, init?)` | `PATCH /v1/configs/:id` |
| `deleteConfig(id, init?)` | `DELETE /v1/configs/:id` |
| `listSnapshots(id, init?)` | `GET /v1/configs/:id/snapshots` |
| `createSnapshot(id, init?)` | `POST /v1/configs/:id/snapshots` |
| `listProfiles(init?)` | `GET /v1/profiles` |
| `createProfile(body, init?)` | `POST /v1/profiles` |
| `getProfile(id, init?)` | `GET /v1/profiles/:id` |
| `deleteProfile(id, init?)` | `DELETE /v1/profiles/:id` |
| `getStats(init?)` | `GET /v1/stats` |

Responses retain the server envelopes, for example `{ config }` or
`{ configs, count }`. IDs are URL-encoded by the client. Non-2xx responses
throw `InstructionsV1ApiError` with `status` and parsed `body` fields.

The runtime server has additional routes that are not yet in the OpenAPI
document or generated client. See the repository's [HTTP API
reference](../docs/http-api.md) and use direct HTTP for those operations.

## Legacy `ConfigsClient`

The package still exports `ConfigsClient` as a compatibility client for the
former local `/api` service. It targets routes such as `/api/configs`,
`/api/sync`, and `/api/profiles`.

Current `instructions-serve` does **not** mount `/api`, so do not use
`ConfigsClient` with it. `ConfigsClient` also has no `fromEnv()` helper and does
not read `CONFIGS_URL`; pass `baseUrl` explicitly when using a separate legacy
server.

## Regeneration

From the repository root:

```bash
bun run generate:sdk
```

This rebuilds `sdk/src/v1.generated.ts` from the same OpenAPI document served
at `/openapi.json`. Do not edit the generated file by hand.

## License

Apache-2.0
