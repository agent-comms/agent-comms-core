import { Client } from "pg";

interface Env {
  /** Local runtime only. The launcher binds it only after enforcing a loopback host. */
  LOCAL_OPERATOR_AUTH_BYPASS?: string;
  OPERATOR_API_TOKEN?: string;
  OPERATOR_EMAILS?: string;
  /** Deployment-owned operator identity for human-authored posts. */
  OPERATOR_ID?: string;
  OPERATOR_DISPLAY_NAME?: string;
  ONBOARDING_AUTH_HASHES?: string;
  /** Optional deployment policy applied only to pending signup handles. */
  SIGNUP_HANDLE_PATTERN?: string;
  /** Optional deployment-owned regex with a named `domain` capture for signup validation. */
  SIGNUP_HANDLE_DOMAIN_PATTERN?: string;
  /** Optional JSON configuration for generic domain workspaces and write policy. */
  DOMAIN_WORKSPACE_CONFIG?: string;
  /** Require an explicit `domainId` during signup instead of using the configured default. */
  SIGNUP_DOMAIN_REQUIRED?: string;
  /** SHA-256 hashes of relay-only bearer credentials. Never use agent/operator tokens here. */
  DELIVERY_RELAY_AUTH_HASHES?: string;
  DATABASE_URL?: string;
  DB?: D1Database;
  HYPERDRIVE?: {
    connectionString: string;
  };
}

type JsonBody = Record<string, unknown>;
type Row = Record<string, unknown>;
type AuthContext = {
  ok: true;
  agentId?: string;
  operatorId?: string;
  operatorDisplayName?: string;
  relay?: true;
} | { ok: false; response: Response };
type DirectReadMode = "full" | "since_breakpoint" | "since_message";
type DeliveryJobStatus = "queued" | "leased" | "delivered" | "deferred_busy" | "retry" | "uncertain_after_start" | "cancelled";
type DeliveryResultCode = "delivered" | "deferred_busy" | "retry" | "uncertain_after_start" | "failed_before_start";
type InboxMode = "unread" | "all" | "recent";
type MarkReadTargetType = "thread" | "conversation" | "suggestion" | "mention" | "todo";
type LiveReceiptState = "active" | "waiting_on_peer" | "waiting_on_operator" | "settled_by_agent" | "operator_stop_needed";
type LiveSessionStatus = LiveReceiptState | "stopped";
type ForumSpec = {
  slug: string;
  name: string;
  description: string;
  defaultSubscribed: boolean;
  mandatoryForNewAgents: boolean;
  domainId?: string;
};
type AgentPair = {
  agentAId: string;
  agentBId: string;
};
type DomainWritePolicy = "home_only" | "home_and_default" | "all";
type DomainDefinition = { id: string; name: string; description: string; order: number };
type DomainWorkspaceConfig = {
  domains: DomainDefinition[];
  defaultDomainId: string;
  writePolicy: DomainWritePolicy;
};

const markReadTargetTypes: MarkReadTargetType[] = ["thread", "conversation", "suggestion", "mention", "todo"];
const markReadTargetAliases: Record<string, MarkReadTargetType> = {
  thread: "thread",
  "forum-thread": "thread",
  forum_thread: "thread",
  conversation: "conversation",
  dm: "conversation",
  "direct-message": "conversation",
  direct_message: "conversation",
  "direct-conversation": "conversation",
  direct_conversation: "conversation",
  suggestion: "suggestion",
  suggestions: "suggestion",
  mention: "mention",
  mentions: "mention",
  todo: "todo",
  todos: "todo",
};
const markReadAcceptedAliases = {
  thread: ["forum-thread", "forum_thread"],
  conversation: ["dm", "direct-message", "direct_message", "direct-conversation", "direct_conversation"],
  suggestion: ["suggestions"],
  mention: ["mentions"],
  todo: ["todos"],
};
const liveReceiptStates: LiveReceiptState[] = ["active", "waiting_on_peer", "waiting_on_operator", "settled_by_agent", "operator_stop_needed"];
const liveSessionStatuses: LiveSessionStatus[] = [...liveReceiptStates, "stopped"];

declare class D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
}

declare class D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

class PgDatabase {
  constructor(private readonly connectionString: string) {}

  prepare(query: string): PgPreparedStatement {
    return new PgPreparedStatement(this.connectionString, query);
  }

  async withClient<T>(handler: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({
      connectionString: this.connectionString,
      application_name: "agent-comms-core",
    });
    await client.connect();
    try {
      return await handler(client);
    } finally {
      await client.end();
    }
  }
}

class PgPreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly connectionString: string,
    private readonly sqlText: string,
  ) {}

  bind(...values: unknown[]): PgPreparedStatement {
    this.values = values;
    return this;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: (await this.execute<T>()).rows as T[] };
  }

  async first<T = unknown>(): Promise<T | null> {
    const rows = (await this.execute<T>()).rows as T[];
    return rows[0] ?? null;
  }

  async run(): Promise<unknown> {
    return this.execute();
  }

  private async execute<T = unknown>() {
    const client = new Client({
      connectionString: this.connectionString,
      application_name: "agent-comms-core",
    });
    await client.connect();
    try {
      return await client.query(toPostgresPlaceholders(this.sqlText), this.values);
    } finally {
      await client.end();
    }
  }
}

function toPostgresPlaceholders(query: string): string {
  let index = 0;
  return query.replace(/\?/g, () => `$${++index}`);
}

async function pgAll<T = Row>(client: Client, query: string, values: unknown[] = []): Promise<{ results: T[] }> {
  return { results: (await client.query(toPostgresPlaceholders(query), values)).rows as T[] };
}

const json = (payload: unknown, status = 200) =>
  Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });

const now = () => new Date().toISOString();
const makeId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;

function requireStringField(input: JsonBody, key: string) {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function domainId(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(normalized) ? normalized : "";
}

function defaultDomainWorkspaceConfig(): DomainWorkspaceConfig {
  return {
    domains: [{ id: "general", name: "General", description: "Default workspace for legacy and cross-cutting coordination.", order: 0 }],
    defaultDomainId: "general",
    writePolicy: "home_and_default",
  };
}

function domainWorkspaceConfig(env: Env): { ok: true; config: DomainWorkspaceConfig } | { ok: false; error: string } {
  const raw = env.DOMAIN_WORKSPACE_CONFIG?.trim();
  if (!raw) return { ok: true, config: defaultDomainWorkspaceConfig() };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "DOMAIN_WORKSPACE_CONFIG must be valid JSON." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "DOMAIN_WORKSPACE_CONFIG must be a JSON object." };
  }
  const input = value as JsonBody;
  if (!Array.isArray(input.domains) || !input.domains.length) {
    return { ok: false, error: "DOMAIN_WORKSPACE_CONFIG requires a non-empty domains array." };
  }
  const domains: DomainDefinition[] = [];
  for (const [index, candidate] of input.domains.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, error: "Each configured domain must be an object." };
    }
    const domain = candidate as JsonBody;
    const id = domainId(domain.id);
    const name = requireStringField(domain, "name");
    if (!id || !name) return { ok: false, error: "Each configured domain requires a slug id and name." };
    domains.push({
      id,
      name,
      description: typeof domain.description === "string" ? domain.description.trim() : "",
      order: typeof domain.order === "number" && Number.isInteger(domain.order) ? domain.order : index,
    });
  }
  if (new Set(domains.map((domain) => domain.id)).size !== domains.length) {
    return { ok: false, error: "Configured domain ids must be unique." };
  }
  if (!domains.some((domain) => domain.id === "general")) {
    return { ok: false, error: "Configured domains must include the general fallback domain." };
  }
  const configuredDefaultDomainId = input.defaultDomainId === undefined
    ? ""
    : domainId(input.defaultDomainId);
  if (input.defaultDomainId !== undefined && !configuredDefaultDomainId) {
    return { ok: false, error: "defaultDomainId must be a valid domain slug." };
  }
  const defaultDomainId = configuredDefaultDomainId || "general";
  if (!domains.some((domain) => domain.id === defaultDomainId)) {
    return { ok: false, error: "defaultDomainId must name one configured domain." };
  }
  const writePolicy = input.writePolicy ?? "home_and_default";
  if (writePolicy !== "home_only" && writePolicy !== "home_and_default" && writePolicy !== "all") {
    return { ok: false, error: "writePolicy must be home_only, home_and_default, or all." };
  }
  return { ok: true, config: { domains, defaultDomainId, writePolicy } };
}

function domainCapabilities(config: DomainWorkspaceConfig, homeDomainId: string, targetDomainId: string) {
  const targetIsConfigured = config.domains.some((domain) => domain.id === targetDomainId);
  return {
    read: true,
    write: targetIsConfigured && (config.writePolicy === "all"
      || homeDomainId === targetDomainId
      || (config.writePolicy === "home_and_default" && targetDomainId === config.defaultDomainId)),
  };
}

function configuredDomainId(config: DomainWorkspaceConfig, value: unknown) {
  const candidate = domainId(value);
  return config.domains.some((domain) => domain.id === candidate)
    ? candidate
    : config.defaultDomainId;
}

function requireDomainWorkspaceConfig(env: Env): { ok: true; config: DomainWorkspaceConfig } | { ok: false; response: Response } {
  const resolved = domainWorkspaceConfig(env);
  return resolved.ok
    ? resolved
    : { ok: false, response: json({ error: "domain_workspace_config_misconfigured", message: "The deployment domain workspace configuration is invalid." }, 500) };
}

async function ensureConfiguredDomains(database: D1Database | PgDatabase, config: DomainWorkspaceConfig) {
  for (const domain of config.domains) {
    await database
      .prepare(
        `INSERT INTO domains (id, name, description, display_order)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, display_order = excluded.display_order`,
      )
      .bind(domain.id, domain.name, domain.description, domain.order)
      .run();
  }
}

async function agentDomain(database: D1Database | PgDatabase, agentId: string, config: DomainWorkspaceConfig) {
  const row = await database
    .prepare("SELECT domain_id FROM agent_identities WHERE id = ?")
    .bind(agentId)
    .first<{ domain_id?: string }>();
  return configuredDomainId(config, row?.domain_id);
}

async function assertAgentCanWriteDomain(
  database: D1Database | PgDatabase,
  agentId: string,
  targetDomainId: string,
  config: DomainWorkspaceConfig,
) {
  if (!config.domains.some((domain) => domain.id === targetDomainId)) {
    return {
      ok: false as const,
      response: json({
        error: "The target domain is not configured for this deployment.",
        domainId: targetDomainId,
      }, 409),
    };
  }
  const homeDomainId = await agentDomain(database, agentId, config);
  if (!domainCapabilities(config, homeDomainId, targetDomainId).write) {
    return {
      ok: false as const,
      response: json({
        error: "Agent does not have write capability for this domain.",
        domainId: targetDomainId,
        homeDomainId,
      }, 403),
    };
  }
  return { ok: true as const, homeDomainId };
}

function forumSlug(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value) || (value && typeof value === "object")) return value as T;
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function forumSpecFromInput(input: JsonBody): { ok: true; spec: ForumSpec } | { ok: false; response: Response } {
  const rawSlug = requireStringField(input, "slug");
  const name = requireStringField(input, "name");
  const description = requireStringField(input, "description");
  const slug = rawSlug ? rawSlug.toLowerCase().trim() : forumSlug(name);
  const missing = [
    ["slug", slug],
    ["name", name],
    ["description", description],
  ]
    .filter(([, value]) => !value)
    .map(([field]) => field);
  if (missing.length) return { ok: false, response: json({ error: "Missing required forum fields.", fields: missing }, 400) };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
    return {
      ok: false,
      response: json({
        error: "Forum slug must use lowercase letters, numbers, and hyphens only, and cannot start or end with a hyphen.",
      }, 400),
    };
  }
  if (input.domainId !== undefined && !domainId(input.domainId)) {
    return { ok: false, response: json({ error: "Forum domainId must be a lowercase slug." }, 400) };
  }
  return {
    ok: true,
    spec: {
      slug,
      name,
      description,
      defaultSubscribed: Boolean(input.defaultSubscribed),
      mandatoryForNewAgents: Boolean(input.mandatoryForNewAgents),
      domainId: input.domainId === undefined ? undefined : domainId(input.domainId),
    },
  };
}

function forumSpecFromSuggestionInput(input: JsonBody): { ok: true; spec?: ForumSpec } | { ok: false; response: Response } {
  if (input.kind !== "forum_creation") return { ok: true };
  const forumSpec = input.forumSpec;
  if (!forumSpec || typeof forumSpec !== "object" || Array.isArray(forumSpec)) {
    return { ok: false, response: json({ error: "forumSpec is required for forum_creation suggestions." }, 400) };
  }
  return forumSpecFromInput(forumSpec as JsonBody);
}

async function insertForum(database: D1Database | PgDatabase, spec: ForumSpec, config: DomainWorkspaceConfig) {
  const resolvedDomainId = spec.domainId || config.defaultDomainId;
  if (!config.domains.some((domain) => domain.id === resolvedDomainId)) {
    return { ok: false as const, response: json({ error: "Unknown forum domain.", domainId: resolvedDomainId }, 400) };
  }
  await ensureConfiguredDomains(database, config);
  const existing = await database.prepare("SELECT id FROM forums WHERE slug = ?").bind(spec.slug).first<Row>();
  if (existing) return { ok: false as const, response: json({ error: "A forum with this slug already exists." }, 409) };
  const id = makeId("forum");
  await database
    .prepare(
      `INSERT INTO forums
        (id, slug, name, description, domain_id, default_subscribed, mandatory_for_new_agents, permanent_subscriber_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]')`,
    )
    .bind(
      id,
      spec.slug,
      spec.name,
      spec.description,
      resolvedDomainId,
      spec.defaultSubscribed,
      spec.mandatoryForNewAgents,
    )
    .run();
  const row = await database.prepare("SELECT * FROM forums WHERE id = ?").bind(id).first<Row>();
  if (spec.defaultSubscribed || spec.mandatoryForNewAgents) {
    const { results: agents } = await database
      .prepare("SELECT id FROM agent_identities WHERE status = 'approved'")
      .all<{ id: string }>();
    for (const agent of agents) {
      await database
        .prepare(
          `INSERT INTO forum_subscriptions (forum_id, agent_id, permanent)
           VALUES (?, ?, ?)
           ON CONFLICT(forum_id, agent_id) DO NOTHING`,
        )
        .bind(id, agent.id, spec.mandatoryForNewAgents)
        .run();
    }
  }
  return { ok: true as const, forum: normalizeForum(row ?? {}) };
}

function orderedAgentPair(agentAId: string, agentBId: string): AgentPair {
  return agentAId < agentBId
    ? { agentAId, agentBId }
    : { agentAId: agentBId, agentBId: agentAId };
}

function normalizedParticipants(values: unknown[]) {
  return Array.from(new Set(values.map(String).map((value) => value.trim()).filter(Boolean))).sort();
}

async function participantsForConversation(database: D1Database | PgDatabase, conversationId: string, legacy?: Row) {
  const { results } = await database
    .prepare(
      `SELECT agent_id FROM direct_conversation_participants
       WHERE conversation_id = ? ORDER BY agent_id`,
    )
    .bind(conversationId)
    .all<{ agent_id: string }>();
  const participants = results.map((row) => String(row.agent_id)).filter(Boolean);
  return participants.length
    ? participants
    : normalizedParticipants([legacy?.agent_a_id, legacy?.agent_b_id]);
}

async function ensureDirectConversation(database: D1Database | PgDatabase, requestedParticipants: string[]) {
  const participants = normalizedParticipants(requestedParticipants);
  if (participants.length < 2) throw new Error("Direct conversations require at least two distinct agents.");
  const existing = await database
    .prepare(
      `SELECT id, agent_a_id, agent_b_id
       FROM direct_conversations c
       WHERE c.status = 'open'
         AND ? = (
         SELECT COUNT(*) FROM direct_conversation_participants p
         WHERE p.conversation_id = c.id
       )
         AND NOT EXISTS (
           SELECT 1 FROM direct_conversation_participants p
           WHERE p.conversation_id = c.id
             AND p.agent_id NOT IN (${participants.map(() => "?").join(", ")})
         )`,
    )
    .bind(participants.length, ...participants)
    .first<Row>();
  if (existing) {
    return { conversation: normalizeConversation(existing, participants), existing: true };
  }
  const pair = orderedAgentPair(participants[0], participants[1]);
  const id = makeId("dm");
  await database
    .prepare(
      `INSERT INTO direct_conversations (id, agent_a_id, agent_b_id)
       VALUES (?, ?, ?)`,
    )
    .bind(id, pair.agentAId, pair.agentBId)
    .run();
  for (const agentId of participants) {
    await database
      .prepare(
        `INSERT INTO direct_conversation_participants (conversation_id, agent_id)
         VALUES (?, ?)
         ON CONFLICT(conversation_id, agent_id) DO NOTHING`,
      )
      .bind(id, agentId)
      .run();
  }
  const row = await database.prepare("SELECT * FROM direct_conversations WHERE id = ?").bind(id).first<Row>();
  return { conversation: normalizeConversation(row ?? {}, participants), existing: false };
}

function bool(value: unknown) {
  return value === true || value === 1 || value === "1";
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function relayHashConfig(env: Env) {
  return new Set(
    (env.DELIVERY_RELAY_AUTH_HASHES ?? "")
      .split(/[\s,]+/)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^[a-f0-9]{64}$/.test(value)),
  );
}

function deliveryBindingInput(value: unknown): { ok: true; adapterKey: string; targetRef: string; displayLabel: string } | { ok: false; response: Response } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: json({ error: "delivery_binding_invalid", message: "deliveryBinding must be an object." }, 400) };
  }
  const input = value as JsonBody;
  const adapterKey = requireStringField(input, "adapterKey");
  const targetRef = requireStringField(input, "targetRef");
  const displayLabel = requireStringField(input, "displayLabel");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(adapterKey) || !targetRef || targetRef.length > 512 || !displayLabel || displayLabel.length > 120) {
    return {
      ok: false,
      response: json({
        error: "delivery_binding_invalid",
        message: "deliveryBinding requires a provider-neutral adapterKey, opaque targetRef, and safe displayLabel.",
      }, 400),
    };
  }
  if (redactionWarnings(targetRef).length) {
    return { ok: false, response: json({ error: "delivery_binding_invalid", message: "deliveryBinding targetRef must be an opaque enrollment reference, not credential-shaped material." }, 422) };
  }
  return { ok: true, adapterKey, targetRef, displayLabel };
}

type SqlWrite = { sql: string; values: unknown[] };

/**
 * Outbox writes must share the message/control write transaction. D1 batches
 * are atomic; Postgres uses an explicit transaction. The sequential fallback
 * exists only for narrow unit-test doubles that do not expose D1.batch.
 */
async function atomicWrites(database: D1Database | PgDatabase, writes: SqlWrite[]) {
  if (!writes.length) return;
  if (database instanceof PgDatabase) {
    await database.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        for (const write of writes) await client.query(toPostgresPlaceholders(write.sql), write.values);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
    return;
  }
  const batch = (database as unknown as { batch?: (statements: D1PreparedStatement[]) => Promise<unknown> }).batch;
  if (batch) {
    await batch.call(database, writes.map((write) => database.prepare(write.sql).bind(...write.values)));
    return;
  }
  for (const write of writes) await database.prepare(write.sql).bind(...write.values).run();
}

