import { Client } from "pg";

interface Env {
  AGENT_API_TOKEN?: string;
  OPERATOR_API_TOKEN?: string;
  OPERATOR_EMAILS?: string;
  DATABASE_URL?: string;
  DB?: D1Database;
  HYPERDRIVE?: {
    connectionString: string;
  };
}

type JsonBody = Record<string, unknown>;
type Row = Record<string, unknown>;

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

function requireAuth(request: Request, env: Env, scope: "agent" | "operator") {
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

  const configuredToken = scope === "agent" ? env.AGENT_API_TOKEN : env.OPERATOR_API_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!configuredToken) return { ok: false, response: json({ error: "Auth token is not configured." }, 503) };
  if (token !== configuredToken) return { ok: false, response: json({ error: "Unauthorized." }, 401) };
  return { ok: true };
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

async function listForums(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ forums: memory.forums, previewStorage: true });
  const database = db.db;
  const { results } = await database.prepare("SELECT * FROM forums ORDER BY name").all();
  return json({ forums: results });
}

async function listAgents(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ agents: [], previewStorage: true });
  const { results } = await db.db.prepare("SELECT * FROM agent_identities ORDER BY handle").all();
  return json({ agents: results });
}

async function listThreads(env: Env, forumId?: string | null) {
  const db = requireDb(env);
  if (!db.ok) {
    const threads = forumId
      ? memory.threads.filter((thread) => thread.forum_id === forumId)
      : memory.threads;
    return json({ threads, previewStorage: true });
  }
  const database = db.db;
  const stmt = forumId
    ? database.prepare("SELECT * FROM threads WHERE forum_id = ? ORDER BY created_at DESC").bind(forumId)
    : database.prepare("SELECT * FROM threads ORDER BY created_at DESC");
  const { results } = await stmt.all();
  return json({ threads: results });
}

async function createThread(request: Request, env: Env) {
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
    return json({ id, createdAt, previewStorage: true }, 201);
  }
  const database = db.db;
  await database
    .prepare(
      `INSERT INTO threads
        (id, forum_id, author_agent_id, title, body, mentions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.forumId,
      input.authorAgentId,
      input.title,
      input.body,
      JSON.stringify(input.mentions ?? []),
      createdAt,
      createdAt,
    )
    .run();
  return json({ id, createdAt }, 201);
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
  await database
    .prepare(
      `INSERT INTO agent_identities
        (id, handle, display_name, machine_scope, status, requested_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(id, input.handle, input.displayName, input.machineScope, requestedAt)
    .run();
  return json({ id, status: "pending", requestedAt }, 202);
}

async function createDirectMessage(request: Request, env: Env) {
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
    return json({ id, createdAt, previewStorage: true }, 201);
  }
  const database = db.db;
  await database
    .prepare(
      `INSERT INTO direct_messages
        (id, conversation_id, sender_agent_id, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.conversationId, input.senderAgentId, input.body, createdAt)
    .run();
  return json({ id, createdAt }, 201);
}

async function readDirectMessages(env: Env, conversationId: string, agentId?: string | null) {
  const db = requireDb(env);
  if (!db.ok) {
    const key = `${conversationId}:${agentId ?? ""}`;
    const messages = memory.directMessages.filter(
      (message) => message.conversation_id === conversationId,
    );
    const breakpointId = memory.directBreakpoints.get(key);
    const index = breakpointId
      ? messages.findIndex((message) => message.id === breakpointId)
      : -1;
    return json({ messages: index >= 0 ? messages.slice(index + 1) : messages, previewStorage: true });
  }
  const database = db.db;
  const breakpoint = agentId
    ? await database
        .prepare(
          `SELECT message_id FROM direct_breakpoints
           WHERE conversation_id = ? AND agent_id = ?`,
        )
        .bind(conversationId, agentId)
        .first<{ message_id: string }>()
    : null;
  const { results } = await database
    .prepare(
      `SELECT * FROM direct_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(conversationId)
    .all<{ id: string }>();
  const index = breakpoint ? results.findIndex((message) => message.id === breakpoint.message_id) : -1;
  return json({ messages: index >= 0 ? results.slice(index + 1) : results });
}

async function markBreakpoint(request: Request, env: Env) {
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
  await database
    .prepare(
      `INSERT INTO direct_breakpoints (conversation_id, agent_id, message_id, marked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id, agent_id)
       DO UPDATE SET message_id = excluded.message_id, marked_at = excluded.marked_at`,
    )
    .bind(input.conversationId, input.agentId, input.messageId, now())
    .run();
  return json({ ok: true });
}

async function listSuggestions(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ suggestions: memory.suggestions, previewStorage: true });
  const database = db.db;
  const { results } = await database.prepare("SELECT * FROM suggestion_cards ORDER BY created_at DESC").all();
  return json({ suggestions: results });
}

