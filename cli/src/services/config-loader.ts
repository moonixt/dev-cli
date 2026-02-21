import fs from "node:fs";
import path from "node:path";
import type {
  LoadedWorkspaceConfig,
  ServiceRuntimeConfig,
  WorkspaceConfigFile,
  WorkspaceServiceConfigFile
} from "../types";

export const workspaceConfigFileName = "dev-cli.config.json";
const serviceIdPattern = /^[a-z0-9][a-z0-9-_]{1,31}$/;
const defaultCategory = "services";
const defaultLogRetentionDays = 7;

type ResolveConfigPathOptions = {
  cwd?: string;
  explicitConfigPath?: string;
};

type LoadWorkspaceConfigOptions = ResolveConfigPathOptions;

export function resolveConfigPath(options?: ResolveConfigPathOptions): string | null {
  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const explicitFromArg = options?.explicitConfigPath?.trim();
  if (explicitFromArg) {
    const resolved = path.resolve(cwd, explicitFromArg);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return resolved;
  }

  const explicitFromEnv = process.env.DEV_CLI_CONFIG?.trim();
  if (explicitFromEnv) {
    const resolved = path.resolve(cwd, explicitFromEnv);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found from DEV_CLI_CONFIG: ${resolved}`);
    }
    return resolved;
  }

  return findConfigUpwards(cwd);
}

export function loadWorkspaceConfig(options?: LoadWorkspaceConfigOptions): LoadedWorkspaceConfig {
  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const configPath = resolveConfigPath(options);
  if (!configPath) {
    const workspaceName = path.basename(cwd);
    return {
      configPath: null,
      workspaceRoot: cwd,
      workspaceName,
      services: {},
      serviceOrder: [],
      groups: { all: [] }
    };
  }

  const workspaceRoot = path.dirname(configPath);
  const raw = readWorkspaceConfigFile(configPath);
  return validateWorkspaceConfig(raw, workspaceRoot, configPath);
}

export function validateWorkspaceConfig(
  rawConfig: WorkspaceConfigFile,
  workspaceRoot: string,
  configPathForErrors = workspaceRoot
): LoadedWorkspaceConfig {
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new Error(`Invalid config in ${configPathForErrors}: expected an object`);
  }

  if (rawConfig.version !== 1) {
    throw new Error(`Invalid config in ${configPathForErrors}: version must be 1`);
  }

  if (!Array.isArray(rawConfig.services)) {
    throw new Error(`Invalid config in ${configPathForErrors}: services must be an array`);
  }

  const services: Record<string, ServiceRuntimeConfig> = {};
  const serviceOrder: string[] = [];

  for (const service of rawConfig.services) {
    const normalized = normalizeServiceConfig(service, workspaceRoot, configPathForErrors);
    if (services[normalized.id]) {
      throw new Error(`Invalid config in ${configPathForErrors}: duplicate service id "${normalized.id}"`);
    }
    services[normalized.id] = normalized;
    serviceOrder.push(normalized.id);
  }

  const groups = normalizeGroups(rawConfig.groups, serviceOrder, configPathForErrors);
  const workspaceName = normalizeWorkspaceName(rawConfig.workspaceName, workspaceRoot);

  return {
    configPath: path.resolve(configPathForErrors),
    workspaceRoot,
    workspaceName,
    services,
    serviceOrder,
    groups
  };
}

function normalizeServiceConfig(
  raw: WorkspaceServiceConfigFile,
  workspaceRoot: string,
  configPathForErrors: string
): ServiceRuntimeConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid config in ${configPathForErrors}: service entry must be an object`);
  }

  const id = String(raw.id ?? "").trim().toLowerCase();
  if (!serviceIdPattern.test(id)) {
    throw new Error(
      `Invalid config in ${configPathForErrors}: service.id "${id}" must match ${serviceIdPattern}`
    );
  }

  const label = String(raw.label ?? id).trim();
  if (!label) {
    throw new Error(`Invalid config in ${configPathForErrors}: service "${id}" label cannot be empty`);
  }

  const category = String(raw.category ?? defaultCategory).trim().toLowerCase();
  if (!category) {
    throw new Error(`Invalid config in ${configPathForErrors}: service "${id}" category cannot be empty`);
  }

  const cwdInput = String(raw.cwd ?? "").trim();
  if (!cwdInput) {
    throw new Error(`Invalid config in ${configPathForErrors}: service "${id}" cwd is required`);
  }

  const cwd = path.resolve(workspaceRoot, cwdInput);
  if (!fs.existsSync(cwd)) {
    throw new Error(`Invalid config in ${configPathForErrors}: cwd not found for "${id}": ${cwd}`);
  }

  const start = raw.start;
  if (!start || typeof start !== "object") {
    throw new Error(`Invalid config in ${configPathForErrors}: service "${id}" start is required`);
  }
  const command = String(start.command ?? "").trim();
  if (!command) {
    throw new Error(
      `Invalid config in ${configPathForErrors}: service "${id}" start.command is required`
    );
  }

  let args: string[] = [];
  if (start.args !== undefined) {
    if (!Array.isArray(start.args)) {
      throw new Error(`Invalid config in ${configPathForErrors}: service "${id}" start.args must be an array`);
    }
    args = start.args.map((item) => String(item));
  }

  const env = normalizeEnv(raw.env, id, configPathForErrors);
  const logEnabled = raw.log?.enabled ?? true;
  const retentionInput = raw.log?.retentionDays ?? defaultLogRetentionDays;
  const logRetentionDays = normalizeRetentionDays(retentionInput, id, configPathForErrors);

  return {
    id,
    label,
    category,
    command,
    args,
    cwd,
    env,
    logEnabled: Boolean(logEnabled),
    logRetentionDays
  };
}

