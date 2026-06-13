// sidepanel/settings/registry.js - All settings sections, in render order.
//
// A section descriptor is { key, normalize, render?, collect?, init? }:
//   key       - property name in the settings object and chrome.storage
//   normalize - (raw) -> canonical sub-config; must accept any input
//   render    - push current settings into the section's form controls
//   collect   - read the section's form controls back into a sub-config
//   init      - one-time event wiring at startup
//
// Adding a section: create a module in ./sections/, export a descriptor,
// list it here, and add its key to SETTINGS_STORAGE_KEYS in state/persistence.js.

import { mcpServersSection } from "./sections/mcp-servers.js";
import { mcpBridgeSection } from "./sections/mcp-bridge.js";
import { tempEmailSection } from "./sections/temp-email.js";
import { webSearchSection } from "./sections/web-search.js";
import { toolAccessSection } from "./sections/tool-access.js";
import { networkCaptureSection } from "./sections/network-capture.js";
import { providerRoutingSection } from "./sections/provider-routing.js";
import { reasoningSection } from "./sections/reasoning.js";
import { authManualKeysSection } from "./sections/auth-manual-keys.js";

export const SETTINGS_SECTIONS = [
  mcpServersSection,
  mcpBridgeSection,
  tempEmailSection,
  webSearchSection,
  toolAccessSection,
  networkCaptureSection,
  providerRoutingSection,
  reasoningSection,
  authManualKeysSection
];
