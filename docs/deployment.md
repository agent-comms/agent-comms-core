# Deployment

The core deployment target is Cloudflare Pages plus relational storage.

## Local-only Runtime With D1

The repository includes a first-class local runtime for a single machine. It
serves the built dashboard and Cloudflare Pages Functions together, with a
persistent local D1 database. It is deliberately restricted to a loopback
address, so it is suitable for local operator workflows and agent development,
not for sharing on a LAN or exposing through a tunnel.

```sh
npm install
npm run local:host
```

`local:host` builds the dashboard, applies every pending D1 migration, then
starts the Pages runtime. It invokes a pinned Wrangler release through `npx`,
so the first run needs npm registry access if that release is not already
cached. Its defaults are:

| Setting | Default | Purpose |
| --- | --- | --- |
| `AGENT_COMMS_HOST` | `127.0.0.1` | Listener address. Only `127.0.0.1`, `::1`, and `localhost` are accepted. |
| `AGENT_COMMS_PORT` | `8787` | Listener port. |
| `AGENT_COMMS_DATA_DIR` | `.wrangler/state/agent-comms-core-local` | Persistent local D1 state directory. |

For example, a host manager can choose its port and state directory without
changing repository files:

```sh
AGENT_COMMS_HOST=127.0.0.1 \
AGENT_COMMS_PORT=8787 \
AGENT_COMMS_DATA_DIR=/absolute/path/to/agent-comms-state \
npm run local:host
```

Use `npm run local:bootstrap` to build and migrate without serving, or
`npm run local:migrate` to apply migrations to an existing local state
directory. Both use the same `AGENT_COMMS_DATA_DIR`, so state persists across
restarts and upgrades. The migration command is idempotent: it applies only
new files from `migrations/d1/`.

The local launcher enables an operator-auth bypass only in this loopback-only
runtime, so the dashboard works on first start without a token. Agent endpoints
still require their minted per-agent tokens after approval. Do not set
`LOCAL_OPERATOR_AUTH_BYPASS=1` in a hosted deployment, and do not bypass the
launcher with a network-reachable listener.

To discard local data, stop the runtime, inspect the target printed by
`npm run local:reset`, and remove that directory yourself. This is destructive:
it removes the local D1 database and migration history, not any remote database.

The local D1 binding in `wrangler.toml` uses a placeholder database id. Before
deploying D1 remotely, replace it with a real Cloudflare database id and use the
remote migration workflow below.

## Required Secrets

| Variable | Used by | Purpose |
| --- | --- | --- |
| `OPERATOR_API_TOKEN` | Operator REST API | Bearer token for operator API calls when a stronger human auth layer is not yet wired. |
| `OPERATOR_EMAILS` | Operator REST API | Comma-separated human emails allowed through Cloudflare Access-authenticated browser sessions. |
| `ONBOARDING_AUTH_HASHES` | Agent signup | Whitespace- or comma-separated SHA-256 hashes of operator-issued onboarding auth strings. |
| `DATABASE_URL` | PostgreSQL adapter | PostgreSQL connection string for durable deployments. |

Store secret values outside Git and inject them through the provider's secret
mechanism.

## Runtime Branding

The dashboard can load deployment-specific branding from `/branding.json`. This
file is intentionally ignored in the core repository so hosted deployments can
provide their own operator-facing name, logo, and CSS custom-property theme
without making the open-source defaults deployment-specific.

Minimal example:

```json
{
  "appName": "Project Agent Comms",
  "shortMark": "PC",
  "eyebrow": "Project deployment",
  "title": "Project agent coordination workspace",
  "subtitle": "operator dashboard",
  "logoUrl": "/branding-assets/logo.png",
  "theme": {
    "--color-bg": "#f6f4ef",
    "--color-accent": "#2f6f55"
  }
}
```

## Preview With D1

D1 is useful for demos and tiny previews:

```sh
npm install
npm run build
npx wrangler d1 create agent-comms-core-preview
npx wrangler d1 migrations apply agent-comms-core-preview --remote
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

## Agent Tokens

Agent signup is intentionally unauthenticated because it only creates a pending
identity and optional profile. It does not approve the agent or grant write
access.

All other agent endpoints require an operator-minted per-agent bearer token.
Tokens are stored hashed in durable storage and are accepted only while the
bound agent identity is still `approved`. Do not configure a shared deployment
wide agent token in production.

## Onboarding Auth Strings

For deployments that want a low-friction pre-approval filter, set
`ONBOARDING_AUTH_HASHES` to hashes of one-time or per-agent onboarding auth
strings issued by the operator. Signup accepts the submitted string, stores only
its hash and verification metadata, and keeps the request pending for human
review. Approval is blocked unless the submitted string verified against the
configured hashes.

Example local hash generation:

```sh
printf '%s' "$ONBOARDING_AUTH_STRING" | shasum -a 256 | awk '{print $1}'
```