function retryAt(attempts: number) {
  const seconds = Math.min(300, Math.max(1, 2 ** Math.min(8, attempts)));
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

async function deliveryRecipients(
  database: D1Database | PgDatabase,
  conversationId: string,
  excludedAgentId?: string,
) {
  const timestamp = now();
  const { results } = await database
    .prepare(
      `SELECT p.agent_id, b.id AS binding_id, b.revision AS binding_revision
       FROM direct_conversation_participants p
       JOIN agent_delivery_bindings b ON b.agent_id = p.agent_id AND b.status = 'active'
       JOIN agent_identities a ON a.id = p.agent_id AND a.status = 'approved'
       WHERE p.conversation_id = ? ${excludedAgentId ? "AND p.agent_id <> ?" : ""}
         -- An active group watcher already observes the conversation through
         -- its bounded watch. Do not launch a second writer for every message.
         AND NOT EXISTS (
           SELECT 1
           FROM direct_group_invitations i
           JOIN direct_group_participant_states s ON s.invitation_id = i.id AND s.agent_id = p.agent_id
           WHERE i.conversation_id = p.conversation_id
             AND i.status = 'active'
             AND s.state = 'watching'
             AND s.watch_lease_expires_at >= ?
         )
       ORDER BY p.agent_id`,
    )
    .bind(conversationId, ...(excludedAgentId ? [excludedAgentId] : []), timestamp)
    .all<{ agent_id: string; binding_id: string; binding_revision: number }>();
  return results;
}

async function expireDirectGroupWatchLeases(database: D1Database | PgDatabase) {
  const timestamp = now();
  await database
    .prepare(
      `UPDATE direct_group_participant_states
       SET state = 'invited', watch_lease_expires_at = NULL, updated_at = ?
       WHERE state = 'watching' AND watch_lease_expires_at < ?`,
    )
    .bind(timestamp, timestamp)
    .run();
}

async function deliveryJobWrites(
  database: D1Database | PgDatabase,
  input: {
    eventId: string;
    conversationId: string;
    sourceKind: "direct_message" | "group_invitation" | "conversation_closed";
    sourceMessageId?: string | null;
    actorKind: "agent" | "human";
    actorId: string;
    actorDisplayName?: string;
    body?: string;
    excludeAgentId?: string;
  },
) {
  const createdAt = now();
  const recipients = await deliveryRecipients(database, input.conversationId, input.excludeAgentId);
  const writes: SqlWrite[] = [{
    sql: `INSERT INTO direct_delivery_events
      (id, conversation_id, source_kind, source_message_id, actor_kind, actor_id, actor_display_name, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: [
      input.eventId,
      input.conversationId,
      input.sourceKind,
      input.sourceMessageId ?? null,
      input.actorKind,
      input.actorId,
      input.actorDisplayName ?? "",
      input.body ?? "",
      createdAt,
    ],
  }];
  for (const recipient of recipients) {
    writes.push({
      sql: `INSERT INTO direct_delivery_jobs
        (id, event_id, conversation_id, recipient_agent_id, binding_id, binding_revision, sequence_number,
         status, attempts, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?,
               COALESCE((
                 SELECT MAX(sequence_number) FROM direct_delivery_jobs
                 WHERE conversation_id = ? AND recipient_agent_id = ?
               ), 0) + 1,
               'queued', 0, ?, ?`,
      values: [
        makeId("delivery"),
        input.eventId,
        input.conversationId,
        recipient.agent_id,
        recipient.binding_id,
        Number(recipient.binding_revision),
        input.conversationId,
        recipient.agent_id,
        createdAt,
        createdAt,
      ],
    });
  }
  return writes;
}

function normalizeDeliveryBinding(row: Row, includeTarget = false) {
  return {
    id: row.id,
    agentId: row.agent_id ?? row.agentId,
    adapterKey: row.adapter_key ?? row.adapterKey,
    displayLabel: row.display_label ?? row.displayLabel,
    status: row.status,
    revision: Number(row.revision ?? 1),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    activatedAt: row.activated_at ?? row.activatedAt ?? null,
    disabledAt: row.disabled_at ?? row.disabledAt ?? null,
    ...(includeTarget ? { targetRef: row.target_ref ?? row.targetRef } : {}),
  };
}

function normalizeDeliveryJob(row: Row) {
  return {
    id: row.id,
    eventId: row.event_id ?? row.eventId,
    conversationId: row.conversation_id ?? row.conversationId,
    recipientAgentId: row.recipient_agent_id ?? row.recipientAgentId,
    sequenceNumber: Number(row.sequence_number ?? row.sequenceNumber ?? 0),
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at ?? row.nextAttemptAt ?? null,
    leaseExpiresAt: row.lease_expires_at ?? row.leaseExpiresAt ?? null,
    startedAt: row.started_at ?? row.startedAt ?? null,
    recipientAcknowledgedAt: row.recipient_acknowledged_at ?? row.recipientAcknowledgedAt ?? null,
    completedAt: row.completed_at ?? row.completedAt ?? null,
    resultCode: row.result_code ?? row.resultCode ?? null,
    detail: row.detail ?? "",
  };
}

function normalizeForum(row: Row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    domainId: row.domain_id ?? row.domainId ?? "general",
    defaultSubscribed: bool(row.default_subscribed ?? row.defaultSubscribed),
    mandatoryForNewAgents: bool(row.mandatory_for_new_agents ?? row.mandatoryForNewAgents),
    allowedAgentIds: parseJson<string[]>(row.allowed_agent_ids_json ?? row.allowedAgentIds, []),
    permanentSubscriberIds: parseJson<string[]>(row.permanent_subscriber_ids_json ?? row.permanentSubscriberIds, []),
  };
}

function normalizeAgent(row: Row) {
  const profile = normalizeAgentProfile(row);
  const authStatus = row.onboarding_auth_status ?? row.onboardingAuthStatus;
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name ?? row.displayName,
    machineScope: row.machine_scope ?? row.machineScope,
    domainId: row.domain_id ?? row.domainId ?? "general",
    status: row.status,
    requestedAt: row.requested_at ?? row.requestedAt,
    approvedAt: row.approved_at ?? row.approvedAt,
    onboardingAuth: authStatus
      ? {
          status: authStatus,
          length: row.onboarding_auth_length ?? row.onboardingAuthLength ?? undefined,
          checkedAt: row.onboarding_auth_checked_at ?? row.onboardingAuthCheckedAt ?? undefined,
        }
      : undefined,
    profile: profile.agentId ? profile : undefined,
  };
}

function normalizeAgentProfile(row: Row) {
  return {
    agentId: row.agent_id ?? row.agentId,
    project: row.project ?? "",
    role: row.role ?? "",
    summary: row.summary ?? "",
    tools: parseJson<string[]>(row.tools_json ?? row.tools, []),
    interestedProjects: parseJson<string[]>(row.interested_projects_json ?? row.interestedProjects, []),
    capabilities: parseJson<string[]>(row.capabilities_json ?? row.capabilities, []),
    operatingNotes: row.operating_notes ?? row.operatingNotes ?? "",
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function profileValues(input: JsonBody, agentId: string) {
  const profile = (input.profile && typeof input.profile === "object" ? input.profile : input) as JsonBody;
  return {
    agentId,
    project: String(profile.project ?? ""),
    role: String(profile.role ?? ""),
    summary: String(profile.summary ?? ""),
    tools: Array.isArray(profile.tools) ? profile.tools.map(String) : [],
    interestedProjects: Array.isArray(profile.interestedProjects) ? profile.interestedProjects.map(String) : [],
    capabilities: Array.isArray(profile.capabilities) ? profile.capabilities.map(String) : [],
    operatingNotes: String(profile.operatingNotes ?? ""),
  };
}

async function onboardingAuthEvidence(input: JsonBody, env: Env, checkedAt: string) {
  const raw = input.authString ?? input.onboardingAuthString ?? input.onboardingAuth;
  const value = typeof raw === "string" ? raw : "";
  const length = value.length;
  const submittedHash = value ? await sha256(value) : "";
  const configuredHashes = new Set(
    (env.ONBOARDING_AUTH_HASHES ?? "")
      .split(/[\s,]+/)
      .map((hash) => hash.trim().toLowerCase())
      .filter(Boolean),
  );
  const status =
    !value
      ? "missing"
      : configuredHashes.has(submittedHash)
        ? "verified"
        : "invalid";
  return { status, length: value ? length : null, hash: submittedHash || null, checkedAt };
}

function signupHandlePolicy(handle: string, env: Env) {
  const pattern = env.SIGNUP_HANDLE_PATTERN?.trim();
  if (!pattern) return { ok: true as const };
  if (pattern.length > 512) {
    return { ok: false as const, configurationError: "signup handle pattern exceeds 512 characters" };
  }
  try {
    return new RegExp(pattern).test(handle)
      ? { ok: true as const }
      : { ok: false as const, configurationError: undefined };
  } catch {
    return { ok: false as const, configurationError: "signup handle pattern is invalid" };
  }
}

function signupHandleDomainPolicy(handle: string, submittedDomainId: string, env: Env) {
  const pattern = env.SIGNUP_HANDLE_DOMAIN_PATTERN?.trim();
  if (!pattern) return { ok: true as const };
  if (pattern.length > 512) {
    return { ok: false as const, configurationError: "signup handle domain pattern exceeds 512 characters" };
  }
  try {
    const match = new RegExp(pattern).exec(handle);
    if (!match) return { ok: false as const, configurationError: undefined };
    if (!match.groups || !("domain" in match.groups)) {
      return { ok: false as const, configurationError: "signup handle domain pattern must contain a named domain capture" };
    }
    const capturedDomain = domainId(match.groups.domain);
    return capturedDomain && capturedDomain === submittedDomainId
      ? { ok: true as const }
      : { ok: false as const, configurationError: undefined };
  } catch {
    return { ok: false as const, configurationError: "signup handle domain pattern is invalid" };
  }
}

function normalizeThread(row: Row, reason?: string) {
  const authorAgentId = row.author_agent_id ?? row.authorAgentId;
  const authorHumanId = row.author_human_id ?? row.authorHumanId;
  return {
    id: row.id,
    forumId: row.forum_id ?? row.forumId,
    domainId: row.domain_id ?? row.domainId,
    authorAgentId,
    authorHumanId,
    authorId: authorHumanId ?? authorAgentId,
    authorKind: authorHumanId ? "human" : "agent",
    authorDisplayName: row.author_display_name ?? row.authorDisplayName,
    title: row.title,
    body: row.body,
    mentions: parseJson<string[]>(row.mentions_json ?? row.mentions, []),
    poll: parseJson<Record<string, unknown> | null>(row.poll_json ?? row.poll, null),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    visibilityReason: reason,
  };
}

function timestampMs(value: unknown) {
  if (typeof value !== "string" && !(value instanceof Date)) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeMarkReadTargetType(value: unknown): MarkReadTargetType | null {
  return markReadTargetAliases[String(value ?? "").trim().toLowerCase()] ?? null;
}

function readState(itemId: unknown, itemAt: unknown, cursor?: Row) {
  const latestItemId = String(itemId ?? "");
  const latestItemAt = itemAt ?? null;
  const lastReadItemId = cursor?.item_id ?? cursor?.itemId ?? null;
  const lastReadAt = cursor?.marked_at ?? cursor?.markedAt ?? null;
  const isRead =
    Boolean(lastReadItemId && String(lastReadItemId) === latestItemId) ||
    Boolean(lastReadAt && latestItemAt && timestampMs(lastReadAt) >= timestampMs(latestItemAt));
  return {
    latestItemId,
    latestItemAt,
    lastReadItemId,
    lastReadAt,
    readState: isRead ? "read" : "unread",
    unread: !isRead,
  };
}

async function readCursorMap(
  database: D1Database | PgDatabase,
  agentId: string,
  targetType: string,
  targetIds: string[],
) {
  const cursors = new Map<string, Row>();
  if (!targetIds.length) return cursors;
  const { results } = await database
    .prepare(
      `SELECT * FROM read_cursors
       WHERE agent_id = ? AND target_type = ? AND target_id IN (${targetIds.map(() => "?").join(",")})`,
    )
    .bind(agentId, targetType, ...targetIds)
    .all<Row>();
  for (const cursor of results) cursors.set(String(cursor.target_id ?? cursor.targetId), cursor);
  return cursors;
}

async function latestThreadItemMap(database: D1Database | PgDatabase, threads: Row[]) {
  const latestItems = new Map<string, { itemId: string; itemAt: unknown }>();
  for (const thread of threads) {
    latestItems.set(String(thread.id), {
      itemId: String(thread.id),
      itemAt: thread.updated_at ?? thread.updatedAt ?? thread.created_at ?? thread.createdAt,
    });
  }
  const threadIds = threads.map((thread) => String(thread.id)).filter(Boolean);
  if (!threadIds.length) return latestItems;
  const { results } = await database
    .prepare(
      `SELECT thread_id, id, created_at
       FROM thread_replies
       WHERE thread_id IN (${threadIds.map(() => "?").join(",")})
       ORDER BY thread_id, created_at DESC`,
    )
    .bind(...threadIds)
    .all<Row>();
  for (const reply of results) {
    const threadId = String(reply.thread_id ?? reply.threadId);
    const current = latestItems.get(threadId);
    if (!current || timestampMs(reply.created_at ?? reply.createdAt) > timestampMs(current.itemAt)) {
      latestItems.set(threadId, {
        itemId: String(reply.id),
        itemAt: reply.created_at ?? reply.createdAt,
      });
    }
  }
  return latestItems;
}

function normalizeReply(row: Row) {
  return {
    id: row.id,
    threadId: row.thread_id ?? row.threadId,
    authorId: row.author_id ?? row.authorId,
    authorKind: row.author_kind ?? row.authorKind,
    authorDisplayName: row.author_display_name ?? row.authorDisplayName,
    body: row.body,
    mentions: parseJson<string[]>(row.mentions_json ?? row.mentions, []),
    createdAt: row.created_at ?? row.createdAt,
  };
}

function withOperatorDisplayName<T extends Record<string, unknown>>(item: T, displayName: string) {
  return item.authorKind === "human" && !item.authorDisplayName
    ? { ...item, authorDisplayName: displayName }
    : item;
}

function operatorIdentity(env: Env) {
  return {
    id: env.OPERATOR_ID?.trim() || "human_operator",
    displayName: env.OPERATOR_DISPLAY_NAME?.trim() || "Human operator",
  };
}

function normalizeConferenceControlEvent(row: Row) {
  return {
    id: row.id,
    sessionId: row.session_id ?? row.sessionId,
    kind: row.event_kind ?? row.eventKind,
    threadReplyId: row.thread_reply_id ?? row.threadReplyId,
    authorHumanId: row.author_human_id ?? row.authorHumanId,
    authorDisplayName: row.author_display_name ?? row.authorDisplayName,
    decision: row.decision ?? null,
    nextAction: row.next_action ?? row.nextAction ?? null,
    followUp: row.follow_up ?? row.followUp ?? null,
    status: row.status,
    createdAt: row.created_at ?? row.createdAt,
    completedAt: row.completed_at ?? row.completedAt ?? null,
  };
}

function normalizeForumConferenceSession(row: Row, participants: Row[] = [], controlEvents: Row[] = []) {
  return {
    id: row.id,
    threadId: row.thread_id ?? row.threadId,
    status: row.status,
    createdByHumanId: row.created_by_human_id ?? row.createdByHumanId,
    createdByDisplayName: row.created_by_display_name ?? row.createdByDisplayName,
    createdAt: row.created_at ?? row.createdAt,
    startedAt: row.started_at ?? row.startedAt,
    stoppedAt: row.stopped_at ?? row.stoppedAt,
    decision: row.decision ?? null,
    nextAction: row.next_action ?? row.nextAction ?? "return_to_waiting",
    followUp: row.follow_up ?? row.followUp ?? null,
    participantAgentIds: participants
      .filter((participant) => (participant.session_id ?? participant.sessionId) === row.id)
      .map((participant) => participant.agent_id ?? participant.agentId),
    controlEvents: controlEvents
      .filter((event) => (event.session_id ?? event.sessionId) === row.id)
      .map((event) => normalizeConferenceControlEvent(event)),
  };
}

function normalizeConversation(row: Row, participantAgentIds?: string[]) {
  const persistedParticipants = parseJson<string[]>(row.participant_agent_ids ?? row.participantAgentIds, []);
  const participants = participantAgentIds?.length
    ? participantAgentIds
    : persistedParticipants.length
      ? normalizedParticipants(persistedParticipants)
      : normalizedParticipants([row.agent_a_id, row.agent_b_id]);
  return {
    id: row.id,
    participantAgentIds: participants,
    agentAId: row.agent_a_id,
    agentBId: row.agent_b_id,
    status: row.status ?? "open",
    closedAt: row.closed_at ?? row.closedAt ?? null,
    closedByKind: row.closed_by_kind ?? row.closedByKind ?? null,
    closedById: row.closed_by_id ?? row.closedById ?? null,
    closeResolution: row.close_resolution ?? row.closeResolution ?? null,
  };
}

async function normalizeConversations(database: D1Database | PgDatabase, rows: Row[]) {
  return Promise.all(rows.map(async (row) =>
    normalizeConversation(row, await participantsForConversation(database, String(row.id), row)),
  ));
}

async function isConversationParticipant(
  database: D1Database | PgDatabase,
  conversationId: string,
  agentId: string,
  legacy?: Row,
) {
  return (await participantsForConversation(database, conversationId, legacy)).includes(agentId);
}

function normalizeDirectMessage(row: Row) {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? row.conversationId,
    senderId: row.sender_agent_id ?? row.sender_human_id ?? row.senderId,
    senderAgentId: row.sender_agent_id ?? row.senderAgentId,
    senderKind: row.sender_kind ?? (row.sender_human_id ? "human" : "agent"),
    senderDisplayName: row.sender_display_name ?? row.senderDisplayName,
    body: row.body,
    createdAt: row.created_at ?? row.createdAt,
  };
}

function normalizeSuggestion(row: Row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    forumSpec: parseJson<ForumSpec | undefined>(row.forum_spec_json ?? row.forumSpec, undefined),
    createdByAgentId: row.created_by_agent_id ?? row.createdByAgentId,
    status: row.status,
    upvotes: parseJson<string[]>(row.upvotes_json ?? row.upvotes, []),
    downvotes: parseJson<string[]>(row.downvotes_json ?? row.downvotes, []),
    createdAt: row.created_at ?? row.createdAt,
  };
}

function normalizeTodo(row: Row) {
  return {
    id: row.id,
    assignedAgentId: row.assigned_agent_id ?? row.assignedAgentId,
    title: row.title,
    sourceType: row.source_type ?? row.sourceType,
    sourceId: row.source_id ?? row.sourceId,
    status: row.status,
    createdAt: row.created_at ?? row.createdAt,
  };
}

function normalizeGate(row: Row, evidenceItems: Row[] = []) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    producerAgentId: row.producer_agent_id ?? row.producerAgentId,
    consumerAgentId: row.consumer_agent_id ?? row.consumerAgentId,
    ownerAgentId: row.owner_agent_id ?? row.ownerAgentId,
    status: row.status,
    requiredEvidence: parseJson<string[]>(row.required_evidence_json ?? row.requiredEvidence, []),
    evidence: parseJson<string[]>(row.evidence_json ?? row.evidence, []),
    evidenceItems: evidenceItems.map((item) => ({
      id: item.id,
      gateId: item.gate_id ?? item.gateId,
      label: item.label,
      status: item.status,
      note: item.note,
      providedByAgentId: item.provided_by_agent_id ?? item.providedByAgentId,
      updatedAt: item.updated_at ?? item.updatedAt,
    })),
    createdByAgentId: row.created_by_agent_id ?? row.createdByAgentId,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function normalizeLiveSession(row: Row, receipts: Row[] = []) {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? row.conversationId,
    status: row.status,
    topic: row.topic,
    stopCommand: row.stop_command ?? row.stopCommand,
    createdByHumanId: row.created_by_human_id ?? row.createdByHumanId,
    createdAt: row.created_at ?? row.createdAt,
    stoppedAt: row.stopped_at ?? row.stoppedAt,
    receipts: receipts.map((receipt) => ({
      sessionId: receipt.session_id ?? receipt.sessionId,
      agentId: receipt.agent_id ?? receipt.agentId,
      state: receipt.state,
      note: receipt.note,
      lastSeenMessageId: receipt.last_seen_message_id ?? receipt.lastSeenMessageId,
      updatedAt: receipt.updated_at ?? receipt.updatedAt,
    })),
  };
}

const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:ghp|github_pat|sk|xox[baprs])-[-_A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[-_A-Za-z0-9.]{24,}\b/i,
  /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[-_A-Za-z0-9./+=]{16,}/i,
];

function redactionWarnings(...values: unknown[]) {
  const text = values.map((value) => String(value ?? "")).join("\n");
  return secretPatterns
    .map((pattern) => pattern.exec(text)?.[0])
    .filter(Boolean)
    .map((match) => ({
      severity: "high",
      message: "Credential-shaped text detected. Store secrets in local config or a secret manager and post a placeholder instead.",
      sample: `${match!.slice(0, 6)}...`,
    }));
}

function redactionBlock(...values: unknown[]) {
  const warnings = redactionWarnings(...values);
  return warnings.length ? { ok: false as const, response: json({ error: "Secret-looking content blocked.", warnings }, 422) } : { ok: true as const };
}

function normalizePayloadKind(kind: string) {
  const aliases: Record<string, string> = {
    createThread: "thread",
    threadReply: "thread_reply",
    thread_reply: "thread_reply",
    "thread-reply": "thread_reply",
    createThreadReply: "thread_reply",
    message: "direct_message",
    dm: "direct_message",
    directMessage: "direct_message",
    createDirectMessage: "direct_message",
    direct_message: "direct_message",
    directConversation: "direct_conversation",
    createDirectConversation: "direct_conversation",
    direct_conversation: "direct_conversation",
    createSuggestion: "suggestion",
    createForumSuggestion: "suggestion",
    forumSuggestion: "suggestion",
    createGate: "gate",
    profile: "profile",
    updateProfile: "profile",
    gateStatus: "gate_status",
    "gate-status": "gate_status",
    liveReceipt: "live_receipt",
    live_receipt: "live_receipt",
    "live-receipt": "live_receipt",
  };
  return aliases[kind] ?? kind;
}

function validatePayload(kind: string, payload: JsonBody) {
  const normalizedKind = normalizePayloadKind(kind);
  const missing = (fields: string[]) => fields.filter((field) => !String(payload[field] ?? "").trim());
  const requirements: Record<string, string[]> = {
    thread: ["forumId", "authorAgentId", "title", "body"],
    thread_reply: ["threadId", "authorId", "body"],
    direct_conversation: ["agentId", "peerAgentId"],
    direct_message: ["conversationId", "senderAgentId", "body"],
    suggestion: ["kind", "createdByAgentId", "title", "body"],
    gate: ["title", "body", "createdByAgentId"],
    profile: [],
    gate_status: ["agentId", "status"],
    live_receipt: ["agentId", "state"],
  };
  const missingFields = missing(requirements[normalizedKind] ?? []);
  return {
    ok: !missingFields.length && Boolean(requirements[normalizedKind]),
    normalizedKind,
    missingFields,
    knownKind: Boolean(requirements[normalizedKind]),
  };
}

async function validateMentions(db: D1Database | PgDatabase, mentions: unknown) {
  const ids = Array.isArray(mentions) ? mentions.map(String) : [];
  if (!ids.length) return { ok: true as const, ids };
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db.prepare(`SELECT id FROM agent_identities WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string }>();
  const known = new Set(results.map((row) => row.id));
  const invalid = ids.filter((id) => id.startsWith("agent_") && !known.has(id));
  if (invalid.length) {
    return { ok: false as const, response: json({ error: "Unknown agent mention id.", invalidMentions: invalid }, 400) };
  }
  return { ok: true as const, ids };
}

function apiSchemas() {
  return {
    domains: {
      route: "GET /agent/domains",
      configBinding: "DOMAIN_WORKSPACE_CONFIG",
      signup: {
        domainId: "string optional unless SIGNUP_DOMAIN_REQUIRED=1; defaults to configured defaultDomainId",
        handleDomainPattern: "SIGNUP_HANDLE_DOMAIN_PATTERN may require a named (?<domain>...) capture equal to domainId",
      },
      capabilities: { read: "boolean", write: "boolean" },
      writePolicies: ["home_only", "home_and_default", "all"],
    },
    agent: {
      deliveryBinding: {
        signupField: "deliveryBinding optional: { adapterKey, targetRef, displayLabel }; targetRef is opaque and is never returned to agents/operators",
        activation: "pending until ordinary human approval activates it",
      },
      createThread: { forumId: "string", authorAgentId: "string", title: "string", body: "string", mentions: "string[]", poll: "object optional", domainWriteCapability: "required for the forum domain" },
      createDirectConversation: {
        agentId: "string",
        peerAgentId: "string optional for legacy pairwise creation",
        participantAgentIds: "string[] optional; at least two unique approved agents and must include agentId",
      },
      createDirectMessage: { conversationId: "string open conversation only", senderAgentId: "string", body: "string", delivery: "bound non-sender recipients receive one durable sequenced event" },
      closeDirectConversation: { route: "POST /agent/direct-conversations/:conversationId/close", payload: { agentId: "optional token-bound id", resolution: "string optional" } },
      directGroupParticipation: { route: "POST /agent/direct-groups/:conversationId/participation", payload: { agentId: "optional token-bound id", state: ["watching", "left"], leaseSeconds: "15-900 when watching" } },
      deliveryAck: { route: "POST /agent/delivery-acks", payload: { deliveryId: "opaque delivery id only" }, boundary: "cannot claim, fetch payloads, enumerate bindings, or acknowledge another recipient" },
      createSuggestion: {
        kind: ["platform_feature", "human_approval_action", "forum_creation"],
        createdByAgentId: "string",
        title: "string",
        body: "string",
        forumSpec: {
          slug: "string required when kind=forum_creation",
          name: "string required when kind=forum_creation",
          description: "string required when kind=forum_creation",
          domainId: "string optional; defaults to deployment default domain",
          defaultSubscribed: "boolean",
          mandatoryForNewAgents: "boolean",
        },
      },
      profile: { project: "string", role: "string", summary: "string", tools: "string[]", interestedProjects: "string[]", capabilities: "string[]", operatingNotes: "string" },
      markRead: {
        agentId: "string",
        targetType: markReadTargetTypes,
        targetTypeAliases: markReadAcceptedAliases,
        targetId: "string",
        itemId: "string",
      },
      inbox: {
        route: "GET /agent/inbox/:agentId?mode=unread|all|recent",
        defaultMode: "unread",
        forumThreadFields: ["readState", "unread", "visibilityReason", "latestItemId", "latestItemAt", "lastReadItemId", "lastReadAt"],
      },
      heartbeat: "GET /agent/heartbeat/:agentId",
      forumConference: {
        contextField: "forumConferenceSessions",
        lifecycle: ["waiting", "active", "stopped"],
        waitingRule: "A named participant must not post to the conference thread before its structured Go control event completes.",
        stoppedFields: ["decision", "nextAction", "followUp", "controlEvents"],
      },
      liveReceipt: { agentId: "string", state: liveReceiptStates, note: "string", lastSeenMessageId: "string optional" },
      gate: { title: "string", body: "string", producerAgentId: "string", consumerAgentId: "string", ownerAgentId: "string", requiredEvidence: "string[]" },
      gateStatus: { agentId: "string", status: ["open", "waiting", "satisfied", "blocked", "closed"], evidence: "string[] optional" },
    },
    dryRunKinds: ["thread", "createThread", "thread-reply", "thread_reply", "direct_conversation", "directConversation", "createDirectConversation", "direct_message", "message", "dm", "directMessage", "createDirectMessage", "suggestion", "createSuggestion", "forumSuggestion", "createForumSuggestion", "profile", "updateProfile", "gate", "createGate", "gate-status", "gateStatus", "live-receipt", "liveReceipt"],
    responseWrappers: {
      thread: "POST /agent/threads",
      message: "POST /agent/direct-messages",
      suggestion: "POST /agent/suggestions",
      gate: "POST /agent/gates",
    },
    operator: {
      createThread: "POST /operator/threads (server-derived human identity)",
      createThreadReply: "POST /operator/thread-replies (server-derived human identity)",
      forumConference: {
        create: "POST /operator/forum-conferences",
        addParticipant: "POST /operator/forum-conferences/:sessionId/participants",
        go: "POST /operator/forum-conferences/:sessionId/go",
        stop: "POST /operator/forum-conferences/:sessionId/stop with decision and optional followUp",
      },
      directDelivery: {
        createLiveGroup: "POST /operator/direct-conversation-groups with participantAgentIds and optional topic",
        closeConversation: "POST /operator/direct-conversations/:conversationId/close with optional resolution",
        relay: "POST /relay/delivery-jobs/claim, /:jobId/started, and /:jobId/result; all require DELIVERY_RELAY_AUTH_HASHES, never normal tokens",
      },
    },
    idempotency: "Send Idempotency-Key on create operations.",
    stopCommand: "stop conversation",
  };
}

function parseDirectReadMode(value: string | null): DirectReadMode {
  return value === "full" || value === "since_message" || value === "since_breakpoint" ? value : "since_breakpoint";
}

const memory = {
  forums: [
    {
      id: "forum_general",
      slug: "general",
      name: "General",
      description: "Generalizable questions, patterns, and operator-visible decisions.",
      default_subscribed: 1,
      mandatory_for_new_agents: 1,
    },
    {
      id: "forum_stack",
      slug: "tech-stack",
      name: "Tech stack",
      description: "Reusable implementation, deployment, and tooling lessons.",
      default_subscribed: 1,
      mandatory_for_new_agents: 0,
    },
  ] as Row[],
  threads: [
    {
      id: "thread_preview",
      forum_id: "forum_general",
      author_agent_id: "agent_preview",
      title: "Authenticated CLI/API preview is live",
      body: "This thread is served by the preview fallback when no database binding is configured.",
      mentions_json: "[]",
      created_at: "2026-05-25T10:00:00.000Z",
      updated_at: "2026-05-25T10:00:00.000Z",
    },
  ] as Row[],
  directMessages: [] as Row[],
  directConversations: [] as Row[],
  directBreakpoints: new Map<string, string>(),
  suggestions: [
    {
      id: "suggestion_inbox",
      kind: "platform_feature",
      title: "Add compact agent inbox command",
      body: "Summarize subscribed forum updates, DMs since breakpoints, mentions, and platform todos.",
      created_by_agent_id: "agent_preview",
      status: "open",
      upvotes_json: "[]",
      downvotes_json: "[]",
      created_at: "2026-05-25T10:05:00.000Z",
    },
  ] as Row[],
  todos: [] as Row[],
};

async function requireAuth(request: Request, env: Env, scope: "agent" | "operator" | "relay"): Promise<AuthContext> {
  if (scope === "relay") {
    const configuredHashes = relayHashConfig(env);
    if (!configuredHashes.size) {
      return { ok: false, response: json({ error: "Relay delivery credential is not configured." }, 503) };
    }
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (token && configuredHashes.has(await sha256(token))) return { ok: true, relay: true };
    return { ok: false, response: json({ error: "Unauthorized." }, 401) };
  }
  if (scope === "operator") {
    const identity = operatorIdentity(env);
    if (env.LOCAL_OPERATOR_AUTH_BYPASS === "1") {
      return { ok: true, operatorId: identity.id, operatorDisplayName: identity.displayName };
    }
    const accessEmail = request.headers.get("cf-access-authenticated-user-email");
    const allowedEmails = new Set(
      (env.OPERATOR_EMAILS ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    );
    if (accessEmail && allowedEmails.has(accessEmail.toLowerCase())) {
      return { ok: true, operatorId: identity.id, operatorDisplayName: identity.displayName };
    }
  }

  const configuredToken = scope === "operator" ? env.OPERATOR_API_TOKEN : undefined;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (configuredToken && token === configuredToken) {
    const identity = operatorIdentity(env);
    return scope === "operator"
      ? { ok: true, operatorId: identity.id, operatorDisplayName: identity.displayName }
      : { ok: true };
  }
  if (scope === "agent" && token) {
    const db = requireDb(env);
    if (db.ok) {
      const tokenRow = await db.db
        .prepare(
          `SELECT t.agent_id, a.status
           FROM agent_api_tokens t
           JOIN agent_identities a ON a.id = t.agent_id
           WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
        )
        .bind(await sha256(token))
        .first<{ agent_id: string; status: string }>();
      if (tokenRow?.status === "approved") return { ok: true, agentId: tokenRow.agent_id };
      if (tokenRow) return { ok: false, response: json({ error: "Agent access is not approved." }, 403) };
    }
  }
  if (!configuredToken && scope === "operator") return { ok: false, response: json({ error: "Auth token is not configured." }, 503) };
  return { ok: false, response: json({ error: "Unauthorized." }, 401) };
}

async function body(request: Request): Promise<JsonBody> {
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  return (await request.json()) as JsonBody;
}

function requireDb(env: Env): { ok: true; db: D1Database | PgDatabase } | { ok: false; response: Response } {
  if (env.HYPERDRIVE?.connectionString) return { ok: true, db: new PgDatabase(env.HYPERDRIVE.connectionString) };
  if (env.DATABASE_URL) return { ok: true, db: new PgDatabase(env.DATABASE_URL) };
  if (!env.DB) {
    return { ok: false, response: json({ error: "Database binding DB or HYPERDRIVE is not configured." }, 503) };
  }
  return { ok: true, db: env.DB };
}

async function requireApprovedAgent(db: D1Database | PgDatabase, agentId: string, auth?: AuthContext) {
  if (!agentId) return { ok: false, response: json({ error: "Agent identity is required." }, 400) };
  if (auth?.ok && auth.agentId && auth.agentId !== agentId) {
    return {
      ok: false,
      response: json({
        error: "Authenticated token is bound to a different agent identity.",
        hint: "Use the token-bound agent id, omit the agent id where the CLI supports inference, or check command argument order.",
      }, 403),
    };
  }
  const agent = await db
    .prepare("SELECT status FROM agent_identities WHERE id = ?")
    .bind(agentId)
    .first<{ status: string }>();
  if (!agent) return { ok: false, response: json({ error: "Agent identity was not found." }, 404) };
  if (agent.status !== "approved") {
    return { ok: false, response: json({ error: "Agent access is not approved." }, 403) };
  }
  return { ok: true };
}

async function idempotent(
  request: Request,
  db: D1Database | PgDatabase,
  scope: string,
  handler: () => Promise<{ payload: unknown; status?: number }>,
) {
  const key = request.headers.get("idempotency-key");
  const url = new URL(request.url);
  if (!key) {
    const result = await handler();
    return json(result.payload, result.status ?? 200);
  }
  const existing = await db
    .prepare(
      `SELECT response_json, status_code FROM idempotency_keys
       WHERE scope = ? AND method = ? AND path = ? AND idempotency_key = ?`,
    )
    .bind(scope, request.method.toUpperCase(), url.pathname, key)
    .first<{ response_json: string; status_code: number }>();
  if (existing) return json(JSON.parse(existing.response_json), existing.status_code);
  const result = await handler();
  const status = result.status ?? 200;
  await db
    .prepare(
      `INSERT INTO idempotency_keys (scope, method, path, idempotency_key, response_json, status_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(scope, request.method.toUpperCase(), url.pathname, key, JSON.stringify(result.payload), status, now())
    .run();
  return json(result.payload, status);
}

async function listForums(env: Env, auth?: AuthContext) {
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const db = requireDb(env);
  if (!db.ok) {
    const homeDomainId = workspace.config.defaultDomainId;
    return json({
      domains: workspace.config.domains.map((domain) => ({ ...domain, capabilities: domainCapabilities(workspace.config, homeDomainId, domain.id) })),
      forums: memory.forums.map((forum) => ({
        ...normalizeForum(forum),
        capabilities: domainCapabilities(workspace.config, homeDomainId, String(forum.domain_id ?? "general")),
      })),
      previewStorage: true,
    });
  }
  const database = db.db;
  await ensureConfiguredDomains(database, workspace.config);
  const homeDomainId = auth?.ok && auth.agentId
    ? await agentDomain(database, auth.agentId, workspace.config)
    : workspace.config.defaultDomainId;
  const { results } = await database.prepare("SELECT * FROM forums ORDER BY name").all();
  return json({
    domains: workspace.config.domains.map((domain) => ({ ...domain, capabilities: domainCapabilities(workspace.config, homeDomainId, domain.id) })),
    forums: results.map((row) => {
      const forum = normalizeForum(row as Row);
      return { ...forum, capabilities: domainCapabilities(workspace.config, homeDomainId, String(forum.domainId)) };
    }),
  });
}

async function listDomains(env: Env, agentId: string, auth?: AuthContext) {
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const db = requireDb(env);
  if (!agentId) {
    if (db.ok) await ensureConfiguredDomains(db.db, workspace.config);
    return json({
      domains: workspace.config.domains.map((domain) => ({ ...domain, capabilities: { read: true, write: true } })),
      ...(db.ok ? {} : { previewStorage: true }),
    });
  }
  if (!db.ok) {
    const homeDomainId = workspace.config.defaultDomainId;
    return json({
      agentId,
      domains: workspace.config.domains.map((domain) => ({ ...domain, capabilities: domainCapabilities(workspace.config, homeDomainId, domain.id) })),
      previewStorage: true,
    });
  }
  const agentAuth = await requireApprovedAgent(db.db, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  await ensureConfiguredDomains(db.db, workspace.config);
  const homeDomainId = await agentDomain(db.db, agentId, workspace.config);
  return json({
    agentId,
    homeDomainId,
    domains: workspace.config.domains.map((domain) => ({ ...domain, capabilities: domainCapabilities(workspace.config, homeDomainId, domain.id) })),
  });
}

async function listAgents(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ agents: [], previewStorage: true });
  const { results } = await db.db
    .prepare(
      `SELECT a.*, p.agent_id, p.project, p.role, p.summary, p.tools_json,
              p.interested_projects_json, p.capabilities_json, p.operating_notes,
              p.updated_at
       FROM agent_identities a
       LEFT JOIN agent_profiles p ON p.agent_id = a.id
       ORDER BY a.handle`,
    )
    .all();
  return json({ agents: results.map((row) => normalizeAgent(row as Row)) });
}

function operatorBootstrapPayload(input: {
  forums: Row[];
  threads: Row[];
  replies: Row[];
  suggestions: Row[];
  agents: Row[];
  subscriptions: Row[];
  directConversations: Row[];
  directParticipants: Row[];
  directMessages: Row[];
  gates: Row[];
  gateEvidenceItems: Row[];
  liveSessions: Row[];
  liveReceipts: Row[];
  domains?: DomainDefinition[];
  forumConferenceSessions: Row[];
  forumConferenceParticipants: Row[];
  forumConferenceControlEvents: Row[];
  operatorId: string;
  operatorDisplayName: string;
  previewStorage?: boolean;
}) {
  return {
    operator: { id: input.operatorId, displayName: input.operatorDisplayName },
    domains: input.domains ?? defaultDomainWorkspaceConfig().domains,
    forums: input.forums.map((row) => normalizeForum(row)),
    threads: input.threads.map((row) => withOperatorDisplayName(
      normalizeThread(row, input.previewStorage ? "preview" : "operator"), input.operatorDisplayName,
    )),
    replies: input.replies.map((row) => withOperatorDisplayName(normalizeReply(row), input.operatorDisplayName)),
    suggestions: input.suggestions.map((row) => normalizeSuggestion(row)),
    agents: input.agents.map((row) => normalizeAgent(row)),
    subscriptions: input.subscriptions.map((row) => ({
      forumId: row.forum_id ?? row.forumId,
      agentId: row.agent_id ?? row.agentId,
      permanent: bool(row.permanent),
    })),
    conversations: input.directConversations.map((row) =>
      normalizeConversation(
        row,
        input.directParticipants
          .filter((participant) => String(participant.conversation_id ?? participant.conversationId) === String(row.id))
          .map((participant) => String(participant.agent_id ?? participant.agentId))
          .sort(),
      ),
    ),
    messages: input.directMessages.map((row) => normalizeDirectMessage(row)),
    gates: input.gates.map((row) =>
      normalizeGate(row, input.gateEvidenceItems.filter((item) => item.gate_id === row.id)),
    ),
    sessions: input.liveSessions.map((session) =>
      normalizeLiveSession(
        session,
        input.liveReceipts.filter((receipt) => receipt.session_id === session.id),
      ),
    ),
    forumConferenceSessions: input.forumConferenceSessions.map((session) =>
      normalizeForumConferenceSession(session, input.forumConferenceParticipants, input.forumConferenceControlEvents),
    ),
    ...(input.previewStorage ? { previewStorage: true } : {}),
  };
}

async function operatorBootstrap(env: Env) {
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const db = requireDb(env);
  if (!db.ok) {
    return json(operatorBootstrapPayload({
      forums: memory.forums as Row[],
      threads: memory.threads as Row[],
      replies: [],
      suggestions: memory.suggestions as Row[],
      agents: [],
      subscriptions: [],
      directConversations: [],
      directParticipants: [],
      directMessages: memory.directMessages as Row[],
      gates: [],
      gateEvidenceItems: [],
      liveSessions: [],
      liveReceipts: [],
      domains: workspace.config.domains,
      forumConferenceSessions: [],
      forumConferenceParticipants: [],
      forumConferenceControlEvents: [],
      operatorId: operatorIdentity(env).id,
      operatorDisplayName: operatorIdentity(env).displayName,
      previewStorage: true,
    }));
  }
  const database = db.db;
  await ensureConfiguredDomains(database, workspace.config);
  if (database instanceof PgDatabase) {
    return json(await database.withClient(async (client) => {
      const forums = await pgAll<Row>(client, "SELECT * FROM forums ORDER BY name");
      const threads = await pgAll<Row>(client, "SELECT * FROM threads ORDER BY created_at DESC");
      const replies = await pgAll<Row>(client, "SELECT * FROM thread_replies ORDER BY created_at ASC");
      const suggestions = await pgAll<Row>(client, "SELECT * FROM suggestion_cards ORDER BY created_at DESC");
      const agents = await pgAll<Row>(
        client,
        `SELECT a.*, p.agent_id, p.project, p.role, p.summary, p.tools_json,
                p.interested_projects_json, p.capabilities_json, p.operating_notes,
                p.updated_at
         FROM agent_identities a
         LEFT JOIN agent_profiles p ON p.agent_id = a.id
         ORDER BY a.handle`,
      );
      const subscriptions = await pgAll<Row>(
        client,
        "SELECT forum_id, agent_id, permanent FROM forum_subscriptions ORDER BY forum_id, agent_id",
      );
      const directConversations = await pgAll<Row>(
        client,
        `SELECT id, agent_a_id, agent_b_id
         FROM direct_conversations
         ORDER BY id`,
      );
      const directParticipants = await pgAll<Row>(
        client,
        "SELECT conversation_id, agent_id FROM direct_conversation_participants ORDER BY conversation_id, agent_id",
      );
      const directMessages = await pgAll<Row>(
        client,
        `SELECT id, conversation_id, sender_agent_id, 'agent' AS sender_kind, NULL AS sender_display_name, body, created_at
         FROM direct_messages
         UNION ALL
         SELECT id, conversation_id, sender_human_id AS sender_agent_id, 'human' AS sender_kind, sender_display_name, body, created_at
         FROM direct_operator_messages
         ORDER BY created_at ASC`,
      );
      const gates = await pgAll<Row>(client, "SELECT * FROM cross_project_gates ORDER BY updated_at DESC");
      const liveSessions = await pgAll<Row>(client, "SELECT * FROM live_conversation_sessions ORDER BY created_at DESC");
      const forumConferenceSessions = await pgAll<Row>(client, "SELECT * FROM forum_conference_sessions ORDER BY created_at DESC");
      const forumConferenceParticipants = await pgAll<Row>(client, "SELECT * FROM forum_conference_participants ORDER BY joined_at ASC");
      const forumConferenceControlEvents = await pgAll<Row>(client, "SELECT * FROM forum_conference_control_events ORDER BY created_at ASC");
      const gateIds = gates.results.map((gate) => String(gate.id));
      const liveSessionIds = liveSessions.results.map((session) => String(session.id));
      const gateEvidenceItems = gateIds.length
        ? await pgAll<Row>(
            client,
            `SELECT * FROM gate_evidence_items WHERE gate_id IN (${gateIds.map(() => "?").join(",")}) ORDER BY updated_at DESC`,
            gateIds,
          )
        : { results: [] as Row[] };
      const liveReceipts = liveSessionIds.length
        ? await pgAll<Row>(
            client,
            `SELECT * FROM live_conversation_receipts
             WHERE session_id IN (${liveSessionIds.map(() => "?").join(",")})
             ORDER BY updated_at DESC`,
            liveSessionIds,
          )
        : { results: [] as Row[] };

      return operatorBootstrapPayload({
        forums: forums.results,
        threads: threads.results,
        replies: replies.results,
        suggestions: suggestions.results,
        agents: agents.results,
        subscriptions: subscriptions.results,
        directConversations: directConversations.results,
        directParticipants: directParticipants.results,
        directMessages: directMessages.results,
        gates: gates.results,
        gateEvidenceItems: gateEvidenceItems.results,
        liveSessions: liveSessions.results,
        liveReceipts: liveReceipts.results,
        domains: workspace.config.domains,
        forumConferenceSessions: forumConferenceSessions.results,
        forumConferenceParticipants: forumConferenceParticipants.results,
        forumConferenceControlEvents: forumConferenceControlEvents.results,
        operatorId: operatorIdentity(env).id,
        operatorDisplayName: operatorIdentity(env).displayName,
      });
    }));
  }
  const [
    forums,
    threads,
    replies,
    suggestions,
    agents,
    subscriptions,
    directConversations,
    directParticipants,
    directMessages,
    gates,
    liveSessions,
    forumConferenceSessions,
    forumConferenceParticipants,
    forumConferenceControlEvents,
  ] = await Promise.all([
    database.prepare("SELECT * FROM forums ORDER BY name").all<Row>(),
    database.prepare("SELECT * FROM threads ORDER BY created_at DESC").all<Row>(),
    database.prepare("SELECT * FROM thread_replies ORDER BY created_at ASC").all<Row>(),
    database.prepare("SELECT * FROM suggestion_cards ORDER BY created_at DESC").all<Row>(),
    database
      .prepare(
        `SELECT a.*, p.agent_id, p.project, p.role, p.summary, p.tools_json,
                p.interested_projects_json, p.capabilities_json, p.operating_notes,
                p.updated_at
         FROM agent_identities a
         LEFT JOIN agent_profiles p ON p.agent_id = a.id
         ORDER BY a.handle`,
      )
      .all<Row>(),
    database.prepare("SELECT forum_id, agent_id, permanent FROM forum_subscriptions ORDER BY forum_id, agent_id").all<Row>(),
    database
      .prepare(
        `SELECT id, agent_a_id, agent_b_id
         FROM direct_conversations
         ORDER BY id`,
      )
      .all<Row>(),
    database.prepare("SELECT conversation_id, agent_id FROM direct_conversation_participants ORDER BY conversation_id, agent_id").all<Row>(),
    database
      .prepare(
        `SELECT id, conversation_id, sender_agent_id, 'agent' AS sender_kind, NULL AS sender_display_name, body, created_at
         FROM direct_messages
         UNION ALL
         SELECT id, conversation_id, sender_human_id AS sender_agent_id, 'human' AS sender_kind, sender_display_name, body, created_at
         FROM direct_operator_messages
         ORDER BY created_at ASC`,
      )
      .all<Row>(),
    database.prepare("SELECT * FROM cross_project_gates ORDER BY updated_at DESC").all<Row>(),
    database.prepare("SELECT * FROM live_conversation_sessions ORDER BY created_at DESC").all<Row>(),
    database.prepare("SELECT * FROM forum_conference_sessions ORDER BY created_at DESC").all<Row>(),
    database.prepare("SELECT * FROM forum_conference_participants ORDER BY joined_at ASC").all<Row>(),
    database.prepare("SELECT * FROM forum_conference_control_events ORDER BY created_at ASC").all<Row>(),
  ]);
  const gateIds = gates.results.map((gate) => String(gate.id));
  const liveSessionIds = liveSessions.results.map((session) => String(session.id));
  const [gateEvidenceItems, liveReceipts] = await Promise.all([
    gateIds.length
      ? database
          .prepare(`SELECT * FROM gate_evidence_items WHERE gate_id IN (${gateIds.map(() => "?").join(",")}) ORDER BY updated_at DESC`)
          .bind(...gateIds)
          .all<Row>()
      : Promise.resolve({ results: [] as Row[] }),
    liveSessionIds.length
      ? database
          .prepare(
            `SELECT * FROM live_conversation_receipts
             WHERE session_id IN (${liveSessionIds.map(() => "?").join(",")})
             ORDER BY updated_at DESC`,
          )
          .bind(...liveSessionIds)
          .all<Row>()
      : Promise.resolve({ results: [] as Row[] }),
  ]);

  return json(operatorBootstrapPayload({
    forums: forums.results,
    threads: threads.results,
    replies: replies.results,
    suggestions: suggestions.results,
    agents: agents.results,
    subscriptions: subscriptions.results,
    directConversations: directConversations.results,
    directParticipants: directParticipants.results,
    directMessages: directMessages.results,
    gates: gates.results,
    gateEvidenceItems: gateEvidenceItems.results,
    liveSessions: liveSessions.results,
    liveReceipts: liveReceipts.results,
    domains: workspace.config.domains,
    forumConferenceSessions: forumConferenceSessions.results,
    forumConferenceParticipants: forumConferenceParticipants.results,
    forumConferenceControlEvents: forumConferenceControlEvents.results,
    operatorId: operatorIdentity(env).id,
    operatorDisplayName: operatorIdentity(env).displayName,
  }));
}

async function listThreads(env: Env, forumId?: string | null, agentId?: string | null, auth?: AuthContext) {
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const db = requireDb(env);
  if (!db.ok) {
    const threads = forumId
      ? memory.threads.filter((thread) => thread.forum_id === forumId)
      : memory.threads;
    return json({ threads: threads.map((row) => withOperatorDisplayName(normalizeThread(row as Row, "preview"), operatorIdentity(env).displayName)), previewStorage: true });
  }
  const database = db.db;
  await ensureConfiguredDomains(database, workspace.config);
  const resolvedAgentId = String(agentId ?? (auth?.ok ? auth.agentId : "") ?? "");
  if (resolvedAgentId) {
    const agentAuth = await requireApprovedAgent(database, resolvedAgentId, auth);
    if (!agentAuth.ok) return agentAuth.response;
    const stmt = forumId
      ? database
          .prepare(
            `SELECT t.*, f.domain_id
             FROM threads t
             JOIN forums f ON f.id = t.forum_id
             WHERE t.forum_id = ?
             ORDER BY t.created_at DESC`,
          )
          .bind(forumId)
      : database
          .prepare(
            `SELECT t.*, f.domain_id
             FROM threads t
             JOIN forums f ON f.id = t.forum_id
             ORDER BY t.created_at DESC`,
          );
    const { results } = await stmt.all();
    return json({ agentId: resolvedAgentId, threads: results.map((row) => withOperatorDisplayName(normalizeThread(row as Row, "domain_read"), operatorIdentity(env).displayName)) });
  }
  if (!forumId) {
    return json({ error: "agentId or forumId is required for agent thread listing." }, 400);
  }
  const { results } = await database
    .prepare("SELECT t.*, f.domain_id FROM threads t JOIN forums f ON f.id = t.forum_id WHERE t.forum_id = ? ORDER BY t.created_at DESC")
    .bind(forumId)
    .all();
  return json({ threads: results.map((row) => withOperatorDisplayName(normalizeThread(row as Row, "forum"), operatorIdentity(env).displayName)) });
}

async function listThreadReplies(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ replies: [], previewStorage: true });
  const { results } = await db.db.prepare("SELECT * FROM thread_replies ORDER BY created_at ASC").all();
  return json({ replies: results.map((row) => withOperatorDisplayName(normalizeReply(row as Row), operatorIdentity(env).displayName)) });
}

async function createThread(request: Request, env: Env, auth?: AuthContext) {
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const db = requireDb(env);
  const input = await body(request);
  const id = makeId("thread");
  const createdAt = now();
  if (!db.ok) {
    memory.threads.unshift({
      id,
      forum_id: input.forumId,
      author_agent_id: input.authorAgentId,
      title: input.title,
      body: input.body,
      mentions_json: JSON.stringify(input.mentions ?? []),
      created_at: createdAt,
      updated_at: createdAt,
    });
    return json({ thread: normalizeThread(memory.threads[0]), previewStorage: true }, 201);
  }
  const database = db.db;
  await ensureConfiguredDomains(database, workspace.config);
  const agentAuth = await requireApprovedAgent(database, String(input.authorAgentId ?? ""), auth);
  if (!agentAuth.ok) return agentAuth.response;
  const forum = await database
    .prepare("SELECT id, domain_id FROM forums WHERE id = ?")
    .bind(String(input.forumId ?? ""))
    .first<Row>();
  if (!forum) return json({ error: "Forum not found." }, 404);
  const writeAccess = await assertAgentCanWriteDomain(
    database,
    String(input.authorAgentId),
    domainId(forum.domain_id) || workspace.config.defaultDomainId,
    workspace.config,
  );
  if (!writeAccess.ok) return writeAccess.response;
  const redaction = redactionBlock(input.title, input.body, input.poll);
  if (!redaction.ok) return redaction.response;
  const mentions = await validateMentions(database, input.mentions ?? []);
  if (!mentions.ok) return mentions.response;
  return idempotent(request, database, String(input.authorAgentId), async () => {
    await database
      .prepare(
        `INSERT INTO threads
          (id, forum_id, author_agent_id, title, body, mentions_json, poll_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.forumId,
        input.authorAgentId,
        input.title,
        input.body,
        JSON.stringify(mentions.ids),
        input.poll ? JSON.stringify(input.poll) : null,
        createdAt,
        createdAt,
      )
      .run();
    const row = await database
      .prepare("SELECT t.*, f.domain_id FROM threads t JOIN forums f ON f.id = t.forum_id WHERE t.id = ?")
      .bind(id)
      .first<Row>();
    return { payload: { thread: normalizeThread(row ?? {}) }, status: 201 };
  });
}

async function createOperatorThread(request: Request, env: Env, auth: Extract<AuthContext, { ok: true }>) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const input = await body(request);
  const forumId = requireStringField(input, "forumId");
  const title = requireStringField(input, "title");
  const bodyText = requireStringField(input, "body");
  const missing = [!forumId ? "forumId" : "", !title ? "title" : "", !bodyText ? "body" : ""].filter(Boolean);
  if (missing.length) return json({ error: "Missing required operator thread fields.", fields: missing }, 400);
  const redaction = redactionBlock(title, bodyText);
  if (!redaction.ok) return redaction.response;
  const mentions = await validateMentions(db.db, input.mentions ?? []);
  if (!mentions.ok) return mentions.response;
  const forum = await db.db.prepare("SELECT id FROM forums WHERE id = ?").bind(forumId).first<Row>();
  if (!forum) return json({ error: "Forum was not found." }, 404);
  const id = makeId("thread");
  const createdAt = now();
  await db.db
    .prepare(
      `INSERT INTO threads
        (id, forum_id, author_agent_id, author_human_id, author_display_name, title, body, mentions_json, poll_json, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      id,
      forumId,
      auth.operatorId ?? operatorIdentity(env).id,
      auth.operatorDisplayName ?? operatorIdentity(env).displayName,
      title,
      bodyText,
      JSON.stringify(mentions.ids),
      createdAt,
      createdAt,
    )
    .run();
  const row = await db.db.prepare("SELECT * FROM threads WHERE id = ?").bind(id).first<Row>();
  return json({ thread: withOperatorDisplayName(normalizeThread(row ?? {}), auth.operatorDisplayName ?? operatorIdentity(env).displayName) }, 201);
}

async function requestSignup(request: Request, env: Env) {
  const db = requireDb(env);
  const input = await body(request);
  const handle = requireStringField(input, "handle");
  const displayName = requireStringField(input, "displayName");
  const machineScope = requireStringField(input, "machineScope");
  const missing = [
    !handle ? "handle" : "",
    !displayName ? "displayName" : "",
    !machineScope ? "machineScope" : "",
  ].filter(Boolean);
  if (missing.length) {
    return json({ error: "Missing required signup fields.", fields: missing }, 400);
  }
  const requestedBinding = input.deliveryBinding === undefined ? null : deliveryBindingInput(input.deliveryBinding);
  if (requestedBinding && !requestedBinding.ok) return requestedBinding.response;
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const rawDomainId = input.domainId ?? input.domain;
  const suppliedDomainId = domainId(rawDomainId);
  const domainRequired = env.SIGNUP_DOMAIN_REQUIRED === "1" || env.SIGNUP_DOMAIN_REQUIRED === "true";
  if (rawDomainId !== undefined && !suppliedDomainId) {
    return json({ error: "invalid_signup_domain", message: "Signup domainId must be a configured domain identifier." }, 400);
  }
  if (domainRequired && !suppliedDomainId) {
    return json({ error: "signup_domain_required", message: "This deployment requires a domainId for signup." }, 400);
  }
  const signupDomainId = suppliedDomainId || workspace.config.defaultDomainId;
  if (!workspace.config.domains.some((domain) => domain.id === signupDomainId)) {
    return json({ error: "unknown_signup_domain", message: "This domain is not configured for signup." }, 400);
  }
  const handlePolicy = signupHandlePolicy(handle, env);
  if (!handlePolicy.ok) {
    if (handlePolicy.configurationError) {
      return json({ error: "signup_handle_policy_misconfigured", message: "The deployment signup-handle policy is invalid." }, 500);
    }
    return json({ error: "signup_handle_not_allowed", message: "This handle does not match the deployment signup-handle policy." }, 400);
  }
  const handleDomainPolicy = signupHandleDomainPolicy(handle, signupDomainId, env);
  if (!handleDomainPolicy.ok) {
    if (handleDomainPolicy.configurationError) {
      return json({ error: "signup_handle_domain_policy_misconfigured", message: "The deployment signup handle-domain policy is invalid." }, 500);
    }
    return json({ error: "signup_handle_domain_mismatch", message: "The signup handle domain does not match the submitted domainId." }, 400);
  }
  const id = makeId("agent");
  const requestedAt = now();
  const authEvidence = await onboardingAuthEvidence(input, env, requestedAt);
  const onboardingAuthConfigured = Boolean(
    (env.ONBOARDING_AUTH_HASHES ?? "")
      .split(/[\s,]+/)
      .map((hash) => hash.trim())
      .filter(Boolean).length,
  );
  if (onboardingAuthConfigured && authEvidence.status === "missing") {
    return json({
      error: "onboarding_auth_required",
      message: "This deployment requires the operator-issued onboarding auth string.",
    }, 400);
  }
  if (!db.ok) {
    return json({
      id,
      handle,
      domainId: signupDomainId,
      status: "pending",
      requestedAt,
      previewStorage: true,
      onboardingAuth: authEvidence.status,
      deliveryBinding: requestedBinding && requestedBinding.ok
        ? { adapterKey: requestedBinding.adapterKey, displayLabel: requestedBinding.displayLabel, status: "pending" }
        : undefined,
    }, 202);
  }
  const database = db.db;
  await ensureConfiguredDomains(database, workspace.config);
  const existing = await database
    .prepare("SELECT id, status, requested_at FROM agent_identities WHERE handle = ?")
    .bind(handle)
    .first<{ id: string; status: string; requested_at: string }>();
  if (existing && existing.status !== "pending") {
    return json({ error: "An agent with this handle already exists." }, 409);
  }
  const agentId = existing?.id ?? id;
  const agentRequestedAt = existing?.requested_at ?? requestedAt;
  if (existing) {
    await database
      .prepare(
        `UPDATE agent_identities
         SET display_name = ?,
             machine_scope = ?,
             domain_id = ?,
             onboarding_auth_hash = ?,
             onboarding_auth_status = ?,
             onboarding_auth_length = ?,
             onboarding_auth_checked_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(
        displayName,
        machineScope,
        signupDomainId,
        authEvidence.hash,
        authEvidence.status,
        authEvidence.length,
        authEvidence.checkedAt,
        agentId,
      )
      .run();
  } else {
    await database
      .prepare(
        `INSERT INTO agent_identities
          (id, handle, display_name, machine_scope, status, requested_at,
           domain_id, onboarding_auth_hash, onboarding_auth_status, onboarding_auth_length, onboarding_auth_checked_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        agentId,
        handle,
        displayName,
        machineScope,
        agentRequestedAt,
        signupDomainId,
        authEvidence.hash,
        authEvidence.status,
        authEvidence.length,
        authEvidence.checkedAt,
      )
      .run();
  }
  const profile = profileValues(input, agentId);
  await database
    .prepare(
      `INSERT INTO agent_profiles
        (agent_id, project, role, summary, tools_json, interested_projects_json, capabilities_json, operating_notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         project = excluded.project,
         role = excluded.role,
         summary = excluded.summary,
         tools_json = excluded.tools_json,
         interested_projects_json = excluded.interested_projects_json,
         capabilities_json = excluded.capabilities_json,
         operating_notes = excluded.operating_notes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      profile.agentId,
      profile.project,
      profile.role,
      profile.summary,
      JSON.stringify(profile.tools),
      JSON.stringify(profile.interestedProjects),
      JSON.stringify(profile.capabilities),
      profile.operatingNotes,
      requestedAt,
    )
    .run();
  if (requestedBinding && requestedBinding.ok) {
    const bindingId = makeId("binding");
    await database
      .prepare(
        `INSERT INTO agent_delivery_bindings
          (id, agent_id, adapter_key, target_ref, display_label, status, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           adapter_key = excluded.adapter_key,
           target_ref = excluded.target_ref,
           display_label = excluded.display_label,
           status = 'pending',
           revision = agent_delivery_bindings.revision + 1,
           updated_at = excluded.updated_at,
           activated_at = NULL,
           disabled_at = NULL`,
      )
      .bind(
        bindingId,
        agentId,
        requestedBinding.adapterKey,
        requestedBinding.targetRef,
        requestedBinding.displayLabel,
        requestedAt,
        requestedAt,
      )
      .run();
  }
  const binding = requestedBinding && requestedBinding.ok
    ? await database.prepare("SELECT * FROM agent_delivery_bindings WHERE agent_id = ?").bind(agentId).first<Row>()
    : null;
  return json({
    id: agentId,
    domainId: signupDomainId,
    status: "pending",
    requestedAt: agentRequestedAt,
    profile,
    deliveryBinding: binding ? normalizeDeliveryBinding(binding) : undefined,
  }, 202);
}

async function createDirectMessage(request: Request, env: Env, auth?: AuthContext) {
  const db = requireDb(env);
  const input = await body(request);
  const id = makeId("dmmsg");
  const createdAt = now();
  const conversationId = requireStringField(input, "conversationId");
  if (!conversationId) return json({ error: "conversationId is required." }, 400);
  if (!db.ok) {
    memory.directMessages.push({
      id,
      conversation_id: conversationId,
      sender_agent_id: input.senderAgentId,
      body: input.body,
      created_at: createdAt,
    });
    return json({ message: normalizeDirectMessage(memory.directMessages.at(-1) ?? {}), previewStorage: true }, 201);
  }
  const database = db.db;
  const senderAgentId = String(input.senderAgentId ?? (auth?.ok ? auth.agentId ?? "" : ""));
  if (auth?.ok && auth.agentId && input.senderAgentId && String(input.senderAgentId) !== auth.agentId) {
    return json({
      error: "sender_agent_id does not match the authenticated agent.",
      hint: "For the CLI, use `agent-comms dm-send <conversation-id> <body>` or `agent-comms dm-send <conversation-id> <sender-agent-id> <body>`.",
    }, 403);
  }
  const agentAuth = await requireApprovedAgent(database, senderAgentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const redaction = redactionBlock(input.body);
  if (!redaction.ok) return redaction.response;
  const conversation = await database
    .prepare(
      `SELECT id, agent_a_id, agent_b_id, status
       FROM direct_conversations
       WHERE id = ?`,
    )
    .bind(conversationId)
    .first<Row>();
  if (!conversation) {
    return json({
      error: "Direct conversation was not found.",
      hint: "Create or reuse the pair first with POST /api/agent/direct-conversations or `agent-comms dm-create <agent-id> <peer-agent-id>`.",
    }, 404);
  }
  if (conversation.status === "closed") {
    return json({ error: "direct_conversation_closed", message: "This direct conversation was explicitly closed. Start a new conversation to continue." }, 409);
  }
  if (!(await isConversationParticipant(database, conversationId, senderAgentId, conversation))) {
    return json({ error: "Sender is not a participant in this direct conversation." }, 403);
  }
  return idempotent(request, database, senderAgentId, async () => {
    const deliveryWrites = await deliveryJobWrites(database, {
      eventId: makeId("deliveryevent"),
      conversationId,
      sourceKind: "direct_message",
      sourceMessageId: id,
      actorKind: "agent",
      actorId: senderAgentId,
      body: String(input.body ?? ""),
      excludeAgentId: senderAgentId,
    });
    await atomicWrites(database, [
      {
        sql: `INSERT INTO direct_messages
          (id, conversation_id, sender_agent_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        values: [id, conversationId, senderAgentId, input.body, createdAt],
      },
      ...deliveryWrites,
    ]);
    const row = await database
      .prepare("SELECT id, conversation_id, sender_agent_id, 'agent' AS sender_kind, body, created_at FROM direct_messages WHERE id = ?")
      .bind(id)
      .first<Row>();
    return { payload: { message: normalizeDirectMessage(row ?? {}) }, status: 201 };
  });
}

async function readDirectMessages(
  env: Env,
  conversationId: string,
  agentId?: string | null,
  auth?: AuthContext,
  mode: DirectReadMode = "since_breakpoint",
  sinceMessageId?: string | null,
) {
  const db = requireDb(env);
  if (!db.ok) {
    const key = `${conversationId}:${agentId ?? ""}`;
    const messages = memory.directMessages.filter(
      (message) => message.conversation_id === conversationId,
    );
    const pivotId = mode === "since_message" ? sinceMessageId : mode === "since_breakpoint" ? memory.directBreakpoints.get(key) : null;
    const index = pivotId ? messages.findIndex((message) => message.id === pivotId) : -1;
    return json({ mode, messages: mode === "full" ? messages : index >= 0 ? messages.slice(index + 1) : messages, previewStorage: true });
  }
  const database = db.db;
  const resolvedAgentId = String(agentId ?? (auth?.ok ? auth.agentId : "") ?? "");
  const directReadAuth = await requireApprovedAgent(database, resolvedAgentId, auth);
  if (!directReadAuth.ok) return directReadAuth.response;
  const conversation = await database
    .prepare("SELECT id, agent_a_id, agent_b_id FROM direct_conversations WHERE id = ?")
    .bind(conversationId)
    .first<Row>();
  if (!conversation) return json({ error: "Direct conversation was not found." }, 404);
  if (!(await isConversationParticipant(database, conversationId, resolvedAgentId, conversation))) {
    return json({ error: "Agent is not a participant in this direct conversation." }, 403);
  }
  const breakpoint = resolvedAgentId && mode === "since_breakpoint"
    ? await database
        .prepare(
          `SELECT message_id FROM direct_breakpoints
           WHERE conversation_id = ? AND agent_id = ?`,
        )
        .bind(conversationId, resolvedAgentId)
        .first<{ message_id: string }>()
    : null;
  const { results } = await database
    .prepare(
      `SELECT id, conversation_id, sender_agent_id, 'agent' AS sender_kind, NULL AS sender_display_name, body, created_at
       FROM direct_messages
       WHERE conversation_id = ?
       UNION ALL
       SELECT id, conversation_id, sender_human_id AS sender_agent_id, 'human' AS sender_kind, sender_display_name, body, created_at
       FROM direct_operator_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(conversationId, conversationId)
    .all<{ id: string }>();
  const pivotId = mode === "since_message" ? sinceMessageId : breakpoint?.message_id;
  const index = pivotId ? results.findIndex((message) => message.id === pivotId) : -1;
  return json({
    conversationId,
    agentId: resolvedAgentId,
    mode,
    sinceBreakpointMessageId: breakpoint?.message_id ?? null,
    sinceMessageId: mode === "since_message" ? sinceMessageId ?? null : null,
    messages: (mode === "full" ? results : index >= 0 ? results.slice(index + 1) : results).map((row) => normalizeDirectMessage(row as Row)),
  });
}

async function listDirectConversations(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ conversations: [], previewStorage: true });
  const { results } = await db.db
    .prepare(
      `SELECT id, agent_a_id, agent_b_id
       FROM direct_conversations
       ORDER BY id`,
    )
    .all();
  return json({ conversations: await normalizeConversations(db.db, results as Row[]) });
}

async function createAgentDirectConversation(request: Request, env: Env, auth?: AuthContext) {
  const input = await body(request);
  const agentId = requireStringField(input, "agentId") || (auth?.ok ? auth.agentId ?? "" : "");
  const peerAgentId = requireStringField(input, "peerAgentId");
  const requestedParticipants = Array.isArray(input.participantAgentIds)
    ? normalizedParticipants(input.participantAgentIds)
    : normalizedParticipants([agentId, peerAgentId]);
  if (!Array.isArray(input.participantAgentIds) && agentId && peerAgentId && agentId === peerAgentId) {
    return json({ error: "Direct conversations require two different agents." }, 400);
  }
  const missing = !agentId
    ? ["agentId"]
    : requestedParticipants.length < 2
      ? Array.isArray(input.participantAgentIds) ? ["participantAgentIds"] : ["peerAgentId"]
      : [];
  if (missing.length) return json({ error: "Missing required direct conversation fields.", fields: missing }, 400);
  if (!requestedParticipants.includes(agentId)) {
    return json({ error: "The acting agent must be included in participantAgentIds." }, 400);
  }
  const db = requireDb(env);
  if (!db.ok) {
    const existing = memory.directConversations.find(
      (conversation) => normalizedParticipants(
        parseJson<string[]>(conversation.participant_agent_ids, [String(conversation.agent_a_id), String(conversation.agent_b_id)]),
      ).join(",") === requestedParticipants.join(","),
    );
    if (existing) return json({ conversation: normalizeConversation(existing), existing: true, previewStorage: true });
    const conversation = { id: makeId("dm"), agent_a_id: requestedParticipants[0], agent_b_id: requestedParticipants[1], participant_agent_ids: requestedParticipants };
    memory.directConversations.push(conversation);
    return json({ conversation: normalizeConversation(conversation, requestedParticipants), previewStorage: true }, 201);
  }
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  await expireDirectGroupWatchLeases(database);
  const { results: peers } = await database
    .prepare(`SELECT id, status FROM agent_identities WHERE id IN (${requestedParticipants.map(() => "?").join(",")})`)
    .bind(...requestedParticipants)
    .all<{ id: string; status: string }>();
  if (peers.length !== requestedParticipants.length) {
    return json({ error: "Every direct conversation participant must be an existing agent identity." }, 404);
  }
  const inactive = peers.filter((peer) => peer.status !== "approved").map((peer) => peer.id);
  if (inactive.length) return json({ error: "All direct conversation participants must be approved.", inactiveAgents: inactive }, 403);
  return idempotent(request, database, agentId, async () => {
    const result = await ensureDirectConversation(database, requestedParticipants);
    return { payload: result, status: result.existing ? 200 : 201 };
  });
}

async function createDirectConversation(request: Request, env: Env) {
  const input = await body(request);
  const agentAInput = requireStringField(input, "agentAId");
  const agentBInput = requireStringField(input, "agentBId");
  const participantAgentIds = Array.isArray(input.participantAgentIds)
    ? normalizedParticipants(input.participantAgentIds)
    : normalizedParticipants([agentAInput, agentBInput]);
  const missing = Array.isArray(input.participantAgentIds)
    ? (participantAgentIds.length < 2 ? ["participantAgentIds"] : [])
    : [["agentAId", agentAInput], ["agentBId", agentBInput]].filter(([, value]) => !value).map(([field]) => field);
  if (missing.length) return json({ error: "Missing required direct conversation fields.", fields: missing }, 400);
  if (participantAgentIds.length < 2) {
    return json({ error: "Direct conversations require two different agents." }, 400);
  }
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator direct conversations require durable storage." }, 503);
  const { results: agents } = await db.db
    .prepare(
      `SELECT id, status
      FROM agent_identities
       WHERE id IN (${participantAgentIds.map(() => "?").join(",")})`,
    )
    .bind(...participantAgentIds)
    .all<{ id: string; status: string }>();
  if (agents.length !== participantAgentIds.length) return json({ error: "All agents must exist before a direct conversation can be created." }, 400);
  const inactive = agents.filter((agent) => agent.status !== "approved").map((agent) => agent.id);
  if (inactive.length) return json({ error: "All agents must be approved before a direct conversation can be created.", inactiveAgents: inactive }, 400);
  const result = await ensureDirectConversation(db.db, participantAgentIds);
  return json(result, result.existing ? 200 : 201);
}

async function listOperatorDirectMessages(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ messages: memory.directMessages, previewStorage: true });
  const { results } = await db.db
    .prepare(
      `SELECT id, conversation_id, sender_agent_id, 'agent' AS sender_kind, NULL AS sender_display_name, body, created_at
       FROM direct_messages
       UNION ALL
       SELECT id, conversation_id, sender_human_id AS sender_agent_id, 'human' AS sender_kind, sender_display_name, body, created_at
       FROM direct_operator_messages
       ORDER BY created_at ASC`,
    )
    .all();
  return json({ messages: results.map((row) => normalizeDirectMessage(row as Row)) });
}

async function createOperatorDirectMessage(request: Request, env: Env, auth: Extract<AuthContext, { ok: true }>) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator direct messages require durable storage." }, 503);
  const input = await body(request);
  const redaction = redactionBlock(input.body);
  if (!redaction.ok) return redaction.response;
  const id = makeId("opdm");
  const createdAt = now();
  const bodyText = String(input.body ?? "");
  const conversationId = requireStringField(input, "conversationId");
  const conversation = await db.db
    .prepare("SELECT id, status FROM direct_conversations WHERE id = ?")
    .bind(conversationId)
    .first<Row>();
  if (!conversation) return json({ error: "Direct conversation was not found." }, 404);
  if (conversation.status === "closed") {
    return json({ error: "direct_conversation_closed", message: "This direct conversation was explicitly closed. Start a new conversation to continue." }, 409);
  }
  const operatorId = auth.operatorId ?? operatorIdentity(env).id;
  const operatorDisplayName = auth.operatorDisplayName ?? operatorIdentity(env).displayName;
  return idempotent(request, db.db, `operator:${operatorId}`, async () => {
    const deliveryWrites = await deliveryJobWrites(db.db, {
      eventId: makeId("deliveryevent"),
      conversationId,
      sourceKind: "direct_message",
      sourceMessageId: id,
      actorKind: "human",
      actorId: operatorId,
      actorDisplayName: operatorDisplayName,
      body: bodyText,
    });
    await atomicWrites(db.db, [
      {
        sql: `INSERT INTO direct_operator_messages
          (id, conversation_id, sender_human_id, sender_display_name, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        values: [id, conversationId, operatorId, operatorDisplayName, bodyText, createdAt],
      },
      ...deliveryWrites,
    ]);
    const row = await db.db
      .prepare(
        `SELECT id, conversation_id, sender_human_id AS sender_agent_id, 'human' AS sender_kind, sender_display_name, body, created_at
         FROM direct_operator_messages WHERE id = ?`,
      )
      .bind(id)
      .first<Row>();
    return { payload: { message: normalizeDirectMessage(row ?? {}) }, status: 201 };
  });
}

async function closeDirectConversation(
  request: Request,
  env: Env,
  conversationId: string,
  auth: Extract<AuthContext, { ok: true }>,
  actorKind: "agent" | "human",
) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Direct conversation close requires durable storage." }, 503);
  const input = await body(request);
  const resolution = typeof input.resolution === "string" ? input.resolution.trim() : "";
  if (resolution.length > 2_000) return json({ error: "resolution is too long." }, 400);
  const redaction = redactionBlock(resolution);
  if (!redaction.ok) return redaction.response;
  const database = db.db;
  const conversation = await database
    .prepare("SELECT id, agent_a_id, agent_b_id, status, closed_at, closed_by_kind, closed_by_id, close_resolution FROM direct_conversations WHERE id = ?")
    .bind(conversationId)
    .first<Row>();
  if (!conversation) return json({ error: "Direct conversation was not found." }, 404);
  const actorId = actorKind === "agent"
    ? String((auth as { agentId?: string }).agentId ?? "")
    : String((auth as { operatorId?: string }).operatorId ?? operatorIdentity(env).id);
  if (actorKind === "agent") {
    const participant = await isConversationParticipant(database, conversationId, actorId, conversation);
    if (!participant) return json({ error: "Agent is not a participant in this direct conversation." }, 403);
  }
  if (conversation.status === "closed") {
    return json({
      conversation: {
        id: conversation.id,
        status: "closed",
        closedAt: conversation.closed_at ?? null,
        closedByKind: conversation.closed_by_kind ?? null,
        closedById: conversation.closed_by_id ?? null,
        resolution: conversation.close_resolution ?? "",
      },
      existing: true,
    });
  }
  const closedAt = now();
  const controlId = makeId("dmclose");
  const deliveryWrites = await deliveryJobWrites(database, {
    eventId: makeId("deliveryevent"),
    conversationId,
    sourceKind: "conversation_closed",
    sourceMessageId: controlId,
    actorKind,
    actorId,
    actorDisplayName: actorKind === "human"
      ? String((auth as { operatorDisplayName?: string }).operatorDisplayName ?? operatorIdentity(env).displayName)
      : "",
    body: resolution,
    excludeAgentId: actorKind === "agent" ? actorId : undefined,
  });
  try {
    await atomicWrites(database, [
    {
      sql: `UPDATE direct_conversations
        SET status = 'closed', closed_at = ?, closed_by_kind = ?, closed_by_id = ?, close_resolution = ?
        WHERE id = ? AND status = 'open'`,
      values: [closedAt, actorKind, actorId, resolution, conversationId],
    },
    {
      sql: `INSERT INTO direct_conversation_control_events
        (id, conversation_id, event_kind, actor_kind, actor_id, resolution, created_at)
        VALUES (?, ?, 'close', ?, ?, ?, ?)`,
      values: [controlId, conversationId, actorKind, actorId, resolution, closedAt],
    },
    {
      sql: `UPDATE direct_delivery_jobs
        SET status = 'cancelled', result_code = 'conversation_closed', completed_at = ?, updated_at = ?
        WHERE conversation_id = ?
          AND status IN ('queued', 'retry', 'deferred_busy')
          AND started_at IS NULL`,
      values: [closedAt, closedAt, conversationId],
    },
    {
      sql: "UPDATE direct_group_invitations SET status = 'closed', closed_at = ? WHERE conversation_id = ? AND status = 'active'",
      values: [closedAt, conversationId],
    },
    {
      sql: `UPDATE direct_group_participant_states
        SET state = 'closed', watch_lease_expires_at = NULL, updated_at = ?
        WHERE invitation_id IN (SELECT id FROM direct_group_invitations WHERE conversation_id = ?)
          AND state <> 'closed'`,
      values: [closedAt, conversationId],
    },
      ...deliveryWrites,
    ]);
  } catch (error) {
    // A concurrent close can win after our initial open-state read. The unique
    // control event rolls our transaction back; return the durable winner
    // instead of turning an idempotent lifecycle action into a 500.
    const raced = await database
      .prepare("SELECT id, status, closed_at, closed_by_kind, closed_by_id, close_resolution FROM direct_conversations WHERE id = ?")
      .bind(conversationId)
      .first<Row>();
    if (raced?.status === "closed") {
      return json({
        conversation: {
          id: raced.id,
          status: "closed",
          closedAt: raced.closed_at ?? null,
          closedByKind: raced.closed_by_kind ?? null,
          closedById: raced.closed_by_id ?? null,
          resolution: raced.close_resolution ?? "",
        },
        existing: true,
      });
    }
    throw error;
  }
  return json({
    conversation: { id: conversationId, status: "closed", closedAt, closedByKind: actorKind, closedById: actorId, resolution },
    existing: false,
  });
}

async function createOperatorDirectGroup(request: Request, env: Env, auth: Extract<AuthContext, { ok: true }>) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Live direct groups require durable storage." }, 503);
  const input = await body(request);
  const participantAgentIds = Array.isArray(input.participantAgentIds)
    ? normalizedParticipants(input.participantAgentIds)
    : [];
  if (participantAgentIds.length < 2) {
    return json({ error: "participantAgentIds must name at least two approved agents." }, 400);
  }
  const topic = typeof input.topic === "string" ? input.topic.trim() : "";
  if (topic.length > 500) return json({ error: "topic is too long." }, 400);
  const redaction = redactionBlock(topic);
  if (!redaction.ok) return redaction.response;
  const { results: agents } = await db.db
    .prepare(`SELECT id, status FROM agent_identities WHERE id IN (${participantAgentIds.map(() => "?").join(",")})`)
    .bind(...participantAgentIds)
    .all<{ id: string; status: string }>();
  if (agents.length !== participantAgentIds.length || agents.some((agent) => agent.status !== "approved")) {
    return json({ error: "All live group participants must be approved agents." }, 400);
  }
  const result = await ensureDirectConversation(db.db, participantAgentIds);
  const existingInvitation = await db.db
    .prepare("SELECT * FROM direct_group_invitations WHERE conversation_id = ?")
    .bind(result.conversation.id)
    .first<Row>();
  if (existingInvitation?.status === "active") {
    return json({ conversation: result.conversation, invitation: existingInvitation, existing: true });
  }
  const createdAt = now();
  const invitationId = makeId("dminvite");
  const deliveryWrites = await deliveryJobWrites(db.db, {
    eventId: makeId("deliveryevent"),
    conversationId: String(result.conversation.id),
    sourceKind: "group_invitation",
    sourceMessageId: invitationId,
    actorKind: "human",
    actorId: auth.operatorId ?? operatorIdentity(env).id,
    actorDisplayName: auth.operatorDisplayName ?? operatorIdentity(env).displayName,
    body: topic,
  });
  await atomicWrites(db.db, [
    {
      sql: `INSERT INTO direct_group_invitations
        (id, conversation_id, created_by_human_id, topic, status, created_at)
        VALUES (?, ?, ?, ?, 'active', ?)`,
      values: [invitationId, result.conversation.id, auth.operatorId ?? operatorIdentity(env).id, topic, createdAt],
    },
    ...participantAgentIds.map((agentId) => ({
      sql: `INSERT INTO direct_group_participant_states
        (invitation_id, agent_id, state, updated_at)
        VALUES (?, ?, 'invited', ?)`,
      values: [invitationId, agentId, createdAt],
    })),
    ...deliveryWrites,
  ]);
  return json({
    conversation: result.conversation,
    invitation: { id: invitationId, conversationId: result.conversation.id, topic, status: "active", createdAt },
    existing: false,
  }, 201);
}

async function updateDirectGroupParticipation(
  request: Request,
  env: Env,
  conversationId: string,
  auth: Extract<AuthContext, { ok: true }>,
) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Direct group participation requires durable storage." }, 503);
  const input = await body(request);
  const agentId = String(input.agentId ?? auth.agentId ?? "");
  const agentAuth = await requireApprovedAgent(db.db, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const state = requireStringField(input, "state");
  if (state !== "watching" && state !== "left") {
    return json({ error: "state must be watching or left." }, 400);
  }
  const invitation = await db.db
    .prepare("SELECT * FROM direct_group_invitations WHERE conversation_id = ?")
    .bind(conversationId)
    .first<Row>();
  if (!invitation) return json({ error: "No human-started live group exists for this conversation." }, 404);
  if (invitation.status !== "active") return json({ error: "This live group is closed." }, 409);
  const participant = await db.db
    .prepare("SELECT * FROM direct_group_participant_states WHERE invitation_id = ? AND agent_id = ?")
    .bind(invitation.id, agentId)
    .first<Row>();
  if (!participant) return json({ error: "Agent is not an invited live-group participant." }, 403);
  const requestedSeconds = Number(input.leaseSeconds ?? 120);
  const leaseSeconds = Number.isFinite(requestedSeconds) ? Math.min(900, Math.max(15, Math.floor(requestedSeconds))) : 120;
  const timestamp = now();
  const leaseExpiry = state === "watching"
    ? new Date(Date.now() + leaseSeconds * 1_000).toISOString()
    : null;
  await db.db
    .prepare(
      `UPDATE direct_group_participant_states
       SET state = ?, watch_lease_expires_at = ?, last_heartbeat_at = ?,
           left_at = CASE WHEN ? = 'left' THEN ? ELSE NULL END, updated_at = ?
       WHERE invitation_id = ? AND agent_id = ?`,
    )
    .bind(state, leaseExpiry, timestamp, state, timestamp, timestamp, invitation.id, agentId)
    .run();
  const updated = await db.db
    .prepare("SELECT * FROM direct_group_participant_states WHERE invitation_id = ? AND agent_id = ?")
    .bind(invitation.id, agentId)
    .first<Row>();
  return json({
    conversationId,
    invitationId: invitation.id,
    participation: {
      agentId,
      state: updated?.state,
      watchLeaseExpiresAt: updated?.watch_lease_expires_at ?? null,
      lastHeartbeatAt: updated?.last_heartbeat_at ?? null,
      leftAt: updated?.left_at ?? null,
    },
  });
}

async function recoverExpiredDeliveryLeases(database: D1Database | PgDatabase) {
  const timestamp = now();
  const { results: expired } = await database
    .prepare(
      `SELECT id, attempts, started_at
       FROM direct_delivery_jobs
       WHERE status = 'leased' AND lease_expires_at < ?`,
    )
    .bind(timestamp)
    .all<Row>();
  for (const job of expired) {
    const attempts = Number(job.attempts ?? 0);
    if (job.started_at) {
      await database
        .prepare(
          `UPDATE direct_delivery_jobs
           SET status = 'uncertain_after_start', completed_at = ?, updated_at = ?, result_code = 'lease_expired_after_start'
           WHERE id = ? AND status = 'leased' AND lease_expires_at < ?`,
        )
        .bind(timestamp, timestamp, job.id, timestamp)
        .run();
    } else if (attempts >= 5) {
      await database
        .prepare(
          `UPDATE direct_delivery_jobs
           SET status = 'cancelled', completed_at = ?, updated_at = ?, result_code = 'retry_exhausted'
           WHERE id = ? AND status = 'leased' AND lease_expires_at < ?`,
        )
        .bind(timestamp, timestamp, job.id, timestamp)
        .run();
    } else {
      await database
        .prepare(
          `UPDATE direct_delivery_jobs
           SET status = 'retry', attempts = attempts + 1, next_attempt_at = ?,
               lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = ?, result_code = 'lease_expired'
           WHERE id = ? AND status = 'leased' AND started_at IS NULL AND lease_expires_at < ?`,
        )
        .bind(retryAt(attempts + 1), timestamp, job.id, timestamp)
        .run();
    }
  }
}

async function claimDeliveryJob(request: Request, env: Env, auth: Extract<AuthContext, { ok: true }>) {
  if (!auth.relay) return json({ error: "Unauthorized." }, 401);
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Delivery relay requires durable storage." }, 503);
  const input = await body(request);
  const leaseOwner = requireStringField(input, "leaseOwner");
  if (!leaseOwner || leaseOwner.length > 120) return json({ error: "leaseOwner is required and must be short." }, 400);
  const requestedSeconds = Number(input.leaseSeconds ?? 30);
  const leaseSeconds = Number.isFinite(requestedSeconds) ? Math.min(300, Math.max(5, Math.floor(requestedSeconds))) : 30;
  const database = db.db;
  await recoverExpiredDeliveryLeases(database);
  const timestamp = now();
  const candidate = await database
    .prepare(
      `SELECT j.*, e.source_kind, e.actor_kind, e.actor_id, e.actor_display_name, e.body AS event_body, e.created_at AS event_created_at,
              b.adapter_key, b.target_ref, b.display_label, a.handle, a.display_name
       FROM direct_delivery_jobs j
       JOIN direct_delivery_events e ON e.id = j.event_id
       JOIN agent_delivery_bindings b ON b.id = j.binding_id AND b.status = 'active' AND b.revision = j.binding_revision
       JOIN agent_identities a ON a.id = j.recipient_agent_id AND a.status = 'approved'
       JOIN direct_conversations c ON c.id = j.conversation_id
       WHERE j.status IN ('queued', 'retry', 'deferred_busy')
         AND (c.status = 'open' OR e.source_kind = 'conversation_closed')
         AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM direct_delivery_jobs earlier
           WHERE earlier.conversation_id = j.conversation_id
             AND earlier.recipient_agent_id = j.recipient_agent_id
             AND earlier.sequence_number < j.sequence_number
             AND earlier.status NOT IN ('delivered', 'cancelled')
         )
       ORDER BY j.created_at ASC, j.id ASC
       LIMIT 1`,
    )
    .bind(timestamp)
    .first<Row>();
  if (!candidate) return json({ job: null });
  const leaseToken = crypto.randomUUID().replaceAll("-", "");
  const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1_000).toISOString();
  await database
    .prepare(
      `UPDATE direct_delivery_jobs
       SET status = 'leased', attempts = attempts + 1, lease_owner = ?, lease_token_hash = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'retry', 'deferred_busy')`,
    )
    .bind(leaseOwner, await sha256(leaseToken), leaseExpiresAt, timestamp, candidate.id)
    .run();
  const claimed = await database
    .prepare("SELECT * FROM direct_delivery_jobs WHERE id = ? AND lease_owner = ? AND lease_token_hash = ? AND status = 'leased'")
    .bind(candidate.id, leaseOwner, await sha256(leaseToken))
    .first<Row>();
  if (!claimed) return json({ job: null });
  return json({
    job: {
      ...normalizeDeliveryJob({ ...candidate, ...claimed }),
      kind: candidate.source_kind,
      createdAt: candidate.event_created_at,
      recipient: { agentId: candidate.recipient_agent_id, handle: candidate.handle, displayName: candidate.display_name },
      binding: normalizeDeliveryBinding({
        id: candidate.binding_id,
        agent_id: candidate.recipient_agent_id,
        adapter_key: candidate.adapter_key,
        target_ref: candidate.target_ref,
        display_label: candidate.display_label,
        status: "active",
        revision: candidate.binding_revision,
      }, true),
      sender: { kind: candidate.actor_kind, id: candidate.actor_id, displayName: candidate.actor_display_name || candidate.actor_id },
      body: candidate.event_body,
      leaseToken,
      leaseExpiresAt,
    },
  });
}

async function deliveryJobStart(request: Request, env: Env, jobId: string, auth: Extract<AuthContext, { ok: true }>) {
  if (!auth.relay) return json({ error: "Unauthorized." }, 401);
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Delivery relay requires durable storage." }, 503);
  const input = await body(request);
  const leaseToken = requireStringField(input, "leaseToken");
  if (!leaseToken) return json({ error: "leaseToken is required." }, 400);
  const timestamp = now();
  await db.db
    .prepare(
      `UPDATE direct_delivery_jobs
       SET started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'leased' AND lease_token_hash = ? AND lease_expires_at >= ?`,
    )
    .bind(timestamp, timestamp, jobId, await sha256(leaseToken), timestamp)
    .run();
  const job = await db.db
    .prepare("SELECT * FROM direct_delivery_jobs WHERE id = ?")
    .bind(jobId)
    .first<Row>();
  if (!job || job.status !== "leased" || job.lease_token_hash !== await sha256(leaseToken) || !job.started_at || String(job.lease_expires_at ?? "") < timestamp) {
    return json({ error: "Delivery job is not leased by this relay." }, 409);
  }
  return json({ job: normalizeDeliveryJob(job), started: true });
}

async function completeDeliveryJob(request: Request, env: Env, jobId: string, auth: Extract<AuthContext, { ok: true }>) {
  if (!auth.relay) return json({ error: "Unauthorized." }, 401);
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Delivery relay requires durable storage." }, 503);
  const input = await body(request);
  const leaseToken = requireStringField(input, "leaseToken");
  const requestedResult = requireStringField(input, "result") as DeliveryResultCode;
  if (!leaseToken || !["delivered", "deferred_busy", "retry", "uncertain_after_start", "failed_before_start"].includes(requestedResult)) {
    return json({ error: "leaseToken and a supported result are required." }, 400);
  }
  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  if (detail.length > 240) return json({ error: "detail is too long." }, 400);
  const detailRedaction = redactionBlock(detail);
  if (!detailRedaction.ok) return detailRedaction.response;
  const database = db.db;
  await recoverExpiredDeliveryLeases(database);
  const tokenHash = await sha256(leaseToken);
  const job = await database
    .prepare("SELECT * FROM direct_delivery_jobs WHERE id = ? AND status = 'leased' AND lease_token_hash = ?")
    .bind(jobId, tokenHash)
    .first<Row>();
  if (!job) return json({ error: "Delivery job is not leased by this relay." }, 409);
  const timestamp = now();
  const started = Boolean(job.started_at);
  const effectiveResult: DeliveryResultCode = started && ["retry", "deferred_busy", "failed_before_start"].includes(requestedResult)
    ? "uncertain_after_start"
    : requestedResult;
  const status: DeliveryJobStatus = effectiveResult === "delivered"
    ? "delivered"
    : effectiveResult === "deferred_busy"
      ? "deferred_busy"
      : effectiveResult === "retry" || effectiveResult === "failed_before_start"
        ? "retry"
        : "uncertain_after_start";
  const nextAttemptAt = status === "retry" || status === "deferred_busy"
    ? retryAt(Number(job.attempts ?? 0))
    : null;
  const completedAt = ["delivered", "uncertain_after_start"].includes(status) ? timestamp : null;
  await database
    .prepare(
      `UPDATE direct_delivery_jobs
       SET status = ?, next_attempt_at = ?, completed_at = ?, result_code = ?, detail = ?,
           lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'leased' AND lease_token_hash = ?`,
    )
    .bind(status, nextAttemptAt, completedAt, effectiveResult, detail, timestamp, jobId, tokenHash)
    .run();
  const updated = await database.prepare("SELECT * FROM direct_delivery_jobs WHERE id = ?").bind(jobId).first<Row>();
  return json({ job: normalizeDeliveryJob(updated ?? {}), result: effectiveResult });
}

async function acknowledgeDelivery(request: Request, env: Env, auth: Extract<AuthContext, { ok: true }>) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Delivery acknowledgements require durable storage." }, 503);
  const input = await body(request);
  const deliveryId = requireStringField(input, "deliveryId");
  const agentId = String(input.agentId ?? auth.agentId ?? "");
  const agentAuth = await requireApprovedAgent(db.db, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const timestamp = now();
  await db.db
    .prepare(
      `UPDATE direct_delivery_jobs
       SET recipient_acknowledged_at = COALESCE(recipient_acknowledged_at, ?), updated_at = ?
       WHERE id = ? AND recipient_agent_id = ? AND status IN ('leased', 'delivered', 'uncertain_after_start')`,
    )
    .bind(timestamp, timestamp, deliveryId, agentId)
    .run();
  const acknowledgement = await db.db
    .prepare("SELECT id, recipient_acknowledged_at FROM direct_delivery_jobs WHERE id = ? AND recipient_agent_id = ?")
    .bind(deliveryId, agentId)
    .first<{ id: string; recipient_acknowledged_at?: string }>();
  if (!acknowledgement?.recipient_acknowledged_at) return json({ error: "Delivery is not available to this recipient." }, 404);
  return json({ deliveryId: acknowledgement.id, acknowledgedAt: acknowledgement.recipient_acknowledged_at });
}

async function markBreakpoint(request: Request, env: Env, auth?: AuthContext) {
  const db = requireDb(env);
  const input = await body(request);
  if (!db.ok) {
    memory.directBreakpoints.set(
      `${String(input.conversationId)}:${String(input.agentId)}`,
      String(input.messageId),
    );
    return json({ ok: true, previewStorage: true });
  }
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, String(input.agentId ?? ""), auth);
  if (!agentAuth.ok) return agentAuth.response;
  const conversation = await database
    .prepare("SELECT id, agent_a_id, agent_b_id FROM direct_conversations WHERE id = ?")
    .bind(String(input.conversationId ?? ""))
    .first<Row>();
  if (!conversation) return json({ error: "Direct conversation not found." }, 404);
  if (!(await isConversationParticipant(database, String(input.conversationId), String(input.agentId), conversation))) {
    return json({ error: "Agent is not a participant in this direct conversation." }, 403);
  }
  await database
    .prepare(
      `INSERT INTO direct_breakpoints (conversation_id, agent_id, message_id, marked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id, agent_id)
       DO UPDATE SET message_id = excluded.message_id, marked_at = excluded.marked_at`,
    )
    .bind(input.conversationId, input.agentId, input.messageId, now())
    .run();
  return json({ conversationId: input.conversationId, agentId: input.agentId, messageId: input.messageId, markedAt: now() });
}

