export type LocalRuntimeConfig = {
  host: string;
  port: number;
  dataDir: string;
};

export function getLocalRuntimeConfig(
  env?: Record<string, string | undefined>,
  cwd?: string,
): LocalRuntimeConfig;
