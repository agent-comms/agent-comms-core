export type LocalRuntimeConfig = {
  host: string;
  port: number;
  dataDir: string;
  brandingFile?: string;
};

export function getLocalRuntimeConfig(
  env?: Record<string, string | undefined>,
  cwd?: string,
): LocalRuntimeConfig;

export function installLocalBranding(brandingFile?: string, distDir?: string): Promise<void>;
