/**
 * Generates the PWA icons from the same geometry as public/favicon.svg.
 *
 * The icon is a dark rounded square with three bars, which is simple enough to
 * rasterise directly — so this uses only Node built-ins rather than pulling in
 * a native image dependency (sharp, canvas) for four static files that change
 * approximately never.
 *
 * Run with: npm run icons
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const BACKGROUND = [15, 23, 42, 255] // #0f172a
const BARS = [
  { x: 14 / 64, y: 30 / 64, w: 8 / 64, h: 20 / 64, color: [56, 189, 248, 255] }, // #38bdf8
  { x: 28 / 64, y: 20 / 64, w: 8 / 64, h: 30 / 64, color: [52, 211, 153, 255] }, // #34d399
  { x: 42 / 64, y: 26 / 64, w: 8 / 64, h: 24 / 64, color: [251, 191, 36, 255] }, // #fbbf24
]
const CORNER_RADIUS = 14 / 64

/**
 * The bars sit on a baseline rather than centred, which reads as deliberate in
 * the rounded-square icon but looks like a mistake once the square is gone.
 * This is how far to lift them to centre the group vertically.
 */
const BAR_BOX_TOP = Math.min(...BARS.map((b) => b.y))
const BAR_BOX_BOTTOM = Math.max(...BARS.map((b) => b.y + b.h))
const CENTERING_LIFT = (BAR_BOX_TOP + BAR_BOX_BOTTOM) / 2 - 0.5

/**
 * @param size    pixel width/height
 * @param inset   fraction of the canvas to leave empty around the artwork.
 *                Maskable icons get a wide inset so Android's circular mask
 *                cannot clip the bars.
 * @param opaque  fill the full canvas rather than a rounded square. iOS applies
 *                its own mask and renders transparency as black.
 * @param center  lift the bars to sit centred, for variants with no visible
 *                square to sit inside.
 */
function render(size, { inset = 0, opaque = false, center = false } = {}) {
  const lift = center ? CENTERING_LIFT : 0
  const px = new Uint8Array(size * size * 4)
  const art = size * (1 - inset * 2)
  const offset = size * inset
  const radius = opaque ? 0 : art * CORNER_RADIUS

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      let color = null

      if (opaque) {
        color = BACKGROUND
      } else if (inRoundedRect(x + 0.5, y + 0.5, offset, offset, art, art, radius)) {
        color = BACKGROUND
      }

      if (color) {
        // Bars are positioned relative to the artwork box, not the canvas.
        const bx = (x + 0.5 - offset) / art
        const by = (y + 0.5 - offset) / art + lift
        for (const bar of BARS) {
          if (bx >= bar.x && bx < bar.x + bar.w && by >= bar.y && by < bar.y + bar.h) {
            color = bar.color
            break
          }
        }
      }

      if (color) {
        px[i] = color[0]
        px[i + 1] = color[1]
        px[i + 2] = color[2]
        px[i + 3] = color[3]
      }
    }
  }

  return px
}

function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false
  if (r <= 0) return true

  // Only the four corner boxes need a distance test.
  const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : null
  const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : null
  if (cx === null || cy === null) return true
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
}

/** Minimal PNG encoder: one IHDR, one deflated IDAT, one IEND. */
function encodePng(pixels, size) {
  // Each scanline is prefixed with a filter byte; 0 means "no filter".
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const targets = [
  { file: 'icon-192.png', size: 192, options: {} },
  { file: 'icon-512.png', size: 512, options: {} },
  // Android masks this to a circle or squircle; keep the art well inside.
  { file: 'icon-512-maskable.png', size: 512, options: { inset: 0.18, opaque: true, center: true } },
  // iOS ignores the manifest and applies its own rounding, so ship it square.
  { file: 'apple-touch-icon.png', size: 180, options: { inset: 0.1, opaque: true, center: true } },
]

mkdirSync(OUT, { recursive: true })
for (const { file, size, options } of targets) {
  const png = encodePng(render(size, options), size)
  writeFileSync(join(OUT, file), png)
  console.log(`${file.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`)
}
