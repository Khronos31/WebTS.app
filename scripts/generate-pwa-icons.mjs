import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import zlib from 'node:zlib';

const PUBLIC_DIR = resolve(import.meta.dirname, '..', 'public');
mkdirSync(PUBLIC_DIR, { recursive: true });

// --- 1. SVG Favicon ---
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00A0AD"/>
      <stop offset="50%" stop-color="#007F89"/>
      <stop offset="100%" stop-color="#005A61"/>
    </linearGradient>
    <linearGradient id="screen" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0A1417"/>
      <stop offset="100%" stop-color="#142429"/>
    </linearGradient>
    <linearGradient id="cyan-glow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38E1ED"/>
      <stop offset="100%" stop-color="#00B4C4"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>

  <!-- Background container -->
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>

  <!-- Antennas -->
  <g stroke="#FFFFFF" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">
    <line x1="256" y1="176" x2="200" y2="108"/>
    <line x1="256" y1="176" x2="312" y2="108"/>
  </g>
  <circle cx="200" cy="108" r="10" fill="#FFFFFF"/>
  <circle cx="312" cy="108" r="10" fill="#FFFFFF"/>

  <!-- TV Body -->
  <rect x="76" y="164" width="360" height="248" rx="36" fill="#FFFFFF" filter="url(#shadow)"/>

  <!-- TV Screen -->
  <rect x="96" y="184" width="320" height="208" rx="24" fill="url(#screen)"/>

  <!-- Centered Play Symbol -->
  <polygon points="234,248 234,328 302,288" fill="url(#cyan-glow)" stroke="url(#cyan-glow)" stroke-width="8" stroke-linejoin="round"/>

  <!-- TV Stand Feet -->
  <g stroke="#FFFFFF" stroke-width="16" stroke-linecap="round">
    <line x1="168" y1="412" x2="144" y2="444"/>
    <line x1="344" y1="412" x2="368" y2="444"/>
  </g>