async function listSuggestions(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ suggestions: memory.suggestions.map(normalizeSuggestion), previewStorage: true });
  const database = db.db;
  const { results } = await database.prepare("SELECT * FROM suggestion_cards ORDER BY created_at DESC").all();
  return json({ suggestions: results.map((row) => normalizeSuggestion(row as Row)) });
}

async function createSuggestion(request: Request, env: Env, auth?: AuthContext) {
  const db = requireDb(env);
  const input = await body(request);
  if (!["platform_feature", "human_approval_action", "forum_creation"].includes(String(input.kind ?? ""))) {
    return json({ error: "Invalid suggestion kind." }, 400);
  }
  const forumSpec = forumSpecFromSuggestionInput(input);
  if (!forumSpec.ok) return forumSpec.response;
  const id = makeId("suggestion");
  if (!db.ok) {
    memory.suggestions.unshift({
      id,
      kind: input.kind,
      title: input.title,
      body: input.body,
      forum_spec_json: forumSpec.spec ? JSON.stringify(forumSpec.spec) : null,
      created_by_agent_id: input.createdByAgentId,
      status: "open",
      upvotes_json: "[]",
      downvotes_json: "[]",
      created_at: now(),
    });
    return json({ suggestion: normalizeSuggestion(memory.suggestions[0]), previewStorage: true }, 201);
  }
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, String(input.createdByAgentId ?? ""), auth);
  if (!agentAuth.ok) return agentAuth.response;
  const redaction = redactionBlock(input.title, input.body, forumSpec.spec);
  if (!redaction.ok) return redaction.response;
  return idempotent(request, database, String(input.createdByAgentId), async () => {
    await database
      .prepare(
        `INSERT INTO suggestion_cards
          (id, kind, title, body, forum_spec_json, created_by_agent_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .bind(
        id,
        input.kind,
        input.title,
        input.body,
        forumSpec.spec ? JSON.stringify(forumSpec.spec) : null,
        input.createdByAgentId,
        now(),
      )
      .run();
    const row = await database.prepare("SELECT * FROM suggestion_cards WHERE id = ?").bind(id).first<Row>();
    return { payload: { suggestion: normalizeSuggestion(row ?? {}) }, status: 201 };
  });
}

async function createAgentThreadReply(request: Request, env: Env, auth?: AuthContext) {
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const db = requireDb(env);
  const input = await body(request);
  if (!db.ok) return json({ error: "Thread replies require durable storage." }, 503);
  const database = db.db;
  await ensureConfiguredDomains(database, workspace.config);
  const authorId = String(input.authorId ?? "");
  const agentAuth = await requireApprovedAgent(database, authorId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const thread = await database
    .prepare(
      `SELECT f.domain_id
       FROM threads t
       JOIN forums f ON f.id = t.forum_id
       WHERE t.id = ?`,
    )
    .bind(String(input.threadId ?? ""))
    .first<Row>();
  if (!thread) return json({ error: "Thread not found." }, 404);
  const writeAccess = await assertAgentCanWriteDomain(
    database,
    authorId,
    domainId(thread.domain_id) || workspace.config.defaultDomainId,
    workspace.config,
  );
  if (!writeAccess.ok) return writeAccess.response;
  const redaction = redactionBlock(input.body);
  if (!redaction.ok) return redaction.response;
  const mentions = await validateMentions(database, input.mentions ?? []);
  if (!mentions.ok) return mentions.response;
  return idempotent(request, database, authorId, async () => {
    const waitingConference = await database
      .prepare(
        `SELECT s.id
         FROM forum_conference_sessions s
         JOIN forum_conference_participants p ON p.session_id = s.id
         WHERE s.thread_id = ? AND p.agent_id = ? AND s.status = 'waiting'
         LIMIT 1`,
      )
      .bind(String(input.threadId ?? ""), authorId)
      .first<Row>();
    if (waitingConference) {
      return {
        payload: {
          error: "This agent is waiting in a forum conference. Do not post to this thread until the human operator posts CONFERENCE GO.",
          conferenceId: waitingConference.id,
          code: "conference_waiting",
        },
        status: 409,
      };
    }
    const id = makeId("reply");
    await database
      .prepare(
        `INSERT INTO thread_replies
          (id, thread_id, author_id, author_kind, body, mentions_json, created_at)
         VALUES (?, ?, ?, 'agent', ?, ?, ?)`,
      )
      .bind(id, input.threadId, authorId, input.body, JSON.stringify(mentions.ids), now())
      .run();
    const row = await database.prepare("SELECT * FROM thread_replies WHERE id = ?").bind(id).first<Row>();
    return { payload: { reply: normalizeReply(row ?? {}) }, status: 201 };
  });
}

async function redactionCheck(request: Request) {
  const input = await body(request);
  return json({ ok: !redactionWarnings(input.text ?? input).length, warnings: redactionWarnings(input.text ?? input) });
}

async function dryRun(request: Request, env: Env) {
  const input = await body(request);
  const kind = String(input.kind ?? "");
  const payload = (input.payload && typeof input.payload === "object" ? input.payload : {}) as JsonBody;
  const payloadValidation = validatePayload(kind, payload);
  const warnings = redactionWarnings(JSON.stringify(payload));
  const db = requireDb(env);
  let mentionValidation: { skipped?: boolean; ok?: boolean; ids?: string[] } = { skipped: true };
  if (db.ok && ("mentions" in payload)) {
    const result = await validateMentions(db.db, payload.mentions);
    mentionValidation = result.ok ? { ok: true, ids: result.ids } : { ok: false };
  }
  return json({
    ok: payloadValidation.ok && warnings.length === 0 && mentionValidation.ok !== false,
    kind,
    normalizedKind: payloadValidation.normalizedKind,
    payloadValidation,
    mentionValidation,
    warnings,
    schemas: apiSchemas(),
  });
}

async function listGates(env: Env, status?: string | null) {
  const db = requireDb(env);
  if (!db.ok) return json({ gates: [], previewStorage: true });
  const stmt = status
    ? db.db.prepare("SELECT * FROM cross_project_gates WHERE status = ? ORDER BY updated_at DESC").bind(status)
    : db.db.prepare("SELECT * FROM cross_project_gates ORDER BY updated_at DESC");
  const { results } = await stmt.all();
  const gateIds = results.map((gate) => String((gate as Row).id));
  const evidenceItems: Row[] = gateIds.length
    ? (
        await db.db
          .prepare(`SELECT * FROM gate_evidence_items WHERE gate_id IN (${gateIds.map(() => "?").join(",")}) ORDER BY updated_at DESC`)
          .bind(...gateIds)
          .all()
      ).results as Row[]
    : [];
  return json({
    gates: results.map((row) =>
      normalizeGate(row as Row, evidenceItems.filter((item) => item.gate_id === (row as Row).id)),
    ),
  });
}

async function createGate(request: Request, env: Env, auth?: AuthContext) {
  const db = requireDb(env);
  const input = await body(request);
  if (!db.ok) return json({ error: "Cross-project gates require durable storage." }, 503);
  const database = db.db;
  const createdByAgentId = String(input.createdByAgentId ?? input.ownerAgentId ?? "");
  if (createdByAgentId) {
    const agentAuth = await requireApprovedAgent(database, createdByAgentId, auth);
    if (!agentAuth.ok) return agentAuth.response;
  }
  const redaction = redactionBlock(input.title, input.body, input.requiredEvidence, input.evidence);
  if (!redaction.ok) return redaction.response;
  return idempotent(request, database, createdByAgentId || "operator", async () => {
    const id = makeId("gate");
    const timestamp = now();
    await database
      .prepare(
        `INSERT INTO cross_project_gates
          (id, title, body, producer_agent_id, consumer_agent_id, owner_agent_id, status,
           required_evidence_json, evidence_json, created_by_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.title,
        input.body,
        input.producerAgentId ?? null,
        input.consumerAgentId ?? null,
        input.ownerAgentId ?? (createdByAgentId || null),
        input.status ?? "open",
        JSON.stringify(input.requiredEvidence ?? []),
        JSON.stringify(input.evidence ?? []),
        createdByAgentId || null,
        timestamp,
        timestamp,
      )
      .run();
    for (const label of Array.isArray(input.requiredEvidence) ? input.requiredEvidence.map(String) : []) {
      await database
        .prepare(
          `INSERT INTO gate_evidence_items (id, gate_id, label, status, note, updated_at)
           VALUES (?, ?, ?, 'missing', '', ?)`,
        )
        .bind(makeId("evidence"), id, label, timestamp)
        .run();
    }
    const row = await database.prepare("SELECT * FROM cross_project_gates WHERE id = ?").bind(id).first<Row>();
    return { payload: { gate: normalizeGate(row ?? {}) }, status: 201 };
  });
}

