const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

/**
 * Render the Stream Reviver product mark without relying on native image
 * libraries. Supersampling keeps the recovery arrow and play glyph clean at
 * toolbar sizes while preserving a reproducible build on every platform.
 */
export function createIconPng(size) {
  if (!Number.isInteger(size) || size < 16 || size > 512) {
    throw new TypeError(`Unsupported icon size: ${size}`);
  }

  const sampleGrid = size <= 32 ? 8 : size <= 48 ? 6 : 4;
  const samplesPerPixel = sampleGrid * sampleGrid;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const accumulated = [0, 0, 0, 0];
      for (let sampleY = 0; sampleY < sampleGrid; sampleY += 1) {
        for (let sampleX = 0; sampleX < sampleGrid; sampleX += 1) {
          const pointX = (x + (sampleX + 0.5) / sampleGrid) / size;
          const pointY = (y + (sampleY + 0.5) / sampleGrid) / size;
          const color = sampleMark(pointX, pointY);
          for (let channel = 0; channel < 4; channel += 1) accumulated[channel] += color[channel];
        }
      }

      const index = y * stride + 1 + x * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        raw[index + channel] = Math.round(accumulated[channel] / samplesPerPixel);
      }
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", Buffer.concat([uint32(size), uint32(size), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", storedZlib(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// RFC 1950/1951 stored blocks avoid platform-specific native zlib output.
// Icon pixels stay unchanged; release ZIP/signing can compress these bytes.
function storedZlib(raw) {
  const blocks = [Buffer.from([0x78, 0x01])];
  for (let offset = 0; offset < raw.length; offset += 65535) {
    const length = Math.min(65535, raw.length - offset);
    const header = Buffer.alloc(5);
    header[0] = offset + length === raw.length ? 1 : 0;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE(length ^ 0xffff, 3);
    blocks.push(header, raw.subarray(offset, offset + length));
  }
  let a = 1, b = 0;
  for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  blocks.push(uint32((b << 16) | a));
  return Buffer.concat(blocks);
}

function sampleMark(x, y) {
  let color = [0, 0, 0, 0];
  const tileDistance = roundedRectangleDistance(x, y, 0.04, 0.04, 0.96, 0.96, 0.225);

  if (tileDistance <= 0) {
    const diagonal = smoothstep(0.02, 1.7, x * 0.72 + y * 0.98);
    const top = [20, 143, 255, 255];
    const bottom = [116, 54, 226, 255];
    color = mix(top, bottom, diagonal);

    // A cool highlight gives the mark depth without introducing details that
    // disappear when Firefox renders the 16 px toolbar asset.
    const highlight = 0.22 * (1 - smoothstep(0.02, 0.62, Math.hypot(x - 0.22, y - 0.13)));
    color = mix(color, [89, 235, 255, 255], highlight);

    const lowerShade = 0.18 * smoothstep(0.42, 1.0, y + x * 0.16);
    color = mix(color, [35, 21, 95, 255], lowerShade);

    const edge = smoothstep(-0.042, -0.004, tileDistance);
    color = mix(color, [13, 20, 54, 255], edge * 0.46);

    // Quiet glass highlight along the upper-left rim.
    if (tileDistance > -0.032 && x + y < 1.04) {
      color = blend(color, [255, 255, 255, 31]);
    }
  }

  // Recovery loop shadow and high-contrast mint loop.
  if (onRecoveryArc(x, y, 0.094)) color = blend(color, [8, 14, 38, 80]);
  if (onRecoveryArc(x, y, 0.068)) color = blend(color, [104, 245, 216, 255]);

  const arrow = recoveryArrowTriangle();
  if (insideTriangle(x + 0.012, y + 0.014, ...arrow)) color = blend(color, [7, 17, 42, 74]);
  if (insideTriangle(x, y, ...arrow)) color = blend(color, [104, 245, 216, 255]);

  // The familiar playback affordance remains the primary silhouette.
  const play = [[0.405, 0.337], [0.405, 0.663], [0.687, 0.5]];
  if (insideTriangle(x + 0.012, y + 0.018, ...play)) color = blend(color, [9, 15, 39, 88]);
  if (insideTriangle(x, y, ...play)) color = blend(color, [255, 255, 255, 255]);

  return color;
}

function onRecoveryArc(x, y, thickness) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const radius = Math.hypot(dx, dy);
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle < 0) angle += 360;
  return Math.abs(radius - 0.322) <= thickness / 2 && angle >= 52 && angle <= 318;
}

function recoveryArrowTriangle() {
  const angle = 318 * Math.PI / 180;
  const radius = 0.322;
  const anchor = [0.5 + Math.cos(angle) * radius, 0.5 + Math.sin(angle) * radius];
  const tangent = [-Math.sin(angle), Math.cos(angle)];
  const normal = [-tangent[1], tangent[0]];
  const tip = [anchor[0] + tangent[0] * 0.105, anchor[1] + tangent[1] * 0.105];
  const base = [anchor[0] - tangent[0] * 0.025, anchor[1] - tangent[1] * 0.025];
  return [
    tip,
    [base[0] + normal[0] * 0.082, base[1] + normal[1] * 0.082],
    [base[0] - normal[0] * 0.082, base[1] - normal[1] * 0.082]
  ];
}

function roundedRectangleDistance(x, y, left, top, right, bottom, radius) {
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const halfWidth = (right - left) / 2;
  const halfHeight = (bottom - top) / 2;
  const qx = Math.abs(x - centerX) - (halfWidth - radius);
  const qy = Math.abs(y - centerY) - (halfHeight - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function insideTriangle(x, y, first, second, third) {
  const d1 = triangleSign(x, y, first, second);
  const d2 = triangleSign(x, y, second, third);
  const d3 = triangleSign(x, y, third, first);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function triangleSign(x, y, first, second) {
  return (x - second[0]) * (first[1] - second[1]) - (first[0] - second[0]) * (y - second[1]);
}

function blend(bottom, top) {
  const topAlpha = top[3] / 255;
  const bottomAlpha = bottom[3] / 255;
  const outputAlpha = topAlpha + bottomAlpha * (1 - topAlpha);
  if (outputAlpha === 0) return [0, 0, 0, 0];
  return [
    Math.round((top[0] * topAlpha + bottom[0] * bottomAlpha * (1 - topAlpha)) / outputAlpha),
    Math.round((top[1] * topAlpha + bottom[1] * bottomAlpha * (1 - topAlpha)) / outputAlpha),
    Math.round((top[2] * topAlpha + bottom[2] * bottomAlpha * (1 - topAlpha)) / outputAlpha),
    Math.round(outputAlpha * 255)
  ];
}

function mix(first, second, amount) {
  const t = clamp(amount, 0, 1);
  return first.map((value, index) => Math.round(value + (second[index] - value) * t));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  return Buffer.concat([uint32(data.length), name, data, uint32(crc32(Buffer.concat([name, data])))]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
