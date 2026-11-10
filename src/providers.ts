import type { AgentProvider } from "./types";

export const agentProviders: AgentProvider[] = ["codex", "claude", "copilot"];
export const providerNames: Record<AgentProvider, string> = {
  codex: "Codex",
  claude: "Claude",
  copilot: "GitHub Copilot",
};
export function providerFromId(threadId: string): AgentProvider {
  return threadId.startsWith("claude:")
    ? "claude"
    : threadId.startsWith("copilot:")
      ? "copilot"
      : "codex";
}
