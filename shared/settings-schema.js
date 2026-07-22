export const DEFAULT_MCP_BRIDGE_PORT = 9229;

export function normalizeMcpBridgeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    port: Number(value.port) || DEFAULT_MCP_BRIDGE_PORT,
    token: String(value.token || "")
  };
}

export function normalizeTempEmailSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    apiUrl: typeof value.apiUrl === "string" ? value.apiUrl.trim() : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : ""
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
