/**
 * dsh-custom-fonts — OpenType table reader shared by both halves.
 *
 * The host half imports this module to describe the fonts installed on the
 * Host machine. The browser half cannot import modules, so client/client.js
 * carries a verbatim copy of the block between the BEGIN/END markers below;
 * scripts/verify.mjs fails when the two copies drift apart.
 *
 * The block is plain functions with no imports and no environment access. It
 * reads only the table directory and the `name`, `OS/2`, and `post` tables
 * (a few KB), through a caller-supplied `read(from, to)` that returns a
 * DataView, so the same code works on a Node file handle and on a Blob.
 */

// BEGIN font-tables (client/client.js carries a verbatim copy)

/** Mac `name` record encodings this reader can decode (encodingID -> TextDecoder label). */
const MAC_NAME_ENCODINGS = { 0: 'macintosh', 1: 'shift_jis', 2: 'big5', 3: 'euc-kr', 25: 'gbk' }

/**
 * CJK coverage from the OS/2 table. `ulCodePageRange1` bits: 17 Japanese,
 * 18 Simplified Chinese, 19 Korean Wansung, 20 Traditional Chinese, 21 Korean
 * Johab. `ulUnicodeRange2` (bits 32..63): 49 Hiragana, 50 Katakana,
 * 56 Hangul syllables, 59 CJK unified ideographs.
 */
function cjkScripts(range2, codePages1) {
  const out = []
  if ((codePages1 & (1 << 17)) || (range2 & (1 << 17)) || (range2 & (1 << 18))) out.push('ja')
  if (codePages1 & (1 << 18)) out.push('zh-Hans')
  if (codePages1 & (1 << 20)) out.push('zh-Hant')
  if ((codePages1 & (1 << 19)) || (codePages1 & (1 << 21)) || (range2 & (1 << 24))) out.push('ko')
  if (out.length === 0 && (range2 & (1 << 27))) out.push('han')
  return out
}

function decodeNameString(view, off, len, platform, encoding) {
  if (platform === 0 || platform === 3) {
    let text = ''
    for (let j = 0; j + 1 < len; j += 2) text += String.fromCharCode(view.getUint16(off + j))
    return text
  }
  const label = MAC_NAME_ENCODINGS[encoding]
  if (label === undefined || typeof TextDecoder !== 'function') return ''
  try {
    return new TextDecoder(label).decode(new Uint8Array(view.buffer, view.byteOffset + off, len))
  } catch (error) {
    return ''
  }
}

/**
 * Family names from a `name` table: nameID 16 (typographic family) wins over
 * nameID 1 within each language, so weight-specific names such as
 * "Hiragino Sans W3" collapse into their family. English names come from
 * Windows records with a 0x?09 language and Mac records with language 0.
 */
function readFamilyNames(nt) {
  const count = nt.getUint16(2)
  const strings = nt.getUint16(4)
  const byLang = new Map()
  for (let r = 0; r < count && 6 + 12 * r + 12 <= nt.byteLength; r++) {
    const rec = 6 + 12 * r
    const platform = nt.getUint16(rec), encoding = nt.getUint16(rec + 2)
    const lang = nt.getUint16(rec + 4), id = nt.getUint16(rec + 6)
    const len = nt.getUint16(rec + 8), off = strings + nt.getUint16(rec + 10)
    if ((id !== 1 && id !== 16) || off + len > nt.byteLength) continue
    if (platform !== 1 && platform !== 3) continue
    const text = decodeNameString(nt, off, len, platform, encoding).replace(/\0/g, '').trim()
    if (text === '') continue
    const english = platform === 3 ? (lang & 0xff) === 0x09 : lang === 0
    const key = english ? 'en' : platform + ':' + lang
    const slot = byLang.get(key) || {}
    if (slot[id] === undefined) slot[id] = text
    byLang.set(key, slot)
  }
  const pick = (slot) => (slot[16] !== undefined ? slot[16] : slot[1])
  const en = byLang.get('en')
  if (en === undefined) return null
  const family = pick(en)
  const names = [family]
  if (en[1] !== undefined && en[1] !== family) names.push(en[1])
  const locals = []
  for (const [key, slot] of byLang) {
    if (key === 'en') continue
    const local = pick(slot)
    if (local !== family && !locals.includes(local)) locals.push(local)
  }
  return { family, names, locals }
}

