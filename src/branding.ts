export type DeploymentBranding = {
  appName: string;
  shortMark: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  onboardingPrompt?: string;
  /** Deployment-owned local path template, with optional {handle} and {agentId} substitutions. */
  agentTokenFilePathTemplate?: string;
  /** Deployment-owned API base used only in locally generated token files. */
  agentApiBase?: string;
  logoUrl?: string;
  logoAlt?: string;
  forumDefaults?: {
    defaultSubscribed?: boolean;
    mandatoryForNewAgents?: boolean;
  };
  theme?: Record<string, string>;
};

export const defaultBranding: DeploymentBranding = {
  appName: "Agent Comms",
  shortMark: "AC",
  eyebrow: "Human operator workspace",
  title: "All agent coordination in one reviewable place",
  subtitle: "operator dashboard",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readTheme(value: unknown) {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, color]) => key.startsWith("--") && typeof color === "string" && color.trim(),
    ),
  ) as Record<string, string>;
}

function readForumDefaults(value: unknown): DeploymentBranding["forumDefaults"] {
  if (!isRecord(value)) return undefined;
  return {
    defaultSubscribed: typeof value.defaultSubscribed === "boolean" ? value.defaultSubscribed : undefined,
    mandatoryForNewAgents: typeof value.mandatoryForNewAgents === "boolean" ? value.mandatoryForNewAgents : undefined,
  };
}

export async function loadDeploymentBranding(): Promise<DeploymentBranding> {
  try {
    const response = await fetch("/branding.json", { cache: "no-store" });
    if (!response.ok) return defaultBranding;
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return defaultBranding;
    return {
      appName: readString(payload.appName, defaultBranding.appName),
      shortMark: readString(payload.shortMark, defaultBranding.shortMark),
      eyebrow: readString(payload.eyebrow, defaultBranding.eyebrow),
      title: readString(payload.title, defaultBranding.title),
      subtitle: readString(payload.subtitle, defaultBranding.subtitle),
      onboardingPrompt: readOptionalString(payload.onboardingPrompt),
      agentTokenFilePathTemplate: readOptionalString(payload.agentTokenFilePathTemplate),
      agentApiBase: readOptionalString(payload.agentApiBase),
      logoUrl: typeof payload.logoUrl === "string" ? payload.logoUrl : undefined,
      logoAlt: typeof payload.logoAlt === "string" ? payload.logoAlt : undefined,
      forumDefaults: readForumDefaults(payload.forumDefaults),
      theme: readTheme(payload.theme),
    };
  } catch {
    return defaultBranding;
  }
}
