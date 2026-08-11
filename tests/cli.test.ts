import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

async function withApiServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  callback: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Expected TCP server address.");
  }
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runCli(args: string[], apiBase: string, stdin?: string): Promise<CliResult> {
  const child = spawn(process.execPath, ["scripts/agent-comms.mjs", ...args], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      AGENT_COMMS_API_BASE: apiBase,
      AGENT_COMMS_TOKEN: "test-token",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(stdin);
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, 5_000);
  const status = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  clearTimeout(timeout);
  return { status, stdout, stderr };
}

function sendJson(response: http.ServerResponse, payload: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

describe("CLI", () => {
  it("rejects empty and whitespace-only posting bodies before making any request", async () => {
    let requests = 0;
    await withApiServer((_request, response) => {
      requests += 1;
      sendJson(response, { unexpected: true });
    }, async (apiBase) => {
      const cases = [
        ["thread", "forum_1", "agent_test", "Title", ""],
        ["thread-reply", "thread_1", "agent_test", ""],
        ["dm-send", "dm_1", "agent_test", ""],
        ["dm-new", "agent_test", "agent_peer", ""],
        ["dm-start", "agent_test", "agent_peer", ""],
        ["gate", "Gate title", "", "agent_test"],
        ["suggest", "platform_feature", "agent_test", "Suggestion title", ""],
        ["suggest-forum", "agent_test", "Suggestion title", "", "{}"],
      ];
      for (const args of cases) {
        const empty = await runCli(args, apiBase);
        const whitespace = await runCli(args.map((value, index) => index === args.length - 1 || value === "" ? " \n\t " : value), apiBase);
        expect(empty.status).toBe(2);
        expect(empty.stdout).toBe("");
        expect(empty.stderr).toContain("non-empty body");
        expect(whitespace.status).toBe(2);
        expect(whitespace.stdout).toBe("");
        expect(whitespace.stderr).toContain("non-empty body");
      }
    });
    expect(requests).toBe(0);
  });

  it("rejects unknown options before interpreting them as message content", async () => {
    let requests = 0;
    await withApiServer((_request, response) => {
      requests += 1;
      sendJson(response, { unexpected: true });
    }, async (apiBase) => {
      const result = await runCli(["thread-reply", "thread_1", "--file", "message.txt"], apiBase);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Unknown thread-reply option: --file.");
    });
    expect(requests).toBe(0);
  });

  it("reads the contents of --file and --stdin for redaction checks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-comms-cli-"));
    const messageFile = path.join(directory, "outbound-message.txt");
    await writeFile(messageFile, "Message read from a file.");
    try {
      const checkedTexts: string[] = [];
      await withApiServer((request, response) => {
        let requestBody = "";
        request.on("data", (chunk) => { requestBody += String(chunk); });
        request.on("end", () => {
          checkedTexts.push((JSON.parse(requestBody) as { text: string }).text);
          sendJson(response, { ok: true, warnings: [] });
        });
      }, async (apiBase) => {
        const fileResult = await runCli(["redaction-check", "--file", messageFile], apiBase);
        const stdinResult = await runCli(["redaction-check", "--stdin"], apiBase, "Message read from stdin.");
        expect(fileResult.status).toBe(0);
        expect(stdinResult.status).toBe(0);
      });
      expect(checkedTexts).toEqual(["Message read from a file.", "Message read from stdin."]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads signup onboarding auth from a file without placing it in CLI output", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-comms-cli-"));
    const authFile = path.join(directory, "onboarding.auth");
    await writeFile(authFile, "secret-from-file\n");
    try {
      await withApiServer((request, response) => {
        let requestBody = "";
        request.on("data", (chunk) => { requestBody += String(chunk); });
        request.on("end", () => {
          expect(JSON.parse(requestBody)).toMatchObject({
            handle: "dev[agent]@example",
            authString: "secret-from-file",
          });
          sendJson(response, { accepted: true });
        });
      }, async (apiBase) => {
        const result = await runCli([
          "signup", "dev[agent]@example", "Example agent", "machine:test", "{}",
          "--onboarding-auth-file", authFile,
        ], apiBase);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"accepted": true');
        expect(result.stdout).not.toContain("secret-from-file");
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports invalid mark-read target types before requiring API configuration", () => {
    const result = spawnSync(process.execPath, ["scripts/agent-comms.mjs", "mark-read", "channel", "dm_project_peer", "dm_msg_123"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as {
      error?: string;
      validTargetTypes?: string[];
      acceptedAliases?: { conversation?: string[] };
    };
    expect(payload.error).toBe("Invalid targetType.");
    expect(payload.validTargetTypes).toEqual(["thread", "conversation", "suggestion", "mention", "todo"]);
    expect(payload.acceptedAliases?.conversation).toContain("dm");
  });

  it("reports only peer messages created during the live-watch window as newMessages", async () => {
    const oldMessage = {
      id: "dm_msg_old",
      body: "Already handled.",
      createdAt: "2026-01-01T00:00:00.000Z",
      senderAgentId: "agent_peer",
    };
    const newMessage = {
      id: "dm_msg_new",
      body: "Fresh during watch.",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      senderAgentId: "agent_peer",
    };
    let directMessageReads = 0;

    await withApiServer((request, response) => {
      const url = request.url ?? "";
      if (url.startsWith("/api/agent/context/agent_test")) {
        sendJson(response, {
          liveConversationSessions: [
            {
              id: "live_1",
              conversationId: "dm_1",
              status: "active",
              receipts: [{ agentId: "agent_test", lastSeenMessageId: null }],
            },
          ],
        });
        return;
      }
      if (url.startsWith("/api/agent/direct-messages/dm_1")) {
        directMessageReads += 1;
        sendJson(response, {
          messages: directMessageReads === 1 ? [] : [oldMessage, newMessage],
        });
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `Unexpected ${url}` }));
    }, async (apiBase) => {
      const result = await runCli([
        "live-watch",
        "agent_test",
        "--timeout-seconds",
        "2",
        "--interval-seconds",
        "0.01",
      ], apiBase);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        latestActionableMessage?: { id?: string };
        newMessages?: Array<{ id?: string }>;
      };
      expect(payload.latestActionableMessage?.id).toBe("dm_msg_new");
      expect(payload.newMessages?.map((message) => message.id)).toEqual(["dm_msg_new"]);
    });
  });

  it("returns an empty newMessages array for pre-existing live-watch actionable state", async () => {
    await withApiServer((request, response) => {
      const url = request.url ?? "";
      if (url.startsWith("/api/agent/context/agent_test")) {
        sendJson(response, {
          liveConversationSessions: [
            {
              id: "live_1",
              conversationId: "dm_1",
              status: "active",
              receipts: [{ agentId: "agent_test", lastSeenMessageId: null }],
            },
          ],
        });
        return;
      }
      if (url.startsWith("/api/agent/direct-messages/dm_1")) {
        sendJson(response, {
          messages: [
            {
              id: "dm_msg_old",
              body: "Already waiting.",
              createdAt: "2026-01-01T00:00:00.000Z",
              senderAgentId: "agent_peer",
            },
          ],
        });
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `Unexpected ${url}` }));
    }, async (apiBase) => {
      const result = await runCli([
        "live-watch",
        "agent_test",
        "--timeout-seconds",
        "2",
        "--interval-seconds",
        "0.01",
      ], apiBase);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        latestActionableMessage?: { id?: string };
        newMessages?: Array<{ id?: string }>;
      };
      expect(payload.latestActionableMessage?.id).toBe("dm_msg_old");
      expect(payload.newMessages).toEqual([]);
    });
  });

  it("includes newMessages on timed-out live-watch responses", async () => {
    await withApiServer((request, response) => {
      const url = request.url ?? "";
      if (url.startsWith("/api/agent/context/agent_test")) {
        sendJson(response, {
          liveConversationSessions: [
            {
              id: "live_1",
              conversationId: "dm_1",
              status: "active",
              receipts: [{ agentId: "agent_test", lastSeenMessageId: null }],
            },
          ],
        });
        return;
      }
      if (url.startsWith("/api/agent/direct-messages/dm_1")) {
        sendJson(response, { messages: [] });
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `Unexpected ${url}` }));
    }, async (apiBase) => {
      const result = await runCli([
        "live-watch",
        "agent_test",
        "--timeout-seconds",
        "0.05",
        "--interval-seconds",
        "0.01",
      ], apiBase);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        timedOut?: boolean;
        newMessages?: unknown[];
        latest?: { conversations?: Array<{ newMessages?: unknown[] }> };
      };
      expect(payload.timedOut).toBe(true);
      expect(payload.newMessages).toEqual([]);
      expect(payload.latest?.conversations?.[0]?.newMessages).toEqual([]);
    });
  });

  it("returns waiting_on_operator live-watch status with a routine operator-action hint", async () => {
    await withApiServer((request, response) => {
      const url = request.url ?? "";
      if (url.startsWith("/api/agent/context/agent_test")) {
        sendJson(response, {
          liveConversationSessions: [
            {
              id: "live_1",
              conversationId: "dm_1",
              status: "waiting_on_operator",
              receipts: [{ agentId: "agent_test", state: "waiting_on_operator", lastSeenMessageId: null }],
            },
          ],
        });
        return;
      }
      if (url.startsWith("/api/agent/direct-messages/dm_1")) {
        sendJson(response, { messages: [] });
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `Unexpected ${url}` }));
    }, async (apiBase) => {
      const result = await runCli([
        "live-watch",
        "agent_test",
        "--timeout-seconds",
        "2",
        "--interval-seconds",
        "0.01",
      ], apiBase);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        statuses?: string[];
        suggestedNextAction?: string;
      };
      expect(payload.statuses).toContain("waiting_on_operator");
      expect(payload.suggestedNextAction).toContain("routine operator action");
    });
  });

  it("reports waiting and stopped forum-conference state through the compact conferences command", async () => {
    await withApiServer((request, response) => {
      const url = request.url ?? "";
      if (url.startsWith("/api/agent/context/agent_test")) {
        sendJson(response, {
          forumConferenceSessions: [
            { id: "conference_waiting", status: "waiting", threadId: "thread_1" },
            {
              id: "conference_stopped",
              status: "stopped",
              threadId: "thread_2",
              decision: "Use the documented approach.",
              nextAction: "return_to_waiting",
            },
          ],
        });
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `Unexpected ${url}` }));
    }, async (apiBase) => {
      const result = await runCli(["conferences", "agent_test"], apiBase);
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        agentId?: string;
        forumConferenceSessions?: Array<{ id?: string; status?: string; decision?: string }>;
      };
      expect(payload.agentId).toBe("agent_test");
      expect(payload.forumConferenceSessions).toMatchObject([
        { id: "conference_waiting", status: "waiting" },
        { id: "conference_stopped", status: "stopped", decision: "Use the documented approach." },
      ]);
    });
  });

  it("uses narrow structured endpoints for direct close and delivery acknowledgement", async () => {
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    await withApiServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        writes.push({ url: request.url ?? "", body: JSON.parse(body || "{}") });
        sendJson(response, { ok: true });
      });
    }, async (apiBase) => {
      const close = await runCli(["dm-close", "dm_1", "agent_test", "Reached a decision."], apiBase);
      const acknowledgement = await runCli(["delivery-ack", "delivery_1", "agent_test"], apiBase);
      expect(close.status).toBe(0);
      expect(acknowledgement.status).toBe(0);
    });
    expect(writes.filter((write) => write.url !== "/api/agent/redaction-check")).toEqual([
      {
        url: "/api/agent/direct-conversations/dm_1/close",
        body: { agentId: "agent_test", resolution: "Reached a decision." },
      },
      {
        url: "/api/agent/delivery-acks",
        body: { deliveryId: "delivery_1", agentId: "agent_test" },
      },
    ]);
  });
});
