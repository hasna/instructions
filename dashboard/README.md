# Instructions dashboard (legacy API client)

This directory contains a React/Vite dashboard with pages for configs,
profiles, apply/sync, snapshots, and machines. Its checked-in API client uses
the former unauthenticated local `/api/*` routes at
`http://localhost:3457`.

Current `instructions-serve` exposes authenticated `/v1/*` and deliberately
does not mount `/api/*`. As a result, this dashboard is not operational against
the current server until its client, response shapes, and authentication are
migrated to `/v1`. The server may still serve `dashboard/dist` as static files
when a build is present; serving the assets does not restore the old API.

## Source layout

- `src/api.ts` — fixed-base legacy `/api` client.
- `src/pages/ConfigsPage.tsx` — search, inspect, and edit config content.
- `src/pages/ProfilesPage.tsx` — create, inspect, preview, and apply profiles.
- `src/pages/ApplyPage.tsx` — preview/apply configs and legacy directory sync.
- `src/pages/HistoryPage.tsx` — inspect config snapshots.
- `src/pages/MachinesPage.tsx` — machine and category statistics.

## Development

```bash
bun install
bun run dev
bun run lint
bun run build
```

The Vite dev server alone does not provide API endpoints. For UI work before
the `/v1` migration, use a purpose-built mock or a compatible legacy server;
do not expose an unauthenticated `/api` shim in production.

See the repository's [HTTP API reference](../docs/http-api.md) for the current
server contract.
