// Pure URL/field secret detection shared by the network log redactor and the
// activity journal. No chrome globals, so both a service worker and a unit test
// can load it.
//
// Callers decide whether redaction is optional: network logs gate it behind the
// user's "Redact sensitive data" setting, while the activity journal always
// applies it — an audit trail that a settings toggle can disable is not one.

export const SENSITIVE_FIELD_RE = /(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth|credential|session|csrf|xsrf)/i;

const SENSITIVE_URL_PARAM_RE = /^(?:authorization|auth|bearer|code|credential|client[_-]?secret|id[_-]?token|jwt|key|password|passwd|pwd|secret|session(?:id)?|sig|signature|token|x-amz-credential|x-amz-security-token|x-amz-signature|x-goog-credential|x-goog-signature)$/i;

export function isSensitiveUrlParam(name) {
  return SENSITIVE_URL_PARAM_RE.test(name) || SENSITIVE_FIELD_RE.test(name);
}

export function redactUrlFragment(fragment) {
  return String(fragment || "").replace(
    /([#&?])([^#&?=]+)=([^&#]*)/g,
    (match, separator, rawKey) => {
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        // Use the raw key when percent-decoding fails.
      }
      return isSensitiveUrlParam(key)
        ? `${separator}${rawKey}=${encodeURIComponent("[redacted]")}`
        : match;
    },
  );
}

// Strips credentials from userinfo, sensitive query params, and the fragment.
export function redactUrlSecrets(rawUrl) {
  const value = String(rawUrl || "");
  if (!value) return value;

  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    const keys = [...new Set(url.searchParams.keys())];
    for (const key of keys) {
      if (isSensitiveUrlParam(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    url.hash = redactUrlFragment(url.hash);
    return url.toString();
  } catch {
    return redactUrlFragment(value);
  }
}
