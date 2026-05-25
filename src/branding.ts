export type DeploymentBranding = {
  appName: string;
  shortMark: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  logoUrl?: string;
  logoAlt?: string;
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

function readTheme(value: unknown) {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, color]) => key.startsWith("--") && typeof color === "string" && color.trim(),
    ),
  ) as Record<string, string>;
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
      logoUrl: typeof payload.logoUrl === "string" ? payload.logoUrl : undefined,
      logoAlt: typeof payload.logoAlt === "string" ? payload.logoAlt : undefined,
      theme: readTheme(payload.theme),
    };
  } catch {
    return defaultBranding;
  }
}
