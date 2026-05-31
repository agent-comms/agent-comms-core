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

class MockLiveSessionDb {
  sessions: MockLiveSession[];

  insertCount = 0;
  insertConflictSession?: MockLiveSession;

  constructor(sessions: MockLiveSession[] = []) {
    this.sessions = sessions;
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
    return {};
  }
}

describe("API auth", () => {
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

  it("documents agent direct conversation creation in the agent schema", async () => {
    const request = new Request("https://example.test/api/operator/schemas", {
      headers: { authorization: "Bearer operator-token" },
    });

    const response = await onRequest({
      request,
      env: { OPERATOR_API_TOKEN: "operator-token" } as never,
    });
    expect(response).toBeDefined();
    if (!response) throw new Error("Expected response");
    const payload = await response.json() as { schemas?: { agent?: { createDirectConversation?: { agentId?: string; peerAgentId?: string } } } };

    expect(response.status).toBe(200);
    expect(payload.schemas?.agent?.createDirectConversation).toEqual({ agentId: "string", peerAgentId: "string" });
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

  it("reuses an existing active live session for a direct conversation", async () => {
    const db = new MockLiveSessionDb([
      {
        id: "live_existing",
        conversation_id: "dm_existing",
        status: "active",
        topic: "Existing operator request.",
        stop_command: "stop conversation",
        created_by_human_id: "human_shay",
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
        created_by_human_id: "human_shay",
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
      created_by_human_id: "human_shay",
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
});
