export function truncateUtf8Tail(value, maxBytes) {
  const text = String(value || "");
  const limit = Math.max(0, Number(maxBytes) || 0);
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= limit) return text;

  const characters = Array.from(text);
  const kept = [];
  let bytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const size = encoder.encode(characters[index]).length;
    if (bytes + size > limit) break;
    kept.push(characters[index]);
    bytes += size;
  }
  return kept.reverse().join("");
}