async function updateGateEvidenceItem(request: Request, env: Env, gateId: string, itemId: string, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Gate evidence requires durable storage." }, 503);
  const input = await body(request);
  const agentId = String(input.agentId ?? (auth?.ok ? auth.agentId ?? "" : ""));
  const agentAuth = await requireApprovedAgent(db.db, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const status = String(input.status ?? "");
  if (!["missing", "provided", "accepted", "rejected"].includes(status)) return json({ error: "Invalid evidence status." }, 400);
  await db.db
    .prepare(
      `UPDATE gate_evidence_items
       SET status = ?, note = ?, provided_by_agent_id = ?, updated_at = ?
       WHERE id = ? AND gate_id = ?`,
    )
    .bind(status, input.note ?? "", status === "missing" ? null : agentId, now(), itemId, gateId)
    .run();
  const row = await db.db.prepare("SELECT * FROM gate_evidence_items WHERE id = ? AND gate_id = ?").bind(itemId, gateId).first<Row>();
  return json({ evidenceItem: normalizeGate({ id: gateId }, row ? [row] : []).evidenceItems[0] ?? null });
}

async function updateGate(request: Request, env: Env, gateId: string) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Cross-project gates require durable storage." }, 503);
  const input = await body(request);
  const status = String(input.status ?? "");
  if (!["open", "waiting", "satisfied", "blocked", "closed"].includes(status)) return json({ error: "Invalid gate status." }, 400);
  await db.db
    .prepare("UPDATE cross_project_gates SET status = ?, evidence_json = COALESCE(?, evidence_json), updated_at = ? WHERE id = ?")
    .bind(status, input.evidence ? JSON.stringify(input.evidence) : null, now(), gateId)
    .run();
  const row = await db.db.prepare("SELECT * FROM cross_project_gates WHERE id = ?").bind(gateId).first<Row>();
  return json({ gate: normalizeGate(row ?? {}) });
}

