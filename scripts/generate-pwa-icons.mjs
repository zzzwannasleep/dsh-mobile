/**
 * Dev-only generator for the committed PWA icons under `assets/pwa/`.
 *
 * Run it by hand after the brand artwork changes:
 *
 *     node scripts/generate-pwa-icons.mjs
 *
 * It is deliberately absent from `npm run build`: a normal build must not need a
 * browser, and the committed PNGs are what ships. Chromium (the Playwright dev
 * dependency) rasterizes `assets/brand/app-icon-rounded.svg`; this module then
 * quantizes the pixels to a palette and writes indexed PNGs, which keeps every
 * icon comfortably under the 200 KB budget the manifest promises.
 *
 * The output is deterministic. The artwork holds no text, animation or external
 * reference, so Chromium's rasterization depends only on the committed SVG, and
 * the palette comes from a stable median cut over the pixels (ties resolve by
 * histogram order) rather than from random sampling.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const SOURCE = new URL('../assets/brand/app-icon-rounded.svg', import.meta.url)
const OUTPUT = new URL('../assets/pwa/', import.meta.url)

/**
 * The maskable variant keeps its artwork inside the middle 80% circle, so a
 * launcher mask that crops to that safe area never clips the subject. The plate
 * behind it matches the artwork's own near-white background.
 */
const MASKABLE_SAFE_FRACTION = 0.8
const MASKABLE_PLATE = '#FFFFFF'

/** Colours per icon; one entry is reserved when the artwork needs transparency. */
const PALETTE_COLORS = 256

/** Icons the manifest references; the names match `PWA_ICONS` in `src/pwa.ts`. */
const ICONS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
]

/** Largest icon the manifest may reference; the test enforces the same limit. */
const MAXIMUM_ICON_BYTES = 200 * 1024

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}

