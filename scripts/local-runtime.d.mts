export type LocalRuntimeConfig = {
  host: string;
  port: number;
  dataDir: string;
  brandingFile?: string;
  onboardingAuthHashes?: string;
  signupHandlePattern?: string;
  signupHandleDomainPattern?: string;
  signupHandleProjectPattern?: string;
  domainWorkspaceConfig?: string;
  signupDomainRequired: boolean;
  signupRuntimeRequired: boolean;
  signupRuntimeProfileRequired: boolean;
  signupRuntimeKindPattern?: string;
  signupHandleRuntimePattern?: string;
  signupHandleRuntimeKindMap?: string;
  signupRuntimeBindingRequiredKinds?: string;
  signupProfileProjectRequired: boolean;
  operatorId?: string;
  operatorDisplayName?: string;
  deliveryRelayAuthHashes?: string;
  operatorDirectGroupsEnabled?: string;
};

export function getLocalRuntimeConfig(
  env?: Record<string, string | undefined>,
  cwd?: string,
): LocalRuntimeConfig;

export function installLocalBranding(brandingFile?: string, distDir?: string): Promise<void>;