/** Characters whose advances differ in any proportional Latin design. */
const PITCH_PROBE = [0x69, 0x6c, 0x6d, 0x57, 0x30, 0x2e, 0x49, 0x4d]

/** Glyph ids for `codes` from a cmap subtable of format 4 or 12 (0 when unmapped). */
async function cmapGlyphs(read, cmap, codes) {
  const head = await read(cmap.at, cmap.at + 4)
  if (head.byteLength < 4) return null
  const numTables = Math.min(head.getUint16(2), 64)
  const recs = await read(cmap.at + 4, cmap.at + 4 + 8 * numTables)
  let best = -1
  let bestRank = 99
  for (let i = 0; i * 8 + 8 <= recs.byteLength; i++) {
    const platform = recs.getUint16(i * 8), encoding = recs.getUint16(i * 8 + 2)
    const rank = platform === 3 && encoding === 1 ? 0 : platform === 0 && encoding <= 3 ? 1 : platform === 3 && encoding === 10 ? 2 : platform === 0 ? 3 : 99
    if (rank < bestRank) { bestRank = rank; best = recs.getUint32(i * 8 + 4) }
  }
  if (best < 0) return null
  const at = cmap.at + best
  const sub = await read(at, at + 16)
  if (sub.byteLength < 8) return null
  const format = sub.getUint16(0)
  if (format === 4) {
    const t = await read(at, at + sub.getUint16(2))
    const segX2 = t.getUint16(6)
    const ends = 14, starts = 16 + segX2, deltas = starts + segX2, ranges = deltas + segX2
    if (ranges + segX2 > t.byteLength) return null
    return codes.map((code) => {
      for (let s = 0; s < segX2; s += 2) {
        if (t.getUint16(ends + s) < code) continue
        const start = t.getUint16(starts + s)
        if (start > code) return 0
        const ro = t.getUint16(ranges + s)
        if (ro === 0) return (code + t.getUint16(deltas + s)) & 0xffff
        const g = ranges + s + ro + 2 * (code - start)
        if (g + 2 > t.byteLength) return 0
        const gid = t.getUint16(g)
        return gid === 0 ? 0 : (gid + t.getUint16(deltas + s)) & 0xffff
      }
      return 0
    })
  }
  if (format === 12) {
    if (sub.byteLength < 16) return null
    const groups = Math.min(sub.getUint32(12), 65536)
    const t = await read(at + 16, at + 16 + 12 * groups)
    return codes.map((code) => {
      for (let g = 0; g * 12 + 12 <= t.byteLength; g++) {
        const start = t.getUint32(g * 12), end = t.getUint32(g * 12 + 4)
        if (code >= start && code <= end) return t.getUint32(g * 12 + 8) + code - start
        if (start > code) break
      }
      return 0
    })
  }
  return null
}

/**
 * Whether the Latin probe characters share one advance width. Measured from
 * cmap + hmtx because the declared flags (post.isFixedPitch, PANOSE) are
 * missing from many monospaced fonts, notably CJK programming fonts whose
 * full-width glyphs make the font as a whole "not fixed pitch".
 * Returns null when the tables are missing or too few probes are mapped.
 */
async function latinFixedPitch(read, tables) {
  const cmap = tables[0x636d6170], hhea = tables[0x68686561], hmtx = tables[0x686d7478]
  if (cmap === undefined || hhea === undefined || hmtx === undefined) return null
  try {
    const h = await read(hhea.at, hhea.at + 36)
    if (h.byteLength < 36) return null
    const metrics = h.getUint16(34)
    if (metrics === 0) return null
    const gids = await cmapGlyphs(read, cmap, PITCH_PROBE)
    if (gids === null) return null
    const widths = new Set()
    let mapped = 0
    for (const gid of gids) {
      if (gid === 0) continue
      const index = Math.min(gid, metrics - 1)
      const m = await read(hmtx.at + 4 * index, hmtx.at + 4 * index + 2)
      if (m.byteLength < 2) continue
      mapped++
      widths.add(m.getUint16(0))
    }
    if (mapped < 4) return null
    return widths.size === 1
  } catch (error) {
    return null
  }
}

