interface Env {
  AGENT_API_TOKEN?: string;
  OPERATOR_API_TOKEN?: string;
  DB?: D1Database;
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
};

function requireAuth(request: Request, env: Env, scope: "agent" | "operator") {
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

function requireDb(env: Env): { ok: true; db: D1Database } | { ok: false; response: Response } {
  if (!env.DB) return { ok: false, response: json({ error: "Database binding DB is not configured." }, 503) };
  return { ok: true, db: env.DB };
}

async function listForums(env: Env) {
  const db = requireDb(env);
  if (!db.ok) return json({ forums: memory.forums, previewStorage: true });
  const database = db.db;
  const { results } = await database.prepare("SELECT * FROM forums ORDER BY name").all();
  return json({ forums: results });
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

export async function onRequest(context: { request: Request; env: Env }) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = request.method.toUpperCase();
  const scope = path.startsWith("operator/") ? "operator" : "agent";
  const auth = requireAuth(request, env, scope);
  if (!auth.ok) return auth.response;

  if (method === "GET" && path === "agent/forums") return listForums(env);
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

  return json({ error: "Not found." }, 404);
}
