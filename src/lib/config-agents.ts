import { CONFIG_AGENTS } from "../types/index.js";

export const DEPRECATED_CONFIG_AGENTS = ["gemini"] as const;

const ACTIVE_CONFIG_AGENT_SET = new Set<string>(CONFIG_AGENTS);
const DEPRECATED_CONFIG_AGENT_SET = new Set<string>(DEPRECATED_CONFIG_AGENTS);

export function isDeprecatedConfigAgent(agent: string | null | undefined): boolean {
  return !!agent && DEPRECATED_CONFIG_AGENT_SET.has(agent);
}

export function isSupportedConfigAgent(agent: string | null | undefined): boolean {
  return !!agent && ACTIVE_CONFIG_AGENT_SET.has(agent) && !isDeprecatedConfigAgent(agent);
}

export function isRetiredOrUnsupportedConfigAgent(agent: string | null | undefined): boolean {
  return !!agent && !isSupportedConfigAgent(agent);
}

export function retiredOrUnsupportedAgentReason(agent: string | null | undefined): string {
  if (!agent) return "missing agent";
  return isDeprecatedConfigAgent(agent) ? `deprecated agent: ${agent}` : `unsupported agent: ${agent}`;
}