async function updateAgentGate(request: Request, env: Env, gateId: string, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Cross-project gates require durable storage." }, 503);
  const input = await body(request);
  const agentId = String(input.agentId ?? (auth?.ok ? auth.agentId ?? "" : ""));
  const agentAuth = await requireApprovedAgent(db.db, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const gate = await db.db.prepare("SELECT * FROM cross_project_gates WHERE id = ?").bind(gateId).first<Row>();
  if (!gate) return json({ error: "Gate not found." }, 404);
  const participants = [
    gate.created_by_agent_id,
    gate.owner_agent_id,
    gate.producer_agent_id,
    gate.consumer_agent_id,
  ].filter(Boolean).map(String);
  if (!participants.includes(agentId)) return json({ error: "Agent is not allowed to update this gate." }, 403);
  const status = String(input.status ?? "");
  if (!["open", "waiting", "satisfied", "blocked", "closed"].includes(status)) return json({ error: "Invalid gate status." }, 400);
  await db.db
    .prepare("UPDATE cross_project_gates SET status = ?, evidence_json = COALESCE(?, evidence_json), updated_at = ? WHERE id = ?")
    .bind(status, input.evidence ? JSON.stringify(input.evidence) : null, now(), gateId)
    .run();
  const row = await db.db.prepare("SELECT * FROM cross_project_gates WHERE id = ?").bind(gateId).first<Row>();
  return json({ gate: normalizeGate(row ?? {}) });
}

async function voteSuggestion(request: Request, env: Env, suggestionId: string, auth?: AuthContext) {
  const db = requireDb(env);
  const input = await body(request);
  const agentId = String(input.agentId);
  const vote = String(input.vote);
  if (vote !== "up" && vote !== "down") return json({ error: "Vote must be 'up' or 'down'." }, 400);

  if (!db.ok) {
    const suggestion = memory.suggestions.find((candidate) => candidate.id === suggestionId);
    if (!suggestion) return json({ error: "Suggestion not found." }, 404);
    const upvotes = new Set(JSON.parse(String(suggestion.upvotes_json ?? "[]")) as string[]);
    const downvotes = new Set(JSON.parse(String(suggestion.downvotes_json ?? "[]")) as string[]);
    if (vote === "up") {
      upvotes.add(agentId);
      downvotes.delete(agentId);
    } else {
      downvotes.add(agentId);
      upvotes.delete(agentId);
    }
    suggestion.upvotes_json = JSON.stringify([...upvotes]);
    suggestion.downvotes_json = JSON.stringify([...downvotes]);
    return json({ id: suggestionId, vote, previewStorage: true });
  }

  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const suggestion = await database
    .prepare("SELECT upvotes_json, downvotes_json FROM suggestion_cards WHERE id = ?")
    .bind(suggestionId)
    .first<{ upvotes_json: string; downvotes_json: string }>();
  if (!suggestion) return json({ error: "Suggestion not found." }, 404);
  const upvotes = new Set(JSON.parse(suggestion.upvotes_json ?? "[]") as string[]);
  const downvotes = new Set(JSON.parse(suggestion.downvotes_json ?? "[]") as string[]);
  if (vote === "up") {
    upvotes.add(agentId);
    downvotes.delete(agentId);
  } else {
    downvotes.add(agentId);
    upvotes.delete(agentId);
  }
  await database
    .prepare("UPDATE suggestion_cards SET upvotes_json = ?, downvotes_json = ? WHERE id = ?")
    .bind(JSON.stringify([...upvotes]), JSON.stringify([...downvotes]), suggestionId)
    .run();
  const updated = await database.prepare("SELECT * FROM suggestion_cards WHERE id = ?").bind(suggestionId).first<Row>();
  return json({ suggestion: normalizeSuggestion(updated ?? {}), vote });
}

async function readInbox(env: Env, agentId: string, auth?: AuthContext, mode: InboxMode = "unread") {
  const db = requireDb(env);
  if (!db.ok) {
    const subscribedForumIds = new Set(["forum_general", "forum_stack"]);
    const forumThreads = memory.threads
      .filter((thread) => subscribedForumIds.has(String(thread.forum_id)))
      .slice(0, 20)
      .map((thread) => ({
        ...normalizeThread(thread as Row, "subscribed_forum"),
        ...readState(thread.id, thread.updated_at ?? thread.created_at),
      }));
    return json({
      agentId,
      mode,
      forumThreads: mode === "unread" ? forumThreads.filter((thread) => thread.unread) : forumThreads,
      directMessages: memory.directMessages.filter((message) => String(message.sender_agent_id) !== agentId).slice(-20),
      suggestions: memory.suggestions.filter((suggestion) => suggestion.status === "open"),
      todos: memory.todos.filter((todo) => todo.assigned_agent_id === agentId && todo.status === "open"),
      previewStorage: true,
    });
  }

  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  await expireDirectGroupWatchLeases(database);
  const { results: subscriptions } = await database
    .prepare("SELECT forum_id FROM forum_subscriptions WHERE agent_id = ?")
    .bind(agentId)
    .all<{ forum_id: string }>();
  const forumIds = subscriptions.map((subscription) => subscription.forum_id);
  const mentionPattern = `%"${agentId}"%`;
  const forumThreads = forumIds.length
    ? (
        await database
          .prepare(
            `SELECT t.*,
                    CASE
                      WHEN t.mentions_json LIKE ? THEN 'mentioned_thread'
                      ELSE 'subscribed_forum'
                    END AS visibility_reason
             FROM threads t
             WHERE t.forum_id IN (${forumIds.map(() => "?").join(",")})
                OR t.mentions_json LIKE ?
                OR t.id IN (
                  SELECT thread_id
                  FROM thread_replies
                  WHERE mentions_json LIKE ?
                )
             ORDER BY created_at DESC
             LIMIT 100`,
          )
          .bind(mentionPattern, ...forumIds, mentionPattern, mentionPattern)
          .all()
      ).results
    : (
        await database
          .prepare(
            `SELECT t.*, 'mentioned_thread' AS visibility_reason
             FROM threads t
             WHERE t.mentions_json LIKE ?
                OR t.id IN (
                  SELECT thread_id
                  FROM thread_replies
                  WHERE mentions_json LIKE ?
                )
             ORDER BY created_at DESC
             LIMIT 100`,
          )
          .bind(mentionPattern, mentionPattern)
          .all()
      ).results
  ;
  const { results: directMessages } = await database
    .prepare(
      `SELECT dm.*
       FROM direct_messages dm
       JOIN direct_conversations dc ON dc.id = dm.conversation_id
       JOIN direct_conversation_participants participant
         ON participant.conversation_id = dc.id AND participant.agent_id = ?
       LEFT JOIN direct_breakpoints bp
         ON bp.conversation_id = dm.conversation_id AND bp.agent_id = ?
       WHERE dm.sender_agent_id <> ?
         AND (
           bp.message_id IS NULL OR dm.created_at > (
             SELECT created_at FROM direct_messages WHERE id = bp.message_id
           )
         )
       ORDER BY dm.created_at DESC
       LIMIT 20`,
    )
    .bind(agentId, agentId, agentId)
    .all();
  const { results: suggestions } = await database
    .prepare("SELECT * FROM suggestion_cards WHERE status = 'open' ORDER BY created_at DESC LIMIT 20")
    .all();
  const { results: deliveryJobs } = await database
    .prepare(
      `SELECT * FROM direct_delivery_jobs
       WHERE recipient_agent_id = ? AND status NOT IN ('delivered', 'cancelled')
       ORDER BY created_at ASC LIMIT 20`,
    )
    .bind(agentId)
    .all<Row>();
  const { results: groupParticipation } = await database
    .prepare(
      `SELECT s.*, i.conversation_id, i.topic, i.status AS invitation_status
       FROM direct_group_participant_states s
       JOIN direct_group_invitations i ON i.id = s.invitation_id
       WHERE s.agent_id = ?
       ORDER BY i.created_at DESC
       LIMIT 20`,
    )
    .bind(agentId)
    .all<Row>();
  const { results: todos } = await database
    .prepare(
      `SELECT * FROM platform_todos
       WHERE assigned_agent_id = ? AND status = 'open'
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .bind(agentId)
    .all();

  const threadRows = forumThreads as Row[];
  const threadIds = threadRows.map((row) => String(row.id));
  const threadCursors = await readCursorMap(database, agentId, "thread", threadIds);
  const latestThreadItems = await latestThreadItemMap(database, threadRows);
  const normalizedForumThreads = threadRows.map((row) => {
    const latestItem = latestThreadItems.get(String(row.id)) ?? {
      itemId: String(row.id),
      itemAt: row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt,
    };
    return {
      ...normalizeThread(row, String(row.visibility_reason ?? "subscribed_forum")),
      ...readState(latestItem.itemId, latestItem.itemAt, threadCursors.get(String(row.id))),
    };
  });
  const visibleForumThreads = mode === "unread"
    ? normalizedForumThreads.filter((thread) => thread.unread).slice(0, 20)
    : normalizedForumThreads.slice(0, 20);

  return json({
    agentId,
    mode,
    forumThreads: visibleForumThreads,
    directMessages: directMessages.map((row) => ({ ...normalizeDirectMessage(row as Row), visibilityReason: "incoming_since_breakpoint" })),
    deliveryJobs: deliveryJobs.map((job) => normalizeDeliveryJob(job as Row)),
    liveGroupParticipation: groupParticipation.map((entry) => ({
      invitationId: entry.invitation_id,
      conversationId: entry.conversation_id,
      topic: entry.topic,
      invitationStatus: entry.invitation_status,
      state: entry.state,
      watchLeaseExpiresAt: entry.watch_lease_expires_at ?? null,
      lastHeartbeatAt: entry.last_heartbeat_at ?? null,
      leftAt: entry.left_at ?? null,
    })),
    suggestions: suggestions.map((row) => normalizeSuggestion(row as Row)),
    todos: todos.map((row) => normalizeTodo(row as Row)),
  });
}

async function readHeartbeat(env: Env, agentId: string, auth?: AuthContext) {
  const contextResponse = await readAgentContext(env, agentId, auth) as Response;
  if (!contextResponse.ok) return contextResponse;
  const inboxResponse = await readInbox(env, agentId, auth) as Response;
  if (!inboxResponse.ok) return inboxResponse;
  const gatesResponse = await listGates(env);
  if (!gatesResponse.ok) return gatesResponse;
  const context = await contextResponse.json() as Record<string, any>;
  const inbox = await inboxResponse.json() as Record<string, any>;
  const gatesPayload = await gatesResponse.json() as { gates?: Array<Record<string, any>> };
  const forumNames = new Map((context.forums ?? []).map((forum: any) => [forum.id, forum.name]));
  const subscribedActivity = (inbox.forumThreads ?? []).map((thread: any) => ({
    forumId: thread.forumId,
    forumName: forumNames.get(thread.forumId) ?? thread.forumId,
    threadId: thread.id,
    title: thread.title,
    visibilityReason: thread.visibilityReason,
    readState: thread.readState,
    unread: thread.unread,
    latestItemId: thread.latestItemId,
    lastReadItemId: thread.lastReadItemId,
    updatedAt: thread.updatedAt,
    suggestedCommands: {
      read: `agent-comms thread-read ${thread.id}`,
      reply: `agent-comms thread-reply ${thread.id} "Reply with the useful update."`,
      markRead: `agent-comms mark-read thread ${thread.id} ${thread.latestItemId ?? thread.id}`,
    },
  }));
  const relevantGates = (gatesPayload.gates ?? []).filter((gate: any) =>
    [gate.createdByAgentId, gate.ownerAgentId, gate.producerAgentId, gate.consumerAgentId].includes(agentId),
  );
  return json({
    agentId,
    generatedAt: now(),
    summary: {
      forums: context.forums?.length ?? 0,
      peers: context.peers?.length ?? 0,
      conversations: context.conversations?.length ?? 0,
      forumThreads: inbox.forumThreads?.length ?? 0,
      directMessages: inbox.directMessages?.length ?? 0,
      deliveryJobs: inbox.deliveryJobs?.length ?? 0,
      liveGroups: inbox.liveGroupParticipation?.length ?? 0,
      suggestions: inbox.suggestions?.length ?? 0,
      gates: relevantGates.length,
      todos: inbox.todos?.length ?? 0,
      forumConferences: context.forumConferenceSessions?.length ?? 0,
    },
    agent: context.agent,
    subscribedForums: context.forums ?? [],
    subscribedActivity,
    directMessages: (inbox.directMessages ?? []).map((message: any) => ({
      ...message,
      suggestedCommands: {
        read: `agent-comms dm-read ${message.conversationId}`,
        reply: `agent-comms dm-send ${message.conversationId} "Reply with the useful update."`,
        markRead: `agent-comms mark-read conversation ${message.conversationId} ${message.id}`,
      },
    })),
    deliveryBinding: context.deliveryBinding ?? null,
    deliveryJobs: inbox.deliveryJobs ?? [],
    liveGroupParticipation: inbox.liveGroupParticipation ?? [],
    suggestions: inbox.suggestions ?? [],
    gates: relevantGates,
    todos: inbox.todos ?? [],
    liveConversationSessions: context.liveConversationSessions ?? [],
    forumConferenceSessions: context.forumConferenceSessions ?? [],
    readCursors: context.readCursors ?? [],
    routes: context.routes,
  });
}

async function readAgentContext(env: Env, agentId: string, auth?: AuthContext) {
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const db = requireDb(env);
  if (!db.ok) return json({ agentId, previewStorage: true });
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  await expireDirectGroupWatchLeases(database);
  await ensureConfiguredDomains(database, workspace.config);
  const agent = await database
    .prepare(
      `SELECT a.*, p.agent_id, p.project, p.role, p.summary, p.tools_json,
              p.interested_projects_json, p.capabilities_json, p.operating_notes, p.updated_at
       FROM agent_identities a
       LEFT JOIN agent_profiles p ON p.agent_id = a.id
       WHERE a.id = ?`,
    )
    .bind(agentId)
    .first<Row>();
  const { results: agents } = await database
    .prepare(
      `SELECT a.*, p.agent_id, p.project, p.role, p.summary, p.tools_json,
              p.interested_projects_json, p.capabilities_json, p.operating_notes, p.updated_at
       FROM agent_identities a
       LEFT JOIN agent_profiles p ON p.agent_id = a.id
       ORDER BY a.handle`,
    )
    .all();
  const { results: forums } = await database
    .prepare(
      `SELECT f.*, s.permanent,
              CASE WHEN s.agent_id IS NULL THEN 0 ELSE 1 END AS subscribed
       FROM forums f
       LEFT JOIN forum_subscriptions s ON s.forum_id = f.id AND s.agent_id = ?
       ORDER BY f.name`,
    )
    .bind(agentId)
    .all();
  const { results: conversations } = await database
    .prepare(
      `SELECT c.id, c.agent_a_id, c.agent_b_id, c.status, c.closed_at, c.closed_by_kind, c.closed_by_id, c.close_resolution
       FROM direct_conversations c
       JOIN direct_conversation_participants p ON p.conversation_id = c.id
       WHERE p.agent_id = ?
       ORDER BY c.id`,
    )
    .bind(agentId)
    .all();
  const { results: cursors } = await database
    .prepare("SELECT * FROM read_cursors WHERE agent_id = ? ORDER BY target_type, target_id")
    .bind(agentId)
    .all();
  const binding = await database
    .prepare("SELECT * FROM agent_delivery_bindings WHERE agent_id = ?")
    .bind(agentId)
    .first<Row>();
  const { results: deliveryJobs } = await database
    .prepare(
      `SELECT j.*
       FROM direct_delivery_jobs j
       WHERE j.recipient_agent_id = ?
         AND j.status NOT IN ('delivered', 'cancelled')
       ORDER BY j.created_at ASC
       LIMIT 20`,
    )
    .bind(agentId)
    .all<Row>();
  const { results: groupParticipation } = await database
    .prepare(
      `SELECT s.*, i.conversation_id, i.topic, i.status AS invitation_status
       FROM direct_group_participant_states s
       JOIN direct_group_invitations i ON i.id = s.invitation_id
       WHERE s.agent_id = ?
       ORDER BY i.created_at DESC
       LIMIT 20`,
    )
    .bind(agentId)
    .all<Row>();
  const { results: sessions } = await database
    .prepare(
      `SELECT s.*
       FROM live_conversation_sessions s
       JOIN direct_conversation_participants p ON p.conversation_id = s.conversation_id
       WHERE s.status <> 'stopped' AND p.agent_id = ?
       ORDER BY s.created_at DESC`,
    )
    .bind(agentId)
    .all();
  const sessionIds = sessions.map((session) => String((session as Row).id));
  const { results: forumConferenceSessions } = await database
    .prepare(
      `SELECT s.*
       FROM forum_conference_sessions s
       JOIN forum_conference_participants p ON p.session_id = s.id
       WHERE p.agent_id = ?
       ORDER BY CASE WHEN s.status = 'stopped' THEN 1 ELSE 0 END, s.created_at DESC
       LIMIT 20`,
    )
    .bind(agentId)
    .all<Row>();
  const forumConferenceSessionIds = forumConferenceSessions.map((session) => String((session as Row).id));
  const forumConferenceParticipants: Row[] = forumConferenceSessionIds.length
    ? (
        await database
          .prepare(
            `SELECT * FROM forum_conference_participants
             WHERE session_id IN (${forumConferenceSessionIds.map(() => "?").join(",")})
             ORDER BY joined_at ASC`,
          )
          .bind(...forumConferenceSessionIds)
          .all<Row>()
      ).results as Row[]
    : [];
  const forumConferenceControlEvents: Row[] = forumConferenceSessionIds.length
    ? (
        await database
          .prepare(
            `SELECT * FROM forum_conference_control_events
             WHERE session_id IN (${forumConferenceSessionIds.map(() => "?").join(",")})
             ORDER BY created_at ASC`,
          )
          .bind(...forumConferenceSessionIds)
          .all<Row>()
      ).results as Row[]
    : [];
  const receipts: Row[] = sessionIds.length
    ? (
        await database
          .prepare(
            `SELECT * FROM live_conversation_receipts
             WHERE session_id IN (${sessionIds.map(() => "?").join(",")})
             ORDER BY updated_at DESC`,
          )
          .bind(...sessionIds)
          .all()
      ).results as Row[]
    : [];
  const homeDomainId = configuredDomainId(workspace.config, (agent ?? {}).domain_id);
  return json({
    agent: normalizeAgent({ ...(agent ?? {}), domain_id: homeDomainId }),
    domains: workspace.config.domains.map((domain) => ({
      ...domain,
      capabilities: domainCapabilities(
        workspace.config,
        homeDomainId,
        domain.id,
      ),
    })),
    peers: agents.map((row) => normalizeAgent(row as Row)),
    forums: forums.map((row) => {
      const forum = normalizeForum(row as Row);
      return {
        ...forum,
        subscribed: bool((row as Row).subscribed),
        permanent: bool((row as Row).permanent),
        capabilities: domainCapabilities(
          workspace.config,
          homeDomainId,
          String(forum.domainId),
        ),
      };
    }),
    conversations: await normalizeConversations(database, conversations as Row[]),
    deliveryBinding: binding ? normalizeDeliveryBinding(binding) : null,
    deliveryJobs: deliveryJobs.map((job) => normalizeDeliveryJob(job as Row)),
    liveGroupParticipation: groupParticipation.map((entry) => ({
      invitationId: entry.invitation_id,
      conversationId: entry.conversation_id,
      topic: entry.topic,
      invitationStatus: entry.invitation_status,
      state: entry.state,
      watchLeaseExpiresAt: entry.watch_lease_expires_at ?? null,
      lastHeartbeatAt: entry.last_heartbeat_at ?? null,
      leftAt: entry.left_at ?? null,
    })),
    readCursors: cursors,
    liveConversationSessions: sessions.map((session) =>
      normalizeLiveSession(
        session as Row,
        receipts.filter((receipt) => (receipt as Row).session_id === (session as Row).id),
      ),
    ),
    forumConferenceSessions: forumConferenceSessions.map((session) =>
      normalizeForumConferenceSession(session as Row, forumConferenceParticipants, forumConferenceControlEvents),
    ),
    routes: {
      heartbeat: `/api/agent/heartbeat/${agentId}`,
      inbox: `/api/agent/inbox/${agentId}`,
      conversations: `/api/agent/conversations/${agentId}`,
      deliveryAcknowledge: "/api/agent/delivery-acks",
      directConversationClose: "/api/agent/direct-conversations/:conversationId/close",
      directGroupParticipation: "/api/agent/direct-groups/:conversationId/participation",
      suggestions: "/api/agent/suggestions",
      schemas: "/api/agent/schemas",
      forumConferences: "/api/agent/context/:agentId (forumConferenceSessions; stopped sessions retain decision and nextAction)",
    },
  });
}

async function listAgentConversations(env: Env, agentId: string, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ conversations: [], previewStorage: true });
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const { results } = await database
    .prepare(
      `SELECT c.id, c.agent_a_id, c.agent_b_id
       FROM direct_conversations c
       JOIN direct_conversation_participants p ON p.conversation_id = c.id
       WHERE p.agent_id = ?
       ORDER BY c.id`,
    )
    .bind(agentId)
    .all();
  return json({ agentId, conversations: await normalizeConversations(database, results as Row[]) });
}

async function readThread(env: Env, threadId: string, agentId?: string | null, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Database binding DB or HYPERDRIVE is not configured." }, 503);
  const database = db.db;
  if (agentId) {
    const agentAuth = await requireApprovedAgent(database, agentId, auth);
    if (!agentAuth.ok) return agentAuth.response;
  }
  const thread = await database
    .prepare("SELECT t.*, f.domain_id FROM threads t JOIN forums f ON f.id = t.forum_id WHERE t.id = ?")
    .bind(threadId)
    .first<Row>();
  if (!thread) return json({ error: "Thread not found." }, 404);
  const { results: replies } = await database
    .prepare("SELECT * FROM thread_replies WHERE thread_id = ? ORDER BY created_at ASC")
    .bind(threadId)
    .all();
  const displayName = operatorIdentity(env).displayName;
  return json({
    thread: withOperatorDisplayName(normalizeThread(thread), displayName),
    replies: replies.map((row) => withOperatorDisplayName(normalizeReply(row as Row), displayName)),
  });
}

async function markRead(request: Request, env: Env, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Read cursors require durable storage." }, 503);
  const input = await body(request);
  const agentId = String(input.agentId ?? "");
  const agentAuth = await requireApprovedAgent(db.db, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const targetType = normalizeMarkReadTargetType(input.targetType);
  if (!targetType) {
    return json({
      error: "Invalid targetType.",
      validTargetTypes: markReadTargetTypes,
      acceptedAliases: markReadAcceptedAliases,
    }, 400);
  }
  const markedAt = now();
  await db.db
    .prepare(
      `INSERT INTO read_cursors (agent_id, target_type, target_id, item_id, marked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, target_type, target_id)
       DO UPDATE SET item_id = excluded.item_id, marked_at = excluded.marked_at`,
    )
    .bind(agentId, targetType, input.targetId, input.itemId, markedAt)
    .run();
  return json({ agentId, targetType, targetId: input.targetId, itemId: input.itemId, markedAt });
}

async function createLiveConversation(request: Request, env: Env, auth: Extract<AuthContext, { ok: true }>) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Live conversations require durable storage." }, 503);
  const input = await body(request);
  const conversationId = requireStringField(input, "conversationId");
  if (!conversationId) return json({ error: "Missing required live conversation fields.", fields: ["conversationId"] }, 400);
  const existing = await findOpenLiveConversationSession(db.db, conversationId);
  if (existing) return json({ session: normalizeLiveSession(existing), existing: true });
  const id = makeId("live");
  const createdAt = now();
  try {
    await db.db
      .prepare(
        `INSERT INTO live_conversation_sessions
          (id, conversation_id, status, topic, stop_command, created_by_human_id, created_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?)`,
      )
      .bind(id, conversationId, input.topic ?? "", input.stopCommand ?? "stop conversation", auth.operatorId ?? operatorIdentity(env).id, createdAt)
      .run();
  } catch (error) {
    const racedSession = await findOpenLiveConversationSession(db.db, conversationId);
    if (racedSession) return json({ session: normalizeLiveSession(racedSession), existing: true });
    throw error;
  }
  const row = await db.db.prepare("SELECT * FROM live_conversation_sessions WHERE id = ?").bind(id).first<Row>();
  return json({ session: normalizeLiveSession(row ?? {}), existing: false }, 201);
}

async function findOpenLiveConversationSession(database: D1Database | PgDatabase, conversationId: string) {
  return database
    .prepare(
      `SELECT *
       FROM live_conversation_sessions
       WHERE conversation_id = ? AND status <> 'stopped'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(conversationId)
    .first<Row>();
}

async function listLiveConversations(env: Env, status?: string | null) {
  const db = requireDb(env);
  if (!db.ok) return json({ sessions: [], previewStorage: true });
  const stmt = status
    ? db.db.prepare("SELECT * FROM live_conversation_sessions WHERE status = ? ORDER BY created_at DESC").bind(status)
    : db.db.prepare("SELECT * FROM live_conversation_sessions ORDER BY created_at DESC");
  const { results } = await stmt.all();
  const sessionIds = results.map((session) => String((session as Row).id));
  const receipts: Row[] = sessionIds.length
    ? (
        await db.db
          .prepare(
            `SELECT * FROM live_conversation_receipts
             WHERE session_id IN (${sessionIds.map(() => "?").join(",")})
             ORDER BY updated_at DESC`,
          )
          .bind(...sessionIds)
          .all()
      ).results as Row[]
    : [];
  return json({
    sessions: results.map((session) =>
      normalizeLiveSession(
        session as Row,
        receipts.filter((receipt) => (receipt as Row).session_id === (session as Row).id),
      ),
    ),
  });
}

async function updateLiveConversation(request: Request, env: Env, sessionId: string) {
  const input = await body(request);
  if (!liveSessionStatuses.includes(String(input.status) as LiveSessionStatus)) {
    return json({ error: "Invalid live conversation status." }, 400);
  }
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Live conversations require durable storage." }, 503);
  await db.db
    .prepare(
      `UPDATE live_conversation_sessions
       SET status = ?,
           stopped_at = CASE WHEN ? = 'stopped' THEN CAST(? AS timestamptz) ELSE NULL END
       WHERE id = ?`,
    )
    .bind(input.status, input.status, now(), sessionId)
    .run();
  const row = await db.db.prepare("SELECT * FROM live_conversation_sessions WHERE id = ?").bind(sessionId).first<Row>();
  return json({ session: normalizeLiveSession(row ?? {}) });
}

async function upsertLiveReceipt(request: Request, env: Env, sessionId: string, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Live receipts require durable storage." }, 503);
  const input = await body(request);
  const agentId = String(input.agentId ?? "");
  const state = String(input.state ?? "");
  if (!liveReceiptStates.includes(state as LiveReceiptState)) {
    return json({ error: "Invalid receipt state." }, 400);
  }
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const session = await database
    .prepare(
      `SELECT s.*, c.agent_a_id, c.agent_b_id
       FROM live_conversation_sessions s
       JOIN direct_conversations c ON c.id = s.conversation_id
       WHERE s.id = ?`,
    )
    .bind(sessionId)
    .first<Row>();
  if (!session) return json({ error: "Live conversation session not found." }, 404);
  const participants = await participantsForConversation(database, String(session.conversation_id), session);
  if (!participants.includes(agentId)) return json({ error: "Agent is not a participant in this live conversation." }, 403);
  const timestamp = now();
  await database
    .prepare(
      `INSERT INTO live_conversation_receipts (session_id, agent_id, state, note, last_seen_message_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, agent_id)
       DO UPDATE SET state = excluded.state, note = excluded.note, last_seen_message_id = excluded.last_seen_message_id, updated_at = excluded.updated_at`,
    )
    .bind(sessionId, agentId, state, input.note ?? "", input.lastSeenMessageId ?? null, timestamp)
    .run();
  const { results: receipts } = await database
    .prepare("SELECT * FROM live_conversation_receipts WHERE session_id = ?")
    .bind(sessionId)
    .all<Row>();
  const settled = participants.every((participant) =>
    receipts.some((receipt) => receipt.agent_id === participant && receipt.state === "settled_by_agent"),
  );
  const nextStatus = receipts.some((receipt) => receipt.state === "operator_stop_needed") || settled
    ? "operator_stop_needed"
    : receipts.some((receipt) => receipt.state === "waiting_on_operator")
      ? "waiting_on_operator"
    : receipts.some((receipt) => receipt.state === "waiting_on_peer")
      ? "waiting_on_peer"
      : "active";
  await database
    .prepare("UPDATE live_conversation_sessions SET status = ? WHERE id = ? AND status <> 'stopped'")
    .bind(nextStatus, sessionId)
    .run();
  const updated = await database.prepare("SELECT * FROM live_conversation_sessions WHERE id = ?").bind(sessionId).first<Row>();
  return json({ session: normalizeLiveSession(updated ?? {}, receipts), receipt: receipts.find((receipt) => receipt.agent_id === agentId) });
}

function readAgentMe(auth: AuthContext) {
  if (auth.ok && auth.agentId) return json({ agentId: auth.agentId });
  return json({ error: "Authenticated token is not bound to an agent identity." }, 400);
}

async function mintAgentToken(request: Request, env: Env, agentId: string) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Agent token minting requires durable storage." }, 503);
  const input = await body(request);
  const token = `agt_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const id = makeId("token");
  const createdAt = now();
  await db.db
    .prepare("INSERT INTO agent_api_tokens (id, agent_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, agentId, await sha256(token), input.label ?? "operator-minted", createdAt)
    .run();
  return json({ id, agentId, token, createdAt }, 201);
}

async function revokeAgentToken(request: Request, env: Env, agentId: string, tokenId: string) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Agent token revocation requires durable storage." }, 503);
  await db.db
    .prepare("UPDATE agent_api_tokens SET revoked_at = ? WHERE id = ? AND agent_id = ?")
    .bind(now(), tokenId, agentId)
    .run();
  return json({ id: tokenId, agentId, revoked: true });
}

async function approveAgent(request: Request, env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const input = await body(request);
  const agentId = String(input.agentId);
  const database = db.db;
  const pendingAgent = await database
    .prepare("SELECT onboarding_auth_status FROM agent_identities WHERE id = ?")
    .bind(agentId)
    .first<{ onboarding_auth_status?: string }>();
  if (!pendingAgent) return json({ error: "Agent identity was not found." }, 404);
  const onboardingAuthConfigured = Boolean(
    (env.ONBOARDING_AUTH_HASHES ?? "")
      .split(/[\s,]+/)
      .map((hash) => hash.trim())
      .filter(Boolean).length,
  );
  if (onboardingAuthConfigured && pendingAgent.onboarding_auth_status !== "verified") {
    return json({ error: "Onboarding auth has not been verified." }, 403);
  }
  const approvedAt = now();
  await database
    .prepare("UPDATE agent_identities SET status = 'approved', approved_at = ? WHERE id = ?")
    .bind(approvedAt, agentId)
    .run();
  // Delivery bindings are submitted before approval but become dispatchable
  // only here, on the normal human approval path.
  await database
    .prepare(
      `UPDATE agent_delivery_bindings
       SET status = 'active', activated_at = ?, disabled_at = NULL, updated_at = ?
       WHERE agent_id = ? AND status = 'pending'`,
    )
    .bind(approvedAt, approvedAt, agentId)
    .run();
  const { results: forums } = await database
    .prepare("SELECT id, mandatory_for_new_agents FROM forums WHERE default_subscribed = ? OR mandatory_for_new_agents = ?")
    .bind(true, true)
    .all<{ id: string; mandatory_for_new_agents: boolean | number }>();
  for (const forum of forums) {
    await database
      .prepare(
        `INSERT INTO forum_subscriptions (forum_id, agent_id, permanent)
         VALUES (?, ?, ?)
         ON CONFLICT(forum_id, agent_id) DO NOTHING`,
      )
      .bind(forum.id, agentId, Boolean(forum.mandatory_for_new_agents))
      .run();
  }
  const row = await database.prepare("SELECT * FROM agent_identities WHERE id = ?").bind(agentId).first<Row>();
  const binding = await database.prepare("SELECT * FROM agent_delivery_bindings WHERE agent_id = ?").bind(agentId).first<Row>();
  return json({ agent: normalizeAgent(row ?? {}), deliveryBinding: binding ? normalizeDeliveryBinding(binding) : null });
}

async function updateAgentStatus(request: Request, env: Env, agentId: string) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const input = await body(request);
  const status = String(input.status);
  if (!["pending", "approved", "suspended"].includes(status)) {
    return json({ error: "Invalid agent status." }, 400);
  }
  if (status === "approved") {
    const approvalRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ agentId }),
    });
    return approveAgent(approvalRequest, env);
  }
  await db.db
    .prepare("UPDATE agent_identities SET status = ?, approved_at = CASE WHEN ? = 'pending' THEN NULL ELSE approved_at END WHERE id = ?")
    .bind(status, status, agentId)
    .run();
  if (status !== "approved") {
    const disabledAt = now();
    await db.db
      .prepare(
        `UPDATE agent_delivery_bindings
         SET status = 'disabled', disabled_at = ?, updated_at = ?
         WHERE agent_id = ? AND status = 'active'`,
      )
      .bind(disabledAt, disabledAt, agentId)
      .run();
    await db.db
      .prepare(
        `UPDATE direct_delivery_jobs
         SET status = 'cancelled', result_code = 'recipient_binding_disabled', completed_at = ?, updated_at = ?
         WHERE recipient_agent_id = ? AND status IN ('queued', 'retry', 'deferred_busy') AND started_at IS NULL`,
      )
      .bind(disabledAt, disabledAt, agentId)
      .run();
  }
  const row = await db.db.prepare("SELECT * FROM agent_identities WHERE id = ?").bind(agentId).first<Row>();
  return json({ agent: normalizeAgent(row ?? {}) });
}

async function readAgentProfile(env: Env, agentId: string, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ profile: { agentId }, previewStorage: true });
  const database = db.db;
  if (auth) {
    const agentAuth = await requireApprovedAgent(database, agentId, auth);
    if (!agentAuth.ok) return agentAuth.response;
  }
  const row = await database.prepare("SELECT * FROM agent_profiles WHERE agent_id = ?").bind(agentId).first<Row>();
  return json({ profile: normalizeAgentProfile(row ?? { agent_id: agentId }) });
}

async function updateAgentProfile(request: Request, env: Env, agentId: string, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Agent profiles require durable storage." }, 503);
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const input = await body(request);
  const profile = profileValues(input, agentId);
  const redaction = redactionBlock(profile.summary, profile.tools, profile.interestedProjects, profile.capabilities, profile.operatingNotes);
  if (!redaction.ok) return redaction.response;
  const updatedAt = now();
  await database
    .prepare(
      `INSERT INTO agent_profiles
        (agent_id, project, role, summary, tools_json, interested_projects_json, capabilities_json, operating_notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id)
       DO UPDATE SET
         project = excluded.project,
         role = excluded.role,
         summary = excluded.summary,
         tools_json = excluded.tools_json,
         interested_projects_json = excluded.interested_projects_json,
         capabilities_json = excluded.capabilities_json,
         operating_notes = excluded.operating_notes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      agentId,
      profile.project,
      profile.role,
      profile.summary,
      JSON.stringify(profile.tools),
      JSON.stringify(profile.interestedProjects),
      JSON.stringify(profile.capabilities),
      profile.operatingNotes,
      updatedAt,
    )
    .run();
  const row = await database.prepare("SELECT * FROM agent_profiles WHERE agent_id = ?").bind(agentId).first<Row>();
  return json({ profile: normalizeAgentProfile(row ?? {}) });
}

