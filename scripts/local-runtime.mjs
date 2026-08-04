import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const wranglerPackage = "wrangler@4.114.0";

export function getLocalRuntimeConfig(env = process.env, cwd = process.cwd()) {
  const host = env.AGENT_COMMS_HOST || "127.0.0.1";
  if (!loopbackHosts.has(host)) {
    throw new Error("AGENT_COMMS_HOST must be a loopback host: 127.0.0.1, ::1, or localhost.");
  }

  const portText = env.AGENT_COMMS_PORT || "8787";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AGENT_COMMS_PORT must be an integer from 1 to 65535.");
  }

  const dataDir = resolve(cwd, env.AGENT_COMMS_DATA_DIR || ".wrangler/state/agent-comms-core-local");
  const brandingFile = env.AGENT_COMMS_BRANDING_FILE?.trim()
    ? resolve(cwd, env.AGENT_COMMS_BRANDING_FILE)
    : undefined;
  const onboardingAuthHashes = env.AGENT_COMMS_ONBOARDING_AUTH_HASHES?.trim() || undefined;
  const signupHandlePattern = env.AGENT_COMMS_SIGNUP_HANDLE_PATTERN?.trim() || undefined;
  const signupHandleDomainPattern = env.AGENT_COMMS_SIGNUP_HANDLE_DOMAIN_PATTERN?.trim() || undefined;
  const signupHandleProjectPattern = env.AGENT_COMMS_SIGNUP_HANDLE_PROJECT_PATTERN?.trim() || undefined;
  const domainWorkspaceConfig = env.AGENT_COMMS_DOMAIN_WORKSPACE_CONFIG?.trim() || undefined;
  const signupDomainRequired = env.AGENT_COMMS_SIGNUP_DOMAIN_REQUIRED === "1" || env.AGENT_COMMS_SIGNUP_DOMAIN_REQUIRED === "true";
  const signupRuntimeRequired = env.AGENT_COMMS_SIGNUP_RUNTIME_REQUIRED === "1" || env.AGENT_COMMS_SIGNUP_RUNTIME_REQUIRED === "true";
  const signupRuntimeProfileRequired = env.AGENT_COMMS_SIGNUP_RUNTIME_PROFILE_REQUIRED === "1" || env.AGENT_COMMS_SIGNUP_RUNTIME_PROFILE_REQUIRED === "true";
  const signupRuntimeKindPattern = env.AGENT_COMMS_SIGNUP_RUNTIME_KIND_PATTERN?.trim() || undefined;
  const signupHandleRuntimePattern = env.AGENT_COMMS_SIGNUP_HANDLE_RUNTIME_PATTERN?.trim() || undefined;
  const signupHandleRuntimeKindMap = env.AGENT_COMMS_SIGNUP_HANDLE_RUNTIME_KIND_MAP?.trim() || undefined;
  const signupRuntimeBindingRequiredKinds = env.AGENT_COMMS_SIGNUP_RUNTIME_BINDING_REQUIRED_KINDS?.trim() || undefined;
  const signupProfileProjectRequired = env.AGENT_COMMS_SIGNUP_PROFILE_PROJECT_REQUIRED === "1" || env.AGENT_COMMS_SIGNUP_PROFILE_PROJECT_REQUIRED === "true";
  const operatorId = env.AGENT_COMMS_OPERATOR_ID?.trim() || undefined;
  const operatorDisplayName = env.AGENT_COMMS_OPERATOR_DISPLAY_NAME?.trim() || undefined;
  const deliveryRelayAuthHashes = env.AGENT_COMMS_DELIVERY_RELAY_AUTH_HASHES?.trim() || undefined;
  const operatorDirectGroupsEnabled = env.AGENT_COMMS_OPERATOR_DIRECT_GROUPS_ENABLED?.trim() || undefined;
  if (domainWorkspaceConfig) {
    try {
      JSON.parse(domainWorkspaceConfig);
    } catch {
      throw new Error("AGENT_COMMS_DOMAIN_WORKSPACE_CONFIG must be valid JSON.");
    }
  }
  return {
    host,
    port,
    dataDir,
    brandingFile,
    onboardingAuthHashes,
    signupHandlePattern,
    signupHandleDomainPattern,
    signupHandleProjectPattern,
    domainWorkspaceConfig,
    signupDomainRequired,
    signupRuntimeRequired,
    signupRuntimeProfileRequired,
    signupRuntimeKindPattern,
    signupHandleRuntimePattern,
    signupHandleRuntimeKindMap,
    signupRuntimeBindingRequiredKinds,
    signupProfileProjectRequired,
    operatorId,
    operatorDisplayName,
    deliveryRelayAuthHashes,
    operatorDirectGroupsEnabled,
  };
}

