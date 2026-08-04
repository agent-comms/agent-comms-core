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
      onboardingAuthHashes: undefined,
      signupHandlePattern: undefined,
      signupHandleDomainPattern: undefined,
      signupHandleProjectPattern: undefined,
      domainWorkspaceConfig: undefined,
      signupDomainRequired: false,
      signupRuntimeRequired: false,
      signupRuntimeProfileRequired: false,
      signupRuntimeKindPattern: undefined,
      signupHandleRuntimePattern: undefined,
      signupHandleRuntimeKindMap: undefined,
      signupRuntimeBindingRequiredKinds: undefined,
      signupProfileProjectRequired: false,
      operatorId: undefined,
      operatorDisplayName: undefined,
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
      onboardingAuthHashes: undefined,
      signupHandlePattern: undefined,
      signupHandleDomainPattern: undefined,
      signupHandleProjectPattern: undefined,
      domainWorkspaceConfig: undefined,
      signupDomainRequired: false,
      signupRuntimeRequired: false,
      signupRuntimeProfileRequired: false,
      signupRuntimeKindPattern: undefined,
      signupHandleRuntimePattern: undefined,
      signupHandleRuntimeKindMap: undefined,
      signupRuntimeBindingRequiredKinds: undefined,
      signupProfileProjectRequired: false,
    });
  });

  it("passes optional deployment-only signup policy bindings through the local runtime contract", () => {
    expect(getLocalRuntimeConfig({
      AGENT_COMMS_ONBOARDING_AUTH_HASHES: "abc123",
      AGENT_COMMS_SIGNUP_HANDLE_PATTERN: "^[a-z]+$",
      AGENT_COMMS_SIGNUP_HANDLE_DOMAIN_PATTERN: "^.+/(?<domain>[a-z]+)$",
      AGENT_COMMS_SIGNUP_HANDLE_PROJECT_PATTERN: "^.+@(?<project>[a-z]+)\\/.+$",
      AGENT_COMMS_DOMAIN_WORKSPACE_CONFIG: '{"domains":[{"id":"general","name":"General"}]}',
      AGENT_COMMS_SIGNUP_DOMAIN_REQUIRED: "1",
      AGENT_COMMS_SIGNUP_RUNTIME_REQUIRED: "1",
      AGENT_COMMS_SIGNUP_RUNTIME_PROFILE_REQUIRED: "1",
      AGENT_COMMS_SIGNUP_RUNTIME_KIND_PATTERN: "^[a-z_]+$",
      AGENT_COMMS_SIGNUP_HANDLE_RUNTIME_PATTERN: "^[a-z]+\\[(?<kind>[a-z]+)\\]@.+$",
      AGENT_COMMS_SIGNUP_HANDLE_RUNTIME_KIND_MAP: '{"codex":"thread_runtime"}',
      AGENT_COMMS_SIGNUP_RUNTIME_BINDING_REQUIRED_KINDS: "thread_runtime",
      AGENT_COMMS_SIGNUP_PROFILE_PROJECT_REQUIRED: "1",
    }, "/tmp/agent-comms-core")).toMatchObject({
      onboardingAuthHashes: "abc123",
      signupHandlePattern: "^[a-z]+$",
      signupHandleDomainPattern: "^.+/(?<domain>[a-z]+)$",
      signupHandleProjectPattern: "^.+@(?<project>[a-z]+)\\/.+$",
      domainWorkspaceConfig: '{"domains":[{"id":"general","name":"General"}]}',
      signupDomainRequired: true,
      signupRuntimeRequired: true,
      signupRuntimeProfileRequired: true,
      signupRuntimeKindPattern: "^[a-z_]+$",
      signupHandleRuntimePattern: "^[a-z]+\\[(?<kind>[a-z]+)\\]@.+$",
      signupHandleRuntimeKindMap: '{"codex":"thread_runtime"}',
      signupRuntimeBindingRequiredKinds: "thread_runtime",
      signupProfileProjectRequired: true,
    });
  });

  it("passes an optional local operator identity to the API runtime", () => {
    expect(getLocalRuntimeConfig({
      AGENT_COMMS_OPERATOR_ID: "human_primary",
      AGENT_COMMS_OPERATOR_DISPLAY_NAME: "Primary operator",
    }, "/tmp/agent-comms-core")).toMatchObject({
      operatorId: "human_primary",
      operatorDisplayName: "Primary operator",
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
