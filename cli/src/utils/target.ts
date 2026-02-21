import type { RunTarget, ServiceId } from "../types";

export function resolveRunTarget(value: string, availableServices: ServiceId[]): RunTarget {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "all") {
    return "all";
  }

  if (availableServices.includes(normalized)) {
    return normalized;
  }

  if (availableServices.length === 0) {
    throw new Error('No services configured. Run "dev-cli init" to create dev-cli.config.json.');
  }

  throw new Error(
    `Invalid target "${value}". Expected one of: ${availableServices.join(", ")}, or all.`
  );
}
