import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentProvider } from "./domain";
import { ServiceError } from "./errors";
import { builtinProviderPlugins } from "./provider-plugins";
import type { AgentProviderPlugin } from "./plugin-sdk";

const EXTERNAL_PLUGIN_PATTERNS = [/^@orchestrai\/provider-/, /^orchestrai-provider-/];

export class ProviderRegistry {
  private readonly plugins = new Map<AgentProvider, AgentProviderPlugin>();

  constructor(plugins: AgentProviderPlugin[]) {
    for (const plugin of plugins) {
      if (this.plugins.has(plugin.id)) {
        throw new ServiceError("duplicate_provider_plugin", `Duplicate provider plugin id: ${plugin.id}`);
      }
      this.plugins.set(plugin.id, plugin);
    }
  }

  get(provider: AgentProvider): AgentProviderPlugin {
    const plugin = this.plugins.get(provider);
    if (!plugin) {
      throw new ServiceError("unknown_provider_plugin", `Unknown provider plugin: ${provider}`);
    }
    return plugin;
  }

  maybeGet(provider: AgentProvider): AgentProviderPlugin | null {
    return this.plugins.get(provider) ?? null;
  }

  list(): AgentProviderPlugin[] {
    return [...this.plugins.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

let activeRegistry: ProviderRegistry | null = null;

export function setActiveProviderRegistry(registry: ProviderRegistry): void {
  activeRegistry = registry;
}

export function getActiveProviderRegistry(): ProviderRegistry {
  if (!activeRegistry) {
    activeRegistry = new ProviderRegistry(builtinProviderPlugins);
  }
  return activeRegistry;
}

export async function loadProviderRegistry(projectsRoot: string): Promise<ProviderRegistry> {
  const plugins = [...builtinProviderPlugins];
  const externalPackages = await discoverExternalProviderPackages(projectsRoot);
  for (const packageName of externalPackages) {
    const imported = (await import(packageName)) as { providerPlugin?: unknown };
    if (!imported.providerPlugin || typeof imported.providerPlugin !== "object") {
      throw new ServiceError("invalid_provider_plugin", `${packageName} does not export providerPlugin`);
    }
    plugins.push(imported.providerPlugin as AgentProviderPlugin);
  }

  const registry = new ProviderRegistry(plugins);
  setActiveProviderRegistry(registry);
  return registry;
}

async function discoverExternalProviderPackages(projectsRoot: string): Promise<string[]> {
  const packageJsonPath = path.join(path.resolve(projectsRoot), "package.json");
  const content = await readFile(packageJsonPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!content) {
    return [];
  }

  const pkg = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const names = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {})
  ]);

  return [...names].filter((name) => EXTERNAL_PLUGIN_PATTERNS.some((pattern) => pattern.test(name))).sort();
}
