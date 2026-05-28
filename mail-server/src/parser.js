import { simpleParser } from "mailparser";

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const CODE_RE = /(?<![\w-])(\d{4,8})(?![\w-])/g;
const NUMERIC_NEAR_KEYWORDS_RE =
  /(?:code|verification|verify|one[\s-]?time|pin|otp|password|passcode|confirm)[^\d\n]{0,40}(\d{4,8})/gi;

export async function parseRfc822(buffer) {
  const parsed = await simpleParser(buffer, {
    skipImageLinks: true,
    skipHtmlToText: false
  });

  const text = parsed.text || "";
  const html = parsed.html || "";
  const haystack = `${text}\n${stripTags(html)}`;

  return {
    from: addressString(parsed.from),
    to: addressList(parsed.to),
    subject: parsed.subject || "",
    text,
    html,
    rawSize: buffer.length,
    codes: extractCodes(haystack),
    links: extractLinks(`${text}\n${html}`)
  };
}

function addressString(field) {
  if (!field) return "";
  if (field.text) return field.text;
  if (field.value && field.value[0]) {
    const v = field.value[0];
    return v.address || v.name || "";
  }
  return "";
}

function addressList(field) {
  if (!field) return "";
  if (Array.isArray(field)) return field.map(addressString).filter(Boolean).join(", ");
  return addressString(field);
}

function stripTags(html) {
  return String(html || "").replace(/<[^>]*>/g, " ");
}

export function extractLinks(input) {
  if (!input) return [];
  const matches = String(input).match(URL_RE) || [];
  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[).,;!?]+$/, "");
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out.slice(0, 50);
}

export function extractCodes(input) {
  if (!input) return [];
  const ranked = new Map();

  let m;
  while ((m = NUMERIC_NEAR_KEYWORDS_RE.exec(input)) !== null) {
    const code = m[1];
    ranked.set(code, (ranked.get(code) || 0) + 10);
  }

  while ((m = CODE_RE.exec(input)) !== null) {
    const code = m[1];
    if (!ranked.has(code)) ranked.set(code, 1);
  }

  return [...ranked.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code]) => code);
}
