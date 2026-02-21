import path from "node:path";

export const cliVersion = "0.1.0";
export const logPrefix = "[dev-cli]";

export const cliRoot = path.resolve(__dirname, "..");
export const repoRoot = path.resolve(cliRoot, "..", "..");
