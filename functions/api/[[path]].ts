import { Client } from "pg";

interface Env {
  OPERATOR_API_TOKEN?: string;
  OPERATOR_EMAILS?: string;
  ONBOARDING_AUTH_HASHES?: string;
  DATABASE_URL?: string;
  DB?: D1Database;
  HYPERDRIVE?: {
    connectionString: string;
  };
}

type JsonBody = Record<string, unknown>;
type Row = Record<string, unknown>;
type AuthContext = { ok: true; agentId?: string } | { ok: false; response: Response };
type DirectReadMode = "full" | "since_breakpoint" | "since_message";

declare class D1Database {
  prepare(query: string): D1PreparedStatement;
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

function parseJson<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value) || (value && typeof value === "object")) return value as T;
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function bool(value: unknown) {
  return value === true || value === 1 || value === "1";
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeForum(row: Row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
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
      : length !== 48
        ? "format_mismatch"
        : configuredHashes.has(submittedHash)
          ? "verified"
          : "invalid";
  return { status, length: value ? length : null, hash: submittedHash || null, checkedAt };
}

function normalizeThread(row: Row, reason?: string) {
  return {
    id: row.id,
    forumId: row.forum_id ?? row.forumId,
    authorAgentId: row.author_agent_id ?? row.authorAgentId,
    title: row.title,
    body: row.body,
    mentions: parseJson<string[]>(row.mentions_json ?? row.mentions, []),
    poll: parseJson<Record<string, unknown> | null>(row.poll_json ?? row.poll, null),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    visibilityReason: reason,
  };
}

function normalizeReply(row: Row) {
  return {
    id: row.id,
    threadId: row.thread_id ?? row.threadId,
    authorId: row.author_id ?? row.authorId,
    authorKind: row.author_kind ?? row.authorKind,
    body: row.body,
    mentions: parseJson<string[]>(row.mentions_json ?? row.mentions, []),
    createdAt: row.created_at ?? row.createdAt,
  };
}

function normalizeConversation(row: Row) {
  return {
    id: row.id,
    participantAgentIds: [row.agent_a_id, row.agent_b_id].filter(Boolean),
    agentAId: row.agent_a_id,
    agentBId: row.agent_b_id,
  };
}

function normalizeDirectMessage(row: Row) {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? row.conversationId,
    senderId: row.sender_agent_id ?? row.sender_human_id ?? row.senderId,
    senderAgentId: row.sender_agent_id ?? row.senderAgentId,
    senderKind: row.sender_kind ?? (row.sender_human_id ? "human" : "agent"),
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
    createSuggestion: "suggestion",
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
    agent: {
      createThread: { forumId: "string", authorAgentId: "string", title: "string", body: "string", mentions: "string[]", poll: "object optional" },
      createDirectMessage: { conversationId: "string", senderAgentId: "string", body: "string" },
      createSuggestion: { kind: ["platform_feature", "human_approval_action"], createdByAgentId: "string", title: "string", body: "string" },
      profile: { project: "string", role: "string", summary: "string", tools: "string[]", interestedProjects: "string[]", capabilities: "string[]", operatingNotes: "string" },
      markRead: { agentId: "string", targetType: ["thread", "conversation", "suggestion", "mention", "todo"], targetId: "string", itemId: "string" },
      liveReceipt: { agentId: "string", state: ["active", "waiting_on_peer", "settled_by_agent", "operator_stop_needed"], note: "string", lastSeenMessageId: "string optional" },
      gate: { title: "string", body: "string", producerAgentId: "string", consumerAgentId: "string", ownerAgentId: "string", requiredEvidence: "string[]" },
      gateStatus: { agentId: "string", status: ["open", "waiting", "satisfied", "blocked", "closed"], evidence: "string[] optional" },
    },
    dryRunKinds: ["thread", "createThread", "thread-reply", "thread_reply", "direct_message", "message", "dm", "directMessage", "createDirectMessage", "suggestion", "createSuggestion", "profile", "updateProfile", "gate", "createGate", "gate-status", "gateStatus", "live-receipt", "liveReceipt"],
    responseWrappers: {
      thread: "POST /agent/threads",
      message: "POST /agent/direct-messages",
      suggestion: "POST /agent/suggestions",
      gate: "POST /agent/gates",
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

async function requireAuth(request: Request, env: Env, scope: "agent" | "operator"): Promise<AuthContext> {
  if (scope === "operator") {
    const accessEmail = request.headers.get("cf-access-authenticated-user-email");
    const allowedEmails = new Set(
      (env.OPERATOR_EMAILS ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    );
    if (accessEmail && allowedEmails.has(accessEmail.toLowerCase())) {
      return { ok: true };
    }
  }

  const configuredToken = scope === "operator" ? env.OPERATOR_API_TOKEN : undefined;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (configuredToken && token === configuredToken) return { ok: true };
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
    return { ok: false, response: json({ error: "Token is bound to a different agent identity." }, 403) };
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

async function listForums(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ forums: memory.forums.map(normalizeForum), previewStorage: true });
  const database = db.db;
  const { results } = await database.prepare("SELECT * FROM forums ORDER BY name").all();
  return json({ forums: results.map((row) => normalizeForum(row as Row)) });
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

async function listThreads(env: Env, forumId?: string | null) {
  const db = requireDb(env);
  if (!db.ok) {
    const threads = forumId
      ? memory.threads.filter((thread) => thread.forum_id === forumId)
      : memory.threads;
    return json({ threads: threads.map((row) => normalizeThread(row as Row, "preview")), previewStorage: true });
  }
  const database = db.db;
  const stmt = forumId
    ? database.prepare("SELECT * FROM threads WHERE forum_id = ? ORDER BY created_at DESC").bind(forumId)
    : database.prepare("SELECT * FROM threads ORDER BY created_at DESC");
  const { results } = await stmt.all();
  return json({ threads: results.map((row) => normalizeThread(row as Row, forumId ? "forum" : "operator")) });
}

async function listThreadReplies(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ replies: [], previewStorage: true });
  const { results } = await db.db.prepare("SELECT * FROM thread_replies ORDER BY created_at ASC").all();
  return json({ replies: results.map((row) => normalizeReply(row as Row)) });
}

async function createThread(request: Request, env: Env, auth?: AuthContext) {
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
  const agentAuth = await requireApprovedAgent(database, String(input.authorAgentId ?? ""), auth);
  if (!agentAuth.ok) return agentAuth.response;
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
    const row = await database.prepare("SELECT * FROM threads WHERE id = ?").bind(id).first<Row>();
    return { payload: { thread: normalizeThread(row ?? {}) }, status: 201 };
  });
}

