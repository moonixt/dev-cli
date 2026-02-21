import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { logPrefix, repoRoot } from "../../config";
import type { DbResetOptions } from "../../types";
import { bold, cyan, highlightErrorKeywords, yellow } from "../../utils/colors";
import { runCommand } from "../../utils/process";

const errorTag = bold(cyan(logPrefix, process.stderr), process.stderr);

export function registerDbCommands(program: Command): void {
  const db = program.command("db").description("Database utilities");
  db
    .command("reset")
    .description("Execute docs/queryreset.txt with sqlcmd")
    .option("--server <server>", "SQL Server host/instance")
    .option("--database <database>", "Initial database (default: master)", "master")
    .option("--user <user>", "SQL login user")
    .option("--password <password>", "SQL login password")
    .option("--trusted", "Use Windows integrated authentication")
    .option("--trust-server-certificate", "Trust SQL Server certificate")
    .action(async (options: DbResetOptions) => {
      process.exitCode = await runDbReset(options);
    });
}

export async function runDbReset(options: DbResetOptions): Promise<number> {
  return runDbResetWithOutput(options, { silent: false });
}

export async function runDbResetWithOutput(
  options: DbResetOptions,
  outputOptions: { silent: boolean }
): Promise<number> {
  const sqlFilePath = path.join(repoRoot, "docs", "queryreset.txt");
  if (!fs.existsSync(sqlFilePath)) {
    console.error(
      `${errorTag} ${highlightErrorKeywords("query file not found:", process.stderr)} ${yellow(sqlFilePath, process.stderr)}`
    );
    return 1;
  }

  const server = options.server ?? process.env.DEV_CLI_SQL_SERVER;
  const database = options.database ?? process.env.DEV_CLI_SQL_DATABASE ?? "master";
  const user = options.user ?? process.env.DEV_CLI_SQL_USER;
  const password = options.password ?? process.env.DEV_CLI_SQL_PASSWORD;
  const trusted = options.trusted ?? parseBooleanEnv(process.env.DEV_CLI_SQL_TRUSTED) ?? (!user && !password);
  const trustServerCertificate =
    options.trustServerCertificate ??
    parseBooleanEnv(process.env.DEV_CLI_SQL_TRUST_SERVER_CERTIFICATE) ??
    false;

  if (!server) {
    console.error(
      `${errorTag} ${highlightErrorKeywords("missing SQL server.", process.stderr)} ${yellow(
        "Use --server or DEV_CLI_SQL_SERVER.",
        process.stderr
      )}`
    );
    return 1;
  }

  if ((user && !password) || (!user && password)) {
    console.error(
      `${errorTag} ${highlightErrorKeywords("provide both --user and --password", process.stderr)} ${yellow(
        "(or env vars).",
        process.stderr
      )}`
    );
    return 1;
  }

  if (!trusted && (!user || !password)) {
    console.error(
      `${errorTag} ${highlightErrorKeywords("auth required.", process.stderr)} ${yellow(
        "Use --trusted (or DEV_CLI_SQL_TRUSTED=1) or provide --user/--password.",
        process.stderr
      )}`
    );
    return 1;
  }

  const args = ["-b", "-I", "-S", server, "-d", database, "-i", sqlFilePath];
  if (trustServerCertificate) {
    args.push("-C");
  }

  if (trusted) {
    args.push("-E");
  } else {
    args.push("-U", user as string, "-P", password as string);
  }

  return runCommand("sqlcmd", args, repoRoot, { silent: outputOptions.silent });
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }

  return undefined;
}
