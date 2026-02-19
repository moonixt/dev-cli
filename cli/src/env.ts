import fs from "node:fs";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";
import { cliRoot } from "./config";

let loaded = false;

export function loadCliEnv(): void {
  if (loaded) {
    return;
  }

  loaded = true;
  const envPath = path.join(cliRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  dotenvConfig({ path: envPath, override: false });
}
