import type { AgentModelDescriptor, AgentProvider } from "./domain";

const MODEL_OPTIONS: Record<AgentProvider, AgentModelDescriptor[]> = {
  codex: [
    { value: "gpt-5.2-codex", label: "GPT-5.2-Codex" },
    { value: "gpt-5.1-codex", label: "GPT-5.1-Codex" },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1-Codex mini" },
    { value: "codex-mini-latest", label: "codex-mini-latest" },
    { value: "o4-mini", label: "o4-mini" }
  ],
  claude: [
    { value: "default", label: "default" },
    { value: "sonnet", label: "sonnet" },
    { value: "opus", label: "opus" },
    { value: "haiku", label: "haiku" },
    { value: "sonnet[1m]", label: "sonnet[1m]" },
    { value: "opusplan", label: "opusplan" }
  ],
  grok: [
    { value: "grok-code-fast-1", label: "grok-code-fast-1" },
    { value: "grok-4-1-fast-reasoning", label: "grok-4-1-fast-reasoning" },
    { value: "grok-4-fast-reasoning", label: "grok-4-fast-reasoning" },
    { value: "grok-4.20-beta-latest-non-reasoning", label: "grok-4.20-beta-latest-non-reasoning" }
  ]
};

export function agentModelOptions(provider: AgentProvider): AgentModelDescriptor[] {
  return MODEL_OPTIONS[provider];
}

export function isKnownAgentModel(provider: AgentProvider, model: string | null | undefined): boolean {
  const normalized = typeof model === "string" ? model.trim() : "";
  return normalized.length > 0 && MODEL_OPTIONS[provider].some((option) => option.value === normalized);
}
