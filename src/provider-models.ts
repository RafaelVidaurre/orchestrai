import type { ProviderModelCatalog, ProviderModelQuery } from "./domain";
import type { ProviderRegistry } from "./provider-registry";
import { getActiveProviderRegistry } from "./provider-registry";

export async function listProviderModels(
  registryOrInput: ProviderRegistry | ProviderModelQuery,
  inputOrOptions?:
    | ProviderModelQuery
    | {
        baseEnv?: NodeJS.ProcessEnv;
        projectsRoot?: string | null;
        typedSecrets?: Record<string, string | null | undefined>;
      },
  options: {
    baseEnv?: NodeJS.ProcessEnv;
    projectsRoot?: string | null;
    typedSecrets?: Record<string, string | null | undefined>;
  } = {}
): Promise<ProviderModelCatalog> {
  const registry = isRegistry(registryOrInput) ? registryOrInput : getActiveProviderRegistry();
  const input = (isRegistry(registryOrInput) ? inputOrOptions : registryOrInput) as ProviderModelQuery;
  const resolvedOptions = (isRegistry(registryOrInput) ? options : inputOrOptions ?? options) as typeof options;
  const plugin = registry.get(input.provider);
  return plugin.listModels({
    provider: input.provider,
    projectId: input.projectId ?? null,
    baseEnv: resolvedOptions.baseEnv ?? process.env,
    projectsRoot: resolvedOptions.projectsRoot ?? null,
    useStoredKey: input.useStoredKey,
    typedSecrets: {
      ...resolvedOptions.typedSecrets,
      XAI_API_KEY: typeof input.xaiApiKey === "string" ? input.xaiApiKey : resolvedOptions.typedSecrets?.XAI_API_KEY
    }
  });
}

function isRegistry(value: ProviderRegistry | ProviderModelQuery): value is ProviderRegistry {
  return typeof value === "object" && value !== null && "get" in value && typeof value.get === "function";
}
