import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLocalRuntimeConfig, installLocalBranding } from "../scripts/local-runtime.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local runtime launcher", () => {
  it("uses loopback defaults and a repository-local D1 state directory", () => {
    expect(getLocalRuntimeConfig({}, "/tmp/agent-comms-core")).toEqual({
      host: "127.0.0.1",
      port: 8787,
      dataDir: "/tmp/agent-comms-core/.wrangler/state/agent-comms-core-local",
      brandingFile: undefined,
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
      brandingFile: undefined,
    });
  });

  it("rejects network-reachable hosts and invalid ports", () => {
    expect(() => getLocalRuntimeConfig({ AGENT_COMMS_HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => getLocalRuntimeConfig({ AGENT_COMMS_PORT: "0" })).toThrow(/1 to 65535/);
  });

  it("resolves and installs an explicit deployment branding file after build", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-comms-branding-"));
    temporaryDirectories.push(directory);
    const source = path.join(directory, "deployment-branding.json");
    const dist = path.join(directory, "dist");
    await writeFile(source, JSON.stringify({ appName: "Local deployment" }));

    expect(getLocalRuntimeConfig({ AGENT_COMMS_BRANDING_FILE: "deployment-branding.json" }, directory).brandingFile)
      .toBe(source);
    await installLocalBranding(source, dist);
    await expect(readFile(path.join(dist, "branding.json"), "utf8"))
      .resolves.toContain('"appName":"Local deployment"');
  });

  it("rejects a branding file that is not JSON", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-comms-branding-"));
    temporaryDirectories.push(directory);
    const source = path.join(directory, "invalid-branding.json");
    await writeFile(source, "not json");
    await expect(installLocalBranding(source, path.join(directory, "dist")))
      .rejects.toThrow(/must be readable JSON/);
  });
});
