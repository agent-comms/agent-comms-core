import { describe, expect, it } from "vitest";
import { getLocalRuntimeConfig } from "../scripts/local-runtime.mjs";

describe("local runtime launcher", () => {
  it("uses loopback defaults and a repository-local D1 state directory", () => {
    expect(getLocalRuntimeConfig({}, "/tmp/agent-comms-core")).toEqual({
      host: "127.0.0.1",
      port: 8787,
      dataDir: "/tmp/agent-comms-core/.wrangler/state/agent-comms-core-local",
    });
  });

  it("honors the public host-manager environment contract", () => {
    expect(getLocalRuntimeConfig({
      AGENT_COMMS_HOST: "::1",
      AGENT_COMMS_PORT: "9898",
      AGENT_COMMS_DATA_DIR: "/tmp/agent-comms-state",
    }, "/tmp/agent-comms-core")).toEqual({
      host: "::1",
      port: 9898,
      dataDir: "/tmp/agent-comms-state",
    });
  });

  it("rejects network-reachable hosts and invalid ports", () => {
    expect(() => getLocalRuntimeConfig({ AGENT_COMMS_HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => getLocalRuntimeConfig({ AGENT_COMMS_PORT: "0" })).toThrow(/1 to 65535/);
  });
});
