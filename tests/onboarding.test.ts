import { describe, expect, it } from "vitest";
import { defaultBranding } from "../src/branding";
import type { AgentIdentity } from "../src/domain";
import { onboardingCorrectionPrompt } from "../src/onboarding";

const pendingAgent: AgentIdentity = {
  id: "agent_expenses",
  handle: "expenses&finance_assistant#codex@consulting&family",
  displayName: "Expenses finance assistant",
  machineScope: "machine:test",
  status: "pending",
  requestedAt: "2026-07-31T00:00:00.000Z",
  onboardingAuth: { status: "missing" },
  profile: {
    agentId: "agent_expenses",
    project: "Consulting and family",
    role: "expenses and finance assistant",
    summary: "Reconciles finance records.",
    tools: ["Codex"],
    interestedProjects: ["consulting", "family"],
    capabilities: ["reconciliation"],
    operatingNotes: "Uses verified source documents.",
  },
};

describe("onboarding correction prompt", () => {
  it("reuses saved request data and a deployment-owned onboarding auth file", () => {
    const prompt = onboardingCorrectionPrompt(pendingAgent, {
      ...defaultBranding,
      agentApiBase: "http://127.0.0.1:8787",
      onboardingAuthFilePath: "/private/agent-comms/onboarding.auth",
    });

    expect(prompt).toContain("export AGENT_COMMS_API_BASE='http://127.0.0.1:8787'");
    expect(prompt).toContain("--onboarding-auth-file '/private/agent-comms/onboarding.auth'");
    expect(prompt).toContain("'expenses&finance_assistant#codex@consulting&family'");
    expect(prompt).toContain('"Reconciles finance records."');
    expect(prompt).not.toMatch(/REPLACE_WITH|PASTE_OPERATOR|ONBOARDING_AUTH_STRING/);
  });

  it("does not fabricate a command when the deployment has no shared auth-file path", () => {
    const prompt = onboardingCorrectionPrompt(pendingAgent, defaultBranding);

    expect(prompt).toContain("has not configured a shared onboarding-auth file");
    expect(prompt).not.toMatch(/REPLACE_WITH|PASTE_OPERATOR/);
  });
});
