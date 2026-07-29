const { nativeImage } = require('electron');

// Monochrome capacity ring with % digits inside — frees menubar title space.
// Black+alpha template image so macOS tints it for light/dark.
const SCALE = 2;
const CANVAS_W = 22;
const CANVAS_H = 22;

const CX = CANVAS_W / 2;
const CY = CANVAS_H / 2;
const RADIUS = 9.15;
const STROKE = 2.05;

// Compact 3×5 digit glyphs (rows of on/off bits).
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '010', '010', '010', '010'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

const ICON_CACHE = new Map();

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function coverage(dist) {
  return clamp01(0.5 - dist * SCALE);
}

/** 0 at 12 o'clock, clockwise positive. */
function sweepAngle(lx, ly) {
  let a = Math.atan2(lx - CX, CY - ly);
  if (a < 0) a += Math.PI * 2;
  return a;
}

function makeBitmap(width, height) {
  const bytes = Buffer.alloc(width * height * 4, 0);

  function stamp(px, py, alpha) {
    if (alpha <= 0) return;
    const x = Math.floor(px);
    const y = Math.floor(py);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    const a = Math.round(Math.min(255, Math.max(bytes[i + 3], alpha * 255)));
    bytes[i] = 0;
    bytes[i + 1] = 0;
    bytes[i + 2] = 0;
    bytes[i + 3] = a;
  }

  /** Soft filled circle in logical coords. */
  function fillCircle(lx, ly, r, alpha) {
    const pad = 1.25 / SCALE;
    const x0 = Math.floor((lx - r - pad) * SCALE);
    const y0 = Math.floor((ly - r - pad) * SCALE);
    const x1 = Math.ceil((lx + r + pad) * SCALE);
    const y1 = Math.ceil((ly + r + pad) * SCALE);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const dx = (px + 0.5) / SCALE - lx;
        const dy = (py + 0.5) / SCALE - ly;
        const a = coverage(Math.sqrt(dx * dx + dy * dy) - r) * alpha;
        if (a > 0) stamp(px, py, a);
      }
    }
  }

  return { bytes, stamp, fillCircle };
}

function paintRing(bitmap, util, trackA, fillA) {
  const half = STROKE / 2;
  const pad = STROKE + 1.5 / SCALE;
  const x0 = Math.floor((CX - RADIUS - pad) * SCALE);
  const y0 = Math.floor((CY - RADIUS - pad) * SCALE);
  const x1 = Math.ceil((CX + RADIUS + pad) * SCALE);
  const y1 = Math.ceil((CY + RADIUS + pad) * SCALE);
  const fillSweep = (Math.max(0, Math.min(100, util)) / 100) * Math.PI * 2;

  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const lx = (px + 0.5) / SCALE;
      const ly = (py + 0.5) / SCALE;
      const dx = lx - CX;
      const dy = ly - CY;
      const dist = Math.abs(Math.sqrt(dx * dx + dy * dy) - RADIUS) - half;
      const edge = coverage(dist);
      if (edge <= 0) continue;

      let a = trackA;
      if (fillA > 0 && fillSweep > 0) {
        const ang = sweepAngle(lx, ly);
        const tip = clamp01((fillSweep - ang) * RADIUS * 1.4 + 0.5);
        a = Math.max(a, fillA * tip);
      }
      bitmap.stamp(px, py, edge * a);
    }
  }
}

function paintDigits(bitmap, text, alpha) {
  const n = text.length;
  // Slightly tighter for "100".
  const cell = n >= 3 ? 1.15 : 1.45;
  const gap = n >= 3 ? 0.55 : 0.7;
  const glyphW = 3 * cell;
  const glyphH = 5 * cell;
  const totalW = n * glyphW + (n - 1) * gap;
  let x = CX - totalW / 2;
  const y = CY - glyphH / 2 + 0.15;
  const dotR = cell * 0.42;

  for (const ch of text) {
    const rows = GLYPHS[ch];
    if (!rows) continue;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (rows[row][col] !== '1') continue;
        bitmap.fillCircle(
          x + (col + 0.5) * cell,
          y + (row + 0.5) * cell,
          dotR,
          alpha
        );
      }
    }
    x += glyphW + gap;
  }
}

function renderBatteryBitmap(consumedPercent, status = 'active') {
  const isIdle = status === 'idle';
  const util = isIdle ? 0 : Math.max(0, Math.min(100, consumedPercent));
  const bitmap = makeBitmap(CANVAS_W * SCALE, CANVAS_H * SCALE);

  paintRing(bitmap, util, isIdle ? 0.28 : 0.2, isIdle ? 0 : 0.95);
  if (!isIdle) {
    paintDigits(bitmap, String(Math.round(util)), 0.92);
  }

  const img = nativeImage.createFromBitmap(bitmap.bytes, {
    width: CANVAS_W * SCALE,
    height: CANVAS_H * SCALE,
    scaleFactor: SCALE,
  });
  if (typeof img.setTemplateImage === 'function') {
    img.setTemplateImage(true);
  }
  return img;
}

function createBatteryIcon(consumedPercent, status = 'active') {
  const isIdle = status === 'idle';
  const util = isIdle ? 0 : Math.max(0, Math.min(100, consumedPercent));
  const bucket = Math.round(util);
  const key = `${isIdle ? 'idle' : status}:${bucket}`;
  const cached = ICON_CACHE.get(key);
  if (cached) return cached;
  const img = renderBatteryBitmap(bucket, isIdle ? 'idle' : status);
  ICON_CACHE.set(key, img);
  return img;
}

function usageLabelForService(serviceData) {
  if (!serviceData || serviceData.error) return '';
  const util =
    serviceData.gaugeUtilization ??
    serviceData.fiveHour?.utilization ??
    serviceData.utilization ??
    0;
  return `${Math.round(Math.max(0, Math.min(100, util)))}%`;
}

function iconFromServiceData(serviceData) {
  if (!serviceData || serviceData.error) {
    return createBatteryIcon(0, 'idle');
  }
  const util = Math.max(
    0,
    Math.min(
      100,
      serviceData.gaugeUtilization ??
        serviceData.fiveHour?.utilization ??
        serviceData.utilization ??
        0
    )
  );
  const status = util > 75 ? 'critical' : util > 50 ? 'warning' : 'active';
  return createBatteryIcon(util, status);
}

function describeNativeImage(img) {
  if (!img) return { present: false };
  try {
    const size = img.getSize();
    return {
      present: true,
      isEmpty: img.isEmpty(),
      width: size.width,
      height: size.height,
      isTemplate: typeof img.isTemplateImage === 'function' ? img.isTemplateImage() : undefined,
    };
  } catch (e) {
    return { present: true, error: String(e) };
  }
}

module.exports = {
  createBatteryIcon,
  iconFromServiceData,
  describeNativeImage,
  usageLabelForService,
};
