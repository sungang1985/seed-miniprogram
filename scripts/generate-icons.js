// Tiny dependency-free rasterizer for the six native tab bar PNGs.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const size = 64
const scale = 4
const width = size * scale
const target = path.join(__dirname, '../miniprogram/assets/tabbar')
fs.mkdirSync(target, { recursive: true })

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([header, name, data, checksum])
}

function render(name, selected) {
  const coverage = new Uint8Array(width * width)
  const color = selected ? [7, 151, 103] : [138, 151, 145]
  function line(x1, y1, x2, y2, thickness = 3.2) {
    const dx = x2 - x1
    const dy = y2 - y1
    const lengthSquared = dx * dx + dy * dy
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const px = (x + 0.5) / scale
        const py = (y + 0.5) / scale
        const t = lengthSquared ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared)) : 0
        if (Math.hypot(px - x1 - t * dx, py - y1 - t * dy) <= thickness / 2) {
          coverage[y * width + x] = 255
        }
      }
    }
  }
  function polyline(points, thickness) {
    for (let i = 1; i < points.length; i += 1) {
      line(...points[i - 1], ...points[i], thickness)
    }
  }
  function circle(cx, cy, radius) {
    const points = []
    for (let i = 0; i <= 64; i += 1) {
      const angle = (i / 64) * Math.PI * 2
      points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
    }
    polyline(points)
  }
  if (name === 'home') {
    polyline([[11, 29], [32, 12], [53, 29]])
    polyline([[16, 28], [16, 51], [27, 51], [27, 37], [37, 37], [37, 51], [48, 51], [48, 28]])
  } else if (name === 'components') {
    for (const x of [13, 36]) {
      for (const y of [13, 36]) {
        polyline([[x, y], [x + 15, y], [x + 15, y + 15], [x, y + 15], [x, y]])
      }
    }
  } else {
    circle(32, 22, 9)
    const points = []
    for (let i = 0; i <= 32; i += 1) {
      const angle = Math.PI + (i / 32) * Math.PI
      points.push([32 + Math.cos(angle) * 19, 52 + Math.sin(angle) * 16])
    }
    polyline(points)
  }

  const pixels = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let opacity = 0
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          opacity += coverage[(y * scale + sy) * width + x * scale + sx]
        }
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4
      pixels.set([...color, Math.round(opacity / (scale * scale))], offset)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  fs.writeFileSync(path.join(target, `${name}${selected ? '-active' : ''}.png`), png)
}

for (const name of ['home', 'components', 'profile']) {
  render(name, false)
  render(name, true)
}
console.log('Generated 6 native tab bar icons.')
