# @hasna/instructions-sdk

Zero-dependency TypeScript client for the `@hasna/instructions` REST API. Works in Node, Bun, Deno, and browser.

## Install

```bash
bun add @hasna/instructions-sdk
```

## Quick Start

```typescript
import { ConfigsClient } from "@hasna/instructions-sdk";

const client = new ConfigsClient({ baseUrl: "http://localhost:3457" });
// Or: reads CONFIGS_URL env var
const client = ConfigsClient.fromEnv?.() ?? new ConfigsClient();

// Get status (drift detection, template count)
const status = await client.getStatus();
console.log(`${status.total} configs, ${status.drifted} drifted`);

// List configs
const rules = await client.listConfigs({ category: "rules" });

// Get a specific config
const claudeMd = await client.getConfig("claude-claude-md");

// Sync from disk
const result = await client.syncKnown({ agent: "claude" });

// Apply a config to disk
await client.applyConfig("claude-claude-md");

// Profiles
const profile = await client.createProfile("my-setup");
await client.applyProfile("my-setup");
const resolved = await client.resolveProfile();
await client.applyAutoProfile({ dryRun: true });

// Snapshots
const snaps = await client.getSnapshots("claude-claude-md");
```

## All Methods (23)

| Method | Description |
|--------|-------------|
| `listConfigs(filter?)` | List configs with optional category/agent/kind/search filter |
| `getConfig(idOrSlug)` | Get full config including content |
| `createConfig(input)` | Create a new config |
| `updateConfig(id, input)` | Update config content/metadata |
| `deleteConfig(id)` | Delete a config |
| `applyConfig(id, dryRun?)` | Write config to its target_path on disk |
| `syncDirectory(dir, direction?, dryRun?)` | Sync a directory with the DB |
| `syncKnown(opts?)` | Sync known config files from disk |
| `getStatus()` | Health check: total, drifted, templates, DB path |
| `getStats()` | Counts by category |
| `listProfiles()` | List all profiles |
| `getProfile(id)` | Get profile with its configs |
| `createProfile(name, desc?, opts?)` | Create a profile with optional selectors/variables |
| `updateProfile(id, input)` | Update profile name/description |
| `deleteProfile(id)` | Delete a profile |
| `applyProfile(id, dryRun?)` | Apply all configs in a profile to disk |
| `resolveProfile(opts?)` | Resolve the matching machine-aware profile |
| `applyAutoProfile(opts?)` | Apply the matching machine-aware profile |
| `listMachines()` | List machines where configs were applied |
| `registerMachine(hostname?, os?, arch?)` | Register a machine |
| `createSnapshot(configId)` | Create a version snapshot |
| `getSnapshots(configId)` | List snapshots for a config |
| `health()` | Health check |

## Environment Variables

- `CONFIGS_URL` — base URL for the configs REST API (default: `http://localhost:3457`)

## Part of the @hasna ecosystem

- [`@hasna/instructions`](https://npm.im/@hasna/instructions) — CLI + MCP + REST server
- [`@hasna/todos`](https://npm.im/@hasna/todos) — task management
- [`@hasna/mementos`](https://npm.im/@hasna/mementos) — persistent memory
- [`@hasna/sessions`](https://npm.im/@hasna/sessions) — session search
- [`@hasna/attachments`](https://npm.im/@hasna/attachments) — file transfer

## License

Apache-2.0
