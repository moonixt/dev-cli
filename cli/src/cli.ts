#!/usr/bin/env node

import { Command } from "commander";
import { registerStartCommand } from "./commands/api/start";
import { registerDbCommands } from "./commands/db/reset";
import { registerInitCommand } from "./commands/init";
import { registerKeywordCommands } from "./commands/keywords";
import { registerShellCommand } from "./commands/shell";
import { cliVersion, logPrefix } from "./config";
import { loadCliEnv } from "./env";
import { bold, cyan, highlightErrorKeywords } from "./utils/colors";

const program = new Command()
  .name("dev-cli")
  .description("LemarSyn project CLI")
  .version(cliVersion);

registerStartCommand(program);
registerShellCommand(program);
registerDbCommands(program);
registerKeywordCommands(program);
registerInitCommand(program);
loadCliEnv();

if (process.argv.slice(2).length === 0) {
  process.argv.push("shell");
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `${bold(cyan(logPrefix, process.stderr), process.stderr)} ${highlightErrorKeywords(message, process.stderr)}`
  );
  process.exit(1);
});