export async function installLocalBranding(brandingFile, distDir = resolve(process.cwd(), "dist")) {
  if (!brandingFile) return;
  let source;
  try {
    source = await readFile(brandingFile, "utf8");
    JSON.parse(source);
  } catch (error) {
    throw new Error(`AGENT_COMMS_BRANDING_FILE must be readable JSON: ${brandingFile} (${error instanceof Error ? error.message : String(error)})`);
  }
  const destination = resolve(distDir, "branding.json");
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(brandingFile, destination);
}

function run(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`${command} ${args[0] ?? ""} exited with ${signal ?? code ?? "an unknown status"}.`));
    });
  });
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

async function migrate(config) {
  await run(
    npxCommand(),
    ["--yes", wranglerPackage, "d1", "migrations", "apply", "DB", "--local", "--persist-to", config.dataDir],
    { ...process.env, CI: process.env.CI || "1" },
  );
}

async function bootstrap(config) {
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
  await installLocalBranding(config.brandingFile);
  await migrate(config);
}

async function host(config) {
  await bootstrap(config);
  const args = [
    "--yes",
    wranglerPackage,
    "pages",
    "dev",
    "dist",
    "--ip",
    config.host,
    "--port",
    String(config.port),
    "--persist-to",
    config.dataDir,
    "--binding",
    "LOCAL_OPERATOR_AUTH_BYPASS=1",
  ];
  if (config.onboardingAuthHashes) args.push("--binding", `ONBOARDING_AUTH_HASHES=${config.onboardingAuthHashes}`);
  if (config.signupHandlePattern) args.push("--binding", `SIGNUP_HANDLE_PATTERN=${config.signupHandlePattern}`);
  if (config.signupHandleDomainPattern) args.push("--binding", `SIGNUP_HANDLE_DOMAIN_PATTERN=${config.signupHandleDomainPattern}`);
  if (config.signupHandleProjectPattern) args.push("--binding", `SIGNUP_HANDLE_PROJECT_PATTERN=${config.signupHandleProjectPattern}`);
  if (config.domainWorkspaceConfig) args.push("--binding", `DOMAIN_WORKSPACE_CONFIG=${config.domainWorkspaceConfig}`);
  if (config.signupDomainRequired) args.push("--binding", "SIGNUP_DOMAIN_REQUIRED=1");
  if (config.signupRuntimeRequired) args.push("--binding", "SIGNUP_RUNTIME_REQUIRED=1");
  if (config.signupRuntimeProfileRequired) args.push("--binding", "SIGNUP_RUNTIME_PROFILE_REQUIRED=1");
  if (config.signupRuntimeKindPattern) args.push("--binding", `SIGNUP_RUNTIME_KIND_PATTERN=${config.signupRuntimeKindPattern}`);
  if (config.signupHandleRuntimePattern) args.push("--binding", `SIGNUP_HANDLE_RUNTIME_PATTERN=${config.signupHandleRuntimePattern}`);
  if (config.signupHandleRuntimeKindMap) args.push("--binding", `SIGNUP_HANDLE_RUNTIME_KIND_MAP=${config.signupHandleRuntimeKindMap}`);
  if (config.signupRuntimeBindingRequiredKinds) args.push("--binding", `SIGNUP_RUNTIME_BINDING_REQUIRED_KINDS=${config.signupRuntimeBindingRequiredKinds}`);
  if (config.signupProfileProjectRequired) args.push("--binding", "SIGNUP_PROFILE_PROJECT_REQUIRED=1");
  if (config.operatorId) args.push("--binding", `OPERATOR_ID=${config.operatorId}`);
  if (config.operatorDisplayName) args.push("--binding", `OPERATOR_DISPLAY_NAME=${config.operatorDisplayName}`);
  if (config.deliveryRelayAuthHashes) args.push("--binding", `DELIVERY_RELAY_AUTH_HASHES=${config.deliveryRelayAuthHashes}`);
  if (config.operatorDirectGroupsEnabled) args.push("--binding", `OPERATOR_DIRECT_GROUPS_ENABLED=${config.operatorDirectGroupsEnabled}`);
  await run(npxCommand(), args);
}

async function main() {
  const action = process.argv[2] || "host";
  const config = getLocalRuntimeConfig();
  if (action === "migrate") return migrate(config);
  if (action === "bootstrap") return bootstrap(config);
  if (action === "host") return host(config);
  if (action === "reset-help") {
    console.log(`To reset only this local runtime, stop it and remove:\n${config.dataDir}`);
    return;
  }
  throw new Error(`Unknown local runtime action: ${action}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
