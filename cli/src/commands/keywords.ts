import { Command } from "commander";
import { logPrefix } from "../config";
import { bold, cyan, dim, green, highlightErrorKeywords, red, yellow } from "../utils/colors";
import {
  addErrorKeyword,
  getDefaultErrorKeywords,
  getErrorKeywords,
  getErrorKeywordsConfigPath,
  hasPersistedErrorKeywords,
  removeErrorKeyword,
  resetErrorKeywords,
  setErrorKeywords
} from "../utils/error-keywords";

const infoTag = bold(cyan(logPrefix));
const errorTag = bold(cyan(logPrefix, process.stderr), process.stderr);

export function registerKeywordCommands(program: Command): void {
  const keywords = program
    .command("keywords")
    .alias("kw")
    .description("Manage error highlight keywords used by logs and CLI messages");

  keywords
    .command("list")
    .description("List active keywords")
    .action(() => {
      printKeywords("active keywords", getErrorKeywords());
      const configPath = getErrorKeywordsConfigPath();
      const configStatus = hasPersistedErrorKeywords() ? dim("(persisted)") : dim("(using defaults/env)");
      console.log(`${dim("config:")} ${configPath} ${configStatus}`);
    });

  keywords
    .command("add")
    .description('Add one keyword (use quotes for phrases, e.g. "connection reset")')
    .argument("<keyword>", "Keyword or phrase to add")
    .action((keyword: string) => {
      try {
        const result = addErrorKeyword(keyword);
        if (!result.added) {
          console.log(`${infoTag} ${yellow(`keyword already exists: ${result.keyword}`)}`);
          return;
        }

        console.log(`${infoTag} ${green(`keyword added: ${result.keyword}`)}`);
        printKeywords("active keywords", result.updatedKeywords);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${errorTag} ${red(message, process.stderr)}`);
        process.exitCode = 1;
      }
    });

  keywords
    .command("remove")
    .description("Remove one keyword")
    .argument("<keyword>", "Keyword or phrase to remove")
    .action((keyword: string) => {
      try {
        const result = removeErrorKeyword(keyword);
        if (!result.removed) {
          console.log(`${infoTag} ${yellow(`keyword not found: ${result.keyword}`)}`);
          return;
        }

        console.log(`${infoTag} ${green(`keyword removed: ${result.keyword}`)}`);
        printKeywords("active keywords", result.updatedKeywords);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${errorTag} ${red(message, process.stderr)}`);
        process.exitCode = 1;
      }
    });

  keywords
    .command("set")
    .description('Replace all keywords (space-separated; use quotes for phrases: "timed out")')
    .argument("<keywords...>", "List of keywords")
    .action((keywordsInput: string[]) => {
      try {
        const updated = setErrorKeywords(keywordsInput);
        console.log(`${infoTag} ${green("keywords replaced")}`);
        printKeywords("active keywords", updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${errorTag} ${red(message, process.stderr)}`);
        process.exitCode = 1;
      }
    });

  keywords
    .command("reset")
    .description("Reset keywords to defaults")
    .action(() => {
      const updated = resetErrorKeywords();
      console.log(`${infoTag} ${green("keywords reset to defaults")}`);
      printKeywords("default keywords", getDefaultErrorKeywords());
      printKeywords("active keywords", updated);
    });
}

function printKeywords(label: string, keywords: string[]): void {
  const highlighted = keywords.map((keyword) => highlightErrorKeywords(keyword));
  const list = highlighted.length > 0 ? highlighted.join(", ") : dim("(none)");
  console.log(`${infoTag} ${label}: ${list}`);
}
