/**
 * Defensive image fetch helper used by mockup generation, AI enhancement,
 * and the clipart proxy.
 *
 * Hardening over a raw `fetch()`:
 *  - `redirect: 'manual'` — never follow redirects (closes SSRF via 302
 *    chains where the original URL passes a hostname allowlist but the
 *    redirect target points at an internal IP).
 *  - 15s abort timeout — protects against slowloris-style upstreams that
 *    would otherwise hold a worker indefinitely.
 *  - Content-Type must start with `image/` — refuses to buffer HTML/JS/etc.
 *  - 16 MB ceiling, checked both via Content-Length header and after the
 *    body read in case the upstream lied about the length.
 */

const MAX_FETCH_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export async function safeImageFetch(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Upstream redirected (status ${res.status}); refusing to follow`);
    }
    if (!res.ok) {
      throw new Error(`Upstream returned status ${res.status}`);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) {
      throw new Error(`Upstream content-type is not image/* (got ${ct || 'empty'})`);
    }
    const declared = parseInt(res.headers.get('content-length') || '0', 10);
    if (declared && declared > MAX_FETCH_BYTES) {
      throw new Error(`Upstream too large: ${declared} bytes (max ${MAX_FETCH_BYTES})`);
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_FETCH_BYTES) {
      throw new Error(`Upstream too large: ${ab.byteLength} bytes (max ${MAX_FETCH_BYTES})`);
    }
    return Buffer.from(ab);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Same as safeImageFetch but returns the content-type alongside the buffer
 * (useful when the caller needs to base64-encode with a data URI).
 */
export async function safeImageFetchWithContentType(
  url: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Upstream redirected (status ${res.status}); refusing to follow`);
    }
    if (!res.ok) {
      throw new Error(`Upstream returned status ${res.status}`);
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new Error(`Upstream content-type is not image/* (got ${contentType || 'empty'})`);
    }
    const declared = parseInt(res.headers.get('content-length') || '0', 10);
    if (declared && declared > MAX_FETCH_BYTES) {
      throw new Error(`Upstream too large: ${declared} bytes (max ${MAX_FETCH_BYTES})`);
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_FETCH_BYTES) {
      throw new Error(`Upstream too large: ${ab.byteLength} bytes (max ${MAX_FETCH_BYTES})`);
    }
    return { buffer: Buffer.from(ab), contentType };
  } finally {
    clearTimeout(timeout);
  }
}
