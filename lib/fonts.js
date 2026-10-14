/**
 * dsh-custom-fonts — installed-font catalog on the Host machine.
 *
 * Browsers can list local fonts only through the Local Font Access API, which
 * exists in Chromium alone and asks for a permission. The Host is a Node
 * process on the same machine as a loopback browser, so it can read the font
 * files directly: it lists them with the platform's own font registry when one
 * is reachable (CoreText on macOS, fontconfig on Linux) and falls back to the
 * standard font directories otherwise.
 *
 * Each file is described by ./font-tables.js (names in every language, CJK
 * coverage, fixed pitch). Descriptions are cached per file, keyed by path,
 * size, and modification time, in memory and in
 * `$DSH_HOME/cache/dsh-custom-fonts/fonts.json`, so only new or changed files
 * are read again.
 */

import { execFile } from 'node:child_process'
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, extname, join } from 'node:path'

import { mergeFamilies, readFontFaces } from './font-tables.js'

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc'])
const CACHE_VERSION = 1
const MAX_FILES = 20000
const MAX_DEPTH = 6
const READ_CONCURRENCY = 8
/** A catalog younger than this is answered without touching the disk. */
const FRESH_MS = 30 * 1000

function dshHome() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env : join(homedir(), '.dsh')
}

function cacheFile() {
  return join(dshHome(), 'cache', 'dsh-custom-fonts', 'fonts.json')
}

function run(command, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout))
    })
  })
}

/** Font file paths CoreText reports as available (includes activated and private system fonts). */
async function coreTextFiles() {
  const script = [
    'ObjC.import("CoreText");',
    'var u = ObjC.castRefToObject($.CTFontManagerCopyAvailableFontURLs());',
    'var out = [];',
    'for (var i = 0; i < u.count; i++) { var p = u.objectAtIndex(i).path; if (p) out.push(p.js) }',
    'JSON.stringify(out)',
  ].join(' ')
  const stdout = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script])
  if (stdout === null) return null
  try {
    const list = JSON.parse(stdout)
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : null
  } catch (error) {
    return null
  }
}

async function fontconfigFiles() {
  const stdout = await run('fc-list', ['--format', '%{file}\\n'])
  if (stdout === null) return null
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

function fontDirectories() {
  const home = homedir()
  switch (platform()) {
    case 'darwin':
      return [
        '/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts'),
        '/System/Library/PrivateFrameworks/FontServices.framework/Resources/Reserved',
      ]
    case 'win32': {
      const dirs = [join(process.env.WINDIR || 'C:\\Windows', 'Fonts')]
      if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'))
      return dirs
    }
    default:
      return [
        '/usr/share/fonts', '/usr/local/share/fonts',
        join(home, '.local', 'share', 'fonts'), join(home, '.fonts'),
      ]
  }
}

async function walk(dir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, depth + 1, out)
    else if (FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(path)
  }
}

/** Every font file path worth reading, without duplicates. */
async function listFontFiles() {
  const found = []
  if (platform() === 'darwin') {
    const files = await coreTextFiles()
    if (files !== null && files.length > 0) found.push(...files)
  } else if (platform() !== 'win32') {
    const files = await fontconfigFiles()
    if (files !== null && files.length > 0) found.push(...files)
  }
  if (found.length === 0) for (const dir of fontDirectories()) await walk(dir, 0, found)
  return [...new Set(found)].filter((path) => FONT_EXTENSIONS.has(extname(path).toLowerCase())).slice(0, MAX_FILES)
}

async function describeFile(path) {
  const handle = await open(path, 'r')
  try {
    const read = async (from, to) => {
      const length = Math.max(0, to - from)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, length, from)
      return new DataView(buffer.buffer, buffer.byteOffset, bytesRead)
    }
    return await readFontFaces(read)
  } finally {
    await handle.close()
  }
}

async function loadDiskCache() {
  try {
    const data = JSON.parse(await readFile(cacheFile(), 'utf8'))
    if (data && data.version === CACHE_VERSION && data.files && typeof data.files === 'object') return new Map(Object.entries(data.files))
  } catch (error) { /* first run or unreadable cache */ }
  return new Map()
}

async function saveDiskCache(files) {
  const target = cacheFile()
  try {
    await mkdir(dirname(target), { recursive: true })
    const temp = target + '.' + process.pid + '.tmp'
    await writeFile(temp, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(files) }))
    await rename(temp, target)
  } catch (error) { /* the cache is an optimisation only */ }
}

/**
 * Create a catalog. `list()` resolves to
 * { families: [{ name, aka, locals, scripts, mono, latin }], files, read, ms }.
 * Concurrent calls share one scan; a scan younger than FRESH_MS is reused.
 */
export function createFontCatalog(options = {}) {
  const listFiles = options.listFiles || listFontFiles
  const describe = options.describe || describeFile
  const persist = options.persist !== false
  let files = null // Map path -> { size, mtime, faces }
  let latest = null
  let latestAt = 0
  let pending = null

  async function scan() {
    const started = Date.now()
    if (files === null) files = persist ? await loadDiskCache() : new Map()
    const paths = await listFiles()
    const next = new Map()
    const queue = []
    await Promise.all(paths.map(async (path) => {
      let info
      try {
        info = await stat(path)
      } catch (error) {
        return
      }
      if (!info.isFile()) return
      const cached = files.get(path)
      if (cached && cached.size === info.size && cached.mtime === info.mtimeMs) next.set(path, cached)
      else queue.push({ path, size: info.size, mtime: info.mtimeMs })
    }))
    const read = queue.length
    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        let faces = []
        try {
          faces = await describe(item.path)
        } catch (error) { /* unreadable file: remembered as empty so it is not retried */ }
        next.set(item.path, { size: item.size, mtime: item.mtime, faces })
      }
    }
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker))
    const changed = read > 0 || next.size !== files.size
    files = next
    if (persist && changed) await saveDiskCache(files)
    const faces = []
    for (const entry of files.values()) faces.push(...entry.faces)
    return { families: mergeFamilies(faces), files: files.size, read, ms: Date.now() - started }
  }

  return {
    list() {
      if (latest !== null && Date.now() - latestAt < FRESH_MS) return Promise.resolve(latest)
      if (pending === null) {
        pending = scan().then((result) => {
          latest = result
          latestAt = Date.now()
          return result
        }).finally(() => { pending = null })
      }
      return pending
    },
  }
}
