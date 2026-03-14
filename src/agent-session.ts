import type { AgentRuntimeEvent, ServiceConfig } from "./domain";
import { Logger } from "./logger";
import { getActiveProviderRegistry } from "./provider-registry";

export interface AgentSession {
  start(): Promise<void>;
  runTurn(prompt: string): Promise<void>;
  stop(): Promise<void>;
}

export function createAgentSession(
  config: ServiceConfig,
  workspacePath: string,
  env: NodeJS.ProcessEnv,
  logger: Logger,
  onEvent: (event: AgentRuntimeEvent) => void
): AgentSession {
  const plugin = getActiveProviderRegistry().get(config.runtime.provider);
  return plugin.createSession(config, workspacePath, env, logger, onEvent);
}

export function agentProviderLabel(provider: ServiceConfig["runtime"]["provider"]): string {
  return getActiveProviderRegistry().get(provider).displayName;
}