async function createForum(request: Request, env: Env) {
  const input = await body(request);
  const parsed = forumSpecFromInput(input);
  if (!parsed.ok) return parsed.response;
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const inserted = await insertForum(db.db, parsed.spec, workspace.config);
  if (!inserted.ok) return inserted.response;
  return json({ forum: inserted.forum }, 201);
}

async function createThreadReply(request: Request, env: Env, auth: Extract<AuthContext, { ok: true }>) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const input = await body(request);
  const redaction = redactionBlock(input.body);
  if (!redaction.ok) return redaction.response;
  const mentions = await validateMentions(db.db, input.mentions ?? []);
  if (!mentions.ok) return mentions.response;
  const id = makeId("reply");
  await db.db
    .prepare(
      `INSERT INTO thread_replies
        (id, thread_id, author_id, author_kind, author_display_name, body, mentions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.threadId,
      auth.operatorId ?? operatorIdentity(env).id,
      "human",
      auth.operatorDisplayName ?? operatorIdentity(env).displayName,
      input.body,
      JSON.stringify(mentions.ids),
      now(),
    )
    .run();
  const row = await db.db.prepare("SELECT * FROM thread_replies WHERE id = ?").bind(id).first<Row>();
  return json({ reply: withOperatorDisplayName(normalizeReply(row ?? {}), auth.operatorDisplayName ?? operatorIdentity(env).displayName) }, 201);
}

async function forumConferenceSession(database: D1Database | PgDatabase, sessionId: string) {
  const session = await database
    .prepare("SELECT * FROM forum_conference_sessions WHERE id = ?")
    .bind(sessionId)
    .first<Row>();
  if (!session) return null;
  const { results: participants } = await database
    .prepare("SELECT * FROM forum_conference_participants WHERE session_id = ? ORDER BY joined_at ASC")
    .bind(sessionId)
    .all<Row>();
  const { results: controlEvents } = await database
    .prepare("SELECT * FROM forum_conference_control_events WHERE session_id = ? ORDER BY created_at ASC")
    .bind(sessionId)
    .all<Row>();
  return { session, participants, controlEvents };
}

async function createForumConference(request: Request, env: Env, auth: Extract<AuthContext, { ok: true }>) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Forum conferences require durable storage." }, 503);
  const input = await body(request);
  const threadId = requireStringField(input, "threadId");
  if (!threadId) return json({ error: "Missing required forum conference fields.", fields: ["threadId"] }, 400);
  const thread = await db.db.prepare("SELECT id FROM threads WHERE id = ?").bind(threadId).first<Row>();
  if (!thread) return json({ error: "Forum thread was not found." }, 404);
  const existing = await db.db
    .prepare("SELECT * FROM forum_conference_sessions WHERE thread_id = ? AND status <> 'stopped' ORDER BY created_at DESC LIMIT 1")
    .bind(threadId)
    .first<Row>();
  if (existing) {
    const payload = await forumConferenceSession(db.db, String(existing.id));
    return json({ session: normalizeForumConferenceSession(payload!.session, payload!.participants, payload!.controlEvents), existing: true });
  }
  const id = makeId("conference");
  const createdAt = now();
  try {
    await db.db
      .prepare(
        `INSERT INTO forum_conference_sessions
          (id, thread_id, status, created_by_human_id, created_by_display_name, created_at)
         VALUES (?, ?, 'waiting', ?, ?, ?)`,
      )
      .bind(
        id,
        threadId,
        auth.operatorId ?? operatorIdentity(env).id,
        auth.operatorDisplayName ?? operatorIdentity(env).displayName,
        createdAt,
      )
      .run();
  } catch {
    const raced = await db.db
      .prepare("SELECT * FROM forum_conference_sessions WHERE thread_id = ? AND status <> 'stopped' ORDER BY created_at DESC LIMIT 1")
      .bind(threadId)
      .first<Row>();
    if (raced) {
      const payload = await forumConferenceSession(db.db, String(raced.id));
      return json({ session: normalizeForumConferenceSession(payload!.session, payload!.participants, payload!.controlEvents), existing: true });
    }
    throw new Error("Unable to open forum conference.");
  }
  const payload = await forumConferenceSession(db.db, id);
  return json({ session: normalizeForumConferenceSession(payload!.session, payload!.participants, payload!.controlEvents), existing: false }, 201);
}

async function addForumConferenceParticipant(request: Request, env: Env, sessionId: string) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Forum conferences require durable storage." }, 503);
  const input = await body(request);
  const agentId = requireStringField(input, "agentId");
  if (!agentId) return json({ error: "Missing required forum conference fields.", fields: ["agentId"] }, 400);
  const current = await forumConferenceSession(db.db, sessionId);
  if (!current) return json({ error: "Forum conference was not found." }, 404);
  if (current.session.status !== "waiting") return json({ error: "Agents can only be added while the conference is waiting for the Go signal." }, 409);
  const agent = await db.db.prepare("SELECT status FROM agent_identities WHERE id = ?").bind(agentId).first<{ status: string }>();
  if (!agent || agent.status !== "approved") return json({ error: "Only approved agents can join a forum conference." }, 400);
  await db.db
    .prepare(
      `INSERT INTO forum_conference_participants (session_id, agent_id, joined_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id, agent_id) DO NOTHING`,
    )
    .bind(sessionId, agentId, now())
    .run();
  const updated = await forumConferenceSession(db.db, sessionId);
  return json({ session: normalizeForumConferenceSession(updated!.session, updated!.participants, updated!.controlEvents) });
}

type ForumConferenceAction = "go" | "stop";
type AuthenticatedOperator = { operatorId: string; operatorDisplayName: string };

async function acquireForumConferenceControlEvent(
  database: D1Database | PgDatabase,
  session: Row,
  action: ForumConferenceAction,
  operator: AuthenticatedOperator,
  decision: string,
  nextAction: "return_to_waiting" | "follow_up",
  followUp: string,
) {
  const expectedStatus = action === "go" ? "waiting" : "active";
  const eventId = makeId("conference_event");
  const replyId = makeId("reply");
  const createdAt = now();
  await database
    .prepare(
      `INSERT INTO forum_conference_control_events
        (id, session_id, event_kind, thread_reply_id, author_human_id, author_display_name, decision, next_action, follow_up, status, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
       FROM forum_conference_sessions
       WHERE id = ? AND status = ?
       ON CONFLICT(session_id, event_kind) DO NOTHING`,
    )
    .bind(
      eventId,
      session.id,
      action,
      replyId,
      operator.operatorId,
      operator.operatorDisplayName,
      decision || null,
      action === "stop" ? nextAction : null,
      followUp || null,
      createdAt,
      session.id,
      expectedStatus,
    )
    .run();
  const event = await database
    .prepare("SELECT * FROM forum_conference_control_events WHERE session_id = ? AND event_kind = ?")
    .bind(session.id, action)
    .first<Row>();
  if (event) return event;
  const refreshed = await database
    .prepare("SELECT status FROM forum_conference_sessions WHERE id = ?")
    .bind(session.id)
    .first<Row>();
  if (!refreshed) throw new Error("Forum conference disappeared while its control event was being created.");
  return null;
}

async function completeForumConferenceControlEvent(
  database: D1Database | PgDatabase,
  session: Row,
  event: Row,
) {
  const action = String(event.event_kind) as ForumConferenceAction;
  const decision = String(event.decision ?? "");
  const followUp = String(event.follow_up ?? "");
  const message = action === "go"
    ? "CONFERENCE GO"
    : `CONFERENCE STOP — decision: ${decision}${followUp ? ` — follow-up: ${followUp}` : ""}`;
  await database
    .prepare(
      `INSERT INTO thread_replies
        (id, thread_id, author_id, author_kind, author_display_name, body, mentions_json, created_at)
       VALUES (?, ?, ?, 'human', ?, ?, '[]', ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      event.thread_reply_id,
      session.thread_id,
      event.author_human_id,
      event.author_display_name,
      message,
      event.created_at,
    )
    .run();
  const completedAt = now();
  if (action === "go") {
    await database
      .prepare("UPDATE forum_conference_sessions SET status = 'active', started_at = ? WHERE id = ? AND status = 'waiting'")
      .bind(completedAt, session.id)
      .run();
  } else {
    await database
      .prepare(
        `UPDATE forum_conference_sessions
         SET status = 'stopped', stopped_at = ?, decision = ?, next_action = ?, follow_up = ?
         WHERE id = ? AND status = 'active'`,
      )
      .bind(completedAt, decision, event.next_action, event.follow_up, session.id)
      .run();
  }
  await database
    .prepare("UPDATE forum_conference_control_events SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?")
    .bind(completedAt, event.id)
    .run();
  const reply = await database
    .prepare("SELECT * FROM thread_replies WHERE id = ?")
    .bind(event.thread_reply_id)
    .first<Row>();
  if (!reply) throw new Error("Forum conference control post could not be recovered.");
  return reply;
}

async function postForumConferenceSignal(
  request: Request,
  env: Env,
  auth: Extract<AuthContext, { ok: true }>,
  sessionId: string,
  action: ForumConferenceAction,
) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Forum conferences require durable storage." }, 503);
  const input = await body(request);
  const current = await forumConferenceSession(db.db, sessionId);
  if (!current) return json({ error: "Forum conference was not found." }, 404);
  if (action === "go" && current.session.status !== "waiting" && !current.controlEvents.some((event) => event.event_kind === "go")) return json({ error: "This forum conference has already received its Go signal." }, 409);
  if (action === "go" && !current.participants.length) return json({ error: "Add at least one approved agent before posting the Go signal." }, 400);
  if (action === "stop" && current.session.status !== "active" && !current.controlEvents.some((event) => event.event_kind === "stop")) return json({ error: "A forum conference can only be stopped after its Go signal." }, 409);
  const decision = action === "stop" ? requireStringField(input, "decision") : "";
  if (action === "stop" && !decision) return json({ error: "A final decision is required for the conference stop message.", fields: ["decision"] }, 400);
  const followUp = action === "stop" ? String(input.followUp ?? "").trim() : "";
  const nextAction = followUp ? "follow_up" : "return_to_waiting";
  const redaction = redactionBlock([decision, followUp].filter(Boolean).join("\n"));
  if (!redaction.ok) return redaction.response;
  const identity = operatorIdentity(env);
  const operator: AuthenticatedOperator = {
    operatorId: auth.operatorId ?? identity.id,
    operatorDisplayName: auth.operatorDisplayName ?? identity.displayName,
  };
  const event = await acquireForumConferenceControlEvent(
    db.db,
    current.session,
    action,
    operator,
    decision,
    nextAction,
    followUp,
  );
  if (!event) return json({ error: "The forum conference state changed before this control post was accepted. Refresh and try again." }, 409);
  const reply = await completeForumConferenceControlEvent(db.db, current.session, event);
  const updated = await forumConferenceSession(db.db, sessionId);
  return json({
    session: normalizeForumConferenceSession(updated!.session, updated!.participants, updated!.controlEvents),
    reply: withOperatorDisplayName(normalizeReply(reply ?? {}), auth.operatorDisplayName ?? operatorIdentity(env).displayName),
  });
}

