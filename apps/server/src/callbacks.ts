const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function callbackData(prefix: string, ids: readonly string[]): string | null {
  const packed: string[] = [];
  for (const id of ids) {
    const value = packUuid(id);
    if (value === null) return null;
    packed.push(value);
  }
  const data = packed.length === 0 ? prefix : `${prefix}.${packed.join(".")}`;
  if (Buffer.byteLength(data) > 64) return null;
  return data;
}

export function readCallback(data: string): { readonly prefix: string; readonly ids: readonly string[] } | null {
  const parts = data.split(".");
  const prefix = parts[0];
  if (prefix === undefined || prefix.length !== 1) return null;
  const ids: string[] = [];
  for (const part of parts.slice(1)) {
    const id = unpackUuid(part);
    if (id === null) return null;
    ids.push(id);
  }
  return { prefix, ids };
}

function packUuid(id: string): string | null {
  if (!UUID.test(id)) return null;
  return Buffer.from(id.replaceAll("-", ""), "hex").toString("base64url");
}

function unpackUuid(packed: string): string | null {
  const bytes = Buffer.from(packed, "base64url");
  if (bytes.length !== 16) return null;
  const hex = bytes.toString("hex");
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
