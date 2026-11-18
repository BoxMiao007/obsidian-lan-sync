/** SHA-256 工具：优先用 WebCrypto（手机与桌面都有）。 */
export async function sha256Buffer(buffer: ArrayBuffer): Promise<string | null> {
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function sha256HexOfHex(hex: string): string {
  return hex.toLowerCase();
}