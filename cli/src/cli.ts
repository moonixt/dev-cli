#!/usr/bin/env node

import { Command } from "commander";
import { registerStartCommand } from "./commands/api/start";
import { registerDbCommands } from "./commands/db/reset";
import { registerShellCommand } from "./commands/shell";
import { cliVersion, logPrefix } from "./config";
import { loadCliEnv } from "./env";

const program = new Command()
  .name("dev-cli")
  .description("LemarSyn project CLI")
  .version(cliVersion);

registerStartCommand(program);
registerShellCommand(program);
registerDbCommands(program);
loadCliEnv();

if (process.argv.slice(2).length === 0) {
  process.argv.push("shell");
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${logPrefix} ${message}`);
  process.exit(1);
});
