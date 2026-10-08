// Agent security settings as stored in the CLI config (`securityEnabled`, `securityMode`,
// `trustedNpubs`) and returned by the runtime's get/setAgentSecurityConfig. Trust here is a claim:
// tasks name their last editor themselves (see `trustLabel` in render.ts).

export type AgentSecurityMode = "off" | "moderate" | "strict";

export type AgentSecurityConfig = {
  enabled: boolean;
  mode: AgentSecurityMode;
  trustedNpubs: string[];
  updatedISO: string;
};