/** Standard PNG CRC-32 over one chunk type plus its data. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** One length/type/data/CRC PNG chunk. */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Rasterize the brand SVG on a fresh canvas at exactly `size` square pixels. */
async function rasterize(page, svg, { size, maskable }) {
  return page.evaluate(async ({ svgBase64, size, maskable, safeFraction, plate }) => {
    const image = new Image()
    image.src = `data:image/svg+xml;base64,${svgBase64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (maskable) {
      // A maskable icon must fill its square: paint the plate, then inset the
      // artwork so all of it stays inside the middle safe circle.
      context.fillStyle = plate
      context.fillRect(0, 0, size, size)
      const inset = Math.round(size * safeFraction)
      context.drawImage(image, (size - inset) / 2, (size - inset) / 2, inset, inset)
    } else {
      context.drawImage(image, 0, 0, size, size)
    }
    const pixels = context.getImageData(0, 0, size, size).data
    let binary = ''
    for (let offset = 0; offset < pixels.length; offset += 8192) {
      binary += String.fromCharCode(...pixels.subarray(offset, offset + 8192))
    }
    return btoa(binary)
  }, {
    svgBase64: svg.toString('base64'),
    size,
    maskable,
    safeFraction: MASKABLE_SAFE_FRACTION,
    plate: MASKABLE_PLATE,
  })
}

/** The RGBA channel with the widest spread, or `undefined` for a flat bucket. */
function widestChannel(bucket) {
  let widest
  for (const name of ['r', 'g', 'b', 'a']) {
    let minimum = 255
    let maximum = 0
    for (const entry of bucket) {
      if (entry[name] < minimum) minimum = entry[name]
      if (entry[name] > maximum) maximum = entry[name]
    }
    const range = maximum - minimum
    if (range > 0 && (widest === undefined || range > widest.range)) widest = { name, range }
  }
  return widest
}

/** Frequency-weighted mean RGBA of one bucket. */
function representative(bucket) {
  let red = 0
  let green = 0
  let blue = 0
  let alpha = 0
  let weight = 0
  for (const entry of bucket) {
    red += entry.r * entry.count
    green += entry.g * entry.count
    blue += entry.b * entry.count
    alpha += entry.a * entry.count
    weight += entry.count
  }
  return [Math.round(red / weight), Math.round(green / weight), Math.round(blue / weight), Math.round(alpha / weight)]
}

/**
 * Stable median cut over the RGBA histogram.
 *
 * Fully transparent pixels are excluded and answered by a reserved transparent
 * entry, because their colour channels carry no information and would otherwise
 * occupy a whole bucket.
 */
function buildPalette(pixels, maximumColors) {
  const histogram = new Map()
  let transparent = false
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) {
      transparent = true
      continue
    }
    const key = ((pixels[offset] << 24) | (pixels[offset + 1] << 16) | (pixels[offset + 2] << 8) | pixels[offset + 3]) >>> 0
    const entry = histogram.get(key)
    if (entry === undefined) {
      histogram.set(key, { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2], a: pixels[offset + 3], count: 1 })
    } else {
      entry.count += 1
    }
  }
  const target = transparent ? maximumColors - 1 : maximumColors
  let buckets = [Array.from(histogram.values())]
  while (buckets.length < target) {
    let chosen
    for (const [index, bucket] of buckets.entries()) {
      if (bucket.length < 2) continue
      const channel = widestChannel(bucket)
      if (channel === undefined) continue
      if (chosen === undefined || channel.range > chosen.channel.range) chosen = { index, channel }
    }
    if (chosen === undefined) break
    const bucket = buckets[chosen.index]
    const sorted = [...bucket].sort((left, right) => left[chosen.channel.name] - right[chosen.channel.name] || left.count - right.count)
    let weight = 0
    for (const entry of sorted) weight += entry.count
    let accumulated = 0
    let split = 1
    for (let index = 0; index < sorted.length - 1; index += 1) {
      accumulated += sorted[index].count
      if (accumulated * 2 >= weight) {
        split = index + 1
        break
      }
    }
    buckets = [...buckets.slice(0, chosen.index), sorted.slice(0, split), sorted.slice(split), ...buckets.slice(chosen.index + 1)]
  }
  const palette = buckets.filter(bucket => bucket.length > 0).map(representative)
  return transparent ? [[0, 0, 0, 0], ...palette] : palette
}

/** Map every pixel onto its nearest palette entry, favouring matching alpha. */
function quantize(pixels, palette) {
  const transparentIndex = palette[0][3] === 0 && palette[0][0] === 0 && palette[0][1] === 0 && palette[0][2] === 0 ? 0 : undefined
  const indices = new Uint8Array(pixels.length / 4)
  const cache = new Map()
  for (let offset = 0, index = 0; offset < pixels.length; offset += 4, index += 1) {
    const key = ((pixels[offset] << 24) | (pixels[offset + 1] << 16) | (pixels[offset + 2] << 8) | pixels[offset + 3]) >>> 0
    let entry = cache.get(key)
    if (entry === undefined) {
      if (pixels[offset + 3] === 0 && transparentIndex !== undefined) {
        entry = transparentIndex
      } else {
        let best = transparentIndex === 0 ? 1 : 0
        let bestDistance = Infinity
        for (let candidate = transparentIndex === 0 ? 1 : 0; candidate < palette.length; candidate += 1) {
          const dr = pixels[offset] - palette[candidate][0]
          const dg = pixels[offset + 1] - palette[candidate][1]
          const db = pixels[offset + 2] - palette[candidate][2]
          const da = pixels[offset + 3] - palette[candidate][3]
          const distance = dr * dr + dg * dg + db * db + 4 * da * da
          if (distance < bestDistance) {
            bestDistance = distance
            best = candidate
          }
        }
        entry = best
      }
      cache.set(key, entry)
    }
    indices[index] = entry
  }
  return indices
}

/** Encode one 8-bit indexed PNG with no interlace and filter 0 rows. */
function encodeIndexedPng({ size, indices, palette }) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 3
  const plte = Buffer.alloc(palette.length * 3)
  for (const [index, entry] of palette.entries()) {
    plte[index * 3] = entry[0]
    plte[index * 3 + 1] = entry[1]
    plte[index * 3 + 2] = entry[2]
  }
  const alpha = Buffer.from(palette.map(entry => entry[3]))
  let lastOpaque = alpha.length - 1
  while (lastOpaque >= 0 && alpha[lastOpaque] === 255) lastOpaque -= 1
  const rows = Buffer.alloc((size + 1) * size)
  for (let row = 0; row < size; row += 1) {
    // Filter 0 (None): palette indices are symbols, not colour samples.
    Buffer.from(indices.subarray(row * size, (row + 1) * size)).copy(rows, row * (size + 1) + 1)
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('PLTE', plte),
    ...(lastOpaque < 0 ? [] : [chunk('tRNS', alpha.subarray(0, lastOpaque + 1))]),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const svg = await readFile(SOURCE)
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await mkdir(OUTPUT, { recursive: true })
  for (const icon of ICONS) {
    const base64 = await rasterize(page, svg, icon)
    const pixels = new Uint8Array(Buffer.from(base64, 'base64'))
    const palette = buildPalette(pixels, PALETTE_COLORS)
    const png = encodeIndexedPng({ size: icon.size, indices: quantize(pixels, palette), palette })
    if (png.length > MAXIMUM_ICON_BYTES) {
      throw new Error(`${icon.file} is ${png.length} bytes, above the ${MAXIMUM_ICON_BYTES}-byte manifest budget`)
    }
    await writeFile(new URL(icon.file, OUTPUT), png)
    console.log(`${icon.file}: ${icon.size}x${icon.size} ${icon.maskable ? 'maskable' : 'any'} ${png.length} bytes, ${palette.length} colours`)
  }
} finally {
  await browser.close()
}
