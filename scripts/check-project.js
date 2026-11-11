const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const miniRoot = path.join(root, 'miniprogram')
const errors = []
let checked = 0

function assert(condition, message) {
  if (!condition) errors.push(message)
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    errors.push(`${path.relative(root, file)}: ${error.message}`)
    return {}
  }
}

function walk(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'miniprogram_npm', '.git'].includes(entry.name)) return []
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

const project = readJSON(path.join(root, 'project.config.json'))
assert(project.miniprogramRoot === 'miniprogram/', 'project.config.json: unexpected miniprogramRoot')
const cloudRoot = project.cloudfunctionRoot ? path.resolve(root, project.cloudfunctionRoot) : null
if (cloudRoot) assert(fs.existsSync(cloudRoot), 'Missing cloud function directory')
const app = readJSON(path.join(miniRoot, 'app.json'))
assert(Array.isArray(app.pages) && app.pages.length > 0, 'app.json: no pages declared')

for (const page of app.pages || []) {
  for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    assert(fs.existsSync(path.join(miniRoot, `${page}.${extension}`)), `Missing page file: ${page}.${extension}`)
  }
}

const tabs = app.tabBar?.list || []
assert(tabs.length >= 2 && tabs.length <= 5, 'tabBar must contain 2–5 entries')
for (const tab of tabs) {
  assert(app.pages?.includes(tab.pagePath), `Undeclared tab page: ${tab.pagePath}`)
  for (const key of ['iconPath', 'selectedIconPath']) {
    const file = path.join(miniRoot, tab[key] || '')
    const exists = fs.existsSync(file) && fs.statSync(file).isFile()
    assert(exists, `Missing tab icon: ${tab[key]}`)
    if (exists) {
      const content = fs.readFileSync(file)
      assert(content.length <= 40 * 1024, `Tab icon exceeds 40 KB: ${tab[key]}`)
      assert(content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Tab icon must be PNG: ${tab[key]}`)
    }
  }
}
assert(fs.existsSync(path.join(miniRoot, app.sitemapLocation || '')), 'Missing sitemap')

for (const file of [...walk(miniRoot), ...walk(path.join(root, 'scripts')), ...walk(path.join(root, 'tests')), ...(cloudRoot ? walk(cloudRoot) : [])]) {
  checked += 1
  if (file.endsWith('.json')) {
    const config = readJSON(file)
    for (const [name, component] of Object.entries(config.usingComponents || {})) {
      if (!component.startsWith('.') && !component.startsWith('/')) continue
      const base = component.startsWith('/') ? path.join(miniRoot, component) : path.resolve(path.dirname(file), component)
      for (const extension of ['js', 'json', 'wxml', 'wxss']) {
        assert(fs.existsSync(`${base}.${extension}`), `Missing component ${name}: ${path.relative(root, base)}.${extension}`)
      }
      if (fs.existsSync(`${base}.json`)) {
        assert(readJSON(`${base}.json`).component === true, `Component flag missing: ${base}.json`)
      }
    }
  }
  if (file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert(result.status === 0, `${path.relative(root, file)}: ${result.stderr || result.error || 'Syntax error'}`)
    const source = fs.readFileSync(file, 'utf8')
    for (const [, specifier] of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (!specifier.startsWith('.')) continue
      const modulePath = path.resolve(path.dirname(file), specifier)
      assert([modulePath, `${modulePath}.js`, `${modulePath}.json`, path.join(modulePath, 'index.js')].some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()), `Missing module ${specifier} in ${path.relative(root, file)}`)
    }
  }
  if (file.endsWith('.wxml')) {
    const source = fs.readFileSync(file, 'utf8')
    assert(!/<\/?(?:div|span|br|p|a|h[1-6]|ul|li|img|html|body)\b/i.test(source), `Unsupported HTML tag in WXML: ${path.relative(root, file)}`)
    const jsPath = file.replace(/\.wxml$/, '.js')
    const js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : ''
    for (const [, handler] of source.matchAll(/(?:bind|catch)(?::)?[\w-]+\s*=\s*["']([\w$]+)["']/g)) {
      assert(new RegExp(`\\b${handler}\\s*(?:\\(|:\\s*(?:function|\\(?))`).test(js), `Missing WXML handler ${handler} in ${path.relative(root, jsPath)}`)
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Project structure, JSON, JavaScript, local modules, tab icons and WXML event references passed (${checked} files).`)
}