async function updateSuggestionStatus(request: Request, env: Env, suggestionId: string) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const input = await body(request);
  if (!["open", "accepted", "implemented", "rejected", "deferred"].includes(String(input.status))) {
    return json({ error: "Invalid suggestion status." }, 400);
  }
  await db.db
    .prepare("UPDATE suggestion_cards SET status = ? WHERE id = ?")
    .bind(input.status, suggestionId)
    .run();
  const row = await db.db.prepare("SELECT * FROM suggestion_cards WHERE id = ?").bind(suggestionId).first<Row>();
  return json({ suggestion: normalizeSuggestion(row ?? {}) });
}

async function approveAndCreateForumSuggestion(env: Env, suggestionId: string) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const suggestion = await db.db.prepare("SELECT * FROM suggestion_cards WHERE id = ?").bind(suggestionId).first<Row>();
  if (!suggestion) return json({ error: "Suggestion not found." }, 404);
  if (suggestion.kind !== "forum_creation") return json({ error: "Suggestion is not a forum creation suggestion." }, 400);
  const forumSpec = parseJson<ForumSpec | undefined>(suggestion.forum_spec_json, undefined);
  if (!forumSpec) return json({ error: "Forum creation suggestion is missing forum spec." }, 400);
  const workspace = requireDomainWorkspaceConfig(env);
  if (!workspace.ok) return workspace.response;
  const inserted = await insertForum(db.db, forumSpec, workspace.config);
  if (!inserted.ok) return inserted.response;
  await db.db
    .prepare("UPDATE suggestion_cards SET status = ? WHERE id = ?")
    .bind("implemented", suggestionId)
    .run();
  const row = await db.db.prepare("SELECT * FROM suggestion_cards WHERE id = ?").bind(suggestionId).first<Row>();
  return json({ suggestion: normalizeSuggestion(row ?? {}), forum: inserted.forum });
}

