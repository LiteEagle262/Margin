export const DEFAULT_MCP_BRIDGE_PORT = 9229;

export function normalizeMcpBridgeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    port: Number(value.port) || DEFAULT_MCP_BRIDGE_PORT,
    token: String(value.token || "")
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
