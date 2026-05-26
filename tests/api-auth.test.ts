import { describe, expect, it } from "vitest";
import { onRequest } from "../functions/api/[[path]]";

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
});
