/**
 * dsh-custom-fonts — client bundle.
 *
 * Customizes the global UI fonts on a settings page:
 *   - "UI font · Latin" for Latin characters and "UI font · CJK" for
 *     CJK glyphs, resolved through a CSS font-family fallback chain (Latin
 *     first, so characters missing from the Latin font fall
 *     back to the CJK one — the standard way to split fonts by script
 *     without any language detection);
 *   - "Code font": a separate mono face for `pre`/`code`/`kbd`/`samp`
 *     regions, applied with priority over the UI stack;
 *   - "Font size offset": a global px offset (range -4..+8, step 0.5). It is
 *     added only where a size is *declared* (see "Size offset" below), never
 *     to every element, so it cannot accumulate through DOM nesting.
 *
 * Persistence: the four values live in the Host settings document under the
 * `dsh-custom-fonts` namespace (schema declared by the host half in
 * ../lib/index.js) and are read/written through the shared
 * `ctx.configForms.get(namespace)` form provided by
 * @deepseek-ai/dsh-client-ui-settings. Edits apply to the page immediately;
 * writes are debounced so typing a font name does not rewrite the profile
 * file on every keystroke.
 *
 * Bundle shape follows the official client-modules contract:
 *   window.__ModuleLoader__.load({ id, factory })
 * The factory's only external is `react` from the loader module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-fonts',
  factory: (require) => {
    const { createElement, useEffect, useState } = require('react')

    /** Settings namespace owned by this plugin (equals its loader entry id). */
    const NAMESPACE = 'dsh-custom-fonts'
    /** Empty font means "use the product default"; size 0 means "no offset". */
    const DEFAULTS = Object.freeze({ en: '', zh: '', code: '', size: 0 })
    const FIELDS = Object.keys(DEFAULTS)
    const SIZE_MIN = -4
    const SIZE_MAX = 8
    const SIZE_STEP = 0.5
    /** CSS variable carrying the current offset (e.g. `2.5px`). */
    const OFFSET_VAR = '--dsh-custom-fonts-size-offset'
    const OFFSET_REF = 'var(' + OFFSET_VAR + ', 0px)'
    /** Quiet period before an edit is written to the Host settings document. */
    const SAVE_DELAY_MS = 400

    // Applied font state. Lives in the bundle closure so it survives
    // settings-page navigation; the persisted copy lives in the Host.
    const state = { ...DEFAULTS }
    let styleTag = null

    const LATIN_FONTS = [
      'Segoe UI', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
      'Courier New', 'Consolas', 'Verdana', 'Calibri',
    ]
    const CJK_FONTS = [
      'Noto Sans CJK JP', 'Yu Gothic', 'Meiryo', 'Hiragino Sans',
      'Noto Sans CJK SC', 'Microsoft YaHei', 'SimSun', 'SimHei',
      'KaiTi', 'FangSong', 'PingFang SC', 'Noto Sans CJK TC', 'PingFang TC',
      'Noto Sans CJK KR', 'Malgun Gothic', 'Apple SD Gothic Neo',
    ]
    const CODE_FONTS = [
      'Consolas', 'Courier New', 'Menlo', 'Monaco', 'SF Mono',
      'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro',
      'DejaVu Sans Mono', 'Sarasa Mono J', 'Sarasa Mono SC', 'Sarasa Mono K',
    ]

    // ---------------------------------------------------------------------
    // Installed-font detection (Local Font Access API, Chromium only)
    // ---------------------------------------------------------------------

    /** Families that are always valid in CSS and never "missing". */
    const GENERIC_FAMILIES = new Set([
      'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
      'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
    ])
    /**
     * Localized names of well-known fonts, used before (or without) a scan so
     * that e.g. typing a Japanese name finds the English family. A scan adds
     * the names stored inside each installed font file on top of these.
     */
    const FONT_ALIASES = {
      'Yu Gothic': ['游ゴシック'], 'Yu Gothic UI': ['游ゴシック UI'], 'Yu Mincho': ['游明朝'],
      'Meiryo': ['メイリオ'], 'Meiryo UI': ['メイリオ UI'],
      'MS Gothic': ['ＭＳ ゴシック'], 'MS PGothic': ['ＭＳ Ｐゴシック'], 'MS UI Gothic': ['ＭＳ UI ゴシック'],
      'MS Mincho': ['ＭＳ 明朝'], 'MS PMincho': ['ＭＳ Ｐ明朝'],
      'BIZ UDGothic': ['BIZ UDゴシック'], 'BIZ UDPGothic': ['BIZ UDPゴシック'],
      'BIZ UDMincho': ['BIZ UD明朝'], 'BIZ UDPMincho': ['BIZ UDP明朝'],
      'Hiragino Sans': ['ヒラギノ角ゴシック'], 'Hiragino Kaku Gothic ProN': ['ヒラギノ角ゴ ProN'],
      'Hiragino Mincho ProN': ['ヒラギノ明朝 ProN'], 'Hiragino Maru Gothic ProN': ['ヒラギノ丸ゴ ProN'],
      'Noto Sans CJK JP': ['源ノ角ゴシック', 'Source Han Sans'], 'Noto Serif CJK JP': ['源ノ明朝', 'Source Han Serif'],
      'Microsoft YaHei': ['微软雅黑'], 'SimSun': ['宋体'], 'SimHei': ['黑体'], 'KaiTi': ['楷体'], 'FangSong': ['仿宋'],
      'Microsoft JhengHei': ['微軟正黑體'], 'PingFang SC': ['苹方'], 'PingFang TC': ['蘋方'],
      'Malgun Gothic': ['맑은 고딕'], 'Apple SD Gothic Neo': ['애플 SD 산돌고딕 Neo'],
    }

    // BEGIN pure font helpers (extracted and unit-tested by scripts/verify.mjs)

    /** Names learned from installed fonts: English family -> other names (localized first). */
    const localNames = new Map()
    /** What installed fonts declare: family -> { scripts, mono, latin }. */
    const fontInfo = new Map()

    function aliasesOf(name) {
      const out = []
      for (const list of [FONT_ALIASES[name], localNames.get(name)]) {
        for (const alias of list || []) if (alias !== name && !out.includes(alias)) out.push(alias)
      }
      return out
    }

    /**
     * Fold text for forgiving search: width/compatibility forms (ＭＳ -> MS),
     * case, hiragana vs. katakana, and separators (so "yugothic" finds "Yu Gothic").
     */
    function foldText(text) {
      return String(text).normalize('NFKC').toLowerCase()
        .replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
        .replace(/[\s\-_.・･]+/g, '')
    }

    /** Split "Inter, Se" into the part to keep ("Inter, ") and the token being typed ("Se"). */
    function splitLastToken(value) {
      const cut = String(value).lastIndexOf(',')
      if (cut < 0) return { head: '', query: String(value).trim() }
      return { head: String(value).slice(0, cut + 1).replace(/\s*$/, ' '), query: String(value).slice(cut + 1).trim() }
    }

    /**
     * Whether a family suits a field: `cjk` wants Japanese/Chinese/Korean
     * coverage, `code` a fixed-pitch Latin design, `latin` Latin coverage.
     * Families nothing is known about count as suitable, so the built-in
     * lists and a browser without metadata keep their plain order.
     */
    function suits(name, kind) {
      const info = fontInfo.get(name)
      if (info === undefined || !kind) return true
      if (kind === 'cjk') return info.scripts.length > 0
      if (kind === 'code') return info.mono
      return info.latin
    }

    /**
     * Suggestions for a query, as { name, alias } (`alias` is the localized
     * name to show next to the family, preferring the one that matched).
     * Families that suit `kind` come first; within each group the order is
     * name prefix, alias prefix, name substring, alias substring.
     */
    function filterFonts(pool, query, limit, kind) {
      const q = foldText(query)
      const buckets = [[], [], [], [], [], [], [], []]
      for (const name of pool) {
        const shift = suits(name, kind) ? 0 : 4
        if (q === '') { buckets[shift].push({ name, alias: aliasesOf(name)[0] || '' }); continue }
        const at = foldText(name).indexOf(q)
        if (at === 0) { buckets[shift].push({ name, alias: aliasesOf(name)[0] || '' }); continue }
        let hit = ''
        let aliasAt = -1
        for (const alias of aliasesOf(name)) {
          const i = foldText(alias).indexOf(q)
          if (i >= 0 && (aliasAt < 0 || i < aliasAt)) { aliasAt = i; hit = alias }
        }
        if (aliasAt === 0) buckets[shift + 1].push({ name, alias: hit })
        else if (at > 0) buckets[shift + 2].push({ name, alias: aliasesOf(name)[0] || '' })
        else if (aliasAt > 0) buckets[shift + 3].push({ name, alias: hit })
      }
      return buckets.flat().slice(0, limit)
    }

    /** Short tags shown next to a suggestion: CJK coverage and fixed pitch. */
    function fontBadges(name) {
      const info = fontInfo.get(name)
      if (info === undefined) return []
      const labels = { ja: 'JP', 'zh-Hans': 'SC', 'zh-Hant': 'TC', ko: 'KR', han: 'CJK' }
      const out = info.scripts.map((s) => labels[s] || s)
      if (info.mono) out.push('Mono')
      return out
    }

    /**
     * Remember what a catalog says about each family: localized and
     * alternative names for search, and coverage for ranking and badges.
     * Entries are { name, aka, locals, scripts, mono, latin }.
     */
    function learnFamilies(families) {
      for (const f of families) {
        if (!f || typeof f.name !== 'string') continue
        const names = []
        for (const n of [...(f.locals || []), ...(f.aka || [])]) if (typeof n === 'string' && !names.includes(n)) names.push(n)
        localNames.set(f.name, names)
        fontInfo.set(f.name, {
          scripts: Array.isArray(f.scripts) ? f.scripts.filter((s) => typeof s === 'string') : [],
          mono: f.mono === true,
          latin: f.latin !== false,
        })
      }
    }

    // BEGIN font-tables (copied from lib/font-tables.js; verify.mjs checks they match)

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

    // END pure font helpers

    /**
     * `status`: idle (not asked yet) | loading | ready | denied | unsupported | error.
     * `source`: where the ready list came from — `host` (read by the DSH Host
     * on this computer) or `browser` (Local Font Access API).
     * `families` is the sorted list of installed family names once ready.
     */
    const fontScan = { status: 'idle', source: null, families: [], lower: new Set(), message: '' }
    let scanPromise = null
    const MAX_SUGGESTIONS = 50
    const FONT_LIST_METHOD = 'dsh-custom-fonts.list'
    /**
     * Connection RPC, kept only when the page runs on the Host's own machine
     * (loopback): only then are the Host's fonts the ones this browser draws.
     */
    let hostRpc = null

    function localFontsSupported() {
      return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function'
    }

    function setFamilies(names, source) {
      fontScan.families = [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
      fontScan.lower = new Set(fontScan.families.map((name) => name.toLowerCase()))
      fontScan.source = source
      fontScan.status = 'ready'
      fontScan.message = ''
    }

    /** Ask the Host for the fonts installed on this computer. */
    async function scanHostFonts() {
      const result = await hostRpc.call('/api', FONT_LIST_METHOD, {})
      if (!result || result.ok !== true || !result.value || !Array.isArray(result.value.families)) {
        throw new Error(result && result.error && result.error.message ? String(result.error.message) : 'the DSH host did not return a font list')
      }
      const families = result.value.families
      learnFamilies(families)
      setFamilies(families.map((f) => f && f.name).filter((name) => typeof name === 'string' && name !== ''), 'host')
    }

    /** In the background, learn names and coverage from each browser-reported family's file. */
    async function learnFromBrowserFaces(faces) {
      const firstFace = new Map()
      for (const face of faces) if (face && face.family && !firstFace.has(face.family)) firstFace.set(face.family, face)
      const queue = [...firstFace.values()]
      let done = 0
      const worker = async () => {
        while (queue.length > 0) {
          const face = queue.shift()
          if (fontInfo.has(face.family) || typeof face.blob !== 'function') continue
          try {
            const blob = await face.blob()
            const described = mergeFamilies(await readFontFaces(async (from, to) => new DataView(await blob.slice(from, to).arrayBuffer())))
            // The browser lists a family under its own name; file this entry under it too.
            learnFamilies(described.flatMap((f) => [f, { ...f, name: face.family, aka: [f.name, ...f.aka] }]))
          } catch (error) { /* unreadable font: English name only */ }
          if (++done % 25 === 0) notify()
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()])
      notify()
    }

    async function scanBrowserFonts() {
      const faces = await window.queryLocalFonts()
      const names = []
      for (const face of faces || []) if (face && face.family) names.push(String(face.family))
      setFamilies(names, 'browser')
      void learnFromBrowserFaces(faces || [])
    }

    /**
     * Load the installed-font list: from the Host when the page is local,
     * otherwise (or when the Host fails) from the browser where supported.
     */
    function scanInstalledFonts() {
      if (scanPromise !== null) return scanPromise
      if (hostRpc === null && !localFontsSupported()) {
        fontScan.status = 'unsupported'
        notify()
        return Promise.resolve(false)
      }
      fontScan.status = 'loading'
      notify()
      const viaHost = hostRpc !== null
        ? scanHostFonts().then(() => true, (error) => {
          fontScan.message = error && error.message ? String(error.message) : ''
          return false
        })
        : Promise.resolve(false)
      scanPromise = viaHost
        .then((ok) => {
          if (ok) return true
          if (!localFontsSupported()) {
            fontScan.status = hostRpc !== null ? 'error' : 'unsupported'
            return false
          }
          return scanBrowserFonts().then(() => true)
        })
        .catch((error) => {
          const name = error && error.name
          fontScan.status = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error'
          fontScan.message = error && error.message ? String(error.message) : ''
          return false
        })
        .then((ok) => { scanPromise = null; notify(); return ok })
      return scanPromise
    }

    /** Load the list without a prompt: from the Host, or when the browser already granted access. */
    function autoScan() {
      if (fontScan.status !== 'idle') return
      if (hostRpc !== null) { void scanInstalledFonts(); return }
      if (!localFontsSupported()) return
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : null
        if (!nav || !nav.permissions || typeof nav.permissions.query !== 'function') return
        nav.permissions.query({ name: 'local-fonts' }).then((result) => {
          if (result && result.state === 'granted') void scanInstalledFonts()
        }, () => {})
      } catch (error) { /* permission name unsupported: user clicks the button */ }
    }

    /** Entered font names that are not installed (only once the scan is ready). */
    function missingFonts(value) {
      if (fontScan.status !== 'ready') return []
      return String(value).split(',')
        .map((part) => part.trim().replace(/^["']|["']$/g, ''))
        .filter((name) => {
          if (name === '' || GENERIC_FAMILIES.has(name.toLowerCase()) || fontScan.lower.has(name.toLowerCase())) return false
          const folded = foldText(name)
          return !fontScan.families.some((family) => aliasesOf(family).some((alias) => foldText(alias) === folded))
        })
    }
    // Turn user input (comma-separated font lists allowed) into quoted CSS.
    // Characters that could end the declaration or the <style> element are
    // dropped, since values may also come from a hand-edited settings file.
    function quoteList(str) {
      return String(str || '').split(',')
        .map((s) => s.replace(/[;{}<>\\\r\n]/g, '').trim())
        .filter((s) => s.length > 0)
        .map((s) => {
          if (/^(['"])[^'"]*\1$/.test(s)) return s
          return "'" + s.replace(/['"]/g, '') + "'"
        }).join(', ')
    }

    // ---------------------------------------------------------------------
    // Size offset
    //
    // The offset must be added exactly once per text run. A blanket
    // `body * { font-size: calc(1em + N) }` adds it on every nesting level
    // (1em is the parent's already-enlarged size), so a 10-deep tree drifts
    // by 10·N. Instead, the page's own stylesheets are mirrored: every rule
    // that *declares* an absolute size gets a twin with the same selector
    // (and the same @media/@supports/... wrapper) whose size is
    // `calc(<original> + offset)`. Equal specificity and a later position
    // make each twin win exactly where its original applied, so the cascade
    // is untouched. Inherited sizes and relative sizes (em, %, rem, keywords)
    // are left alone and simply follow their already-offset parent, so the
    // shift never compounds. Elements with no declared size inherit from
    // `html`, which gets `calc(100% + offset)`.
    //
    // Declared sizes the original rule repeats verbatim (em, %, keywords)
    // keep their place in the tie-breaking order. The twins reference a CSS
    // variable, so dragging the slider only rewrites that variable; the twins
    // themselves are rebuilt only when the page's stylesheets change.
    // ---------------------------------------------------------------------

    const ABS_UNIT = '(?:px|pt|pc|cm|mm|q|in|vw|vh|vmin|vmax|[sld]v[wh])'
    const ABS_LENGTH = new RegExp('^(?:\\d+\\.?\\d*|\\.\\d+)' + ABS_UNIT + '$', 'i')
    const HAS_ABS = new RegExp('\\d' + ABS_UNIT + '\\b', 'i')
    /** Units resolved against the parent (or root) font size: never offset twice. */
    const HAS_REL = /[\d.](?:r?em|ex|ch|r?lh|cap|ic)\b|%/i
    const ZERO = /^[-+]?0*\.?0+[a-z]*$/i
    const SINGLE_VAR = /^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/
    const FONT_PREFIX = /^(?:normal|italic|oblique|small-caps|bold|bolder|lighter|\d{1,4}(?:\.\d+)?|(?:ultra-|extra-|semi-)?(?:condensed|expanded))$/i
    const GROUP_PRELUDE = /^@(?:media|supports|container|layer|scope|document|-moz-document)\b/i

    /**
     * Whether a declared font-size / line-height expression may be offset:
     * absolute lengths and calc()/min()/max()/clamp() over absolute lengths.
     * `var(--x)` is followed through the page's custom properties; an
     * unknown variable is trusted only for font-size (`allowVar`), since a
     * line-height variable may hold a unitless number. Zero sizes (a
     * whitespace-collapsing trick) and anything relative to the parent are
     * left alone: their parent already carries the offset.
     */
    function offsetable(value, allowVar, tokens, depth = 0) {
      const v = String(value || '').trim()
      if (v === '' || ZERO.test(v) || HAS_REL.test(v)) return false
      if (ABS_LENGTH.test(v)) return true
      const single = SINGLE_VAR.exec(v)
      if (single !== null && tokens && tokens.has(single[1]) && depth < 5) {
        return offsetable(tokens.get(single[1]), allowVar, tokens, depth + 1)
      }
      if (relativeVar(v, tokens, 0)) return false
      if (/^(?:calc|min|max|clamp)\(/i.test(v)) return HAS_ABS.test(v)
      return allowVar && single !== null
    }

    /** Whether a value references a custom property that is (transitively) relative. */
    function relativeVar(value, tokens, depth) {
      if (!tokens || depth > 4) return false
      for (const m of String(value).matchAll(/var\(\s*(--[\w-]+)/g)) {
        const token = tokens.get(m[1])
        if (token === undefined) continue
        if (HAS_REL.test(token) || relativeVar(token, tokens, depth + 1)) return true
      }
      return false
    }

    /** Split a `font` shorthand at top level into words, '/' and ','. */
    function splitFont(value) {
      const out = []
      let depth = 0
      let cur = ''
      for (const ch of value) {
        if (ch === '(') depth += 1
        else if (ch === ')') depth -= 1
        if (depth === 0 && (/\s/.test(ch) || ch === '/' || ch === ',')) {
          if (cur) out.push(cur)
          cur = ''
          if (ch === '/' || ch === ',') out.push(ch)
          continue
        }
        cur += ch
      }
      if (cur) out.push(cur)
      return out
    }

    /**
     * The font-size / line-height expressions inside a `font` shorthand,
     * or null when they cannot be determined. `font: var(--token)` uses
     * the token's `--token-font-size` / `--token-line-height` companions
     * (DSH design tokens provide them) or else the token's own value.
     */
    function resolveFont(value, tokens, depth) {
      const v = String(value || '').trim()
      const single = SINGLE_VAR.exec(v)
      if (single !== null) {
        const name = single[1]
        if (tokens.has(name + '-font-size')) {
          return {
            size: 'var(' + name + '-font-size)',
            lh: tokens.has(name + '-line-height') ? 'var(' + name + '-line-height)' : null,
          }
        }
        return tokens.has(name) && depth < 3 ? resolveFont(tokens.get(name), tokens, depth + 1) : null
      }
      const words = splitFont(v)
      let i = 0
      while (i < words.length && FONT_PREFIX.test(words[i])) i += 1
      // A size must be followed by a family; a lone word is a system font.
      if (i >= words.length - 1 || words[i] === '/' || words[i] === ',') return null
      return { size: words[i], lh: words[i + 1] === '/' ? words[i + 2] || null : null }
    }

    /**
     * The raw `font` value of each rule in a <style> element's source. The
     * CSSOM drops a `font: var(...)` shorthand once a longhand (for example
     * font-family) follows it in the same block, so this is the fallback.
     */
    function sourceFonts(text) {
      const map = new Map()
      const clean = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '')
      const block = /([^{};]+)\{([^{}]*)\}/g
      let m
      while ((m = block.exec(clean)) !== null) {
        const decl = /(?:^|;)\s*font\s*:\s*([^;]+)/i.exec(m[2])
        if (decl !== null) map.set(normSelector(m[1]), decl[1].replace(/!\s*important\s*$/i, '').trim())
      }
      return map
    }

    function normSelector(sel) {
      return String(sel).replace(/\s+/g, '').replace(/["']/g, '')
    }

    function listOf(items) {
      try { return items ? Array.from(items) : [] } catch { return [] }
    }

    function safeRules(owner) {
      try { return owner && owner.cssRules ? owner.cssRules : null } catch { return null }
    }

    /**
     * Twin declarations for one style block ('' if it sets no size). An
     * absolute size becomes `calc(size + offset)`; any other declared size
     * (em, %, keywords, inherit) is repeated verbatim so that the relative
     * order of all size declarations — and thus who wins a tie — is exactly
     * the original one.
     */
    function mirrorDecls(style, tokens, lookupFont) {
      const declared = new Set(listOf(style))
      let parsed
      const shorthand = () => {
        if (parsed === undefined) {
          const raw = String(style.getPropertyValue('font') || '').trim() || lookupFont() || ''
          parsed = raw ? resolveFont(raw, tokens, 0) : null
        }
        return parsed
      }
      let out = ''
      for (const prop of ['font-size', 'line-height']) {
        if (!declared.has(prop)) continue
        let value = String(style.getPropertyValue(prop) || '').trim()
        let priority = style.getPropertyPriority(prop)
        if (value === '') {
          // Longhand still pending a `font: var(...)` substitution.
          const resolved = shorthand()
          value = resolved ? (prop === 'font-size' ? resolved.size : resolved.lh) || '' : ''
          if (value === '') continue
          priority = priority || style.getPropertyPriority('font')
        }
        const bang = priority === 'important' ? ' !important' : ''
        const next = offsetable(value, prop === 'font-size', tokens) ? 'calc(' + value + ' + ' + OFFSET_REF + ')' : value
        out += prop + ': ' + next + bang + '; '
      }
      return out
    }

    function collectTokens(rules, tokens) {
      for (const rule of listOf(rules)) {
        if (rule.style && typeof rule.selectorText === 'string') {
          for (const prop of listOf(rule.style)) {
            if (prop.startsWith('--')) tokens.set(prop, String(rule.style.getPropertyValue(prop)).trim())
          }
        }
        if (rule.styleSheet) collectTokens(safeRules(rule.styleSheet), tokens)
        else collectTokens(safeRules(rule), tokens)
      }
    }

    function mirrorRules(rules, tokens, lookupFont) {
      let out = ''
      for (const rule of listOf(rules)) {
        if (rule.style && typeof rule.selectorText === 'string') {
          const decls = mirrorDecls(rule.style, tokens, () => lookupFont(rule.selectorText))
          const nested = safeRules(rule)
          const inner = nested ? mirrorRules(nested, tokens, lookupFont) : ''
          // Blocks with only verbatim (relative) sizes are emitted too: they
          // must still outrank earlier twins exactly as their originals did.
          if (decls || inner) out += rule.selectorText + ' { ' + decls + inner + '}\n'
        } else if (rule.styleSheet) {
          // @import: mirror the imported sheet under the same media query.
          const media = rule.media && rule.media.mediaText ? String(rule.media.mediaText) : ''
          const inner = mirrorRules(safeRules(rule.styleSheet), tokens, lookupFont)
          if (inner) out += media && media !== 'all' ? '@media ' + media + ' {\n' + inner + '}\n' : inner
        } else {
          const nested = safeRules(rule)
          if (nested === null) continue
          const text = String(rule.cssText || '')
          const prelude = text.slice(0, text.indexOf('{')).trim()
          if (!GROUP_PRELUDE.test(prelude)) continue
          const inner = mirrorRules(nested, tokens, lookupFont)
          if (inner) out += prelude + ' {\n' + inner + '}\n'
        }
      }
      return out
    }

    function isOwnNode(node) {
      return Boolean(node && node.nodeType === 1 && typeof node.hasAttribute === 'function' && node.hasAttribute('data-dsh-custom-fonts'))
    }

    /** Twin rules for the page's current stylesheets. Independent of N. */
    function buildSizeCss() {
      const sheets = listOf(document.styleSheets).filter((sheet) => !sheet.disabled && !isOwnNode(sheet.ownerNode))
      const tokens = new Map()
      for (const sheet of sheets) collectTokens(safeRules(sheet), tokens)
      // Text with no declared size anywhere inherits from the root.
      let out = 'html { font-size: calc(100% + ' + OFFSET_REF + '); }\n'
      for (const sheet of sheets) {
        const rules = safeRules(sheet)
        if (rules === null) continue
        let fonts = null
        const lookupFont = (selector) => {
          if (fonts === null) {
            const node = sheet.ownerNode
            fonts = node && String(node.tagName).toUpperCase() === 'STYLE' ? sourceFonts(node.textContent) : new Map()
          }
          return fonts.get(normSelector(selector)) || null
        }
        const inner = mirrorRules(rules, tokens, lookupFont)
        const media = sheet.media && sheet.media.mediaText ? String(sheet.media.mediaText) : ''
        if (inner) out += media && media !== 'all' ? '@media ' + media + ' {\n' + inner + '}\n' : inner
      }
      return out
    }

    /** Cached twin rules; dropped whenever the page's stylesheets change. */
    let sizeCss = null

    function formatOffset(offset) {
      return (offset > 0 ? '+' : '') + offset + 'px'
    }

    // The font CSS. Order matters:
    //   1. UI stack (Latin → CJK fallback)
    //   2. code stack, later and equally specific, wins inside code regions
    //   3. the offset variable read by the twin rules
    function buildCss(o) {
      const enQ = quoteList(o.en)
      const zhQ = quoteList(o.zh)
      const codeQ = quoteList(o.code)
      const offset = normalizeSize(o.size)
      const rules = []
      const vars = []
      if (enQ) vars.push('--dsh-custom-fonts-en: ' + enQ)
      if (zhQ) vars.push('--dsh-custom-fonts-zh: ' + zhQ)
      if (offset !== 0) vars.push(OFFSET_VAR + ': ' + offset + 'px')
      const uiStack = [enQ, zhQ].filter(Boolean).join(', ')
      if (uiStack) {
        rules.push('body, body * { font-family: ' + uiStack + ' !important; }')
      }
      if (codeQ) {
        rules.push('pre, code, kbd, samp { font-family: ' + codeQ + ' !important; }')
      }
      if (rules.length === 0 && vars.length === 0) return null
      return (vars.length > 0 ? ':root { ' + vars.join('; ') + '; }\n' : '') + rules.join('\n')
    }

    // Two <style> elements, both kept at the end of <head> so their rules
    // win ties against the originals: `styleTag` (fonts and the offset
    // variable — tiny, rewritten on every edit) and `sizeTag` (the twin
    // rules — large, rewritten only when the page's stylesheets change, so
    // dragging the slider stays cheap). Offset 0 removes the twin rules
    // entirely, leaving the page exactly as it was.
    let sizeTag = null

    function ensureTag(tag, kind, css) {
      const el = tag !== null ? tag : document.createElement('style')
      if (tag === null) el.setAttribute('data-dsh-custom-fonts', kind)
      if (el.textContent !== css) el.textContent = css
      return el
    }

    function keepLast(tags) {
      const head = document.head
      const live = tags.filter((tag) => tag !== null)
      const tail = listOf(head.children).slice(-live.length)
      if (live.length > 0 && live.every((tag, i) => tail[i] === tag)) return
      for (const tag of live) { tag.remove(); head.appendChild(tag) }
    }

    function applyFonts(next) {
      Object.assign(state, next)
      const css = buildCss(state)
      if (css === null) {
        if (styleTag !== null) { styleTag.remove(); styleTag = null }
      } else {
        styleTag = ensureTag(styleTag, 'fonts', css)
      }
      if (normalizeSize(state.size) === 0) {
        if (sizeTag !== null) { sizeTag.remove(); sizeTag = null }
      } else {
        if (sizeCss === null) sizeCss = buildSizeCss()
        sizeTag = ensureTag(sizeTag, 'size', sizeCss)
      }
      keepLast([sizeTag, styleTag])
    }

    function removeTags() {
      if (styleTag !== null) { styleTag.remove(); styleTag = null }
      if (sizeTag !== null) { sizeTag.remove(); sizeTag = null }
    }

    // Stylesheets added later (lazily loaded plugin CSS, <link> loads, HMR)
    // need their own twins and must not end up after ours.
    let observer = null
    let rebuildTimer = null

    function scheduleRebuild() {
      sizeCss = null
      if (rebuildTimer !== null) return
      rebuildTimer = setTimeout(() => {
        rebuildTimer = null
        if (normalizeSize(state.size) !== 0) applyFonts({})
      }, 50)
    }

    function tagOf(node) {
      return node && typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
    }

    function isStyleNode(node) {
      const tag = tagOf(node)
      return tag === 'STYLE' || (tag === 'LINK' && /stylesheet/i.test(String(node.rel || (node.getAttribute && node.getAttribute('rel')) || '')))
    }

    function watchStylesheets() {
      if (observer !== null || typeof MutationObserver !== 'function') return
      observer = new MutationObserver((records) => {
        let foreign = false
        for (const record of records) {
          if (record.type === 'characterData') {
            const parent = record.target && record.target.parentNode
            if (isStyleNode(parent) && !isOwnNode(parent)) foreign = true
            continue
          }
          if (isOwnNode(record.target)) continue
          if (isStyleNode(record.target)) { foreign = true; continue }
          for (const node of [...listOf(record.addedNodes), ...listOf(record.removedNodes)]) {
            if (!isStyleNode(node) || isOwnNode(node)) continue
            foreign = true
            if (tagOf(node) === 'LINK' && typeof node.addEventListener === 'function') {
              node.addEventListener('load', scheduleRebuild, { once: true })
            }
          }
        }
        if (foreign) scheduleRebuild()
      })
      observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    }

    function unwatchStylesheets() {
      if (observer !== null) { observer.disconnect(); observer = null }
      if (rebuildTimer !== null) { clearTimeout(rebuildTimer); rebuildTimer = null }
    }

    // ---------------------------------------------------------------------
    // Persistence
    // ---------------------------------------------------------------------

    function normalizeFont(value) {
      return typeof value === 'string' ? value : ''
    }

    function normalizeSize(value) {
      // Numbers, or numeric strings from a hand-edited file; anything else
      // (arrays, booleans, '2px', ...) means "no offset".
      const n = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
      if (!Number.isFinite(n)) return 0
      // Snap to the slider grid (0.5px); `|| 0` folds -0 into 0.
      const snapped = Math.round(n / SIZE_STEP) * SIZE_STEP
      return Math.min(SIZE_MAX, Math.max(SIZE_MIN, snapped)) || 0
    }

    /** Coerce stored (possibly missing or malformed) values into safe settings. */
    function normalizeSettings(value) {
      const o = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
      return {
        en: normalizeFont(o.en),
        zh: normalizeFont(o.zh),
        code: normalizeFont(o.code),
        size: normalizeSize(o.size),
      }
    }

    /** The shared settings form for our namespace while the plugin is active. */
    let form = null
    /** Local edits not yet confirmed by the Host; they win over stored values. */
    let pending = {}
    let saveTimer = null
    /** Last save outcome shown on the page: idle | saving | saved | error. */
    let saveStatus = { kind: 'idle', message: '' }
    const listeners = new Set()

    function notify() {
      for (const listener of listeners) {
        try { listener() } catch (error) { console.error('[dsh-custom-fonts]', error) }
      }
    }

    function setStatus(kind, message) {
      saveStatus = { kind, message: message || '' }
      notify()
    }

    /**
     * Why writes cannot reach the Host right now, or null when they can.
     * `loading` is not a problem: writes queue behind the first read.
     */
    function persistenceProblem(target) {
      if (target === null) {
        return 'Font settings cannot be saved because the DSH settings service is not available. Changes apply until you reload the page.'
      }
      const snap = target.getSnapshot()
      if (snap.mode === 'memory') {
        return 'This connection cannot save DSH settings (only a local connection can). Changes apply until you reload the page.'
      }
      if (snap.status === 'unavailable') {
        return 'Font settings cannot be saved because DSH has not loaded this plugin\'s settings. If you edited the configuration file by hand, check the dsh-custom-fonts entry for invalid values. Changes apply until you reload the page.'
      }
      return null
    }

    /**
     * Adopt whatever the settings form currently holds.
     *
     * The form is the single source of truth: it is hydrated from the Host
     * document when the plugin loads, and every accepted write lands back in
     * it. Local edits still waiting to be written are layered on top so a
     * Host echo never undoes what the user is typing.
     */
    function adopt() {
      if (form !== null) {
        const snap = form.getSnapshot()
        if (snap.status === 'ready') {
          applyFonts({ ...normalizeSettings(snap.value), ...pending })
        }
      }
      notify()
    }

    /** Write field operations; `sent` holds the pending values they carry. */
    async function writeOps(ops, sent) {
      const target = form
      const problem = persistenceProblem(target)
      if (problem !== null) {
        // Keep the edits applied (and pending) for this page; nothing to send.
        setStatus('error', problem)
        return false
      }
      setStatus('saving')
      let accepted = false
      let failure = null
      try {
        accepted = await target.mutate(ops)
      } catch (error) {
        failure = error
      }
      if (failure === null) {
        // Accepted or refused-and-reloaded: either way the Host value is now
        // authoritative for every field the user has not changed since.
        for (const [key, value] of Object.entries(sent)) {
          if (Object.is(pending[key], value)) delete pending[key]
        }
      }
      if (failure !== null) {
        const reason = failure instanceof Error ? failure.message : String(failure)
        setStatus('error', 'Could not save font settings (' + reason + '). Your changes still apply in this window; edit a setting again to retry.')
      } else if (!accepted) {
        setStatus('error', 'DSH did not accept the font settings (the settings file may have changed elsewhere). The saved values have been reloaded.')
      } else if (saveTimer === null && Object.keys(pending).length === 0) {
        setStatus('saved')
      }
      adopt()
      return failure === null && accepted
    }

    /** Write every pending edit now. */
    function flush() {
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
      const sent = { ...pending }
      const keys = Object.keys(sent)
      if (keys.length === 0) return Promise.resolve(true)
      return writeOps(keys.map((key) => ({ op: 'set', path: [key], value: sent[key] })), sent)
    }

    /** Apply an edit immediately and save it after a short quiet period. */
    function update(patch) {
      const clean = {}
      for (const [key, value] of Object.entries(patch)) {
        if (!FIELDS.includes(key)) continue
        clean[key] = key === 'size' ? normalizeSize(value) : normalizeFont(value)
      }
      Object.assign(pending, clean)
      applyFonts(clean)
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => { saveTimer = null; void flush() }, SAVE_DELAY_MS)
      notify()
    }

    /**
     * Restore defaults: clear the page immediately, then remove the stored
     * overrides (`unset`) so the namespace falls back to its defaults — or to
     * whatever a lower profile layer configures — instead of pinning values.
     */
    function resetAll() {
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
      pending = { ...DEFAULTS }
      applyFonts(DEFAULTS)
      notify()
      return writeOps(FIELDS.map((key) => ({ op: 'unset', path: [key] })), { ...DEFAULTS })
    }

    // ---------------------------------------------------------------------
    // Settings page
    // ---------------------------------------------------------------------

    /** An inline size that follows the offset like stylesheet sizes do. */
    function px(n) {
      return 'calc(' + n + 'px + ' + OFFSET_REF + ')'
    }

    const fieldLabelStyle = {
      display: 'block', fontSize: px(13), fontWeight: 600, marginBottom: 6,
      color: 'var(--dsw-alias-label-primary)',
    }
    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '8px 10px',
      borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
      fontSize: px(14), outline: 'none',
    }

    /** Draw el's text in the given family (overrides the global !important rule). */
    function previewFace(el, family) {
      if (el && el.style) el.style.setProperty('font-family', quoteList(family) + ', sans-serif', 'important')
    }

    const suggestListStyle = {
      position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, zIndex: 50,
      maxHeight: 240, overflowY: 'auto', margin: '4px 0 0', padding: 4, listStyle: 'none',
      borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
    }

    function Field(props) {
      const inputId = props.listId + '-input'
      const [open, setOpen] = useState(false)
      const [active, setActive] = useState(-1)
      // Installed fonts once detected; otherwise the built-in common names.
      const pool = fontScan.status === 'ready' ? fontScan.families : props.options
      const { head, query } = splitLastToken(props.value)
      const matches = open ? filterFonts(pool, query, MAX_SUGGESTIONS, props.kind) : []
      const missing = missingFonts(props.value)

      function choose(name) {
        props.onChange({ target: { value: head + name } })
        setOpen(false)
        setActive(-1)
      }
      function onKeyDown(e) {
        if (e.key === 'Escape') { setOpen(false); return }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (!open) { setOpen(true); return }
          if (matches.length === 0) return
          e.preventDefault()
          const step = e.key === 'ArrowDown' ? 1 : -1
          setActive((active + step + matches.length) % matches.length)
          return
        }
        if (e.key === 'Enter' && open && active >= 0 && active < matches.length) {
          e.preventDefault()
          choose(matches[active].name)
        }
      }
      const keepFocus = (e) => { if (e.preventDefault) e.preventDefault() }

      return createElement('div', { style: { marginBottom: 14 } },
        createElement('label', { htmlFor: inputId, style: fieldLabelStyle, title: props.hint }, props.label),
        createElement('div', { style: { position: 'relative' } },
          createElement('input', {
            id: inputId, type: 'text', value: props.value,
            placeholder: props.placeholder, title: props.hint,
            role: 'combobox', 'aria-expanded': open && matches.length > 0, 'aria-autocomplete': 'list',
            spellCheck: false, autoComplete: 'off',
            onChange: (e) => { props.onChange(e); setOpen(true); setActive(-1) },
            onFocus: () => { setOpen(true) },
            onBlur: () => { setOpen(false); setActive(-1) },
            onKeyDown,
            style: { ...inputStyle, paddingRight: 30 },
          }),
          createElement('span', {
            'aria-hidden': 'true', onMouseDown: (e) => { keepFocus(e); setOpen(!open) },
            style: {
              position: 'absolute', right: 0, top: 0, bottom: 0, width: 30, display: 'flex',
              alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              fontSize: px(10), color: 'var(--dsw-alias-label-secondary)',
            },
          }, '\u25BC'),
          matches.length > 0 && createElement('ul', { role: 'listbox', onMouseDown: keepFocus, style: suggestListStyle },
            matches.map((item, i) => createElement('li', {
              key: item.name, role: 'option', 'aria-selected': i === active,
              onMouseDown: (e) => { keepFocus(e); choose(item.name) },
              onMouseEnter: () => { setActive(i) },
              style: {
                padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: px(14),
                display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
                color: 'var(--dsw-alias-label-primary)',
                background: i === active ? 'var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, 0.18))' : 'transparent',
              },
            },
              // Each family is drawn in its own typeface. An inline !important
              // is needed to beat the page-wide `font-family ... !important`.
              createElement('span', { ref: (el) => { previewFace(el, item.name) } }, item.name),
              item.alias !== '' && createElement('span', {
                ref: (el) => { previewFace(el, item.name) },
                style: { fontSize: px(12), color: 'var(--dsw-alias-label-secondary)' },
              }, item.alias),
              ...fontBadges(item.name).map((badge, b) => createElement('span', {
                key: 'badge-' + badge,
                style: {
                  marginLeft: b === 0 ? 'auto' : 0,
                  padding: '0 5px', borderRadius: 4, fontSize: px(10), lineHeight: 1.6,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  color: 'var(--dsw-alias-label-secondary)',
                },
              }, badge)),
            )),
          ),
        ),
        missing.length > 0 && createElement('div', {
          role: 'alert',
          style: { marginTop: 4, fontSize: px(12), lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
        }, 'Not found on this device: ' + missing.join(', ') + '. It will be ignored unless it is a web font.'),
      )
    }

    function FontDetectBar() {
      const status = fontScan.status
      let text
      if (status === 'ready') {
        text = fontScan.families.length + ' installed fonts '
          + (fontScan.source === 'host' ? 'found on this computer' : 'detected by the browser')
          + '. Type to search, or pick from the list; fonts that fit each field are listed first.'
      } else if (status === 'loading') text = 'Detecting installed fonts…'
      else if (status === 'unsupported') text = 'This browser cannot list installed fonts, so only common font names are suggested. Open DSH on the computer it runs on, or use a Chromium-based browser (Chrome or Edge), for full suggestions.'
      else if (status === 'denied') text = 'Permission to read installed fonts was denied. Allow it in the site settings (Fonts / Local fonts) and try again.'
      else if (status === 'error') text = 'Could not read installed fonts' + (fontScan.message ? ' (' + fontScan.message + ')' : '') + '.'
      else text = 'Showing common font names. Detect the fonts installed on this device to get suggestions for any of them.'
      const showButton = status === 'idle' || status === 'denied' || status === 'error'
      return createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14,
          fontSize: px(12), lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)',
        },
      },
        showButton && createElement('button', {
          type: 'button', title: 'Read the list of installed fonts',
          onClick: () => { void scanInstalledFonts() },
          style: {
            padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)', fontSize: px(13),
          },
        }, 'Detect installed fonts'),
        createElement('span', { 'aria-live': 'polite' }, text),
      )
    }
    /** Re-render whenever the applied state or the save status changes. */
    function useFontSettings() {
      const [, setTick] = useState(0)
      useEffect(() => {
        const listener = () => setTick((tick) => tick + 1)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return state
    }

    function statusText() {
      if (saveStatus.kind === 'saving') return 'Saving…'
      if (saveStatus.kind === 'error') return saveStatus.message
      const loading = form !== null && form.getSnapshot().status === 'loading'
      const problem = loading ? null : persistenceProblem(form)
      if (problem !== null) return problem
      if (saveStatus.kind === 'saved') return 'All changes saved.'
      return 'Changes are saved automatically.'
    }

    function FontPage() {
      const { en, zh, code, size } = useFontSettings()
      useEffect(() => { autoScan() }, [])
      const uiStack = [quoteList(en), quoteList(zh)].filter(Boolean).join(', ')
      const codeQ = quoteList(code)
      return createElement('div', { style: { maxWidth: 560, padding: '4px 2px' } },
        createElement('p', {
          style: {
            margin: '0 0 18px', fontSize: px(13), lineHeight: 1.7,
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
          'Customize the interface fonts. The UI font is set separately for Latin and CJK characters (Japanese, Chinese, and Korean); the code font is used for code blocks and inline code. Leave a font empty to use the default, and keep the size offset at 0 for no change. Changes apply everywhere immediately and are saved automatically.',
        ),
        createElement(FontDetectBar, null),
        createElement(Field, {
          label: 'UI font · Latin', listId: 'dsh-custom-fonts-en-list', value: en,
          placeholder: 'e.g. Segoe UI, Arial', options: LATIN_FONTS, kind: 'latin',
          hint: 'Font for Latin letters, digits, and punctuation. Separate several fonts with commas.',
          onChange: (e) => { update({ en: e.target.value }) },
        }),
        createElement(Field, {
          label: 'UI font · CJK', listId: 'dsh-custom-fonts-zh-list', value: zh,
          placeholder: 'e.g. Noto Sans CJK JP, Noto Sans CJK SC', options: CJK_FONTS, kind: 'cjk',
          hint: 'Fallback font for Japanese, Chinese, and Korean text. Choose a font that supports your language. Separate several fonts with commas.',
          onChange: (e) => { update({ zh: e.target.value }) },
        }),
        createElement(Field, {
          label: 'Code font', listId: 'dsh-custom-fonts-code-list', value: code,
          placeholder: 'e.g. Consolas, JetBrains Mono', options: CODE_FONTS, kind: 'code',
          hint: 'Monospace font for code blocks and inline code. Separate several fonts with commas.',
          onChange: (e) => { update({ code: e.target.value }) },
        }),
        createElement('div', { style: { marginBottom: 16 } },
          createElement('div', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 6,
            },
          },
            createElement('label', { htmlFor: 'dsh-custom-fonts-size-input', style: fieldLabelStyle },
              'Font size offset ',
              createElement('span', {
                style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 },
              },
                formatOffset(size),
              ),
            ),
            size !== 0
              ? createElement('button', {
                  type: 'button',
                  title: 'Set the font size offset back to 0',
                  onClick: () => { update({ size: 0 }) },
                  style: {
                    fontSize: px(12), padding: '2px 10px', borderRadius: 6, cursor: 'pointer',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    color: 'var(--dsw-alias-label-primary)',
                  },
                }, 'Reset')
              : null,
          ),
          createElement('input', {
            id: 'dsh-custom-fonts-size-input',
            type: 'range', min: SIZE_MIN, max: SIZE_MAX, step: SIZE_STEP, value: size,
            title: 'Adds this many pixels to every text size (-4 to +8, in 0.5px steps)',
            'aria-valuetext': formatOffset(size),
            onChange: (e) => { update({ size: Number(e.target.value) }) },
            style: { width: '100%' },
          }),
        ),
        createElement('div', {
          style: {
            marginTop: 4, padding: '14px 16px', borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            fontSize: px(15), lineHeight: 1.8, color: 'var(--dsw-alias-label-primary)',
            fontFamily: uiStack || 'inherit',
          },
        },
          'The quick brown fox jumps over the lazy dog 0123456789',
          createElement('br', null),
          // CJK samples intentionally use each script to preview font coverage.
          '日本語：いろはにほへと 漢字 0123456789',
          createElement('br', null),
          '中文：敏捷的棕色狐狸跳过了懒狗 0123456789',
          createElement('br', null),
          '한국어: 다람쥐 헌 쳇바퀴에 타고파 0123456789',
        ),
        createElement('div', {
          style: {
            marginTop: 8, padding: '10px 16px', borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            fontSize: px(13), lineHeight: 1.8, color: 'var(--dsw-alias-label-secondary)',
          },
        },
          createElement('code', {
            style: {
              fontFamily: codeQ || 'inherit',
              color: 'var(--dsw-alias-label-primary)',
              background: 'var(--dsw-alias-bg-layer-2)',
              padding: '2px 6px', borderRadius: 4,
            },
          },
            codeQ
              ? 'const font = "ui + code"; return 0x2f;  // code font preview'
              : 'const demo = "set your code font";  // code font preview',
          ),
        ),
        createElement('button', {
          type: 'button',
          title: 'Clear every font setting and remove the saved values',
          onClick: () => { void resetAll() },
          style: {
            marginTop: 16, padding: '8px 16px', borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)', fontSize: px(13),
          },
        }, 'Restore defaults'),
        createElement('p', {
          role: 'status',
          'data-dsh-custom-fonts-status': saveStatus.kind,
          style: {
            margin: '10px 0 0', fontSize: px(12), lineHeight: 1.6,
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, statusText()),
      )
    }

    function apply(ctx) {
      // `slots` and `configForms` are declared in `inject`, so Cordis only
      // runs apply() once both services are present.
      const slots = ctx.slots
      // Track stylesheet changes; remove the injected styles on unload.
      ctx.effect(() => {
        watchStylesheets()
        return () => {
          unwatchStylesheets()
          removeTags()
          sizeCss = null
        }
      })

      // Stored preferences: adopt once on load, then follow every accepted
      // write. `get` returns the shared form for our namespace, so another
      // editor of the same namespace observes the same values.
      const shared = ctx.configForms.get(NAMESPACE)
      ctx.effect(() => {
        form = shared
        const unsubscribe = shared.subscribe(adopt)
        // Best effort: write an edit still waiting for its quiet period
        // before the page goes away.
        const onPageHide = () => { void flush() }
        window.addEventListener('pagehide', onPageHide)
        adopt()
        return () => {
          window.removeEventListener('pagehide', onPageHide)
          void flush()
          unsubscribe()
          if (form === shared) form = null
        }
      }, 'dsh-custom-fonts: persisted settings')

      // The Host lists its own fonts. Use it only from a loopback page: from
      // another device the Host's fonts are not the ones this browser draws.
      // `connection` is a nested inject, not a plugin dependency, so the
      // page still works in compositions without it.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['connection'], (inner) => {
          const connection = inner.get('connection')
          const rpc = connection && connection.isLoopback === true && connection.rpc && typeof connection.rpc.call === 'function'
            ? connection.rpc : null
          inner.effect(() => {
            hostRpc = rpc
            if (rpc !== null && fontScan.status === 'unsupported') fontScan.status = 'idle'
            // The Fonts page may already be open.
            if (rpc !== null && listeners.size > 0) autoScan()
            notify()
            return () => { if (hostRpc === rpc) hostRpc = null }
          }, 'dsh-custom-fonts: host font list')
        })
      }

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'fonts', order: 25, label: () => 'Fonts' },
        () => createElement(FontPage),
      ))
    }

    return { name: 'dsh-custom-fonts', inject: ['slots', 'configForms'], apply }
  },
})
