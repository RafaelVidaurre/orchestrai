import type { AgentRuntimeEvent, ServiceConfig } from "./domain";
import { ClaudeCliSession } from "./claude";
import { CodexAppServerSession } from "./codex";
import { GrokApiSession } from "./grok";
import { Logger } from "./logger";

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
  switch (config.runtime.provider) {
    case "grok":
      return new GrokApiSession(config, workspacePath, env, logger, onEvent);
    case "claude":
      return new ClaudeCliSession(config, workspacePath, env, logger, onEvent);
    case "codex":
    default:
      return new CodexAppServerSession(config, workspacePath, env, logger, onEvent);
  }
}

export function agentProviderLabel(provider: ServiceConfig["runtime"]["provider"]): string {
  switch (provider) {
    case "claude":
      return "Claude CLI";
    case "grok":
      return "Grok";
    case "codex":
    default:
      return "Codex";
  }
}
