import { mcpServersSection } from "./sections/mcp-servers.js";
import { mcpBridgeSection } from "./sections/mcp-bridge.js";
import { openAIAccountSection } from "./sections/openai-account.js";
import { webSearchSection } from "./sections/web-search.js";
import { toolAccessSection } from "./sections/tool-access.js";
import { networkCaptureSection } from "./sections/network-capture.js";
import { providerRoutingSection } from "./sections/provider-routing.js";
import { reasoningSection } from "./sections/reasoning.js";
import { agentLimitsSection } from "./sections/agent-limits.js";
import { authManualKeysSection } from "./sections/auth-manual-keys.js";
import { appearanceSection } from "./sections/appearance.js";

export const SETTINGS_SECTIONS = [
  appearanceSection,
  openAIAccountSection,
  mcpServersSection,
  mcpBridgeSection,
  webSearchSection,
  toolAccessSection,
  networkCaptureSection,
  providerRoutingSection,
  reasoningSection,
  agentLimitsSection,
  authManualKeysSection
];
