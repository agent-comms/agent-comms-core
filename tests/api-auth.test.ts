import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { onRequest } from "../functions/api/[[path]]";

type MockLiveSession = {
  id: string;
  conversation_id: string;
  status: string;
  topic: string;
  stop_command: string;
  created_by_human_id: string;
  created_at: string;
};

type MockLiveReceipt = {
  session_id: string;
  agent_id: string;
  state: string;
  note: string;
  last_seen_message_id: string | null;
  updated_at: string;
};

type MockDirectConversation = {
  id: string;
  agent_a_id: string;
  agent_b_id: string;
};

type MockConversationParticipant = {
  conversation_id: string;
  agent_id: string;
};

class MockLiveSessionDb {
  sessions: MockLiveSession[];
  receipts: MockLiveReceipt[];
  conversations: MockDirectConversation[];
  participants: MockConversationParticipant[];

  insertCount = 0;
  insertConflictSession?: MockLiveSession;

  constructor(
    sessions: MockLiveSession[] = [],
    conversations: MockDirectConversation[] = [],
    receipts: MockLiveReceipt[] = [],
    participants: MockConversationParticipant[] = [],
  ) {
    this.sessions = sessions;
    this.conversations = conversations;
    this.receipts = receipts;
    this.participants = participants;
  }

  prepare(query: string) {
    return new MockLiveSessionStatement(this, query);
  }
}

class MockLiveSessionStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: MockLiveSessionDb,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM agent_api_tokens")) {
      return { agent_id: "agent_a", status: "approved" } as T;
    }
    if (this.query.includes("SELECT status FROM agent_identities")) {
      return { status: "approved" } as T;
    }
    if (this.query.includes("FROM live_conversation_sessions s") && this.query.includes("JOIN direct_conversations c")) {
      const sessionId = String(this.values[0]);
      const session = this.db.sessions.find((candidate) => candidate.id === sessionId);
      const conversation = this.db.conversations.find((candidate) => candidate.id === session?.conversation_id);
      if (!session || !conversation) return null;
      return { ...session, ...conversation } as T;
    }
    if (this.query.includes("WHERE conversation_id = ? AND status <> 'stopped'")) {
      const conversationId = String(this.values[0]);
      return this.db.sessions
        .filter((session) => session.conversation_id === conversationId && session.status !== "stopped")
        .sort((left, right) => right.created_at.localeCompare(left.created_at))[0] as T ?? null;
    }
    if (this.query.includes("WHERE id = ?")) {
      const sessionId = String(this.values[0]);
      return this.db.sessions.find((session) => session.id === sessionId) as T ?? null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM direct_conversation_participants")) {
      const conversationId = String(this.values[0]);
      return { results: this.db.participants.filter((participant) => participant.conversation_id === conversationId) as T[] };
    }
    if (this.query.includes("FROM live_conversation_receipts WHERE session_id = ?")) {
      const sessionId = String(this.values[0]);
      return { results: this.db.receipts.filter((receipt) => receipt.session_id === sessionId) as T[] };
    }
    return { results: [] };
  }

  async run() {
    if (this.query.includes("INSERT INTO live_conversation_sessions")) {
      const [id, conversationId, topic, stopCommand, createdByHumanId, createdAt] = this.values.map(String);
      this.db.insertCount += 1;
      if (this.db.insertConflictSession) {
        this.db.sessions.push(this.db.insertConflictSession);
        throw new Error("UNIQUE constraint failed: live_conversation_sessions.conversation_id");
      }
      this.db.sessions.push({
        id,
        conversation_id: conversationId,
        status: "active",
        topic,
        stop_command: stopCommand,
        created_by_human_id: createdByHumanId,
        created_at: createdAt,
      });
    }
    if (this.query.includes("INSERT INTO live_conversation_receipts")) {
      const [sessionId, agentId, state, note, lastSeenMessageId, updatedAt] = this.values.map((value) =>
        value === null || value === undefined ? null : String(value)
      );
      const existing = this.db.receipts.find((receipt) => receipt.session_id === sessionId && receipt.agent_id === agentId);
      const receipt = {
        session_id: String(sessionId),
        agent_id: String(agentId),
        state: String(state),
        note: String(note ?? ""),
        last_seen_message_id: lastSeenMessageId,
        updated_at: String(updatedAt),
      };
      if (existing) Object.assign(existing, receipt);
      else this.db.receipts.push(receipt);
    }
    if (this.query.includes("UPDATE live_conversation_sessions SET status = ? WHERE id = ? AND status <> 'stopped'")) {
      const [status, sessionId] = this.values.map(String);
      const session = this.db.sessions.find((candidate) => candidate.id === sessionId && candidate.status !== "stopped");
      if (session) session.status = status;
    }
    return {};
  }
}

class MockReadCursorDb {
  readCursorWrites: unknown[][] = [];

  prepare(query: string) {
    return new MockReadCursorStatement(this, query);
  }
}

class MockReadCursorStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: MockReadCursorDb,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM agent_api_tokens")) {
      return { agent_id: "agent_project", status: "approved" } as T;
    }
    if (this.query.includes("SELECT status FROM agent_identities")) {
      return { status: "approved" } as T;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: [] };
  }

  async run() {
    if (this.query.includes("INSERT INTO read_cursors")) {
      this.db.readCursorWrites.push(this.values);
    }
    return {};
  }
}

class MockGroupConversationDb {
  conversations: Array<{ id: string; agent_a_id: string; agent_b_id: string }> = [];
  participants: Array<{ conversation_id: string; agent_id: string }> = [];

  prepare(query: string) {
    return new MockGroupConversationStatement(this, query);
  }
}

class MockGroupConversationStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: MockGroupConversationDb,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM agent_api_tokens")) {
      return { agent_id: "agent_author", status: "approved" } as T;
    }
    if (this.query.includes("SELECT status FROM agent_identities")) return { status: "approved" } as T;
    if (this.query.includes("FROM direct_conversations c") && this.query.includes("NOT EXISTS")) {
      const expectedCount = Number(this.values[0]);
      const requested = this.values.slice(1).map(String).sort();
      const conversation = this.db.conversations.find((candidate) => {
        const actual = this.db.participants
          .filter((participant) => participant.conversation_id === candidate.id)
          .map((participant) => participant.agent_id)
          .sort();
        return actual.length === expectedCount && actual.join(",") === requested.join(",");
      });
      return (conversation ?? null) as T | null;
    }
    if (this.query.includes("FROM direct_conversations WHERE id = ?")) {
      return (this.db.conversations.find((conversation) => conversation.id === String(this.values[0])) ?? null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.query.includes("SELECT id, status FROM agent_identities")) {
      return {
        results: ["agent_author", "agent_peer", "agent_reviewer"]
          .filter((id) => this.values.map(String).includes(id))
          .map((id) => ({ id, status: "approved" })) as T[],
      };
    }
    if (this.query.includes("SELECT agent_id FROM direct_conversation_participants")) {
      return { results: this.db.participants.filter((participant) => participant.conversation_id === String(this.values[0])) as T[] };
    }
    return { results: [] };
  }

  async run() {
    if (this.query.includes("INSERT INTO direct_conversations")) {
      const [id, agentA, agentB] = this.values.map(String);
      this.db.conversations.push({ id, agent_a_id: agentA, agent_b_id: agentB });
    }
    if (this.query.includes("INSERT INTO direct_conversation_participants")) {
      const [conversationId, agentId] = this.values.map(String);
      if (!this.db.participants.some((participant) => participant.conversation_id === conversationId && participant.agent_id === agentId)) {
        this.db.participants.push({ conversation_id: conversationId, agent_id: agentId });
      }
    }
    return {};
  }
}

type MockForumConferenceSession = {
  id: string;
  thread_id: string;
  status: "waiting" | "active" | "stopped";
  created_by_human_id: string;
  created_by_display_name: string;
  created_at: string;
  started_at?: string;
  stopped_at?: string;
  decision?: string | null;
  next_action?: string;
  follow_up?: string | null;
};

type MockForumConferenceEvent = {
  id: string;
  session_id: string;
  event_kind: "go" | "stop";
  thread_reply_id: string;
  author_human_id: string;
  author_display_name: string;
  decision?: string | null;
  next_action?: string | null;
  follow_up?: string | null;
  status: "pending" | "completed";
  created_at: string;
  completed_at?: string;
};

class MockForumConferenceDb {
  sessions: MockForumConferenceSession[] = [];
  participants: Array<{ session_id: string; agent_id: string; joined_at: string }> = [];
  events: MockForumConferenceEvent[] = [];
  replies: Array<Record<string, unknown>> = [];

  prepare(query: string) {
    return new MockForumConferenceStatement(this, query);
  }
}

class MockForumConferenceStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: MockForumConferenceDb,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM agent_api_tokens")) return { agent_id: "agent_a", status: "approved" } as T;
    if (this.query.includes("SELECT id FROM threads WHERE id = ?")) return { id: String(this.values[0]) } as T;
    if (this.query.includes("SELECT f.domain_id")) return { domain_id: "general" } as T;
    if (this.query.includes("SELECT domain_id FROM agent_identities")) return { domain_id: "general" } as T;
    if (this.query.includes("WHERE thread_id = ? AND status <> 'stopped'")) {
      return (this.db.sessions.find((session) => session.thread_id === String(this.values[0]) && session.status !== "stopped") ?? null) as T | null;
    }
    if (this.query.includes("SELECT * FROM forum_conference_sessions WHERE id = ?")) {
      return (this.db.sessions.find((session) => session.id === String(this.values[0])) ?? null) as T | null;
    }
    if (this.query.includes("SELECT status FROM forum_conference_sessions WHERE id = ?")) {
      const session = this.db.sessions.find((candidate) => candidate.id === String(this.values[0]));
      return (session ? { status: session.status } : null) as T | null;
    }
    if (this.query.includes("SELECT status FROM agent_identities")) return { status: "approved" } as T;
    if (this.query.includes("JOIN forum_conference_participants p ON p.session_id = s.id")) {
      const [threadId, agentId] = this.values.map(String);
      const waiting = this.db.sessions.find((session) =>
        session.thread_id === threadId &&
        session.status === "waiting" &&
        this.db.participants.some((participant) => participant.session_id === session.id && participant.agent_id === agentId),
      );
      return (waiting ? { id: waiting.id } : null) as T | null;
    }
    if (this.query.includes("FROM forum_conference_control_events WHERE session_id = ? AND event_kind = ?")) {
      return (this.db.events.find((event) => event.session_id === String(this.values[0]) && event.event_kind === String(this.values[1])) ?? null) as T | null;
    }
    if (this.query.includes("SELECT * FROM thread_replies WHERE id = ?")) {
      return (this.db.replies.find((reply) => reply.id === String(this.values[0])) ?? null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM forum_conference_participants")) {
      return { results: this.db.participants.filter((participant) => participant.session_id === String(this.values[0])) as T[] };
    }
    if (this.query.includes("FROM forum_conference_control_events")) {
      return { results: this.db.events.filter((event) => event.session_id === String(this.values[0])) as T[] };
    }
    return { results: [] };
  }

  async run() {
    if (this.query.includes("INSERT INTO forum_conference_sessions")) {
      const [id, threadId, humanId, displayName, createdAt] = this.values.map(String);
      this.db.sessions.push({
        id,
        thread_id: threadId,
        status: "waiting",
        created_by_human_id: humanId,
        created_by_display_name: displayName,
        created_at: createdAt,
        next_action: "return_to_waiting",
      });
    }
    if (this.query.includes("INSERT INTO forum_conference_participants")) {
      const [sessionId, agentId, joinedAt] = this.values.map(String);
      if (!this.db.participants.some((participant) => participant.session_id === sessionId && participant.agent_id === agentId)) {
        this.db.participants.push({ session_id: sessionId, agent_id: agentId, joined_at: joinedAt });
      }
    }
    if (this.query.includes("INSERT INTO forum_conference_control_events")) {
      const [id, sessionId, eventKind, replyId, authorId, authorDisplayName, decision, nextAction, followUp, createdAt, expectedSessionId, expectedStatus] = this.values;
      const session = this.db.sessions.find((candidate) => candidate.id === String(expectedSessionId));
      if (session?.status === String(expectedStatus) && !this.db.events.some((event) => event.session_id === String(sessionId) && event.event_kind === String(eventKind))) {
        this.db.events.push({
          id: String(id),
          session_id: String(sessionId),
          event_kind: String(eventKind) as "go" | "stop",
          thread_reply_id: String(replyId),
          author_human_id: String(authorId),
          author_display_name: String(authorDisplayName),
          decision: decision === null ? null : String(decision),
          next_action: nextAction === null ? null : String(nextAction),
          follow_up: followUp === null ? null : String(followUp),
          status: "pending",
          created_at: String(createdAt),
        });
      }
    }
    if (this.query.includes("INSERT INTO thread_replies")) {
      const [id, threadId, authorId, authorDisplayName, body, createdAt] = this.values.map(String);
      if (!this.db.replies.some((reply) => reply.id === id)) {
        this.db.replies.push({
          id,
          thread_id: threadId,
          author_id: authorId,
          author_kind: "human",
          author_display_name: authorDisplayName,
          body,
          mentions_json: "[]",
          created_at: createdAt,
        });
      }
    }
    if (this.query.includes("SET status = 'active'")) {
      const [startedAt, sessionId] = this.values.map(String);
      const session = this.db.sessions.find((candidate) => candidate.id === sessionId && candidate.status === "waiting");
      if (session) {
        session.status = "active";
        session.started_at = startedAt;
      }
    }
    if (this.query.includes("SET status = 'stopped'")) {
      const [stoppedAt, decision, nextAction, followUp, sessionId] = this.values;
      const session = this.db.sessions.find((candidate) => candidate.id === String(sessionId) && candidate.status === "active");
      if (session) {
        session.status = "stopped";
        session.stopped_at = String(stoppedAt);
        session.decision = String(decision);
        session.next_action = String(nextAction);
        session.follow_up = followUp === null ? null : String(followUp);
      }
    }
    if (this.query.includes("UPDATE forum_conference_control_events SET status = 'completed'")) {
      const [completedAt, eventId] = this.values.map(String);
      const event = this.db.events.find((candidate) => candidate.id === eventId);
      if (event) {
        event.status = "completed";
        event.completed_at = completedAt;
      }
    }
    return {};
  }
}