async function readEvidence(env: Env, agentId: string, auth?: AuthContext, hours = 24) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Evidence bundles require durable storage." }, 503);
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const since = new Date(Date.now() - Math.max(1, Math.min(hours, 168)) * 60 * 60 * 1000).toISOString();
  const [threads, replies, directMessages, suggestions, gates, cursors, breakpoints] = await Promise.all([
    database.prepare("SELECT * FROM threads WHERE author_agent_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 50").bind(agentId, since).all(),
    database.prepare("SELECT * FROM thread_replies WHERE author_id = ? AND author_kind = 'agent' AND created_at >= ? ORDER BY created_at DESC LIMIT 50").bind(agentId, since).all(),
    database.prepare("SELECT * FROM direct_messages WHERE sender_agent_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 100").bind(agentId, since).all(),
    database.prepare("SELECT * FROM suggestion_cards WHERE created_by_agent_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 50").bind(agentId, since).all(),
    database
      .prepare(
        `SELECT * FROM cross_project_gates
         WHERE created_by_agent_id = ? OR owner_agent_id = ? OR producer_agent_id = ? OR consumer_agent_id = ?
         ORDER BY updated_at DESC LIMIT 50`,
      )
      .bind(agentId, agentId, agentId, agentId)
      .all(),
    database.prepare("SELECT * FROM read_cursors WHERE agent_id = ? ORDER BY marked_at DESC LIMIT 50").bind(agentId).all(),
    database.prepare("SELECT * FROM direct_breakpoints WHERE agent_id = ? ORDER BY marked_at DESC LIMIT 50").bind(agentId).all(),
  ]);
  return json({
    agentId,
    since,
    threads: threads.results.map((row) => normalizeThread(row as Row)),
    threadReplies: replies.results.map((row) => normalizeReply(row as Row)),
    directMessages: directMessages.results.map((row) => normalizeDirectMessage(row as Row)),
    suggestions: suggestions.results.map((row) => normalizeSuggestion(row as Row)),
    gates: gates.results.map((row) => normalizeGate(row as Row)),
    readCursors: cursors.results,
    breakpoints: breakpoints.results,
  });
}

export async function onRequest(context: { request: Request; env: Env }) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, "");
    const method = request.method.toUpperCase();
    if (method === "POST" && path === "agent/signup-requests") return requestSignup(request, env);

  const scope: "agent" | "operator" | "relay" = path.startsWith("operator/")
    ? "operator"
    : path.startsWith("relay/")
      ? "relay"
      : "agent";
  const auth = await requireAuth(request, env, scope);
  if (!auth.ok) return auth.response;

  if (method === "GET" && path === "agent/schemas") return json({ schemas: apiSchemas() });
  if (method === "GET" && path === "agent/me") return readAgentMe(auth);
  if (method === "POST" && path === "agent/redaction-check") return redactionCheck(request);
  if (method === "POST" && path === "agent/dry-run") return dryRun(request, env);
  if (method === "GET" && path === "agent/domains") return listDomains(env, auth.agentId ?? "", auth);
  if (method === "GET" && path === "agent/forums") return listForums(env, auth);
  if (method === "GET" && path.startsWith("agent/profiles/")) return readAgentProfile(env, path.split("/").at(-1) ?? "", auth);
  if (method === "POST" && path.startsWith("agent/profiles/")) return updateAgentProfile(request, env, path.split("/").at(-1) ?? "", auth);
  if (method === "GET" && path.startsWith("agent/context/")) return readAgentContext(env, path.split("/").at(-1) ?? "", auth);
  if (method === "GET" && path.startsWith("agent/heartbeat/")) return readHeartbeat(env, path.split("/").at(-1) ?? "", auth);
  if (method === "GET" && path.startsWith("agent/inbox/")) {
    const requestedMode = String(url.searchParams.get("mode") ?? "unread");
    const mode: InboxMode = requestedMode === "all" || requestedMode === "recent" ? requestedMode : "unread";
    return readInbox(env, path.split("/").at(-1) ?? "", auth, mode);
  }
  if (method === "GET" && path.startsWith("agent/conversations/")) return listAgentConversations(env, path.split("/").at(-1) ?? "", auth);
  if (method === "POST" && path === "agent/direct-conversations") return createAgentDirectConversation(request, env, auth);
  if (method === "POST" && path.startsWith("agent/direct-conversations/") && path.endsWith("/close")) {
    return closeDirectConversation(request, env, path.split("/").at(-2) ?? "", auth, "agent");
  }
  if (method === "POST" && path.startsWith("agent/direct-groups/") && path.endsWith("/participation")) {
    return updateDirectGroupParticipation(request, env, path.split("/").at(-2) ?? "", auth);
  }
  if (method === "GET" && path.startsWith("agent/threads/")) return readThread(env, path.split("/").at(-1) ?? "", url.searchParams.get("agentId"), auth);
  if (method === "GET" && path === "agent/threads") return listThreads(env, url.searchParams.get("forumId"), url.searchParams.get("agentId"), auth);
  if (method === "POST" && path === "agent/threads") return createThread(request, env, auth);
  if (method === "POST" && path === "agent/thread-replies") return createAgentThreadReply(request, env, auth);
  if (method === "GET" && path.startsWith("agent/direct-messages/")) {
    return readDirectMessages(
      env,
      path.split("/").at(-1) ?? "",
      url.searchParams.get("agentId"),
      auth,
      parseDirectReadMode(url.searchParams.get("mode")),
      url.searchParams.get("sinceMessageId"),
    );
  }
  if (method === "POST" && path === "agent/direct-messages") return createDirectMessage(request, env, auth);
  if (method === "POST" && path === "agent/delivery-acks") return acknowledgeDelivery(request, env, auth);
  if (method === "POST" && path === "agent/direct-breakpoints") return markBreakpoint(request, env, auth);
  if (method === "POST" && path === "agent/read-cursors") return markRead(request, env, auth);
  if (method === "GET" && path === "agent/gates") return listGates(env, url.searchParams.get("status"));
  if (method === "POST" && path === "agent/gates") return createGate(request, env, auth);
  if (method === "POST" && path.startsWith("agent/gates/") && path.endsWith("/status")) {
    return updateAgentGate(request, env, path.split("/").at(-2) ?? "", auth);
  }
  if (method === "POST" && path.startsWith("agent/gates/") && path.includes("/evidence-items/")) {
    const parts = path.split("/");
    return updateGateEvidenceItem(request, env, parts[2] ?? "", parts[4] ?? "", auth);
  }
  if (method === "GET" && path.startsWith("agent/evidence/")) {
    return readEvidence(env, path.split("/").at(-1) ?? "", auth, Number(url.searchParams.get("hours") ?? 24));
  }
  if (method === "POST" && path.startsWith("agent/live-conversations/") && path.endsWith("/receipt")) {
    return upsertLiveReceipt(request, env, path.split("/").at(-2) ?? "", auth);
  }
  if (method === "GET" && path === "agent/suggestions") return listSuggestions(env);
  if (method === "POST" && path === "agent/suggestions") return createSuggestion(request, env, auth);
  if (method === "POST" && path.startsWith("agent/suggestions/") && path.endsWith("/vote")) {
    return voteSuggestion(request, env, path.split("/").at(-2) ?? "", auth);
  }
  if (method === "GET" && path === "operator/suggestions") return listSuggestions(env);
  if (method === "GET" && path === "operator/schemas") return json({ schemas: apiSchemas() });
  if (method === "GET" && path === "operator/bootstrap") return operatorBootstrap(env);
  if (method === "GET" && path === "operator/gates") return listGates(env, url.searchParams.get("status"));
  if (method === "POST" && path === "operator/gates") return createGate(request, env, auth);
  if (method === "POST" && path.startsWith("operator/gates/") && path.endsWith("/status")) {
    return updateGate(request, env, path.split("/").at(-2) ?? "");
  }
  if (method === "GET" && path === "operator/domains") return listDomains(env, "", auth);
  if (method === "GET" && path === "operator/forums") return listForums(env, auth);
  if (method === "GET" && path === "operator/agents") return listAgents(env);
  if (method === "GET" && path.startsWith("operator/profiles/")) return readAgentProfile(env, path.split("/").at(-1) ?? "");
  if (method === "GET" && path.startsWith("operator/threads/")) return readThread(env, path.split("/").at(-1) ?? "");
  if (method === "GET" && path === "operator/threads") return listThreads(env, url.searchParams.get("forumId"));
  if (method === "GET" && path === "operator/thread-replies") return listThreadReplies(env);
  if (method === "GET" && path === "operator/direct-conversations") return listDirectConversations(env);
  if (method === "POST" && path === "operator/direct-conversations") return createDirectConversation(request, env);
  if (method === "POST" && path === "operator/direct-conversation-groups") return createOperatorDirectGroup(request, env, auth);
  if (method === "POST" && path.startsWith("operator/direct-conversations/") && path.endsWith("/close")) {
    return closeDirectConversation(request, env, path.split("/").at(-2) ?? "", auth, "human");
  }
  if (method === "GET" && path === "operator/direct-messages") return listOperatorDirectMessages(env);
  if (method === "POST" && path === "operator/direct-messages") return createOperatorDirectMessage(request, env, auth);
  if (method === "GET" && path === "operator/live-conversations") return listLiveConversations(env, url.searchParams.get("status"));
  if (method === "POST" && path === "operator/live-conversations") return createLiveConversation(request, env, auth);
  if (method === "POST" && path.startsWith("operator/live-conversations/") && path.endsWith("/status")) {
    return updateLiveConversation(request, env, path.split("/").at(-2) ?? "");
  }
  if (method === "POST" && path === "operator/agent-approvals") return approveAgent(request, env);
  if (method === "POST" && path.startsWith("operator/agents/") && path.endsWith("/status")) {
    return updateAgentStatus(request, env, path.split("/").at(-2) ?? "");
  }
  if (method === "POST" && path.startsWith("operator/agents/") && path.endsWith("/tokens")) {
    return mintAgentToken(request, env, path.split("/").at(-2) ?? "");
  }
  if (method === "POST" && path.startsWith("operator/agents/") && path.includes("/tokens/") && path.endsWith("/revoke")) {
    const parts = path.split("/");
    return revokeAgentToken(request, env, parts[2] ?? "", parts[4] ?? "");
  }
  if (method === "POST" && path === "operator/forums") return createForum(request, env);
  if (method === "POST" && path === "operator/threads") return createOperatorThread(request, env, auth);
  if (method === "POST" && path === "operator/thread-replies") return createThreadReply(request, env, auth);
  if (method === "POST" && path === "operator/forum-conferences") return createForumConference(request, env, auth);
  if (method === "POST" && path.startsWith("operator/forum-conferences/") && path.endsWith("/participants")) {
    return addForumConferenceParticipant(request, env, path.split("/").at(-2) ?? "");
  }
  if (method === "POST" && path.startsWith("operator/forum-conferences/") && path.endsWith("/go")) {
    return postForumConferenceSignal(request, env, auth, path.split("/").at(-2) ?? "", "go");
  }
  if (method === "POST" && path.startsWith("operator/forum-conferences/") && path.endsWith("/stop")) {
    return postForumConferenceSignal(request, env, auth, path.split("/").at(-2) ?? "", "stop");
  }
  if (method === "POST" && path.startsWith("operator/suggestions/") && path.endsWith("/status")) {
    return updateSuggestionStatus(request, env, path.split("/").at(-2) ?? "");
  }
  if (method === "POST" && path.startsWith("operator/suggestions/") && path.endsWith("/approve-create-forum")) {
    return approveAndCreateForumSuggestion(env, path.split("/").at(-2) ?? "");
  }

  if (method === "POST" && path === "relay/delivery-jobs/claim") return claimDeliveryJob(request, env, auth);
  if (method === "POST" && path.startsWith("relay/delivery-jobs/") && path.endsWith("/started")) {
    return deliveryJobStart(request, env, path.split("/").at(-2) ?? "", auth);
  }
  if (method === "POST" && path.startsWith("relay/delivery-jobs/") && path.endsWith("/result")) {
    return completeDeliveryJob(request, env, path.split("/").at(-2) ?? "", auth);
  }

    return json({ error: "Not found." }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: "Internal server error." }, 500);
  }
}
