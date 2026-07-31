import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultBranding, loadDeploymentBranding } from "../src/branding";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("deployment branding", () => {
  it("loads an optional deployment-owned onboarding prompt", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      appName: "Private deployment",
      onboardingPrompt: "Use this deployment only from the assigned machine.",
      agentTokenFilePathTemplate: "/private/agents/{handle}/agent-comms-token.env",
      agentApiBase: "http://127.0.0.1:8787",
      dayTheme: { "--color-bg": "#f6f4ef" },
      nightTheme: { "--color-bg": "#101714" },
    })));

    await expect(loadDeploymentBranding()).resolves.toMatchObject({
      appName: "Private deployment",
      onboardingPrompt: "Use this deployment only from the assigned machine.",
      agentTokenFilePathTemplate: "/private/agents/{handle}/agent-comms-token.env",
      agentApiBase: "http://127.0.0.1:8787",
      dayTheme: { "--color-bg": "#f6f4ef" },
      nightTheme: { "--color-bg": "#101714" },
    });
  });

  it("ignores an empty onboarding prompt", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ onboardingPrompt: "   " })));

    await expect(loadDeploymentBranding()).resolves.toEqual({
      ...defaultBranding,
      forumDefaults: undefined,
      theme: undefined,
      dayTheme: undefined,
      nightTheme: undefined,
    });
  });
});
