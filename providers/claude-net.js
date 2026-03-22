/**
 * HTTP GET via Electron's net module (Chromium network stack).
 * Same cookies/URL often work in the browser but fail with Node/axios due to TLS fingerprinting.
 */
const { app, net } = require('electron');

function canUseElectronNet() {
  try {
    return app && typeof app.isReady === 'function' && app.isReady();
  } catch {
    return false;
  }
}

function normalizeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

/**
 * @returns {Promise<{ data: unknown, status: number, statusText: string }>}
 */
function netGet(url, headers, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url,
      headers: normalizeHeaders(headers),
    });

    const timer = setTimeout(() => {
      req.abort();
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);

    const chunks = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        const status = res.statusCode || 0;
        const statusText = res.statusMessage || '';
        if (status >= 200 && status < 300) {
          resolve({ data, status, statusText });
        } else {
          const err = new Error(`Request failed with status code ${status}`);
          err.response = { status, statusText, data };
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.end();
  });
}

module.exports = { canUseElectronNet, netGet };