describe("API auth", () => {
  it("permits the explicitly enabled local operator runtime without a token", async () => {
    const response = await onRequest({
      request: new Request("https://example.test/api/operator/schemas"),
      env: { LOCAL_OPERATOR_AUTH_BYPASS: "1" } as never,
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    expect(response.status).toBe(200);
  });

  it("enforces a disabled human direct-group capability before accessing storage", async () => {
    const response = await onRequest({
      request: new Request("https://example.test/api/operator/direct-conversation-groups", {
        method: "POST",
        headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
        body: JSON.stringify({ participantAgentIds: ["agent_a", "agent_b"] }),
      }),
      env: {
        OPERATOR_API_TOKEN: "operator-token",
        OPERATOR_DIRECT_GROUPS_ENABLED: "false",
      } as never,
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      error: "Human-created direct groups are disabled by this deployment.",
    });
  });

  it("keeps relay targets and diagnostics out of operator bootstrap delivery telemetry", async () => {
    const bootstrapDb = {
      prepare(query: string) {
        const statement = {
          bind: (..._values: unknown[]) => statement,
          all: async () => ({
            results: query.includes("FROM agent_delivery_bindings")
              ? [{
                  id: "binding_1",
                  agent_id: "agent_a",
                  adapter_key: "generic_adapter",
                  target_ref: "relay-only-target",
                  display_label: "Bound thread",
                  status: "active",
                  revision: 1,
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                }]
              : query.includes("FROM direct_delivery_jobs")
                ? [{
                    id: "job_1",
                    event_id: "event_1",
                    conversation_id: "dm_1",
                    recipient_agent_id: "agent_a",
                    sequence_number: 1,
                    status: "delivered",
                    attempts: 1,
                    detail: "relay-only diagnostic",
                  }]
                : [],
          }),
          run: async () => ({}),
        };
        return statement;
      },
    };
    const response = await onRequest({
      request: new Request("https://example.test/api/operator/bootstrap", {
        headers: { authorization: "Bearer operator-token" },
      }),
      env: {
        DB: bootstrapDb,
        OPERATOR_API_TOKEN: "operator-token",
        OPERATOR_DIRECT_GROUPS_ENABLED: "false",
      } as never,
    });

    expect(response?.status).toBe(200);
    const payload = await response?.json() as {
      operator?: { capabilities?: { directGroups?: { create?: boolean } } };
      deliveryBindings?: Array<Record<string, unknown>>;
      deliveryJobs?: Array<Record<string, unknown>>;
    };
    expect(payload.operator?.capabilities?.directGroups?.create).toBe(false);
    expect(payload.deliveryBindings?.[0]).toMatchObject({ id: "binding_1", agentId: "agent_a", status: "active" });
    expect(payload.deliveryBindings?.[0]).not.toHaveProperty("targetRef");
    expect(payload.deliveryJobs?.[0]).toMatchObject({ id: "job_1", recipientAgentId: "agent_a", status: "delivered" });
    expect(payload.deliveryJobs?.[0]).not.toHaveProperty("detail");
    expect(JSON.stringify(payload)).not.toContain("relay-only-target");
    expect(JSON.stringify(payload)).not.toContain("relay-only diagnostic");
  });

  it("allows unauthenticated signup requests as pending-only onboarding", async () => {
    const request = new Request("https://example.test/api/agent/signup-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "dev@example",
        displayName: "Example dev agent",
        machineScope: "project:example",
        profile: { project: "Example", role: "dev" },
      }),
    });

    const response = await onRequest({ request, env: {} });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { status?: string; previewStorage?: boolean };

    expect(response.status).toBe(202);
    expect(payload.status).toBe("pending");
    expect(payload.previewStorage).toBe(true);
  });

  it("does not accept a shared AGENT_API_TOKEN for agent endpoints", async () => {
    const request = new Request("https://example.test/api/agent/forums", {
      headers: { authorization: "Bearer shared-token" },
    });

    const response = await onRequest({
      request,
      env: { AGENT_API_TOKEN: "shared-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe("Unauthorized.");
  });

  it("returns field-level validation for incomplete signup payloads", async () => {
    const request = new Request("https://example.test/api/agent/signup-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "dev@example" }),
    });

    const response = await onRequest({ request, env: {} });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { error?: string; fields?: string[] };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Missing required signup fields.");
    expect(payload.fields).toEqual(["displayName", "machineScope"]);
  });

  it("validates a deployment-owned handle domain capture against signup domainId", async () => {
    const config = JSON.stringify({
      domains: [
        { id: "general", name: "General" },
        { id: "research", name: "Research" },
      ],
      defaultDomainId: "general",
      writePolicy: "home_and_default",
    });
    const mismatch = new Request("https://example.test/api/agent/signup-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "dev[codex]@example/research",
        displayName: "Example agent",
        machineScope: "machine:example",
        domainId: "general",
      }),
    });
    const mismatchResponse = await onRequest({
      request: mismatch,
      env: {
        DOMAIN_WORKSPACE_CONFIG: config,
        SIGNUP_DOMAIN_REQUIRED: "1",
        SIGNUP_HANDLE_PATTERN: "^[a-z]+\\[[a-z]+\\]@[a-z0-9-]+/[a-z0-9-]+$",
        SIGNUP_HANDLE_DOMAIN_PATTERN: "^[a-z]+\\[[a-z]+\\]@[a-z0-9-]+/(?<domain>[a-z0-9-]+)$",
      } as never,
    });
    expect(mismatchResponse?.status).toBe(400);
    expect((await mismatchResponse?.json() as { error?: string }).error).toBe("signup_handle_domain_mismatch");

    const nonmatchingHandle = new Request("https://example.test/api/agent/signup-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "dev#codex@example/research",
        displayName: "Example agent",
        machineScope: "machine:example",
        domainId: "research",
      }),
    });
    const nonmatchingHandleResponse = await onRequest({
      request: nonmatchingHandle,
      env: {
        DOMAIN_WORKSPACE_CONFIG: config,
        SIGNUP_DOMAIN_REQUIRED: "1",
        SIGNUP_HANDLE_DOMAIN_PATTERN: "^[a-z]+\\[[a-z]+\\]@[a-z0-9-]+/(?<domain>[a-z0-9-]+)$",
      } as never,
    });
    expect(nonmatchingHandleResponse?.status).toBe(400);
    expect((await nonmatchingHandleResponse?.json() as { error?: string }).error).toBe("signup_handle_domain_mismatch");

    const matched = new Request("https://example.test/api/agent/signup-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "dev[codex]@example/research",
        displayName: "Example agent",
        machineScope: "machine:example",
        domainId: "research",
      }),
    });
    const matchedResponse = await onRequest({
      request: matched,
      env: {
        DOMAIN_WORKSPACE_CONFIG: config,
        SIGNUP_DOMAIN_REQUIRED: "1",
        SIGNUP_HANDLE_PATTERN: "^[a-z]+\\[[a-z]+\\]@[a-z0-9-]+/[a-z0-9-]+$",
        SIGNUP_HANDLE_DOMAIN_PATTERN: "^[a-z]+\\[[a-z]+\\]@[a-z0-9-]+/(?<domain>[a-z0-9-]+)$",
      } as never,
    });
    expect(matchedResponse?.status).toBe(202);
    expect((await matchedResponse?.json() as { domainId?: string }).domainId).toBe("research");
  });

  it("rejects an invalid explicitly configured default workspace instead of silently falling back", async () => {
    const request = new Request("https://example.test/api/operator/bootstrap", {
      headers: { authorization: "Bearer operator-token" },
    });
    const response = await onRequest({
      request,
      env: {
        OPERATOR_API_TOKEN: "operator-token",
        DOMAIN_WORKSPACE_CONFIG: JSON.stringify({
          domains: [{ id: "general", name: "General" }],
          defaultDomainId: "not a domain slug",
        }),
      } as never,
    });
    expect(response?.status).toBe(500);
    expect((await response?.json() as { error?: string }).error).toBe("domain_workspace_config_misconfigured");
  });

  it("rejects signup without onboarding auth when deployment requires it", async () => {
    const request = new Request("https://example.test/api/agent/signup-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "dev@example",
        displayName: "Example dev agent",
        machineScope: "project:example",
      }),
    });

    const response = await onRequest({
      request,
      env: { ONBOARDING_AUTH_HASHES: "abc123" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { error?: string; message?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("onboarding_auth_required");
    expect(payload.message).not.toContain("48");
  });

  it("verifies a configured onboarding auth value regardless of its length", async () => {
    const authString = "a".repeat(64);
    const configuredHash = createHash("sha256").update(authString).digest("hex");
    const request = new Request("https://example.test/api/agent/signup-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "dev@example",
        displayName: "Example dev agent",
        machineScope: "project:example",
        authString,
      }),
    });

    const response = await onRequest({
      request,
      env: { ONBOARDING_AUTH_HASHES: configuredHash } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { onboardingAuth?: string; status?: string };

    expect(response.status).toBe(202);
    expect(payload.status).toBe("pending");
    expect(payload.onboardingAuth).toBe("verified");
  });

  it("returns field-level validation for incomplete operator forum creation", async () => {
    const request = new Request("https://example.test/api/operator/forums", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Data engineering" }),
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { error?: string; fields?: string[] };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Missing required forum fields.");
    expect(payload.fields).toEqual(["description"]);
  });

  it("rejects invalid operator forum slugs before storage access", async () => {
    const request = new Request("https://example.test/api/operator/forums", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: "Bad Slug!",
        name: "Bad slug",
        description: "This request should fail validation.",
      }),
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toContain("Forum slug");
  });

  it("returns field-level validation for incomplete direct conversation creation", async () => {
    const request = new Request("https://example.test/api/operator/direct-conversations", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentAId: "agent_a" }),
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { error?: string; fields?: string[] };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Missing required direct conversation fields.");
    expect(payload.fields).toEqual(["agentBId"]);
  });

  it("rejects direct conversations with the same agent before storage access", async () => {
    const request = new Request("https://example.test/api/operator/direct-conversations", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentAId: "agent_a", agentBId: "agent_a" }),
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Direct conversations require two different agents.");
  });

  it("creates a deployment-wide group conversation with explicit membership", async () => {
    const db = new MockGroupConversationDb();
    const request = new Request("https://example.test/api/agent/direct-conversations", {
      method: "POST",
      headers: {
        authorization: "Bearer minted-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent_author",
        participantAgentIds: ["agent_author", "agent_peer", "agent_reviewer"],
      }),
    });
    const response = await onRequest({ request, env: { DB: db } as never });
    expect(response?.status).toBe(201);
    const payload = await response?.json() as { conversation?: { participantAgentIds?: string[] } };
    expect(payload.conversation?.participantAgentIds).toEqual(["agent_author", "agent_peer", "agent_reviewer"]);
    expect(db.participants.map((participant) => participant.agent_id).sort()).toEqual([
      "agent_author",
      "agent_peer",
      "agent_reviewer",
    ]);

    const pairRequest = new Request("https://example.test/api/agent/direct-conversations", {
      method: "POST",
      headers: {
        authorization: "Bearer minted-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: "agent_author", peerAgentId: "agent_peer" }),
    });
    const pairResponse = await onRequest({ request: pairRequest, env: { DB: db } as never });
    expect(pairResponse?.status).toBe(201);
    expect(db.conversations).toHaveLength(2);

    const duplicateGroupRequest = new Request("https://example.test/api/agent/direct-conversations", {
      method: "POST",
      headers: {
        authorization: "Bearer minted-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent_author",
        participantAgentIds: ["agent_author", "agent_peer", "agent_reviewer"],
      }),
    });
    const duplicateGroupResponse = await onRequest({ request: duplicateGroupRequest, env: { DB: db } as never });
    expect(duplicateGroupResponse?.status).toBe(200);
    expect(db.conversations).toHaveLength(2);
  });

  it("does not let an approved agent write a breakpoint for a conversation it has not joined", async () => {
    const db = new MockGroupConversationDb();
    db.conversations.push({ id: "dm_private", agent_a_id: "agent_peer", agent_b_id: "agent_reviewer" });
    db.participants.push(
      { conversation_id: "dm_private", agent_id: "agent_peer" },
      { conversation_id: "dm_private", agent_id: "agent_reviewer" },
    );
    const request = new Request("https://example.test/api/agent/direct-breakpoints", {
      method: "POST",
      headers: {
        authorization: "Bearer minted-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversationId: "dm_private",
        agentId: "agent_author",
        messageId: "dm_msg_1",
      }),
    });

    const response = await onRequest({ request, env: { DB: db } as never });
    expect(response?.status).toBe(403);
    expect((await response?.json() as { error?: string }).error).toBe("Agent is not a participant in this direct conversation.");
  });

  it("documents forum creation suggestions in the agent schema", async () => {
    const request = new Request("https://example.test/api/operator/schemas", {
      headers: { authorization: "Bearer operator-token" },
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { schemas?: { agent?: { createSuggestion?: { kind?: string[] } } } };

    expect(response.status).toBe(200);
    expect(payload.schemas?.agent?.createSuggestion?.kind).toContain("forum_creation");
  });

  it("documents pairwise-compatible and group direct conversation creation in the agent schema", async () => {
    const request = new Request("https://example.test/api/operator/schemas", {
      headers: { authorization: "Bearer operator-token" },
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { schemas?: { agent?: { createDirectConversation?: { agentId?: string; peerAgentId?: string; participantAgentIds?: string } } } };

    expect(response.status).toBe(200);
    expect(payload.schemas?.agent?.createDirectConversation).toMatchObject({
      agentId: "string",
      peerAgentId: expect.stringContaining("pairwise"),
      participantAgentIds: expect.stringContaining("approved agents"),
    });
  });

  it("documents the heartbeat helper in the agent schema", async () => {
    const request = new Request("https://example.test/api/operator/schemas", {
      headers: { authorization: "Bearer operator-token" },
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { schemas?: { agent?: { heartbeat?: string } } };

    expect(response.status).toBe(200);
    expect(payload.schemas?.agent?.heartbeat).toBe("GET /agent/heartbeat/:agentId");
  });

  it("documents inbox read-state semantics in the agent schema", async () => {
    const request = new Request("https://example.test/api/operator/schemas", {
      headers: { authorization: "Bearer operator-token" },
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as {
      schemas?: {
        agent?: {
          inbox?: {
            defaultMode?: string;
            forumThreadFields?: string[];
            route?: string;
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.schemas?.agent?.inbox?.defaultMode).toBe("unread");
    expect(payload.schemas?.agent?.inbox?.route).toContain("mode=unread|all|recent");
    expect(payload.schemas?.agent?.inbox?.forumThreadFields).toEqual(
      expect.arrayContaining(["readState", "unread", "visibilityReason", "latestItemId", "lastReadItemId"]),
    );
  });

  it("documents mark-read target aliases in the agent schema", async () => {
    const request = new Request("https://example.test/api/operator/schemas", {
      headers: { authorization: "Bearer operator-token" },
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as {
      schemas?: {
        agent?: {
          markRead?: {
            targetType?: string[];
            targetTypeAliases?: { conversation?: string[]; thread?: string[] };
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.schemas?.agent?.markRead?.targetType).toEqual(["thread", "conversation", "suggestion", "mention", "todo"]);
    expect(payload.schemas?.agent?.markRead?.targetTypeAliases?.conversation).toEqual(
      expect.arrayContaining(["dm", "direct-message", "direct-conversation"]),
    );
    expect(payload.schemas?.agent?.markRead?.targetTypeAliases?.thread).toContain("forum-thread");
  });

  it("documents waiting_on_operator in the agent live receipt schema", async () => {
    const request = new Request("https://example.test/api/operator/schemas", {
      headers: { authorization: "Bearer operator-token" },
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as {
      schemas?: { agent?: { liveReceipt?: { state?: string[] } } };
    };

    expect(response.status).toBe(200);
    expect(payload.schemas?.agent?.liveReceipt?.state).toContain("waiting_on_operator");
  });

  it("normalizes mark-read target aliases before persisting read cursors", async () => {
    const db = new MockReadCursorDb();
    const request = new Request("https://example.test/api/agent/read-cursors", {
      method: "POST",
      headers: {
        authorization: "Bearer minted-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent_project",
        targetType: "dm",
        targetId: "dm_project_peer",
        itemId: "dm_msg_123",
      }),
    });

    const response = await onRequest({
      request,
      env: { DB: db } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { targetType?: string };

    expect(response.status).toBe(200);
    expect(payload.targetType).toBe("conversation");
    expect(db.readCursorWrites).toHaveLength(1);
    expect(db.readCursorWrites[0].slice(0, 4)).toEqual(["agent_project", "conversation", "dm_project_peer", "dm_msg_123"]);
  });

  it("returns actionable mark-read target validation details", async () => {
    const db = new MockReadCursorDb();
    const request = new Request("https://example.test/api/agent/read-cursors", {
      method: "POST",
      headers: {
        authorization: "Bearer minted-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent_project",
        targetType: "channel",
        targetId: "dm_project_peer",
        itemId: "dm_msg_123",
      }),
    });

    const response = await onRequest({
      request,
      env: { DB: db } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as {
      error?: string;
      validTargetTypes?: string[];
      acceptedAliases?: { conversation?: string[] };
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Invalid targetType.");
    expect(payload.validTargetTypes).toEqual(["thread", "conversation", "suggestion", "mention", "todo"]);
    expect(payload.acceptedAliases?.conversation).toContain("dm");
    expect(db.readCursorWrites).toHaveLength(0);
  });

  it("rejects invalid live conversation status before storage access", async () => {
    const request = new Request("https://example.test/api/operator/live-conversations/live_123/status", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "paused" }),
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Invalid live conversation status.");
  });

  it("accepts waiting_on_operator receipts and derives waiting_on_operator before waiting_on_peer", async () => {
    const db = new MockLiveSessionDb(
      [
        {
          id: "live_waiting",
          conversation_id: "dm_waiting",
          status: "active",
          topic: "Needs an operator handoff.",
          stop_command: "stop conversation",
          created_by_human_id: "human_operator",
          created_at: "2026-05-31T08:00:00.000Z",
        },
      ],
      [{ id: "dm_waiting", agent_a_id: "agent_a", agent_b_id: "agent_b" }],
      [
        {
          session_id: "live_waiting",
          agent_id: "agent_b",
          state: "waiting_on_peer",
          note: "Waiting on peer.",
          last_seen_message_id: "dm_msg_1",
          updated_at: "2026-05-31T08:00:00.000Z",
        },
      ],
    );
    const request = new Request("https://example.test/api/agent/live-conversations/live_waiting/receipt", {
      method: "POST",
      headers: {
        authorization: "Bearer minted-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent_a",
        state: "waiting_on_operator",
        note: "Need the operator to provision the API key.",
        lastSeenMessageId: "dm_msg_2",
      }),
    });

    const response = await onRequest({
      request,
      env: { DB: db } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as {
      session?: { status?: string };
      receipt?: { state?: string; note?: string; last_seen_message_id?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.receipt).toMatchObject({
      state: "waiting_on_operator",
      note: "Need the operator to provision the API key.",
      last_seen_message_id: "dm_msg_2",
    });
    expect(payload.session?.status).toBe("waiting_on_operator");
    expect(db.sessions[0].status).toBe("waiting_on_operator");
  });

  it("waits for every explicit group member before marking a live conversation settled", async () => {
    const db = new MockLiveSessionDb(
      [
        {
          id: "live_group",
          conversation_id: "dm_group",
          status: "active",
          topic: "Group review.",
          stop_command: "stop conversation",
          created_by_human_id: "human_operator",
          created_at: "2026-05-31T08:00:00.000Z",
        },
      ],
      [{ id: "dm_group", agent_a_id: "agent_a", agent_b_id: "agent_b" }],
      [
        {
          session_id: "live_group",
          agent_id: "agent_b",
          state: "settled_by_agent",
          note: "Done.",
          last_seen_message_id: "dm_msg_1",
          updated_at: "2026-05-31T08:00:00.000Z",
        },
        {
          session_id: "live_group",
          agent_id: "agent_c",
          state: "waiting_on_peer",
          note: "Still evaluating.",
          last_seen_message_id: "dm_msg_2",
          updated_at: "2026-05-31T08:00:00.000Z",
        },
      ],
      [
        { conversation_id: "dm_group", agent_id: "agent_a" },
        { conversation_id: "dm_group", agent_id: "agent_b" },
        { conversation_id: "dm_group", agent_id: "agent_c" },
      ],
    );
    const request = new Request("https://example.test/api/agent/live-conversations/live_group/receipt", {
      method: "POST",
      headers: {
        authorization: "Bearer minted-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: "agent_a", state: "settled_by_agent" }),
    });

    const response = await onRequest({ request, env: { DB: db } as never });
    expect(response?.status).toBe(200);
    expect((await response?.json() as { session?: { status?: string } }).session?.status).toBe("waiting_on_peer");
    expect(db.sessions[0].status).toBe("waiting_on_peer");
  });

  it("keeps operator_stop_needed ahead of waiting_on_operator when deriving live status", async () => {
    const db = new MockLiveSessionDb(
      [
        {
          id: "live_stop",
          conversation_id: "dm_stop",
          status: "active",
          topic: "Needs adjudication.",
          stop_command: "stop conversation",
          created_by_human_id: "human_operator",
          created_at: "2026-05-31T08:00:00.000Z",
        },
      ],
      [{ id: "dm_stop", agent_a_id: "agent_a", agent_b_id: "agent_b" }],
      [
        {
          session_id: "live_stop",
          agent_id: "agent_b",
          state: "operator_stop_needed",
          note: "Hard stop.",
          last_seen_message_id: "dm_msg_1",
          updated_at: "2026-05-31T08:00:00.000Z",
        },
      ],
    );
    const request = new Request("https://example.test/api/agent/live-conversations/live_stop/receipt", {
      method: "POST",
      headers: {
        authorization: "Bearer minted-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "agent_a",
        state: "waiting_on_operator",
        note: "Routine operator action also needed.",
      }),
    });

    const response = await onRequest({
      request,
      env: { DB: db } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { session?: { status?: string } };

    expect(response.status).toBe(200);
    expect(payload.session?.status).toBe("operator_stop_needed");
    expect(db.sessions[0].status).toBe("operator_stop_needed");
  });

  it("reuses an existing active live session for a direct conversation", async () => {
    const db = new MockLiveSessionDb([
      {
        id: "live_existing",
        conversation_id: "dm_existing",
        status: "active",
        topic: "Existing operator request.",
        stop_command: "stop conversation",
        created_by_human_id: "human_operator",
        created_at: "2026-05-31T08:00:00.000Z",
      },
    ]);
    const request = new Request("https://example.test/api/operator/live-conversations", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversationId: "dm_existing",
        topic: "Second operator request.",
      }),
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token", DB: db } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as {
      existing?: boolean;
      session?: { id?: string; conversationId?: string; topic?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.existing).toBe(true);
    expect(payload.session).toMatchObject({
      id: "live_existing",
      conversationId: "dm_existing",
      topic: "Existing operator request.",
    });
    expect(db.insertCount).toBe(0);
  });

  it("creates a live session when the conversation only has stopped sessions", async () => {
    const db = new MockLiveSessionDb([
      {
        id: "live_stopped",
        conversation_id: "dm_restart",
        status: "stopped",
        topic: "Previous operator request.",
        stop_command: "stop conversation",
        created_by_human_id: "human_operator",
        created_at: "2026-05-31T08:00:00.000Z",
      },
    ]);
    const request = new Request("https://example.test/api/operator/live-conversations", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversationId: "dm_restart",
        topic: "Fresh operator request.",
      }),
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token", DB: db } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as {
      existing?: boolean;
      session?: { conversationId?: string; status?: string; topic?: string };
    };

    expect(response.status).toBe(201);
    expect(payload.existing).toBe(false);
    expect(payload.session).toMatchObject({
      conversationId: "dm_restart",
      status: "active",
      topic: "Fresh operator request.",
    });
    expect(db.insertCount).toBe(1);
  });

  it("returns the raced live session when a concurrent create wins the insert", async () => {
    const db = new MockLiveSessionDb();
    db.insertConflictSession = {
      id: "live_raced",
      conversation_id: "dm_raced",
      status: "active",
      topic: "Concurrent operator request.",
      stop_command: "stop conversation",
      created_by_human_id: "human_operator",
      created_at: "2026-05-31T08:01:00.000Z",
    };
    const request = new Request("https://example.test/api/operator/live-conversations", {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversationId: "dm_raced",
        topic: "Losing operator request.",
      }),
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token", DB: db } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as {
      existing?: boolean;
      session?: { id?: string; conversationId?: string; topic?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.existing).toBe(true);
    expect(payload.session).toMatchObject({
      id: "live_raced",
      conversationId: "dm_raced",
      topic: "Concurrent operator request.",
    });
    expect(db.insertCount).toBe(1);
  });

  it("enforces an optional deployment-configured signup-handle pattern", async () => {
    const response = await onRequest({
      request: new Request("https://example.test/api/agent/signup-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle: "dev@phonebook",
          displayName: "Phonebook agent",
          machineScope: "machine:test",
        }),
      }),
      env: { SIGNUP_HANDLE_PATTERN: "^[a-z]+\\[[a-z]+\\]@[a-z]+$" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "signup_handle_not_allowed" });
  });

  it("persists named Go and Stop control events exactly once across repeated operator posts", async () => {
    const db = new MockForumConferenceDb();
    const env = {
      DB: db,
      OPERATOR_API_TOKEN: "operator-token",
      OPERATOR_ID: "operator_ada",
      OPERATOR_DISPLAY_NAME: "Ada Example",
    } as never;
    const request = (path: string, body: Record<string, unknown>) => onRequest({
      request: new Request(`https://example.test/api/operator/${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer operator-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
    });

    const created = await request("forum-conferences", { threadId: "thread_design" });
    expect(created?.status).toBe(201);
    const createdPayload = await created?.json() as { session?: { id?: string; createdByDisplayName?: string } };
    const sessionId = createdPayload.session?.id;
    expect(sessionId).toBeTruthy();
    expect(createdPayload.session?.createdByDisplayName).toBe("Ada Example");

    expect((await request(`forum-conferences/${sessionId}/participants`, { agentId: "agent_a" }))?.status).toBe(200);
    expect((await request(`forum-conferences/${sessionId}/go`, {}))?.status).toBe(200);
    expect((await request(`forum-conferences/${sessionId}/go`, {}))?.status).toBe(200);
    expect((await request(`forum-conferences/${sessionId}/stop`, {
      decision: "Adopt the recorded approach.",
      followUp: "Agent A implements the agreed change.",
    }))?.status).toBe(200);
    const replayedStop = await request(`forum-conferences/${sessionId}/stop`, {
      decision: "Ignored replay value.",
      followUp: "Ignored replay follow-up.",
    });
    expect(replayedStop?.status).toBe(200);
    const replayedPayload = await replayedStop?.json() as {
      session?: { status?: string; decision?: string; nextAction?: string; followUp?: string; controlEvents?: Array<{ status?: string }> };
    };

    expect(db.events).toHaveLength(2);
    expect(db.events.every((event) => event.status === "completed")).toBe(true);
    expect(db.replies.map((reply) => reply.body)).toEqual([
      "CONFERENCE GO",
      "CONFERENCE STOP — decision: Adopt the recorded approach. — follow-up: Agent A implements the agreed change.",
    ]);
    expect(replayedPayload.session).toMatchObject({
      status: "stopped",
      decision: "Adopt the recorded approach.",
      nextAction: "follow_up",
      followUp: "Agent A implements the agreed change.",
    });
    expect(replayedPayload.session?.controlEvents).toHaveLength(2);
  });

  it("blocks a waiting conference participant from posting before the human Go signal", async () => {
    const db = new MockForumConferenceDb();
    db.sessions.push({
      id: "conference_waiting",
      thread_id: "thread_design",
      status: "waiting",
      created_by_human_id: "operator_ada",
      created_by_display_name: "Ada Example",
      created_at: "2026-08-03T10:00:00.000Z",
    });
    db.participants.push({
      session_id: "conference_waiting",
      agent_id: "agent_a",
      joined_at: "2026-08-03T10:01:00.000Z",
    });
    const response = await onRequest({
      request: new Request("https://example.test/api/agent/thread-replies", {
        method: "POST",
        headers: {
          authorization: "Bearer minted-agent-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId: "thread_design", authorId: "agent_a", body: "Starting too soon." }),
      }),
      env: {
        DB: db,
        DOMAIN_WORKSPACE_CONFIG: JSON.stringify({
          domains: [{ id: "general", name: "General" }],
          defaultDomainId: "general",
          writePolicy: "home_and_default",
        }),
      } as never,
    });
    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({
      code: "conference_waiting",
      conferenceId: "conference_waiting",
    });
  });

  it("accepts relay delivery credentials only from the dedicated hashed relay configuration", async () => {
    const relayToken = "relay-only-test-token";
    const relayHash = createHash("sha256").update(relayToken).digest("hex");
    const request = (token: string, hashes?: string) => onRequest({
      request: new Request("https://example.test/api/relay/delivery-jobs/claim", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ leaseOwner: "test-relay" }),
      }),
      env: {
        OPERATOR_API_TOKEN: relayToken,
        ...(hashes ? { DELIVERY_RELAY_AUTH_HASHES: hashes } : {}),
      } as never,
    });

    expect((await request(relayToken))?.status).toBe(503);
    expect((await request("wrong-token", relayHash))?.status).toBe(401);
    // Valid relay auth reaches the durable-storage boundary instead of gaining
    // any ordinary agent/operator authority.
    expect((await request(relayToken, relayHash))?.status).toBe(503);
  });
});
