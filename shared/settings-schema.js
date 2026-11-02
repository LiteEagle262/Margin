export const DEFAULT_MCP_BRIDGE_PORT = 9229;

export function normalizeMcpBridgeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    port: Number(value.port) || DEFAULT_MCP_BRIDGE_PORT,
    token: String(value.token || "")
  };
}

// Only the on/off switch is a setting. Loom's port and token come from its
// native host at run time and are never stored or exported.
export function normalizeLoomBridgeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled !== false
  };
}

export function normalizeNetworkCaptureSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    autoCaptureLatchedTab: value.autoCaptureLatchedTab === true,
    persistSessionLogs: value.persistSessionLogs !== false,
    captureResponseBodies: value.captureResponseBodies !== false,
    redactSensitiveData: value.redactSensitiveData !== false
  };
}
