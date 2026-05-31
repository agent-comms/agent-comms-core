import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CLI", () => {
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
});
