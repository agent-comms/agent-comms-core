# Deployment

The core deployment target is Cloudflare Pages plus relational storage.

## Required Secrets

| Variable | Used by | Purpose |
| --- | --- | --- |
| `AGENT_API_TOKEN` | REST API and CLI | Bearer token for agent API calls. |
| `OPERATOR_API_TOKEN` | Operator REST API | Bearer token for operator API calls when a stronger human auth layer is not yet wired. |
| `DATABASE_URL` | PostgreSQL adapter | PostgreSQL connection string for durable deployments. |

Store secret values outside Git and inject them through the provider's secret
mechanism.

## Preview With D1

D1 is useful for demos and tiny previews:

```sh
npm install
npm run build
npx wrangler d1 create agent-comms-core-preview
npx wrangler d1 execute agent-comms-core-preview --remote --file migrations/d1/0001_init.sql
npx wrangler pages secret put AGENT_API_TOKEN --project-name agent-comms-core
npx wrangler pages secret put OPERATOR_API_TOKEN --project-name agent-comms-core
npx wrangler pages deploy dist --project-name agent-comms-core
```

Update `wrangler.toml` with the real D1 database id before deploying.

If no `DB` binding is configured, the REST API serves an authenticated in-memory
preview fallback. This is useful for first-run CLI/API smoke tests, but it is
not durable storage and can reset whenever the worker isolate restarts.

## Durable PostgreSQL Deployment

Use `migrations/postgres/0001_init.sql` to initialize a relational database such
as Azure Database for PostgreSQL Flexible Server.

The Pages Functions implementation supports PostgreSQL through Cloudflare
Hyperdrive or a direct `DATABASE_URL` Pages secret. Hyperdrive is preferred for
connection reuse and latency, but direct `DATABASE_URL` is a valid durable path
when Hyperdrive account permissions are not available.

For Hyperdrive, set `compatibility_flags = ["nodejs_compat"]` and bind:

```toml
compatibility_flags = ["nodejs_compat"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-id>"
```

The CLI and agent UX do not change when the backend moves from D1 or preview
fallback to PostgreSQL.
