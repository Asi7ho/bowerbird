// Link previews and the private-host gate, main process only.
//
// Pure functions — no electron imports — so the SSRF boundary
// they enforce can be unit-tested without launching the app.
// main.ts imports them; the fetch handlers there do the I/O.

// Read a fetch body as text, stopping at maxBytes: a server
// must not be able to OOM the main process with a multi-GB
// body the caller only slices afterwards. The meta tags a
// preview needs sit at the top of the document, so a prefix
// is enough for fetchPreview; callers that need the whole
// body check `truncated`.
export async function readCappedText(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        // Keep only up to the cap, then stop reading.
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), truncated };
}

// ---------------------------------------------------------------- link preview

export function decodeEntities(s: string): string {
  let out = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  out = out.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (_m, num) => {
    const code = num.startsWith("x") ? parseInt(num.slice(1), 16) : parseInt(num, 10);
    return Number.isNaN(code) ? _m : String.fromCodePoint(code);
  });
  return out;
}

export function metaContent(html: string, property: string): string | null {
  const re = /<meta[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (tag.includes(`property="${property}"`) || tag.includes(`property='${property}'`) || tag.includes(`name="${property}"`) || tag.includes(`name='${property}'`)) {
      const cm = /content=(?:"([^"]*)"|'([^']*)')/.exec(tag);
      if (cm) {
        const value = decodeEntities((cm[1] ?? cm[2] ?? "").trim());
        if (value) return value;
      }
    }
  }
  return null;
}

export function tagContent(html: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(html);
  if (!m) return null;
  const value = decodeEntities(m[1].trim());
  return value || null;
}

// Href of the first <link> whose rel matches one of the wanted kinds
// (e.g. "icon", "apple-touch-icon"), or null.
export function linkHref(html: string, kinds: string[]): string | null {
  const re = /<link[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const rel = /rel=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const href = /href=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!rel || !href) continue;
    const relLower = (rel[1] ?? rel[2] ?? "").toLowerCase();
    const hrefValue = decodeEntities((href[1] ?? href[2] ?? "").trim());
    if (hrefValue && kinds.some((k) => relLower.includes(k))) return hrefValue;
  }
  return null;
}

export function isPrivateHost(host: string): boolean {
  let h = String(host || "").toLowerCase().replace(/\.$/, "");
  // WHATWG URL returns IPv6 hostnames bracketed ("[::1]"), so
  // strip the brackets or the IPv6 checks below never match.
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h || h === "localhost" || h.endsWith(".local") || h === "0.0.0.0") return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127 || (a === 169 && b === 254)) return true;
    return false;
  }
  if (h === "::1" || h.startsWith("fe80:")) return true;
  // Unique-local addresses are fc00::/7, so the first hextet
  // runs fc00–fdff — a literal "fd00:" prefix check misses
  // fd12:: and the rest of the range.
  const firstHextet = Number.parseInt(h.split(":")[0] || "", 16);
  if (!Number.isNaN(firstHextet) && firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true;
  // IPv4-mapped IPv6: WHATWG URL returns the embedded address
  // in hex ("::ffff:7f00:1" for 127.0.0.1), so the dotted
  // ::ffff: checks never see it. Decode the first hextet:
  // 7f00-7fff is 127.x, 0a00-0aff is 10.x, ac10-ac1f is
  // 172.16-31, c0a8 is 192.168, a9fe is 169.254.
  if (h.startsWith("::ffff:")) {
    const rest = h.slice("::ffff:".length);
    if (rest.includes(".")) {
      const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(rest);
      if (!m) return false;
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 127 || (a === 169 && b === 254)) return true;
      return false;
    }
    const first = Number.parseInt(rest.split(":")[0] || "", 16);
    if (Number.isNaN(first)) return false;
    if (first >= 0x7f00 && first <= 0x7fff) return true;
    if (first >= 0x0a00 && first <= 0x0aff) return true;
    if (first >= 0xac10 && first <= 0xac1f) return true;
    if (first === 0xc0a8) return true;
    if (first === 0xa9fe) return true;
    return false;
  }
  return false;
}
