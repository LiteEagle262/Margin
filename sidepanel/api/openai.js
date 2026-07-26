function runtimeRequest(message) {
  return new Promise((resolve, reject) => {
    const finish = (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "OpenAI sign-in did not respond."));
        return;
      }
      resolve(response.result ?? response);
    };
    try {
      chrome.runtime.sendMessage(message, finish);
    } catch (error) {
      reject(error);
    }
  });
}

export function getOpenAIAuthStatus() {
  return runtimeRequest({ type: "openai-oauth/status" });
}

export function startOpenAILogin() {
  return runtimeRequest({ type: "openai-oauth/start" });
}

export function pollOpenAILogin() {
  return runtimeRequest({ type: "openai-oauth/poll" });
}

export function cancelOpenAILogin() {
  return runtimeRequest({ type: "openai-oauth/cancel" });
}

export function openOpenAIDevicePage() {
  return runtimeRequest({ type: "openai-oauth/open-device" });
}

export function logoutOpenAIAccount() {
  return runtimeRequest({ type: "openai-oauth/logout" });
}

export function fetchOpenAIModels() {
  return runtimeRequest({ type: "openai-oauth/models" });
}

export function fetchOpenAIChatCompletion(requestBody, { signal, sessionId = "", onDelta } = {}) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "openai-responses" });
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      try {
        port.disconnect();
      } catch {}
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      try {
        port.postMessage({ type: "cancel" });
      } catch {}
      fail(new DOMException("The operation was aborted.", "AbortError"));
    };

    port.onMessage.addListener((message) => {
      // Display-only token stream; the authoritative payload is the final
      // {type:"result"} message.
      if (message?.type === "delta") {
        if (!settled && typeof message.text === "string" && message.text && typeof onDelta === "function") {
          try {
            onDelta(message.text);
          } catch {}
        }
        return;
      }
      if (message?.type === "result") {
        succeed(message.result);
        return;
      }
      if (message?.type === "error") {
        if (message.aborted) {
          fail(new DOMException("The operation was aborted.", "AbortError"));
        } else {
          fail(new Error(message.error || "OpenAI could not complete the request."));
        }
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) fail(new Error("The OpenAI background connection closed unexpectedly."));
    });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    port.postMessage({ type: "request", body: requestBody, sessionId });
  });
}