/**
 * Describe every face in a font file (single font or .ttc/.otc collection).
 * `read(from, to)` must resolve to a DataView of the bytes in [from, to),
 * shorter at the end of the file. Returns
 * [{ family, names, locals, scripts, mono, latin }] where `names` are the
 * English family names (typographic first), `locals` the other-language
 * family names, `scripts` CJK coverage tags (ja, zh-Hans, zh-Hant, ko, han),
 * `mono` whether the face declares fixed pitch, and `latin` whether it
 * covers Basic Latin. Unreadable data yields [].
 */
async function readFontFaces(read) {
  const out = []
  const head = await read(0, 12)
  if (head.byteLength < 12) return out
  const tag = head.getUint32(0)
  let offsets = [0]
  if (tag === 0x74746366) { // 'ttcf'
    const count = Math.min(head.getUint32(8), 256)
    const table = await read(12, 12 + 4 * count)
    offsets = []
    for (let i = 0; i * 4 + 4 <= table.byteLength; i++) offsets.push(table.getUint32(i * 4))
  } else if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) {
    return out
  }
  for (const base of offsets) {
    const header = await read(base, base + 12)
    if (header.byteLength < 12) continue
    const numTables = Math.min(header.getUint16(4), 512)
    const dir = await read(base + 12, base + 12 + 16 * numTables)
    const tables = {}
    for (let i = 0; i * 16 + 16 <= dir.byteLength; i++) {
      const t = dir.getUint32(i * 16)
      // name, OS/2, post, cmap, hhea, hmtx
      if (t === 0x6e616d65 || t === 0x4f532f32 || t === 0x706f7374 || t === 0x636d6170 || t === 0x68686561 || t === 0x686d7478) {
        tables[t] = { at: dir.getUint32(i * 16 + 8), length: dir.getUint32(i * 16 + 12) }
      }
    }
    const name = tables[0x6e616d65]
    if (name === undefined) continue
    const nt = await read(name.at, name.at + Math.min(name.length, 262144))
    if (nt.byteLength < 6) continue
    const family = readFamilyNames(nt)
    if (family === null) continue
    let scripts = []
    let latin = true
    let mono = false
    const os2 = tables[0x4f532f32]
    if (os2 !== undefined) {
      const o = await read(os2.at, os2.at + Math.min(os2.length, 96))
      if (o.byteLength >= 58) {
        const version = o.getUint16(0)
        latin = (o.getUint32(42) & 1) !== 0
        const codePages1 = version >= 1 && o.byteLength >= 82 ? o.getUint32(78) : 0
        scripts = cjkScripts(o.getUint32(46), codePages1)
        // PANOSE Latin Text family (2) with monospaced proportion (9).
        if (o.getUint8(32) === 2 && o.getUint8(35) === 9) mono = true
      }
    }
    const measured = await latinFixedPitch(read, tables)
    if (measured !== null) mono = measured
    else if (!mono && tables[0x706f7374] !== undefined) {
      const post = tables[0x706f7374]
      const p = await read(post.at, post.at + 16)
      if (p.byteLength >= 16 && p.getUint32(12) !== 0) mono = true
    }
    out.push({ family: family.family, names: family.names, locals: family.locals, scripts, mono, latin })
  }
  return out
}

/**
 * Merge per-face descriptions into one entry per family. Coverage is the
 * union over faces; `mono` holds when any face is fixed pitch, since a family
 * is either monospaced throughout or not at all in practice.
 */
function mergeFamilies(faces) {
  const byName = new Map()
  for (const face of faces) {
    if (!face || typeof face.family !== 'string' || face.family === '' || face.family.startsWith('.')) continue
    let entry = byName.get(face.family)
    if (entry === undefined) {
      entry = { name: face.family, aka: [], locals: [], scripts: [], mono: false, latin: false }
      byName.set(face.family, entry)
    }
    for (const n of face.names || []) if (n !== entry.name && !entry.aka.includes(n)) entry.aka.push(n)
    for (const n of face.locals || []) if (!entry.locals.includes(n)) entry.locals.push(n)
    for (const s of face.scripts || []) if (!entry.scripts.includes(s)) entry.scripts.push(s)
    entry.mono = entry.mono || face.mono === true
    entry.latin = entry.latin || face.latin !== false
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
}

// END font-tables

export { readFontFaces, mergeFamilies, cjkScripts }