function normalizeWorkspaceName(nameInput: string | undefined, workspaceRoot: string): string {
  const normalized = String(nameInput ?? "").trim();
  if (normalized) {
    return normalized;
  }
  return path.basename(workspaceRoot);
}

function normalizeEnv(
  rawEnv: Record<string, string> | undefined,
  serviceId: string,
  configPathForErrors: string
): Record<string, string> {
  if (rawEnv === undefined) {
    return {};
  }
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    throw new Error(`Invalid config in ${configPathForErrors}: service "${serviceId}" env must be an object`);
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    const envKey = key.trim();
    if (!envKey) {
      throw new Error(`Invalid config in ${configPathForErrors}: service "${serviceId}" has an empty env key`);
    }
    if (typeof value !== "string") {
      throw new Error(
        `Invalid config in ${configPathForErrors}: service "${serviceId}" env "${envKey}" must be string`
      );
    }
    env[envKey] = value;
  }
  return env;
}

function normalizeRetentionDays(value: unknown, serviceId: string, configPathForErrors: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(
      `Invalid config in ${configPathForErrors}: service "${serviceId}" log.retentionDays must be numeric`
    );
  }
  const intValue = Math.floor(numeric);
  if (intValue < 1 || intValue > 365) {
    throw new Error(
      `Invalid config in ${configPathForErrors}: service "${serviceId}" log.retentionDays must be 1-365`
    );
  }
  return intValue;
}

function normalizeGroups(
  rawGroups: Record<string, string[]> | undefined,
  serviceOrder: string[],
  configPathForErrors: string
): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  if (rawGroups !== undefined) {
    if (!rawGroups || typeof rawGroups !== "object" || Array.isArray(rawGroups)) {
      throw new Error(`Invalid config in ${configPathForErrors}: groups must be an object`);
    }

    for (const [groupName, members] of Object.entries(rawGroups)) {
      const normalizedGroup = groupName.trim().toLowerCase();
      if (!normalizedGroup) {
        throw new Error(`Invalid config in ${configPathForErrors}: group name cannot be empty`);
      }
      if (!Array.isArray(members)) {
        throw new Error(`Invalid config in ${configPathForErrors}: group "${normalizedGroup}" must be an array`);
      }

      const normalizedMembers = members.map((member) => String(member).trim().toLowerCase());
      const uniqueMembers = Array.from(new Set(normalizedMembers));
      for (const member of uniqueMembers) {
        if (!serviceOrder.includes(member)) {
          throw new Error(
            `Invalid config in ${configPathForErrors}: group "${normalizedGroup}" references unknown service "${member}"`
          );
        }
      }
      groups[normalizedGroup] = uniqueMembers;
    }
  }

  if (!groups.all) {
    groups.all = [...serviceOrder];
  }

  return groups;
}

function readWorkspaceConfigFile(configPath: string): WorkspaceConfigFile {
  let rawText = "";
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config ${configPath}: ${message}`);
  }

  try {
    return JSON.parse(rawText) as WorkspaceConfigFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${configPath}: ${message}`);
  }
}

function findConfigUpwards(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, workspaceConfigFileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}
