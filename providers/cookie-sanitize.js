/** DevTools cookie rows often include Domain/expires/Path — strip those from a Cookie header value. */

const COOKIE_ATTR_NAMES = new Set([
  'domain',
  'expires',
  'max-age',
  'path',
  'samesite',
  'partitionkey',
  'priority',
]);

function isDevToolsCookieNoise(part) {
  const p = part.trim();
  if (!p) return true;
  const low = p.toLowerCase();
  if (low === 'httponly' || low === 'secure') return true;
  const eq = p.indexOf('=');
  if (eq === -1) return low === 'httponly' || low === 'secure';
  const name = p.slice(0, eq).trim().toLowerCase();
  return COOKIE_ATTR_NAMES.has(name);
}

/**
 * Claude: raw token → sessionKey=…; full Cookie header → sanitize parts.
 */
function buildClaudeCookieHeader(stored) {
  let s = stored.trim();
  if (/^cookie\s*:/i.test(s)) {
    s = s.replace(/^cookie\s*:\s*/i, '').trim();
  }
  if (!s.includes(';') && !/^sessionKey=/i.test(s)) {
    return `sessionKey=${s}`;
  }
  const parts = s.split(';').map((x) => x.trim()).filter((p) => p && !isDevToolsCookieNoise(p));
  if (parts.length === 0) {
    const m = s.match(/sessionKey\s*=\s*([^;]+)/i);
    if (m) return `sessionKey=${m[1].trim()}`;
    return s;
  }
  return parts.join('; ');
}

/**
 * Cursor (and similar): full Cookie line; strip DevTools noise.
 * If the user pastes a bare token (no =), treat as WorkosCursorSessionToken value.
 */
function buildCursorCookieHeader(stored) {
  let s = stored.trim();
  if (/^cookie\s*:/i.test(s)) {
    s = s.replace(/^cookie\s*:\s*/i, '').trim();
  }
  if (!s.includes('=')) {
    return `WorkosCursorSessionToken=${s}`;
  }
  const parts = s.split(';').map((x) => x.trim()).filter((p) => p && !isDevToolsCookieNoise(p));
  if (parts.length === 0) {
    const m = s.match(/WorkosCursorSessionToken\s*=\s*([^;]+)/i);
    if (m) return `WorkosCursorSessionToken=${m[1].trim()}`;
    return s;
  }
  return parts.join('; ');
}

module.exports = { buildClaudeCookieHeader, buildCursorCookieHeader, isDevToolsCookieNoise };
