const { nativeImage } = require('electron');

// Bitmap: `[████░░]` only — consumed % is shown via `tray.setTitle` on macOS (native text).
const SCALE = 2;
const CANVAS_H = 22;
const SEGMENTS = 6;
const SEG_W = 3;
const SEG_GAP = 1;
const SEG_H = 10;
const SEG_Y = 6;
const BAR_START_X = 4;
const RIGHT_BRACKET_W = 2;
const CANVAS_PAD_RIGHT = 1;

const BLACK = '#000000';
const TRACK = '#AEAEB2';
const IDLE = '#8E8E93';
const ICON_CACHE = new Map();

function hexToRgba(hex, alpha = 255) {
  const normalized = hex.replace('#', '');
  const n = parseInt(normalized, 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
    a: alpha,
  };
}

function makeBitmap(width, height) {
  const bytes = Buffer.alloc(width * height * 4, 0);
  function fillRect(x, y, w, h, c) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(width, Math.ceil(x + w));
    const y1 = Math.min(height, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * width + px) * 4;
        bytes[i] = c.r;
        bytes[i + 1] = c.g;
        bytes[i + 2] = c.b;
        bytes[i + 3] = c.a;
      }
    }
  }
  return { bytes, fillRect };
}

function renderBatteryBitmap(consumedPercent, status = 'active') {
  const isIdle = status === 'idle';
  const util = isIdle ? 0 : Math.max(0, Math.min(100, consumedPercent));
  const filled = Math.round((util / 100) * SEGMENTS);
  const color = hexToRgba(isIdle ? IDLE : BLACK);
  const trackRgba = hexToRgba(TRACK);

  const rightX = BAR_START_X + SEGMENTS * (SEG_W + SEG_GAP) - SEG_GAP + 1;
  const rightBracketRight = rightX + RIGHT_BRACKET_W;
  const canvasW = Math.ceil(rightBracketRight + CANVAS_PAD_RIGHT);

  const bitmap = makeBitmap(canvasW * SCALE, CANVAS_H * SCALE);

  bitmap.fillRect(0 * SCALE, 5 * SCALE, 2 * SCALE, 12 * SCALE, color);
  bitmap.fillRect(0 * SCALE, 5 * SCALE, 3 * SCALE, 2 * SCALE, color);
  bitmap.fillRect(0 * SCALE, 15 * SCALE, 3 * SCALE, 2 * SCALE, color);

  for (let i = 0; i < SEGMENTS; i++) {
    const x = BAR_START_X + i * (SEG_W + SEG_GAP);
    const fill = !isIdle && i < filled ? color : trackRgba;
    bitmap.fillRect(x * SCALE, SEG_Y * SCALE, SEG_W * SCALE, SEG_H * SCALE, fill);
  }

  bitmap.fillRect(rightX * SCALE, 5 * SCALE, 2 * SCALE, 12 * SCALE, color);
  bitmap.fillRect((rightX - 2) * SCALE, 5 * SCALE, 3 * SCALE, 2 * SCALE, color);
  bitmap.fillRect((rightX - 2) * SCALE, 15 * SCALE, 3 * SCALE, 2 * SCALE, color);

  return nativeImage.createFromBitmap(bitmap.bytes, {
    width: canvasW * SCALE,
    height: CANVAS_H * SCALE,
    scaleFactor: SCALE,
  });
}

function createBatteryIcon(consumedPercent, status = 'active') {
  const isIdle = status === 'idle';
  const util = isIdle ? 0 : Math.max(0, Math.min(100, consumedPercent));
  const filled = Math.round((util / 100) * SEGMENTS);
  const key = `${status}:${filled}`;
  const cached = ICON_CACHE.get(key);
  if (cached) return cached;
  const img = renderBatteryBitmap((filled / SEGMENTS) * 100, status);
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
