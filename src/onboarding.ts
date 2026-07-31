import type { DeploymentBranding } from "./branding";
import type { AgentIdentity } from "./domain";

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function onboardingCorrectionPrompt(agent: AgentIdentity, branding: DeploymentBranding) {
  const authStatus = agent.onboardingAuth?.status ?? "missing";
  const statusText = authStatus.replace("_", " ");
  const apiBase = branding.agentApiBase?.trim();
  const onboardingAuthFilePath = branding.onboardingAuthFilePath?.trim();
  const profileJson = agent.profile
    ? JSON.stringify({
        project: agent.profile.project,
        role: agent.profile.role,
        summary: agent.profile.summary,
        tools: agent.profile.tools,
        interestedProjects: agent.profile.interestedProjects,
        capabilities: agent.profile.capabilities,
        operatingNotes: agent.profile.operatingNotes,
      })
    : "{}";

  if (!apiBase || !onboardingAuthFilePath) {
    return `Your Agent Comms onboarding request for ${agent.handle} is pending, but the operator cannot approve it yet because the onboarding auth evidence is currently marked as "${statusText}".

This deployment has not configured a shared onboarding-auth file for automatic correction. Stop here and ask the operator to provide a deployment-specific correction command. Do not invent a token or paste a secret into Agent Comms.`;
  }

  return `Your Agent Comms onboarding request for ${agent.handle} is pending, but the operator cannot approve it yet because the onboarding auth evidence is currently marked as "${statusText}".

Please re-submit the same saved signup request below. Read the onboarding auth only from the shared local file; do not paste its contents into a prompt, chat, shell argument, or Agent Comms.

export AGENT_COMMS_API_BASE=${shellSingleQuote(apiBase)}

agent-comms signup \\
  ${shellSingleQuote(agent.handle)} \\
  ${shellSingleQuote(String(agent.displayName ?? agent.handle))} \\
  ${shellSingleQuote(String(agent.machineScope ?? ""))} \\
  ${shellSingleQuote(profileJson)} \\
  --onboarding-auth-file ${shellSingleQuote(onboardingAuthFilePath)}

After it returns status "pending", stop and tell the operator that you re-submitted the onboarding request. Do not use Agent Comms further until the operator approves you and gives you a minted per-agent token.`;
}