</svg>
`;

writeFileSync(resolve(PUBLIC_DIR, 'favicon.svg'), svgContent, 'utf-8');
console.log('Created public/favicon.svg');

// --- 2. Pure Node PNG Generator ---

function encodePNG(width, height, rgbaBuffer) {
  const rowSize = width * 4;
  const scanlines = Buffer.alloc(height * (rowSize + 1));
  for (let y = 0; y < height; y++) {
    scanlines[y * (rowSize + 1)] = 0; // Filter: None
    rgbaBuffer.copy(scanlines, y * (rowSize + 1) + 1, y * rowSize, (y + 1) * rowSize);
  }
  const compressed = zlib.deflateSync(scanlines, { level: 9 });

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // Deflate
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // No interlace

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Distance helper functions for 2D SDF rendering
function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = bay_y(ay, by);
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.hypot(dx, dy);
}

function bay_y(ay, by) {
  return by - ay;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function pointInTriangle(px, py, x1, y1, x2, y2, x3, y3) {
  const d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3);
  const d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function renderIcon(size, isMaskable = false) {
  const buf = Buffer.alloc(size * size * 4);
  const supersample = 2; // 2x2 SSAA for crisp edges
  const subStep = 1 / supersample;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;

      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          // Normalize coordinates to 0..512 space
          const nx = ((x + (sx + 0.5) * subStep) / size) * 512;
          const ny = ((y + (sy + 0.5) * subStep) / size) * 512;

          let r = 0, g = 0, b = 0, a = 0;

          // Background
          const bgDist = isMaskable
            ? -10 // Full bleed for maskable
            : sdRoundedBox(nx - 256, ny - 256, 256, 256, 112);

          if (bgDist <= 0) {
            // Gradient: #00A0AD (0,160,173) to #005A61 (0,90,97)
            const t = (nx + ny) / 1024;
            r = Math.round(0 * (1 - t) + 0 * t);
            g = Math.round(160 * (1 - t) + 90 * t);
            b = Math.round(173 * (1 - t) + 97 * t);
            a = 255;
          }

          // Antenna Stand & Poles
          const antLeft = sdSegment(nx, ny, 256, 176, 200, 108);
          const antRight = sdSegment(nx, ny, 256, 176, 312, 108);
          const ballLeft = sdCircle(nx, ny, 200, 108, 10);
          const ballRight = sdCircle(nx, ny, 312, 108, 10);

          if (antLeft <= 8 || antRight <= 8 || ballLeft <= 0 || ballRight <= 0) {
            r = 255; g = 255; b = 255; a = 255;
          }

          // TV Stand Feet
          const legLeft = sdSegment(nx, ny, 168, 412, 144, 444);
          const legRight = sdSegment(nx, ny, 344, 412, 368, 444);
          if (legLeft <= 8 || legRight <= 8) {
            r = 255; g = 255; b = 255; a = 255;
          }

          // TV Outer Body (76, 164, width 360, height 248, rx 36)
          const tvBodyDist = sdRoundedBox(nx - 256, ny - 288, 180, 124, 36);
          if (tvBodyDist <= 0) {
            r = 255; g = 255; b = 255; a = 255;
          }

          // TV Screen (96, 184, width 320, height 208, rx 24)
          const tvScreenDist = sdRoundedBox(nx - 256, ny - 288, 160, 104, 24);
          if (tvScreenDist <= 0) {
            // Screen dark gradient: #0A1417 (10,20,23) to #142429 (20,36,41)
            const st = (nx - 96 + (ny - 184)) / 528;
            r = Math.round(10 * (1 - st) + 20 * st);
            g = Math.round(20 * (1 - st) + 36 * st);
            b = Math.round(23 * (1 - st) + 41 * st);
            a = 255;

            // Centered Play Triangle (234, 248) -> (234, 328) -> (302, 288) with rounded 4px stroke
            const inTri = pointInTriangle(nx, ny, 234, 248, 234, 328, 302, 288);
            const edge1 = sdSegment(nx, ny, 234, 248, 234, 328);
            const edge2 = sdSegment(nx, ny, 234, 248, 302, 288);
            const edge3 = sdSegment(nx, ny, 234, 328, 302, 288);

            if (inTri || edge1 <= 4 || edge2 <= 4 || edge3 <= 4) {
              // Cyan Glow: #38E1ED (56, 225, 237)
              r = 56; g = 225; b = 237; a = 255;
            }
          }

          rAcc += r; gAcc += g; bAcc += b; aAcc += a;
        }
      }

      const pixelIdx = (y * size + x) * 4;
      const samples = supersample * supersample;
      buf[pixelIdx + 0] = Math.round(rAcc / samples);
      buf[pixelIdx + 1] = Math.round(gAcc / samples);
      buf[pixelIdx + 2] = Math.round(bAcc / samples);
      buf[pixelIdx + 3] = Math.round(aAcc / samples);
    }
  }

  return encodePNG(size, size, buf);
}

// Generate Icons
console.log('Generating icon-512.png...');
const icon512 = renderIcon(512, false);
writeFileSync(resolve(PUBLIC_DIR, 'icon-512.png'), icon512);

console.log('Generating icon-maskable-512.png...');
const iconMaskable512 = renderIcon(512, true);
writeFileSync(resolve(PUBLIC_DIR, 'icon-maskable-512.png'), iconMaskable512);

console.log('Generating icon-192.png...');
const icon192 = renderIcon(192, false);
writeFileSync(resolve(PUBLIC_DIR, 'icon-192.png'), icon192);

console.log('Generating apple-touch-icon.png (180x180)...');
const appleTouchIcon = renderIcon(180, false);
writeFileSync(resolve(PUBLIC_DIR, 'apple-touch-icon.png'), appleTouchIcon);

console.log('Generating favicon-32x32.png...');
const favicon32 = renderIcon(32, false);
writeFileSync(resolve(PUBLIC_DIR, 'favicon-32x32.png'), favicon32);

// Generate favicon.ico (containing 32x32 PNG)
function makeIco(pngBuffer, width = 32, height = 32) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type 1: ICO
  header.writeUInt16LE(1, 4); // 1 image

  const dir = Buffer.alloc(16);
  dir[0] = width >= 256 ? 0 : width;
  dir[1] = height >= 256 ? 0 : height;
  dir[2] = 0; // Colors (0 = 256+ colors)
  dir[3] = 0; // Reserved
  dir.writeUInt16LE(1, 4); // Color planes
  dir.writeUInt16LE(32, 6); // Bits per pixel
  dir.writeUInt32LE(pngBuffer.length, 8); // Size of image data
  dir.writeUInt32LE(22, 12); // Offset of image data (6 + 16 = 22)

  return Buffer.concat([header, dir, pngBuffer]);
}

const faviconIco = makeIco(favicon32, 32, 32);
writeFileSync(resolve(PUBLIC_DIR, 'favicon.ico'), faviconIco);
console.log('Created public/favicon.ico');
console.log('All icons regenerated successfully!');
