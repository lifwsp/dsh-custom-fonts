/**
 * dsh-custom-fonts — client bundle.
 *
 * Customizes the global UI fonts on a settings page:
 *   - "UI font · English" for Latin characters and "UI font · Chinese" for
 *     CJK glyphs, resolved through a CSS font-family fallback chain (English
 *     first, so Latin runs through the English font and Han characters fall
 *     back to the Chinese one — the standard way to split fonts by script
 *     without any language detection);
 *   - "Code font": a separate mono face for `pre`/`code`/`kbd`/`samp`
 *     regions, applied with priority over the UI stack;
 *   - "Font size offset": a global px offset (range -4..+8) applied as
 *     `calc(1em + Npx)` relative to each element's own size — every level
 *     shifts by exactly N, so there is no cascade blow-up.
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
    /** Quiet period before an edit is written to the Host settings document. */
    const SAVE_DELAY_MS = 400

    // Applied font state. Lives in the bundle closure so it survives
    // settings-page navigation; the persisted copy lives in the Host.
    const state = { ...DEFAULTS }
    let styleTag = null

    const EN_FONTS = [
      'Segoe UI', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
      'Courier New', 'Consolas', 'Verdana', 'Calibri',
    ]
    const ZH_FONTS = [
      '微软雅黑', 'Microsoft YaHei', '宋体', 'SimSun', '黑体', 'SimHei',
      '楷体', 'KaiTi', '仿宋', 'FangSong', '思源黑体', 'Noto Sans CJK SC',
      '苹方', 'PingFang SC',
    ]
    const CODE_FONTS = [
      'Consolas', 'Courier New', 'Menlo', 'Monaco', 'SF Mono',
      'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro',
      'DejaVu Sans Mono', 'Sarasa Mono SC', '等距更纱黑体',
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

    // The global font CSS. Order matters:
    //   1. UI stack (latin → chinese fallback)
    //   2. code stack, later and equally specific, wins inside code regions
    //   3. size offset, relative to each element's own size
    function buildCss(o) {
      const enQ = quoteList(o.en)
      const zhQ = quoteList(o.zh)
      const codeQ = quoteList(o.code)
      const offset = Number(o.size) || 0
      const rules = []
      const vars = []
      if (enQ) vars.push('--dsh-custom-fonts-en: ' + enQ)
      if (zhQ) vars.push('--dsh-custom-fonts-zh: ' + zhQ)
      const uiStack = [enQ, zhQ].filter(Boolean).join(', ')
      if (uiStack) {
        rules.push('body, body * { font-family: ' + uiStack + ' !important; }')
      }
      if (codeQ) {
        rules.push('pre, code, kbd, samp { font-family: ' + codeQ + ' !important; }')
      }
      if (offset !== 0) {
        const sign = offset > 0 ? '+' : '-'
        rules.push('body, body * { font-size: calc(1em ' + sign + ' ' + Math.abs(offset) + 'px) !important; }')
      }
      if (rules.length === 0) return null
      return (vars.length > 0 ? ':root { ' + vars.join('; ') + '; }\n' : '') + rules.join('\n')
    }

    // Apply or revert everything: replaces the injected <style> each time.
    function applyFonts(next) {
      Object.assign(state, next)
      if (styleTag !== null) { styleTag.remove(); styleTag = null }
      const css = buildCss(state)
      if (css !== null) {
        const tag = document.createElement('style')
        tag.setAttribute('data-dsh-custom-fonts', '')
        tag.textContent = css
        document.head.appendChild(tag)
        styleTag = tag
      }
    }

    // ---------------------------------------------------------------------
    // Persistence
    // ---------------------------------------------------------------------

    function normalizeFont(value) {
      return typeof value === 'string' ? value : ''
    }

    function normalizeSize(value) {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return 0
      return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n)))
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

    const fieldLabelStyle = {
      display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6,
      color: 'var(--dsw-alias-label-primary)',
    }
    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '8px 10px',
      borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
      fontSize: 14, outline: 'none',
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
            margin: '0 0 18px', fontSize: 13, lineHeight: 1.7,
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
          'Customize the interface fonts. The UI font is set separately for English (Latin) and Chinese characters; the code font is used for code blocks and inline code. Leave a font empty to use the default, and keep the size offset at 0 for no change. Changes apply everywhere immediately and are saved automatically.',
        ),
        createElement(Field, {
          label: 'UI font · English', listId: 'dsh-custom-fonts-en-list', value: en,
          placeholder: 'e.g. Segoe UI, Arial', options: EN_FONTS,
          hint: 'Font for Latin letters, digits, and punctuation. Separate several fonts with commas.',
          onChange: (e) => { update({ en: e.target.value }) },
        }),
        createElement(Field, {
          label: 'UI font · Chinese', listId: 'dsh-custom-fonts-zh-list', value: zh,
          placeholder: 'e.g. Microsoft YaHei, Noto Sans CJK SC', options: ZH_FONTS,
          hint: 'Font for Chinese characters, used after the English font. Separate several fonts with commas.',
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
                size > 0 ? '+' + size + 'px' : size + 'px',
              ),
            ),
            size !== 0
              ? createElement('button', {
                  type: 'button',
                  title: 'Set the font size offset back to 0',
                  onClick: () => { update({ size: 0 }) },
                  style: {
                    fontSize: 12, padding: '2px 10px', borderRadius: 6, cursor: 'pointer',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    color: 'var(--dsw-alias-label-primary)',
                  },
                }, 'Reset')
              : null,
          ),
          createElement('input', {
            id: 'dsh-custom-fonts-size-input',
            type: 'range', min: SIZE_MIN, max: SIZE_MAX, step: 1, value: size,
            title: 'Adds this many pixels to every text size (-4 to +8)',
            onChange: (e) => { update({ size: Number(e.target.value) }) },
            style: { width: '100%' },
          }),
        ),
        createElement('div', {
          style: {
            marginTop: 4, padding: '14px 16px', borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            fontSize: 15, lineHeight: 1.8, color: 'var(--dsw-alias-label-primary)',
            fontFamily: uiStack || 'inherit',
          },
        },
          'The quick brown fox jumps over the lazy dog 0123456789',
          createElement('br', null),
          // Chinese sample text, kept as-is to preview the Chinese font.
          '敏捷的棕色狐狸跳过了懒狗 0123456789',
        ),
        createElement('div', {
          style: {
            marginTop: 8, padding: '10px 16px', borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            fontSize: 13, lineHeight: 1.8, color: 'var(--dsw-alias-label-secondary)',
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
            color: 'var(--dsw-alias-label-primary)', fontSize: 13,
          },
        }, 'Restore defaults'),
        createElement('p', {
          role: 'status',
          'data-dsh-custom-fonts-status': saveStatus.kind,
          style: {
            margin: '10px 0 0', fontSize: 12, lineHeight: 1.6,
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, statusText()),
      )
    }

    function apply(ctx) {
      // `slots` and `configForms` are declared in `inject`, so Cordis only
      // runs apply() once both services are present.
      const slots = ctx.slots
      // Remove the injected stylesheet when the plugin is unloaded.
      ctx.effect(() => () => {
        if (styleTag !== null) { styleTag.remove(); styleTag = null }
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
