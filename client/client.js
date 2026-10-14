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

    function Field(props) {
      const inputId = props.listId + '-input'
      return createElement('div', { style: { marginBottom: 14 } },
        createElement('label', { htmlFor: inputId, style: fieldLabelStyle, title: props.hint }, props.label),
        createElement('input', {
          id: inputId, type: 'text', list: props.listId, value: props.value,
          placeholder: props.placeholder, onChange: props.onChange, title: props.hint,
          spellCheck: false, autoComplete: 'off',
          style: inputStyle,
        }),
        createElement('datalist', { id: props.listId },
          props.options.map((name) => createElement('option', { key: name, value: name }))
        ),
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
        createElement(Field, {
          label: 'UI font · Latin', listId: 'dsh-custom-fonts-en-list', value: en,
          placeholder: 'e.g. Segoe UI, Arial', options: LATIN_FONTS,
          hint: 'Font for Latin letters, digits, and punctuation. Separate several fonts with commas.',
          onChange: (e) => { update({ en: e.target.value }) },
        }),
        createElement(Field, {
          label: 'UI font · CJK', listId: 'dsh-custom-fonts-zh-list', value: zh,
          placeholder: 'e.g. Noto Sans CJK JP, Noto Sans CJK SC', options: CJK_FONTS,
          hint: 'Fallback font for Japanese, Chinese, and Korean text. Choose a font that supports your language. Separate several fonts with commas.',
          onChange: (e) => { update({ zh: e.target.value }) },
        }),
        createElement(Field, {
          label: 'Code font', listId: 'dsh-custom-fonts-code-list', value: code,
          placeholder: 'e.g. Consolas, JetBrains Mono', options: CODE_FONTS,
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

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'fonts', order: 25, label: () => 'Fonts' },
        () => createElement(FontPage),
      ))
    }

    return { name: 'dsh-custom-fonts', inject: ['slots', 'configForms'], apply }
  },
})