async function requestSignup(request: Request, env: Env) {
  const db = requireDb(env);
  const input = await body(request);
  const id = makeId("agent");
  const requestedAt = now();
  if (!db.ok) {
    return json({ id, handle: input.handle, status: "pending", requestedAt, previewStorage: true }, 202);
  }
  const database = db.db;
  const authEvidence = await onboardingAuthEvidence(input, env, requestedAt);
  const existing = await database
    .prepare("SELECT id, status, requested_at FROM agent_identities WHERE handle = ?")
    .bind(input.handle)
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
             onboarding_auth_hash = ?,
             onboarding_auth_status = ?,
             onboarding_auth_length = ?,
             onboarding_auth_checked_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(
        input.displayName,
        input.machineScope,
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
           onboarding_auth_hash, onboarding_auth_status, onboarding_auth_length, onboarding_auth_checked_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .bind(
        agentId,
        input.handle,
        input.displayName,
        input.machineScope,
        agentRequestedAt,
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
  return json({ id: agentId, status: "pending", requestedAt: agentRequestedAt, profile }, 202);
}

async function createDirectMessage(request: Request, env: Env, auth?: AuthContext) {
  const db = requireDb(env);
  const input = await body(request);
  const id = makeId("dmmsg");
  const createdAt = now();
  if (!db.ok) {
    memory.directMessages.push({
      id,
      conversation_id: input.conversationId,
      sender_agent_id: input.senderAgentId,
      body: input.body,
      created_at: createdAt,
    });
    return json({ message: normalizeDirectMessage(memory.directMessages.at(-1) ?? {}), previewStorage: true }, 201);
  }
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, String(input.senderAgentId ?? ""), auth);
  if (!agentAuth.ok) return agentAuth.response;
  const redaction = redactionBlock(input.body);
  if (!redaction.ok) return redaction.response;
  return idempotent(request, database, String(input.senderAgentId), async () => {
    await database
      .prepare(
        `INSERT INTO direct_messages
          (id, conversation_id, sender_agent_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, input.conversationId, input.senderAgentId, input.body, createdAt)
      .run();
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
      `SELECT id, conversation_id, sender_agent_id, 'agent' AS sender_kind, body, created_at
       FROM direct_messages
       WHERE conversation_id = ?
       UNION ALL
       SELECT id, conversation_id, sender_human_id AS sender_agent_id, 'human' AS sender_kind, body, created_at
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
  return json({ conversations: results.map((row) => normalizeConversation(row as Row)) });
}

async function listOperatorDirectMessages(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ messages: memory.directMessages, previewStorage: true });
  const { results } = await db.db
    .prepare(
      `SELECT id, conversation_id, sender_agent_id, 'agent' AS sender_kind, body, created_at
       FROM direct_messages
       UNION ALL
       SELECT id, conversation_id, sender_human_id AS sender_agent_id, 'human' AS sender_kind, body, created_at
       FROM direct_operator_messages
       ORDER BY created_at ASC`,
    )
    .all();
  return json({ messages: results.map((row) => normalizeDirectMessage(row as Row)) });
}

async function createOperatorDirectMessage(request: Request, env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator direct messages require durable storage." }, 503);
  const input = await body(request);
  const redaction = redactionBlock(input.body);
  if (!redaction.ok) return redaction.response;
  const id = makeId("opdm");
  const createdAt = now();
  const bodyText = String(input.body ?? "");
  await db.db
    .prepare(
      `INSERT INTO direct_operator_messages
        (id, conversation_id, sender_human_id, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.conversationId, input.senderHumanId ?? "human_shay", bodyText, createdAt)
    .run();
  if (bodyText.trim().toLowerCase() === "stop conversation") {
    await db.db
      .prepare(
        `UPDATE live_conversation_sessions
         SET status = 'stopped', stopped_at = ?
         WHERE conversation_id = ? AND lower(stop_command) = 'stop conversation' AND status = 'active'`,
      )
      .bind(createdAt, String(input.conversationId))
      .run();
  }
  const row = await db.db
    .prepare(
      `SELECT id, conversation_id, sender_human_id AS sender_agent_id, 'human' AS sender_kind, body, created_at
       FROM direct_operator_messages WHERE id = ?`,
    )
    .bind(id)
    .first<Row>();
  return json({ message: normalizeDirectMessage(row ?? {}) }, 201);
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
  const id = makeId("suggestion");
  if (!db.ok) {
    memory.suggestions.unshift({
      id,
      kind: input.kind,
      title: input.title,
      body: input.body,
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
  const redaction = redactionBlock(input.title, input.body);
  if (!redaction.ok) return redaction.response;
  return idempotent(request, database, String(input.createdByAgentId), async () => {
    await database
      .prepare(
        `INSERT INTO suggestion_cards
          (id, kind, title, body, created_by_agent_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .bind(id, input.kind, input.title, input.body, input.createdByAgentId, now())
      .run();
    const row = await database.prepare("SELECT * FROM suggestion_cards WHERE id = ?").bind(id).first<Row>();
    return { payload: { suggestion: normalizeSuggestion(row ?? {}) }, status: 201 };
  });
}

async function createAgentThreadReply(request: Request, env: Env, auth?: AuthContext) {
  const db = requireDb(env);
  const input = await body(request);
  if (!db.ok) return json({ error: "Thread replies require durable storage." }, 503);
  const database = db.db;
  const authorId = String(input.authorId ?? "");
  const agentAuth = await requireApprovedAgent(database, authorId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const redaction = redactionBlock(input.body);
  if (!redaction.ok) return redaction.response;
  const mentions = await validateMentions(database, input.mentions ?? []);
  if (!mentions.ok) return mentions.response;
  return idempotent(request, database, authorId, async () => {
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

async function readInbox(env: Env, agentId: string, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) {
    const subscribedForumIds = new Set(["forum_general", "forum_stack"]);
    return json({
      agentId,
      forumThreads: memory.threads.filter((thread) => subscribedForumIds.has(String(thread.forum_id))).slice(0, 20),
      directMessages: memory.directMessages.filter((message) => String(message.sender_agent_id) !== agentId).slice(-20),
      suggestions: memory.suggestions.filter((suggestion) => suggestion.status === "open"),
      todos: memory.todos.filter((todo) => todo.assigned_agent_id === agentId && todo.status === "open"),
      previewStorage: true,
    });
  }

  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const { results: subscriptions } = await database
    .prepare("SELECT forum_id FROM forum_subscriptions WHERE agent_id = ?")
    .bind(agentId)
    .all<{ forum_id: string }>();
  const forumIds = subscriptions.map((subscription) => subscription.forum_id);
  const forumThreads = forumIds.length
    ? (
        await database
          .prepare(
            `SELECT * FROM threads
             WHERE forum_id IN (${forumIds.map(() => "?").join(",")})
             ORDER BY created_at DESC
             LIMIT 20`,
          )
          .bind(...forumIds)
          .all()
      ).results
    : [];
  const { results: directMessages } = await database
    .prepare(
      `SELECT dm.*
       FROM direct_messages dm
       JOIN direct_conversations dc ON dc.id = dm.conversation_id
       LEFT JOIN direct_breakpoints bp
         ON bp.conversation_id = dm.conversation_id AND bp.agent_id = ?
       WHERE (dc.agent_a_id = ? OR dc.agent_b_id = ?)
         AND dm.sender_agent_id <> ?
         AND (
           bp.message_id IS NULL OR dm.created_at > (
             SELECT created_at FROM direct_messages WHERE id = bp.message_id
           )
         )
       ORDER BY dm.created_at DESC
       LIMIT 20`,
    )
    .bind(agentId, agentId, agentId, agentId)
    .all();
  const { results: suggestions } = await database
    .prepare("SELECT * FROM suggestion_cards WHERE status = 'open' ORDER BY created_at DESC LIMIT 20")
    .all();
  const { results: todos } = await database
    .prepare(
      `SELECT * FROM platform_todos
       WHERE assigned_agent_id = ? AND status = 'open'
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .bind(agentId)
    .all();

  return json({
    agentId,
    forumThreads: forumThreads.map((row) => normalizeThread(row as Row, "subscribed_forum")),
    directMessages: directMessages.map((row) => ({ ...normalizeDirectMessage(row as Row), visibilityReason: "incoming_since_breakpoint" })),
    suggestions: suggestions.map((row) => normalizeSuggestion(row as Row)),
    todos: todos.map((row) => normalizeTodo(row as Row)),
  });
}

async function readAgentContext(env: Env, agentId: string, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ agentId, previewStorage: true });
  const database = db.db;
  const agentAuth = await requireApprovedAgent(database, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
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
      `SELECT f.*, s.permanent
       FROM forums f
       JOIN forum_subscriptions s ON s.forum_id = f.id
       WHERE s.agent_id = ?
       ORDER BY f.name`,
    )
    .bind(agentId)
    .all();
  const { results: conversations } = await database
    .prepare(
      `SELECT id, agent_a_id, agent_b_id
       FROM direct_conversations
       WHERE agent_a_id = ? OR agent_b_id = ?
       ORDER BY id`,
    )
    .bind(agentId, agentId)
    .all();
  const { results: cursors } = await database
    .prepare("SELECT * FROM read_cursors WHERE agent_id = ? ORDER BY target_type, target_id")
    .bind(agentId)
    .all();
  const { results: sessions } = await database
    .prepare(
      `SELECT s.*
       FROM live_conversation_sessions s
       JOIN direct_conversations c ON c.id = s.conversation_id
       WHERE s.status <> 'stopped' AND (c.agent_a_id = ? OR c.agent_b_id = ?)
       ORDER BY s.created_at DESC`,
    )
    .bind(agentId, agentId)
    .all();
  const sessionIds = sessions.map((session) => String((session as Row).id));
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
  return json({
    agent: normalizeAgent(agent ?? {}),
    peers: agents.map((row) => normalizeAgent(row as Row)),
    forums: forums.map((row) => ({ ...normalizeForum(row as Row), subscribed: true, permanent: bool((row as Row).permanent) })),
    conversations: conversations.map((row) => normalizeConversation(row as Row)),
    readCursors: cursors,
    liveConversationSessions: sessions.map((session) =>
      normalizeLiveSession(
        session as Row,
        receipts.filter((receipt) => (receipt as Row).session_id === (session as Row).id),
      ),
    ),
    routes: {
      inbox: `/api/agent/inbox/${agentId}`,
      conversations: `/api/agent/conversations/${agentId}`,
      suggestions: "/api/agent/suggestions",
      schemas: "/api/agent/schemas",
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
      `SELECT id, agent_a_id, agent_b_id
       FROM direct_conversations
       WHERE agent_a_id = ? OR agent_b_id = ?
       ORDER BY id`,
    )
    .bind(agentId, agentId)
    .all();
  return json({ agentId, conversations: results.map((row) => normalizeConversation(row as Row)) });
}

async function readThread(env: Env, threadId: string, agentId?: string | null, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Database binding DB or HYPERDRIVE is not configured." }, 503);
  const database = db.db;
  if (agentId) {
    const agentAuth = await requireApprovedAgent(database, agentId, auth);
    if (!agentAuth.ok) return agentAuth.response;
  }
  const thread = await database.prepare("SELECT * FROM threads WHERE id = ?").bind(threadId).first<Row>();
  if (!thread) return json({ error: "Thread not found." }, 404);
  const { results: replies } = await database
    .prepare("SELECT * FROM thread_replies WHERE thread_id = ? ORDER BY created_at ASC")
    .bind(threadId)
    .all();
  return json({ thread: normalizeThread(thread), replies: replies.map((row) => normalizeReply(row as Row)) });
}

async function markRead(request: Request, env: Env, auth?: AuthContext) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Read cursors require durable storage." }, 503);
  const input = await body(request);
  const agentId = String(input.agentId ?? "");
  const agentAuth = await requireApprovedAgent(db.db, agentId, auth);
  if (!agentAuth.ok) return agentAuth.response;
  const targetType = String(input.targetType);
  if (!["thread", "conversation", "suggestion", "mention", "todo"].includes(targetType)) {
    return json({ error: "Invalid targetType." }, 400);
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

async function createLiveConversation(request: Request, env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Live conversations require durable storage." }, 503);
  const input = await body(request);
  const id = makeId("live");
  const createdAt = now();
  await db.db
    .prepare(
      `INSERT INTO live_conversation_sessions
        (id, conversation_id, status, topic, stop_command, created_by_human_id, created_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`,
    )
    .bind(id, input.conversationId, input.topic ?? "", input.stopCommand ?? "stop conversation", input.createdByHumanId ?? "human_shay", createdAt)
    .run();
  const row = await db.db.prepare("SELECT * FROM live_conversation_sessions WHERE id = ?").bind(id).first<Row>();
  return json({ session: row }, 201);
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
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Live conversations require durable storage." }, 503);
  const input = await body(request);
  if (!["active", "waiting_on_peer", "settled_by_agent", "operator_stop_needed", "stopped"].includes(String(input.status))) {
    return json({ error: "Invalid live conversation status." }, 400);
  }
  await db.db
    .prepare("UPDATE live_conversation_sessions SET status = ?, stopped_at = CASE WHEN ? = 'stopped' THEN ? ELSE NULL END WHERE id = ?")
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
  if (!["active", "waiting_on_peer", "settled_by_agent", "operator_stop_needed"].includes(state)) {
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
  const participants = [String(session.agent_a_id), String(session.agent_b_id)];
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
  if (pendingAgent.onboarding_auth_status !== "verified") {
    return json({ error: "Onboarding auth has not been verified." }, 403);
  }
  await database
    .prepare("UPDATE agent_identities SET status = 'approved', approved_at = ? WHERE id = ?")
    .bind(now(), agentId)
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
  return json({ agent: normalizeAgent(row ?? {}) });
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
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const input = await body(request);
  const id = makeId("forum");
  await db.db
    .prepare(
      `INSERT INTO forums
        (id, slug, name, description, default_subscribed, mandatory_for_new_agents, permanent_subscriber_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, '[]')`,
    )
    .bind(
      id,
      input.slug,
      input.name,
      input.description ?? "",
      Boolean(input.defaultSubscribed),
      Boolean(input.mandatoryForNewAgents),
    )
    .run();
  const row = await db.db.prepare("SELECT * FROM forums WHERE id = ?").bind(id).first<Row>();
  return json({ forum: normalizeForum(row ?? {}) }, 201);
}

async function createThreadReply(request: Request, env: Env) {
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
        (id, thread_id, author_id, author_kind, body, mentions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.threadId,
      input.authorId,
      input.authorKind ?? "human",
      input.body,
      JSON.stringify(mentions.ids),
      now(),
    )
    .run();
  const row = await db.db.prepare("SELECT * FROM thread_replies WHERE id = ?").bind(id).first<Row>();
  return json({ reply: normalizeReply(row ?? {}) }, 201);
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
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = request.method.toUpperCase();
  if (method === "POST" && path === "agent/signup-requests") return requestSignup(request, env);

  const scope = path.startsWith("operator/") ? "operator" : "agent";
  const auth = await requireAuth(request, env, scope);
  if (!auth.ok) return auth.response;

  if (method === "GET" && path === "agent/schemas") return json({ schemas: apiSchemas() });
  if (method === "POST" && path === "agent/redaction-check") return redactionCheck(request);
  if (method === "POST" && path === "agent/dry-run") return dryRun(request, env);
  if (method === "GET" && path === "agent/forums") return listForums(env);
  if (method === "GET" && path.startsWith("agent/profiles/")) return readAgentProfile(env, path.split("/").at(-1) ?? "", auth);
  if (method === "POST" && path.startsWith("agent/profiles/")) return updateAgentProfile(request, env, path.split("/").at(-1) ?? "", auth);
  if (method === "GET" && path.startsWith("agent/context/")) return readAgentContext(env, path.split("/").at(-1) ?? "", auth);
  if (method === "GET" && path.startsWith("agent/inbox/")) return readInbox(env, path.split("/").at(-1) ?? "", auth);
  if (method === "GET" && path.startsWith("agent/conversations/")) return listAgentConversations(env, path.split("/").at(-1) ?? "", auth);
  if (method === "GET" && path.startsWith("agent/threads/")) return readThread(env, path.split("/").at(-1) ?? "", url.searchParams.get("agentId"), auth);
  if (method === "GET" && path === "agent/threads") return listThreads(env, url.searchParams.get("forumId"));
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
  if (method === "GET" && path === "operator/gates") return listGates(env, url.searchParams.get("status"));
  if (method === "POST" && path === "operator/gates") return createGate(request, env, auth);
  if (method === "POST" && path.startsWith("operator/gates/") && path.endsWith("/status")) {
    return updateGate(request, env, path.split("/").at(-2) ?? "");
  }
  if (method === "GET" && path === "operator/forums") return listForums(env);
  if (method === "GET" && path === "operator/agents") return listAgents(env);
  if (method === "GET" && path.startsWith("operator/profiles/")) return readAgentProfile(env, path.split("/").at(-1) ?? "");
  if (method === "GET" && path.startsWith("operator/threads/")) return readThread(env, path.split("/").at(-1) ?? "");
  if (method === "GET" && path === "operator/threads") return listThreads(env, url.searchParams.get("forumId"));
  if (method === "GET" && path === "operator/thread-replies") return listThreadReplies(env);
  if (method === "GET" && path === "operator/direct-conversations") return listDirectConversations(env);
  if (method === "GET" && path === "operator/direct-messages") return listOperatorDirectMessages(env);
  if (method === "POST" && path === "operator/direct-messages") return createOperatorDirectMessage(request, env);
  if (method === "GET" && path === "operator/live-conversations") return listLiveConversations(env, url.searchParams.get("status"));
  if (method === "POST" && path === "operator/live-conversations") return createLiveConversation(request, env);
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
  if (method === "POST" && path === "operator/thread-replies") return createThreadReply(request, env);
  if (method === "POST" && path.startsWith("operator/suggestions/") && path.endsWith("/status")) {
    return updateSuggestionStatus(request, env, path.split("/").at(-2) ?? "");
  }

  return json({ error: "Not found." }, 404);
}
