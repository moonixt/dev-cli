import type { ServiceRuntimeConfig, ShellCommand, ShellCommandCatalog } from "../types";

const builtinCategoryOrder = ["logs", "database", "keywords", "system"];

const builtinLabels: Record<string, string> = {
  logs: "Logs",
  database: "Database",
  keywords: "Keywords",
  system: "System"
};

export function generateShellCommandCatalog(
  services: Record<string, ServiceRuntimeConfig>,
  serviceOrder: string[]
): ShellCommandCatalog {
  const commands: ShellCommand[] = [];
  const categoryOrder: string[] = [];
  const categoryLabels: Record<string, string> = {};

  const servicesByCategory = new Map<string, string[]>();
  for (const serviceId of serviceOrder) {
    const service = services[serviceId];
    if (!service) {
      continue;
    }
    if (!servicesByCategory.has(service.category)) {
      servicesByCategory.set(service.category, []);
      categoryOrder.push(service.category);
      categoryLabels[service.category] = formatCategoryLabel(service.category);
    }
    servicesByCategory.get(service.category)?.push(serviceId);
  }

  for (const [category, serviceIds] of servicesByCategory.entries()) {
    for (const serviceId of serviceIds) {
      const service = services[serviceId];
      commands.push({
        category,
        command: `/start ${service.id}`,
        description: `start ${service.label} service`
      });
    }
    commands.push({ category, command: "/start all", description: "start group all services" });
    for (const serviceId of serviceIds) {
      const service = services[serviceId];
      commands.push({
        category,
        command: `/stop ${service.id}`,
        description: `stop ${service.label} service`
      });
    }
    commands.push({ category, command: "/stop all", description: "stop group all services" });
    commands.push({ category, command: "/status", description: "show running services" });
  }

  categoryOrder.push(...builtinCategoryOrder);
  for (const [category, label] of Object.entries(builtinLabels)) {
    categoryLabels[category] = label;
  }

  commands.push({ category: "logs", command: "/logs", description: "enable logs from all services" });
  commands.push({ category: "logs", command: "/logs all", description: "show logs from all services" });
  for (const serviceId of serviceOrder) {
    const service = services[serviceId];
    if (!service) {
      continue;
    }
    commands.push({
      category: "logs",
      command: `/logs ${service.id}`,
      description: `show only ${service.label} logs`
    });
  }
  commands.push({ category: "logs", command: "/logs off", description: "hide live log panel" });
  commands.push({ category: "logs", command: "/logs clear", description: "clear log buffer" });

  commands.push({ category: "database", command: "/db reset", description: "run docs/queryreset.txt on SQL Server" });

  commands.push({ category: "keywords", command: "/keywords list", description: "list active error keywords" });
  commands.push({
    category: "keywords",
    command: "/keywords add",
    description: "add one error keyword (or use /keywords <term>)"
  });
  commands.push({ category: "keywords", command: "/keywords remove", description: "remove one error keyword" });
  commands.push({ category: "keywords", command: "/keywords set", description: "replace all error keywords" });
  commands.push({ category: "keywords", command: "/keywords reset", description: "reset error keywords to defaults" });

  commands.push({ category: "system", command: "/clear", description: "redraw the terminal UI" });
  commands.push({ category: "system", command: "/help", description: "show command list" });
  commands.push({ category: "system", command: "/exit", description: "close interactive UI" });

  const dedupedCommands = dedupeCommands(commands);
  return {
    commands: dedupedCommands,
    commandNames: dedupedCommands.map((item) => item.command),
    categoryOrder: dedupeCategoryOrder(categoryOrder, dedupedCommands),
    categoryLabels
  };
}

function formatCategoryLabel(category: string): string {
  if (category === "apis") {
    return "APIs";
  }

  return category
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function dedupeCommands(commands: ShellCommand[]): ShellCommand[] {
  const seen = new Set<string>();
  const result: ShellCommand[] = [];
  for (const command of commands) {
    if (seen.has(command.command)) {
      continue;
    }
    seen.add(command.command);
    result.push(command);
  }
  return result;
}

function dedupeCategoryOrder(categoryOrder: string[], commands: ShellCommand[]): string[] {
  const categoriesWithCommands = new Set(commands.map((item) => item.category));
  const seen = new Set<string>();
  const output: string[] = [];
  for (const category of categoryOrder) {
    if (seen.has(category) || !categoriesWithCommands.has(category)) {
      continue;
    }
    seen.add(category);
    output.push(category);
  }
  return output;
}