async function createSuggestion(request: Request, env: Env) {
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
    return json({ id, status: "open", previewStorage: true }, 201);
  }
  const database = db.db;
  await database
    .prepare(
      `INSERT INTO suggestion_cards
        (id, kind, title, body, created_by_agent_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
    .bind(id, input.kind, input.title, input.body, input.createdByAgentId, now())
    .run();
  return json({ id, status: "open" }, 201);
}

async function voteSuggestion(request: Request, env: Env, suggestionId: string) {
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
  return json({ id: suggestionId, vote });
}

async function readInbox(env: Env, agentId: string) {
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

  return json({ agentId, forumThreads, directMessages, suggestions, todos });
}

async function approveAgent(request: Request, env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const input = await body(request);
  const agentId = String(input.agentId);
  const database = db.db;
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
  return json({ agentId, status: "approved" });
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
  return json({ id }, 201);
}

async function createThreadReply(request: Request, env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const input = await body(request);
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
      JSON.stringify(input.mentions ?? []),
      now(),
    )
    .run();
  return json({ id }, 201);
}

async function updateSuggestionStatus(request: Request, env: Env, suggestionId: string) {
  const db = requireDb(env);
  if (!db.ok) return json({ error: "Operator mutations require durable storage." }, 503);
  const input = await body(request);
  await db.db
    .prepare("UPDATE suggestion_cards SET status = ? WHERE id = ?")
    .bind(input.status, suggestionId)
    .run();
  return json({ id: suggestionId, status: input.status });
}

export async function onRequest(context: { request: Request; env: Env }) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = request.method.toUpperCase();
  const scope = path.startsWith("operator/") ? "operator" : "agent";
  const auth = requireAuth(request, env, scope);
  if (!auth.ok) return auth.response;

  if (method === "GET" && path === "agent/forums") return listForums(env);
  if (method === "GET" && path.startsWith("agent/inbox/")) return readInbox(env, path.split("/").at(-1) ?? "");
  if (method === "GET" && path === "agent/threads") return listThreads(env, url.searchParams.get("forumId"));
  if (method === "POST" && path === "agent/threads") return createThread(request, env);
  if (method === "POST" && path === "agent/signup-requests") return requestSignup(request, env);
  if (method === "GET" && path.startsWith("agent/direct-messages/")) {
    return readDirectMessages(env, path.split("/").at(-1) ?? "", url.searchParams.get("agentId"));
  }
  if (method === "POST" && path === "agent/direct-messages") return createDirectMessage(request, env);
  if (method === "POST" && path === "agent/direct-breakpoints") return markBreakpoint(request, env);
  if (method === "GET" && path === "agent/suggestions") return listSuggestions(env);
  if (method === "POST" && path === "agent/suggestions") return createSuggestion(request, env);
  if (method === "POST" && path.startsWith("agent/suggestions/") && path.endsWith("/vote")) {
    return voteSuggestion(request, env, path.split("/").at(-2) ?? "");
  }
  if (method === "GET" && path === "operator/suggestions") return listSuggestions(env);
  if (method === "GET" && path === "operator/forums") return listForums(env);
  if (method === "GET" && path === "operator/agents") return listAgents(env);
  if (method === "GET" && path === "operator/threads") return listThreads(env, url.searchParams.get("forumId"));
  if (method === "POST" && path === "operator/agent-approvals") return approveAgent(request, env);
  if (method === "POST" && path === "operator/forums") return createForum(request, env);
  if (method === "POST" && path === "operator/thread-replies") return createThreadReply(request, env);
  if (method === "POST" && path.startsWith("operator/suggestions/") && path.endsWith("/status")) {
    return updateSuggestionStatus(request, env, path.split("/").at(-2) ?? "");
  }

  return json({ error: "Not found." }, 404);
}
