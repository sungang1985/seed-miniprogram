// Static invitation artwork: never capture a screenshot of a location map.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const width = 500
const height = 400
const pixels = Buffer.alloc((width * 4 + 1) * height)
function pixel(x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const offset = y * (width * 4 + 1) + 1 + x * 4
  pixels.set([...color, 255], offset)
}
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const inside = x >= 24 && x < 476 && y >= 24 && y < 376
    pixel(x, y, inside ? [248, 252, 249] : [220, 239, 227])
  }
}
function line(x1, y1, x2, y2, thickness, color) {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = dx * dx + dy * dy
  for (let y = Math.max(0, Math.floor(Math.min(y1, y2) - thickness)); y < Math.min(height, Math.max(y1, y2) + thickness); y += 1) {
    for (let x = Math.max(0, Math.floor(Math.min(x1, x2) - thickness)); x < Math.min(width, Math.max(x1, x2) + thickness); x += 1) {
      const t = length ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length)) : 0
      if (Math.hypot(x - x1 - t * dx, y - y1 - t * dy) <= thickness / 2) pixel(x, y, color)
    }
  }
}
const green = [7, 151, 103]
const soft = [164, 207, 180]
for (const cx of [158, 342]) {
  for (let i = 0; i < 64; i += 1) {
    const a = i * Math.PI * 2 / 64
    const b = (i + 1) * Math.PI * 2 / 64
    line(cx + 27 * Math.cos(a), 147 + 27 * Math.sin(a), cx + 27 * Math.cos(b), 147 + 27 * Math.sin(b), 5, green)
  }
  for (let i = 0; i < 32; i += 1) {
    const a = Math.PI + i * Math.PI / 32
    const b = Math.PI + (i + 1) * Math.PI / 32
    line(cx + 48 * Math.cos(a), 224 + 35 * Math.sin(a), cx + 48 * Math.cos(b), 224 + 35 * Math.sin(b), 5, green)
  }
}
for (let x = 211; x < 286; x += 16) line(x, 164, x + 7, 164, 4, soft)
const font = {
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001']
}
const label = 'LIVE LOCATION'
const startX = (width - (label.length * 18 - 3)) / 2
Array.from(label).forEach((letter, index) => {
  ;(font[letter] || []).forEach((row, y) => Array.from(row).forEach((value, x) => {
    if (value !== '1') return
    for (let dy = 0; dy < 3; dy += 1) for (let dx = 0; dx < 3; dx += 1) pixel(Math.round(startX + index * 18 + x * 3 + dx), 287 + y * 3 + dy, green)
  }))
})
function crc32(data) {
  let value = 0xffffffff
  for (const byte of data) {
    value ^= byte
    for (let i = 0; i < 8; i += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  }
  return (value ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, crc])
}
const header = Buffer.alloc(13)
header.writeUInt32BE(width, 0)
header.writeUInt32BE(height, 4)
header[8] = 8
header[9] = 6
const directory = path.join(__dirname, '../miniprogram/assets/share')
fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(directory, 'location-invite.png'), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))
]))
console.log('Generated static location invitation cover (500 × 400).')
