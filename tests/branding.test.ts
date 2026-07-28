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
    })));

    await expect(loadDeploymentBranding()).resolves.toMatchObject({
      appName: "Private deployment",
      onboardingPrompt: "Use this deployment only from the assigned machine.",
    });
  });

  it("ignores an empty onboarding prompt", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ onboardingPrompt: "   " })));

    await expect(loadDeploymentBranding()).resolves.toEqual({
      ...defaultBranding,
      forumDefaults: undefined,
      theme: undefined,
    });
  });
});
