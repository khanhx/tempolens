/** Decodes standard base64 into bytes. Throws on invalid input. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Base64 → UTF-8 text (invalid sequences become U+FFFD). Throws on invalid base64. */
export function base64ToText(b64: string): string {
  return decoder.decode(base64ToBytes(b64));
}

/** UTF-8 text → base64. */
export function textToBase64(text: string): string {
  const bytes = encoder.encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Like base64ToText but returns null instead of throwing. */
export function tryBase64ToText(b64: string | undefined): string | null {
  if (b64 === undefined) return null;
  try {
    return base64ToText(b64);
  } catch {
    return null;
  }
}
