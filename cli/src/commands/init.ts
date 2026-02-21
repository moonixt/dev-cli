import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { logPrefix } from "../config";
import { workspaceConfigFileName } from "../services/config-loader";
import type { WorkspaceConfigFile } from "../types";
import { bold, cyan, green, red, yellow } from "../utils/colors";

type InitCommandOptions = {
  yes?: boolean;
  force?: boolean;
  config?: string;
};

const infoTag = bold(cyan(logPrefix));
const errorTag = bold(cyan(logPrefix, process.stderr), process.stderr);

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Create dev-cli.config.json for the current project")
    .option("--yes", "Use defaults without interactive prompts")
    .option("--force", "Overwrite existing config file")
    .option("--config <path>", "Write config to a custom path")
    .action(async (options: InitCommandOptions) => {
      process.exitCode = await runInitCommand(options);
    });
}

async function runInitCommand(options: InitCommandOptions): Promise<number> {
  const cwd = process.cwd();
  const targetPath = options.config
    ? path.resolve(cwd, options.config)
    : path.join(cwd, workspaceConfigFileName);

  if (fs.existsSync(targetPath) && !options.force) {
    console.error(
      `${errorTag} ${red(`config already exists at ${targetPath}`, process.stderr)} ${yellow(
        "(use --force to overwrite)",
        process.stderr
      )}`
    );
    return 1;
  }

  const config = options.yes
    ? buildDefaultConfig(cwd)
    : await promptForConfig(cwd);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}${os.EOL}`, "utf8");
  console.log(`${infoTag} ${green(`config written: ${targetPath}`)}`);
  console.log(`${infoTag} ${yellow("next: edit services and run dev-cli shell")}`);
  return 0;
}

function buildDefaultConfig(cwd: string): WorkspaceConfigFile {
  const workspaceName = path.basename(cwd);
  return {
    version: 1,
    workspaceName,
    services: [
      {
        id: "app",
        label: "App",
        category: "services",
        cwd: ".",
        start: {
          command: process.platform === "win32" ? "npm.cmd" : "npm",
          args: ["run", "dev"]
        },
        env: {},
        log: {
          enabled: true,
          retentionDays: 7
        },
        health: {
          kind: "none"
        }
      }
    ],
    groups: {
      all: ["app"]
    }
  };
}

async function promptForConfig(cwd: string): Promise<WorkspaceConfigFile> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const workspaceDefault = path.basename(cwd);
    const serviceIdDefault = "app";
    const labelDefault = "App";
    const categoryDefault = "services";
    const cwdDefault = ".";
    const commandDefault = process.platform === "win32" ? "npm.cmd" : "npm";
    const argsDefault = "run dev";

    const workspaceName = await askWithDefault(rl, "workspace name", workspaceDefault);
    const serviceId = await askWithDefault(rl, "first service id", serviceIdDefault);
    const serviceLabel = await askWithDefault(rl, "service label", labelDefault);
    const serviceCategory = await askWithDefault(rl, "service category", categoryDefault);
    const serviceCwd = await askWithDefault(rl, "service cwd (relative)", cwdDefault);
    const command = await askWithDefault(rl, "start command", commandDefault);
    const argsRaw = await askWithDefault(rl, "start args (space-separated)", argsDefault);

    return {
      version: 1,
      workspaceName,
      services: [
        {
          id: serviceId.trim().toLowerCase(),
          label: serviceLabel.trim() || serviceId,
          category: serviceCategory.trim().toLowerCase() || categoryDefault,
          cwd: serviceCwd.trim() || cwdDefault,
          start: {
            command: command.trim() || commandDefault,
            args: splitArgs(argsRaw)
          },
          env: {},
          log: {
            enabled: true,
            retentionDays: 7
          },
          health: {
            kind: "none"
          }
        }
      ],
      groups: {
        all: [serviceId.trim().toLowerCase()]
      }
    };
  } finally {
    rl.close();
  }
}

async function askWithDefault(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string
): Promise<string> {
  const value = await rl.question(`${label} [${defaultValue}]: `);
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : defaultValue;
}

function splitArgs(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed.split(/\s+/);
}
