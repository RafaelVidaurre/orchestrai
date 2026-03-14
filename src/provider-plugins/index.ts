import type { AgentProviderPlugin } from "../plugin-sdk";
import { claudeProviderPlugin } from "./claude";
import { codexProviderPlugin } from "./codex";
import { grokProviderPlugin } from "./grok";

export const builtinProviderPlugins: AgentProviderPlugin[] = [
  codexProviderPlugin,
  claudeProviderPlugin,
  grokProviderPlugin
];
