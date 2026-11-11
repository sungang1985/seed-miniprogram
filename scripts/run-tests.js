const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Run each node:test file directly to keep per-case TAP output on Node 20+.
// Separate processes isolate each file's mocked WeChat globals and modules.
const directory = path.join(__dirname, '../tests')
const files = fs.readdirSync(directory).filter((name) => name.endsWith('.test.js')).sort()
if (!files.length) {
  console.error('No test files found.')
  process.exit(1)
}
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(directory, file)], { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message)
    process.exit(result.status || 1)
  }
}
