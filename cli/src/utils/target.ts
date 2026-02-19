import type { RunTarget } from "../types";

export function normalizeTarget(value: string): RunTarget {
  const normalized = value.toLowerCase();
  if (normalized === "api" || normalized === "sasa" || normalized === "frontend" || normalized === "waha" || normalized === "all") {
    return normalized;
  }

  throw new Error(`Invalid target "${value}". Expected api, sasa, frontend, waha, or all.`);
}
