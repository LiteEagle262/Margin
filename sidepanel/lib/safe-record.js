const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isSafeRecordKey(value) {
  const key = String(value || "");
  return Boolean(key) && !FORBIDDEN_KEYS.has(key) && !key.includes("\0");
}

export function isSafeVirtualPath(value) {
  const path = String(value || "").trim().replaceAll("\\", "/");
  if (!path || path.length > 500 || path.startsWith("/") || /^[a-z]:\//i.test(path)) return false;
  return path.split("/").every((segment) =>
    isSafeRecordKey(segment) && segment !== "." && segment !== ".."
  );
}

export function safeRecord(source, keyValidator = isSafeRecordKey) {
  const output = Object.create(null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return output;
  for (const [key, value] of Object.entries(source)) {
    if (keyValidator(key)) output[key] = value;
  }
  return output;
}
