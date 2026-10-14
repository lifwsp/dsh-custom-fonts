// Zero-runtime-dependency smoke test for dsh-custom-fonts.
//
// Verifies the load contracts this package ships and the persistence logic:
//   1. host half  — importable ESM exposing { name, inject: [], apply, Config }
//      with every Config field volatile (required by the DSH settings service);
//   2. client half — window.__ModuleLoader__.load({ id, factory }) registers a
//      Cordis surface { name, inject: ['slots', 'configForms'], apply } that
//      registers the settings.section entry and carries a cleanup disposer;
//   3. persistence — stored values are restored on load, edits are applied at
//      once and saved (debounced) through the shared config form, reset unsets
//      the stored overrides, malformed/missing data is tolerated, and save
//      failures are reported instead of thrown;
//   4. size offset — 0.5px steps, offset only declared absolute sizes (never
//      a blanket `body *` rule, which compounded through DOM nesting), keep
//      relative sizes untouched, and leave the page unchanged at 0;
//   5. UI text — the rendered settings page contains no Chinese outside the
//      font-name suggestions and the Chinese preview sample;
//   6. fonts — the OpenType reader (names, coverage, fixed pitch), field-aware
//      suggestion ranking, the host font catalog and its /api route.
//
// scripts/browser-check.mjs measures the same behaviour in a real browser.
//
// The fake form mirrors the public surface of the real ConfigFormController in
// @deepseek-ai/dsh-client-ui-settings: getSnapshot / subscribe / mutate.
//
// Run: node scripts/verify.mjs   (or: npm test)

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(import.meta.dirname, '..')
const SAVE_DELAY_MS = 400
let failures = 0

async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- minimal DOM ---------------------------------------------------------
// `sheets` are fake CSSOM stylesheets standing for the page's own CSS; each
// rule is { selectorText, style: { prop: value | [value, 'important'] } }.
function cssRule(selectorText, decls) {
  const props = Object.keys(decls)
  const style = {
    length: props.length,
    [Symbol.iterator]: () => props[Symbol.iterator](),
    getPropertyValue: (p) => { const v = decls[p]; return v === undefined ? '' : Array.isArray(v) ? v[0] : v },
    getPropertyPriority: (p) => Array.isArray(decls[p]) ? decls[p][1] : '',
  }
  return { selectorText, style, cssRules: null }
}

function installDom(sheets = []) {
  const head = {
    children: [],
    get lastElementChild() { return this.children[this.children.length - 1] || null },
    appendChild(node) { node.parent = this; this.children.push(node) },
  }
  const listeners = new Map()
  globalThis.document = {
    head,
    get styleSheets() { return sheets },
    createElement: (tag) => ({
      tag, tagName: tag.toUpperCase(), nodeType: 1, attrs: {}, textContent: '', parent: null,
      setAttribute(key, value) { this.attrs[key] = value },
      hasAttribute(key) { return key in this.attrs },
      remove() {
        if (this.parent === null) return
        this.parent.children = this.parent.children.filter((node) => node !== this)
        this.parent = null
      },
    }),
  }
  globalThis.window = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type) },
  }
  return {
    css: () => head.children.map((node) => node.textContent).join('\n'),
    styleTexts: () => head.children.map((node) => node.textContent),
    styleCount: () => head.children.length,
    fire: (type) => listeners.get(type)?.(),
    hasListener: (type) => listeners.has(type),
  }
}

// --- minimal React: createElement builds a tree, hooks are inert ----------
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

function render(node) {
  if (node === null || node === undefined || node === false) return null
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  const { props = {} } = node
  for (const key of ['placeholder', 'title', 'aria-label']) if (typeof props[key] === 'string') out.push(props[key])
  // <option> values are font-name suggestions, not UI copy.
  if (node.type !== 'option') for (const child of node.children || []) collectText(child, out)
  return out
}

function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

// --- fake config form (same contract as ConfigFormController) -------------
function createFakeForm({ value, status = 'ready', mode = 'host', accept = true, throws = null, delay = 0 } = {}) {
  const listeners = new Set()
  const form = {
    snap: { status, value, mode, writable: true, revision: 0 },
    calls: [],
    stored: value === undefined ? {} : { ...value },
    getSnapshot() { return this.snap },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    listenerCount: () => listeners.size,
    publish(patch) { form.snap = { ...form.snap, ...patch }; for (const fn of listeners) fn() },
    async mutate(ops) {
      form.calls.push(structuredClone(ops))
      if (delay) await sleep(delay)
      if (throws) throw throws
      if (!accept) { form.publish({}); return false }
      for (const op of ops) {
        if (op.op === 'set') form.stored[op.path[0]] = op.value
        else delete form.stored[op.path[0]]
      }
      const defaults = { en: '', zh: '', code: '', size: 0 }
      form.publish({ value: { ...defaults, ...form.stored }, revision: form.snap.revision + 1 })
      return true
    },
  }
  return form
}

/** Load a fresh copy of the client bundle and mount it against `form`. */
function mountClient(form, sheets, connection) {
  const dom = installDom(sheets)
  let handoff = null
  globalThis.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  // Evaluate the bundle as the browser does (a classic script), fresh each time.
  new Function(readFileSync(join(root, 'client', 'client.js'), 'utf8'))()
  assert(handoff && handoff.id === 'dsh-custom-fonts', 'no registration with id dsh-custom-fonts')
  const surface = handoff.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected require: ' + id)
  })
  const effects = []
  const registrations = []
  const ctx = {
    effect: (fn) => { effects.push(fn()) },
    configForms: { get: (ns) => { assert(ns === 'dsh-custom-fonts', `wrong namespace ${ns}`); return form } },
    inject: (deps, fn) => {
      if (connection === undefined) return
      assert(JSON.stringify(deps) === '["connection"]', `unexpected nested inject ${deps}`)
      fn({ get: () => connection, effect: (f) => { effects.push(f()) } })
    },
    slots: {
      inject: (key, cb) => { assert(key === 'settings.section', `wrong slot ${key}`); cb() },
      register: (opts, component) => { registrations.push({ opts, component }) },
    },
  }
  surface.apply(ctx)
  const page = () => render(registrations[0].component())
  return {
    surface, dom, effects, registrations, page,
    unload: () => { for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose() },
    status: () => findAll(page(), (n) => n.props && n.props.role === 'status')[0],
    input: (listId) => findAll(page(), (n) => n.type === 'input' && n.props.id === listId + '-input')[0],
    slider: () => findAll(page(), (n) => n.type === 'input' && n.props.type === 'range')[0],
    button: (label) => findAll(page(), (n) => n.type === 'button' && n.children.includes(label))[0],
  }
}

// --- host half -----------------------------------------------------------
await check('host half exposes { name, inject: [], apply, Config }', async () => {
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  assert(mod.name === 'dsh-custom-fonts', `name is ${mod.name}`)
  assert(Array.isArray(mod.inject) && mod.inject.length === 0, 'host inject must stay empty')
  assert(typeof mod.apply === 'function', 'apply missing')
  mod.apply() // must not throw
  assert(mod.Config && typeof mod.Config.toJSON === 'function', 'Config schema missing')
})

await check('host Config: four volatile fields with safe defaults', async () => {
  const { Config } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  const fields = Config.dict
  assert(JSON.stringify(Object.keys(fields)) === '["en","zh","code","size"]', 'unexpected fields')
  for (const [key, field] of Object.entries(fields)) {
    assert(field.meta.volatile === true, `${key} is not volatile`)
    assert(typeof field.meta.description === 'string' && !/[\u3400-\u9fff]/.test(field.meta.description), `${key} needs an English description`)
  }
  const defaults = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.meta.default]))
  assert(JSON.stringify(defaults) === '{"en":"","zh":"","code":"","size":0}', `defaults changed: ${JSON.stringify(defaults)}`)
})

// --- client half ---------------------------------------------------------
await check('client registers surface, Fonts page, and cleanup', async () => {
  const c = mountClient(createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } }))
  assert(c.surface.name === 'dsh-custom-fonts', `name is ${c.surface.name}`)
  assert(JSON.stringify(c.surface.inject) === '["slots","configForms"]', 'inject must declare slots and configForms')
  const { opts } = c.registrations[0]
  assert(opts.name === 'settings.section' && opts.id === 'fonts' && opts.label() === 'Fonts', 'settings.section entry not registered')
  assert(c.effects.every((dispose) => typeof dispose === 'function'), 'every effect must return a disposer')
  c.unload()
})

await check('first run: no stored data produces no stylesheet', async () => {
  const c = mountClient(createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } }))
  assert(c.dom.styleCount() === 0, 'unexpected stylesheet for default settings')
  c.unload()
})

await check('stored settings are restored and applied on load', async () => {
  const form = createFakeForm({ value: { en: 'Segoe UI', zh: '微软雅黑', code: 'Consolas', size: 2 } })
  const c = mountClient(form)
  const css = c.dom.css()
  assert(css.includes("body, body * { font-family: 'Segoe UI', '微软雅黑' !important; }"), 'UI stack not applied')
  assert(css.includes("pre, code, kbd, samp { font-family: 'Consolas' !important; }"), 'code font not applied')
  assert(css.includes('--dsh-custom-fonts-size-offset: 2px'), 'size offset not applied')
  assert(!css.includes('1em'), 'size offset must not use a blanket em rule')
  assert(c.input('dsh-custom-fonts-en-list').props.value === 'Segoe UI', 'input does not show stored value')
  assert(c.slider().props.value === 2, 'slider does not show stored value')
  assert(form.calls.length === 0, 'loading must not write')
  c.unload()
})

await check('settings loaded after mount (status loading -> ready) are applied', async () => {
  const form = createFakeForm({ status: 'loading', value: undefined })
  const c = mountClient(form)
  assert(c.dom.styleCount() === 0, 'nothing should apply while loading')
  form.publish({ status: 'ready', value: { en: 'Arial', zh: '', code: '', size: 0 } })
  assert(c.dom.css().includes("'Arial'"), 'late-arriving settings not applied')
  c.unload()
})

await check('missing or malformed stored values fall back safely', async () => {
  const form = createFakeForm({ value: { en: 42, zh: null, code: ['x'], size: 'huge' } })
  const c = mountClient(form)
  assert(c.dom.styleCount() === 0, 'malformed values must not produce CSS')
  form.publish({ value: { size: 99 } })
  assert(c.dom.css().includes('--dsh-custom-fonts-size-offset: 8px'), 'size must clamp to +8')
  form.publish({ value: { size: -1e9 } })
  assert(c.dom.css().includes('--dsh-custom-fonts-size-offset: -4px'), 'size must clamp to -4')
  for (const bad of [Infinity, NaN, '', '2px', {}, [3], true]) {
    form.publish({ value: { size: bad } })
    assert(!/size-offset: (?!0px)/.test(c.dom.css()) && !c.dom.css().includes('NaN') && !c.dom.css().includes('Infinity'), `bad size ${String(bad)} leaked into CSS`)
  }
  form.publish({ value: null })
  assert(c.dom.styleCount() === 0, 'null value must revert to defaults')
  form.publish({ value: { en: "Evil'; } body { display: none } <style>" } })
  assert(!/display:\s*none/.test(c.dom.css().replace(/'[^']*'/g, '')) && !c.dom.css().includes('<'), 'font names must not break out of the declaration')
  c.unload()
})

await check('edits apply immediately and are saved once after the quiet period', async () => {
  const form = createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } })
  const c = mountClient(form)
  for (const value of ['J', 'Je', 'JetBrains Mono']) c.input('dsh-custom-fonts-code-list').props.onChange({ target: { value } })
  assert(c.dom.css().includes("'JetBrains Mono'"), 'edit not applied immediately')
  assert(form.calls.length === 0, 'must not write on every keystroke')
  await sleep(SAVE_DELAY_MS + 100)
  assert(form.calls.length === 1, `expected one write, got ${form.calls.length}`)
  assert(JSON.stringify(form.calls[0]) === '[{"op":"set","path":["code"],"value":"JetBrains Mono"}]', 'write must touch only the edited field')
  assert(form.stored.code === 'JetBrains Mono', 'value not stored')
  assert(c.status().children.includes('All changes saved.'), 'saved status not shown')
  c.unload()
})

await check('several fields edited together are saved in one atomic write', async () => {
  const form = createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } })
  const c = mountClient(form)
  c.input('dsh-custom-fonts-en-list').props.onChange({ target: { value: 'Georgia' } })
  c.slider().props.onChange({ target: { value: '3' } })
  await sleep(SAVE_DELAY_MS + 100)
  assert(form.calls.length === 1 && form.calls[0].length === 2, 'expected one mutate with two ops')
  assert(form.stored.en === 'Georgia' && form.stored.size === 3, 'values not stored')
  c.unload()
})

await check('a Host echo does not undo an edit that is still being typed', async () => {
  const form = createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } })
  const c = mountClient(form)
  c.input('dsh-custom-fonts-en-list').props.onChange({ target: { value: 'Verd' } })
  form.publish({ value: { en: '', zh: '', code: '', size: 0 } }) // unrelated refresh
  assert(c.dom.css().includes("'Verd'"), 'pending edit was overwritten by a refresh')
  await sleep(SAVE_DELAY_MS + 100)
  c.unload()
})

await check('size "Reset" button saves 0', async () => {
  const form = createFakeForm({ value: { en: '', zh: '', code: '', size: 4 } })
  const c = mountClient(form)
  c.button('Reset').props.onClick()
  assert(c.dom.styleCount() === 0, 'offset not cleared immediately')
  await sleep(SAVE_DELAY_MS + 100)
  assert(form.stored.size === 0, 'size reset not saved')
  c.unload()
})

await check('"Restore defaults" clears the page and unsets every stored field', async () => {
  const form = createFakeForm({ value: { en: 'Arial', zh: 'SimSun', code: 'Consolas', size: -2 } })
  const c = mountClient(form)
  const pendingEdit = c.input('dsh-custom-fonts-en-list').props.onChange({ target: { value: 'Arial Black' } })
  void pendingEdit
  await c.button('Restore defaults').props.onClick()
  await sleep(20)
  assert(c.dom.styleCount() === 0, 'styles not removed')
  assert(form.calls.length === 1, `expected one write (pending edit cancelled), got ${form.calls.length}`)
  assert(form.calls[0].every((op) => op.op === 'unset') && form.calls[0].length === 4, 'reset must unset all four fields')
  assert(Object.keys(form.stored).length === 0, 'stored overrides remain')
  await sleep(SAVE_DELAY_MS + 100)
  assert(form.calls.length === 1, 'cancelled edit was written after reset')
  c.unload()
})

await check('save failure is reported and does not throw', async () => {
  const form = createFakeForm({ value: { en: '', zh: '', code: '', size: 0 }, throws: new Error('disk full') })
  const c = mountClient(form)
  c.input('dsh-custom-fonts-en-list').props.onChange({ target: { value: 'Arial' } })
  await sleep(SAVE_DELAY_MS + 100)
  const text = c.status().children.join('')
  assert(text.includes('Could not save font settings') && text.includes('disk full'), `unexpected status: ${text}`)
  assert(c.dom.css().includes("'Arial'"), 'edit should stay applied after a failed save')
  c.unload()
})

await check('refused write (conflict) is reported and the stored value is re-adopted', async () => {
  const form = createFakeForm({ value: { en: 'Arial', zh: '', code: '', size: 0 }, accept: false })
  const c = mountClient(form)
  c.input('dsh-custom-fonts-en-list').props.onChange({ target: { value: 'Georgia' } })
  await sleep(SAVE_DELAY_MS + 100)
  assert(c.status().children.join('').includes('did not accept'), 'conflict not reported')
  assert(c.dom.css().includes("'Arial'"), 'stored value not re-adopted after refusal')
  c.unload()
})

await check('non-persistent connection: edits still apply, user is told they are not saved', async () => {
  const form = createFakeForm({ status: 'unavailable', value: undefined, mode: 'memory' })
  const c = mountClient(form)
  c.input('dsh-custom-fonts-en-list').props.onChange({ target: { value: 'Arial' } })
  assert(c.dom.css().includes("'Arial'"), 'edit not applied')
  assert(c.status().children.join('').includes('cannot save'), 'missing non-persistence notice')
  await sleep(SAVE_DELAY_MS + 100)
  assert(form.calls.length === 0, 'must not write in memory mode')
  c.unload()
})

await check('unload flushes a pending edit and removes listeners and styles', async () => {
  const form = createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } })
  const c = mountClient(form)
  c.input('dsh-custom-fonts-en-list').props.onChange({ target: { value: 'Calibri' } })
  assert(c.dom.hasListener('pagehide'), 'pagehide flush not registered')
  c.unload()
  await sleep(20)
  assert(form.stored.en === 'Calibri', 'pending edit lost on unload')
  assert(form.listenerCount() === 0, 'form subscription leaked')
  assert(!c.dom.hasListener('pagehide'), 'pagehide listener leaked')
  assert(c.dom.styleCount() === 0, 'stylesheet not removed on unload')
})

await check('pagehide flushes a pending edit immediately', async () => {
  const form = createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } })
  const c = mountClient(form)
  c.slider().props.onChange({ target: { value: '5' } })
  c.dom.fire('pagehide')
  await sleep(20)
  assert(form.stored.size === 5, 'pagehide did not flush')
  c.unload()
})

// --- size offset ---------------------------------------------------------
const PAGE_SHEETS = () => [{
  ownerNode: { tagName: 'STYLE', nodeType: 1, hasAttribute: () => false, textContent: '' },
  media: { mediaText: '' },
  cssRules: [
    cssRule('body', { '--dsw-font-xs-13': '13px/20px var(--dsw-font-family)', '--dsw-font-xs-13-font-size': '13px', '--dsw-font-xs-13-line-height': '20px', '--rel': '1.2em' }),
    cssRule('.root', { 'font-size': '14px' }),
    cssRule('.h1', { 'font-size': 'calc(21px + var(--dsh-content-font-delta))', 'line-height': 'calc(30px + var(--dsh-content-font-delta))' }),
    cssRule('.nest', { 'font-size': '1em' }),
    cssRule('.pct', { 'font-size': '100%' }),
    cssRule('.code', { 'font-size': ['.875em', 'important'] }),
    cssRule('.tok', { 'font-size': '', 'line-height': '', 'font': 'var(--dsw-font-xs-13)' }),
    cssRule('.gap', { 'font-size': '0' }),
    cssRule('.relvar', { 'font-size': 'var(--rel)' }),
    cssRule('.unitless', { 'line-height': '1.5' }),
    cssRule('.colour', { color: 'red' }),
  ],
}]

await check('offset 0.5px steps: values snap to the 0.5px grid', async () => {
  const form = createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } })
  const c = mountClient(form, PAGE_SHEETS())
  assert(c.slider().props.step === 0.5, 'slider step must be 0.5')
  for (const [input, expected] of [['0.5', 0.5], ['-0.5', -0.5], ['1.25', 1.5], ['-2', -2], ['0.2', 0], ['-0.2', 0]]) {
    c.slider().props.onChange({ target: { value: input } })
    assert(c.slider().props.value === expected, `${input} -> ${c.slider().props.value}, expected ${expected}`)
    assert(Object.is(c.slider().props.value, expected), `${input} must not yield -0`)
  }
  c.slider().props.onChange({ target: { value: '2.5' } })
  assert(c.dom.css().includes('--dsh-custom-fonts-size-offset: 2.5px'), 'half-pixel offset not applied')
  assert(collectText(c.page()).includes('+2.5px'), 'label must show +2.5px')
  await sleep(SAVE_DELAY_MS + 100)
  assert(form.stored.size === 2.5, `stored ${form.stored.size}`)
  c.unload()
})

await check('stored integer offsets from older versions keep working', async () => {
  const c = mountClient(createFakeForm({ value: { en: '', zh: '', code: '', size: 3 } }), PAGE_SHEETS())
  assert(c.slider().props.value === 3 && c.dom.css().includes('--dsh-custom-fonts-size-offset: 3px'), 'integer offset not restored')
  c.unload()
})

await check('offset 0 injects no size rules at all', async () => {
  const c = mountClient(createFakeForm({ value: { en: 'Arial', zh: '', code: '', size: 0 } }), PAGE_SHEETS())
  const css = c.dom.css()
  assert(!css.includes('font-size') && !css.includes('size-offset'), `unexpected size CSS at 0:\n${css}`)
  c.unload()
})

await check('regression: offset never targets every element with a relative size', async () => {
  for (const size of [0.5, -0.5, 2, -2, 8, -4]) {
    const c = mountClient(createFakeForm({ value: { en: 'Arial', zh: 'Meiryo', code: 'Consolas', size } }), PAGE_SHEETS())
    const css = c.dom.css()
    // The bug: `body, body * { font-size: calc(1em + N) }` compounds per level.
    for (const block of css.split('}')) {
      if (/(^|[\s,])(\*|body \*)\s*\{/.test(block + '{') && /font-size/.test(block)) throw new Error(`blanket font-size rule at ${size}: ${block}`)
    }
    assert(!/font-size:\s*calc\(\s*1em/.test(css), 'calc(1em + N) is cumulative')
    assert(css.includes('--dsh-custom-fonts-size-offset: ' + size + 'px'), `offset variable missing for ${size}`)
    c.unload()
  }
})

await check('offset twins: absolute sizes shift, relative sizes are repeated verbatim', async () => {
  const c = mountClient(createFakeForm({ value: { en: '', zh: '', code: '', size: 2 } }), PAGE_SHEETS())
  const css = c.dom.css()
  const OFF = 'var(--dsh-custom-fonts-size-offset, 0px)'
  const rule = (sel) => { const m = new RegExp('(^|\\n)' + sel.replace('.', '\\.') + ' \\{([^}]*)\\}').exec(css); return m ? m[2] : null }
  assert(css.includes('html { font-size: calc(100% + ' + OFF + '); }'), 'root size not offset')
  assert(rule('.root').includes('font-size: calc(14px + ' + OFF + ')'), '.root not offset')
  assert(rule('.h1').includes('font-size: calc(calc(21px + var(--dsh-content-font-delta)) + ' + OFF + ')'), '.h1 size not offset')
  assert(rule('.h1').includes('line-height: calc(calc(30px + var(--dsh-content-font-delta)) + ' + OFF + ')'), '.h1 line-height not offset')
  assert(rule('.tok').includes('font-size: calc(var(--dsw-font-xs-13-font-size) + ' + OFF + ')'), 'font: var(--token) size not offset')
  assert(rule('.tok').includes('line-height: calc(var(--dsw-font-xs-13-line-height) + ' + OFF + ')'), 'font: var(--token) line-height not offset')
  // Relative sizes inherit the parent's already-offset size: offsetting
  // them again would compound. They are repeated only to keep tie order.
  assert(rule('.nest').trim() === 'font-size: 1em;', `.nest changed: ${rule('.nest')}`)
  assert(rule('.pct').trim() === 'font-size: 100%;', `.pct changed: ${rule('.pct')}`)
  assert(rule('.code').trim() === 'font-size: .875em !important;', `.code changed: ${rule('.code')}`)
  assert(rule('.relvar').trim() === 'font-size: var(--rel);', 'a variable holding em must not be offset')
  assert(rule('.gap').trim() === 'font-size: 0;', 'zero sizes must stay zero')
  assert(rule('.unitless').trim() === 'line-height: 1.5;', 'unitless line-height must not be offset')
  assert(rule('.colour') === null, 'rules without sizes must not be mirrored')
  // Changing the offset only rewrites the variable, not the twin rules.
  const twins = c.dom.styleTexts().find((t) => t.includes('html { font-size'))
  c.slider().props.onChange({ target: { value: '-1.5' } })
  assert(c.dom.styleTexts().find((t) => t.includes('html { font-size')) === twins, 'twin rules must not be rebuilt per slider step')
  assert(c.dom.css().includes('--dsh-custom-fonts-size-offset: -1.5px'), 'negative half-pixel offset missing')
  c.slider().props.onChange({ target: { value: '0' } })
  assert(!c.dom.css().includes('font-size'), 'twins must be removed at 0')
  await sleep(SAVE_DELAY_MS + 100)
  c.unload()
})

await check('settings page sizes follow the offset (live preview)', async () => {
  const c = mountClient(createFakeForm({ value: { en: '', zh: '', code: '', size: 1 } }), PAGE_SHEETS())
  const sizes = findAll(c.page(), (n) => n.props && n.props.style && n.props.style.fontSize !== undefined).map((n) => n.props.style.fontSize)
  assert(sizes.length > 0 && sizes.every((s) => typeof s === 'string' && s.includes('--dsh-custom-fonts-size-offset')), `inline sizes: ${sizes}`)
  c.unload()
})

// --- UI text -------------------------------------------------------------
await check('settings page UI text is English (no untranslated Chinese)', async () => {
  const form = createFakeForm({ value: { en: '', zh: '', code: 'Consolas', size: 1 } })
  const c = mountClient(form)
  const allowed = ['日本語：いろはにほへと 漢字 0123456789', '中文：敏捷的棕色狐狸跳过了懒狗 0123456789', '한국어: 다람쥐 헌 쳇바퀴에 타고파 0123456789'] // Intentional CJK preview samples
  const leaks = collectText(c.page()).filter((text) => /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(text) && !allowed.includes(text))
  assert(leaks.length === 0, `untranslated text: ${JSON.stringify(leaks)}`)
  assert(c.registrations[0].opts.label() === 'Fonts', 'section label not English')
  const text = collectText(c.page()).join(' ')
  assert(text.includes('UI font · Latin') && text.includes('UI font · CJK'), 'script-neutral labels missing')
  for (const sample of allowed) assert(text.includes(sample), 'CJK preview missing')
  c.unload()
})

await check('client source has no Chinese outside font names and the preview sample', async () => {
  const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  const fontLists = /const (LATIN|CJK|CODE)_FONTS = \[[\s\S]*?\]|const FONT_ALIASES = \{[\s\S]*?\n    \}/g
  const stripped = source.replace(fontLists, '').replace(/'日本語：[^']*'|'中文：[^']*'|'한국어:[^']*'/g, '')
  const match = stripped.match(/[\u3400-\u9fff]+/)
  assert(match === null, `Chinese text left in client source: ${match && match[0]}`)
})

// --- font search helpers: extracted from the client source ----------------
function loadHelpers() {
  const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  const aliases = source.match(/const FONT_ALIASES = \{[\s\S]*?\n    \}/)[0]
  const block = source.match(/\/\/ BEGIN pure font helpers[^\n]*\n([\s\S]*?)\/\/ END pure font helpers/)[1]
  return new Function(`${aliases}\n${block}\nreturn { foldText, filterFonts, splitLastToken, readFontFaces, mergeFamilies, learnFamilies, fontBadges, localNames, fontInfo, aliasesOf }`)()
}

await check('font search: Japanese names, width forms, kana, separators', async () => {
  const h = loadHelpers()
  const pool = ['Arial', 'Meiryo', 'MS Gothic', 'Yu Gothic', 'Yu Mincho', 'Noto Sans CJK JP']
  const names = (q) => h.filterFonts(pool, q, 50).map((m) => m.name)
  assert(names('游ゴシック').join() === 'Yu Gothic', `游ゴシック -> ${names('游ゴシック')}`)
  assert(names('めいりお').join() === 'Meiryo', 'hiragana should match katakana alias')
  assert(names('ＭＳ').includes('MS Gothic'), 'full-width ＭＳ should match MS Gothic')
  assert(names('ms gothic').join() === 'MS Gothic' && names('msgothic').join() === 'MS Gothic', 'separators ignored')
  assert(names('YU').join() === 'Yu Gothic,Yu Mincho', 'prefix matches keep order')
  assert(names('gothic').join() === 'MS Gothic,Yu Gothic', 'substring matches')
  const hit = h.filterFonts(pool, '明朝', 50)[0]
  assert(hit.name === 'Yu Mincho' && hit.alias === '游明朝', 'alias shown for the matching name')
  assert(h.filterFonts(pool, 'zzz', 50).length === 0, 'no false positives')
  assert(h.filterFonts(pool, '', 3).length === 3, 'limit applies to the empty query')
})

await check('font search: comma-separated lists complete the last entry only', async () => {
  const h = loadHelpers()
  assert(JSON.stringify(h.splitLastToken('Inter, Se')) === JSON.stringify({ head: 'Inter, ', query: 'Se' }), 'split')
  assert(JSON.stringify(h.splitLastToken('Yu')) === JSON.stringify({ head: '', query: 'Yu' }), 'single')
})

// --- OpenType reader ------------------------------------------------------
const utf16 = (text) => { const b = Buffer.alloc(text.length * 2); for (let i = 0; i < text.length; i++) b.writeUInt16BE(text.charCodeAt(i), i * 2); return b }

/**
 * Build a minimal sfnt with `name` records [platform, encoding, language, nameID, Buffer],
 * plus optional OS/2 (ulUnicodeRange2, ulCodePageRange1, PANOSE) and post (isFixedPitch).
 * `base` is the absolute offset the font will sit at (for .ttc members).
 */
function makeFont({ names, os2, post }, base = 0) {
  const strings = Buffer.concat(names.map((n) => n[4]))
  const name = Buffer.alloc(6 + 12 * names.length)
  name.writeUInt16BE(0, 0); name.writeUInt16BE(names.length, 2); name.writeUInt16BE(6 + 12 * names.length, 4)
  let off = 0
  names.forEach((n, i) => {
    ;[n[0], n[1], n[2], n[3], n[4].length, off].forEach((v, k) => name.writeUInt16BE(v, 6 + 12 * i + 2 * k))
    off += n[4].length
  })
  const tables = [['name', Buffer.concat([name, strings])]]
  if (os2) {
    const t = Buffer.alloc(86)
    t.writeUInt16BE(1, 0)
    if (os2.panose) os2.panose.forEach((v, i) => t.writeUInt8(v, 32 + i))
    t.writeUInt32BE(1, 42) // Basic Latin
    t.writeUInt32BE((os2.range2 || 0) >>> 0, 46)
    t.writeUInt32BE((os2.codePages1 || 0) >>> 0, 78)
    tables.push(['OS/2', t])
  }
  if (post !== undefined) { const t = Buffer.alloc(32); t.writeUInt32BE(post ? 1 : 0, 12); tables.push(['post', t]) }
  const dir = Buffer.alloc(12 + 16 * tables.length)
  dir.writeUInt32BE(0x00010000, 0); dir.writeUInt16BE(tables.length, 4)
  let at = base + dir.length
  tables.forEach(([tag, data], i) => {
    dir.write(tag, 12 + 16 * i, 'latin1'); dir.writeUInt32BE(at, 12 + 16 * i + 8); dir.writeUInt32BE(data.length, 12 + 16 * i + 12)
    at += data.length
  })
  return Buffer.concat([dir, ...tables.map((t) => t[1])])
}
const blobReader = (buffer) => { const blob = new Blob([buffer]); return async (from, to) => new DataView(await blob.slice(from, to).arrayBuffer()) }

await check('font reader: names in every language, typographic family first, TTC', async () => {
  const h = loadHelpers()
  const font = makeFont({ names: [
    [3, 1, 0x409, 1, utf16('Hiragino Sans W3')], [3, 1, 0x409, 16, utf16('Hiragino Sans')],
    [3, 1, 0x411, 1, utf16('ヒラギノ角ゴシック W3')], [3, 1, 0x411, 16, utf16('ヒラギノ角ゴシック')],
  ] })
  const one = await h.readFontFaces(blobReader(font))
  assert(one.length === 1 && one[0].family === 'Hiragino Sans', `typographic family: ${JSON.stringify(one)}`)
  assert(one[0].names.includes('Hiragino Sans W3') && one[0].locals.join() === 'ヒラギノ角ゴシック', `names: ${JSON.stringify(one[0])}`)

  // Mac platform records (Shift_JIS) are read too.
  const sjis = Buffer.from([0x83, 0x81, 0x83, 0x43, 0x83, 0x8a, 0x83, 0x49]) // メイリオ
  const mac = makeFont({ names: [[1, 0, 0, 1, Buffer.from('Meiryo', 'latin1')], [1, 1, 11, 1, sjis]] })
  const m = await h.readFontFaces(blobReader(mac))
  assert(m.length === 1 && m[0].family === 'Meiryo' && m[0].locals[0] === 'メイリオ', `mac records: ${JSON.stringify(m)}`)

  const a = { names: [[3, 1, 0x409, 1, utf16('Meiryo')], [3, 1, 0x411, 1, utf16('メイリオ')]] }
  const b = { names: [[3, 1, 0x409, 1, utf16('Meiryo UI')], [3, 1, 0x411, 1, utf16('メイリオ UI')]] }
  const f1 = makeFont(a, 20)
  const f2 = makeFont(b, 20 + f1.length)
  const head = Buffer.alloc(20)
  head.write('ttcf', 0, 'latin1'); head.writeUInt32BE(0x10000, 4); head.writeUInt32BE(2, 8)
  head.writeUInt32BE(20, 12); head.writeUInt32BE(20 + f1.length, 16)
  const ttc = await h.readFontFaces(blobReader(Buffer.concat([head, f1, f2])))
  assert(ttc.length === 2 && ttc[1].family === 'Meiryo UI' && ttc[1].locals[0] === 'メイリオ UI', `ttc: ${JSON.stringify(ttc)}`)
  assert((await h.readFontFaces(blobReader(Buffer.from('not a font file!')))).length === 0, 'garbage ignored')
})

await check('font reader: CJK coverage from OS/2, fixed pitch from post/PANOSE', async () => {
  const h = loadHelpers()
  const en = (n) => [[3, 1, 0x409, 1, utf16(n)]]
  const jp = await h.readFontFaces(blobReader(makeFont({ names: en('JP Font'), os2: { codePages1: 1 << 17 } })))
  assert(jp[0].scripts.join() === 'ja' && jp[0].mono === false, `ja: ${JSON.stringify(jp[0])}`)
  const sc = await h.readFontFaces(blobReader(makeFont({ names: en('SC Font'), os2: { codePages1: 1 << 18, range2: 1 << 27 } })))
  assert(sc[0].scripts.join() === 'zh-Hans', `zh-Hans: ${JSON.stringify(sc[0])}`)
  const ko = await h.readFontFaces(blobReader(makeFont({ names: en('KR Font'), os2: { range2: 1 << 24 } })))
  assert(ko[0].scripts.join() === 'ko', `ko: ${JSON.stringify(ko[0])}`)
  const latin = await h.readFontFaces(blobReader(makeFont({ names: en('Latin Font'), os2: {} })))
  assert(latin[0].scripts.length === 0 && latin[0].latin === true, `latin: ${JSON.stringify(latin[0])}`)
  const monoPost = await h.readFontFaces(blobReader(makeFont({ names: en('Mono A'), os2: {}, post: true })))
  const monoPanose = await h.readFontFaces(blobReader(makeFont({ names: en('Mono B'), os2: { panose: [2, 0, 0, 9] } })))
  assert(monoPost[0].mono && monoPanose[0].mono, 'post.isFixedPitch and PANOSE monospaced both count')
})

await check('client carries an exact copy of lib/font-tables.js', async () => {
  const lib = readFileSync(join(root, 'lib', 'font-tables.js'), 'utf8')
  const client = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  const body = (text) => text.match(/\/\/ BEGIN font-tables[^\n]*\n([\s\S]*?)\/\/ END font-tables/)[1]
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
  assert(body(lib) === body(client), 'client/client.js font-tables block differs from lib/font-tables.js; copy it over')
})

await check('suggestions: fonts that fit the field come first, with badges', async () => {
  const h = loadHelpers()
  h.learnFamilies([
    { name: 'Arial', aka: [], locals: [], scripts: [], mono: false, latin: true },
    { name: 'Hiragino Sans', aka: [], locals: ['ヒラギノ角ゴシック'], scripts: ['ja'], mono: false, latin: true },
    { name: 'Menlo', aka: [], locals: [], scripts: [], mono: true, latin: true },
    { name: 'PlemolJP35', aka: [], locals: [], scripts: ['ja'], mono: true, latin: true },
  ])
  const pool = ['Arial', 'Hiragino Sans', 'Menlo', 'PlemolJP35']
  const names = (q, kind) => h.filterFonts(pool, q, 50, kind).map((m) => m.name).join()
  assert(names('', 'cjk') === 'Hiragino Sans,PlemolJP35,Arial,Menlo', `cjk: ${names('', 'cjk')}`)
  assert(names('', 'code') === 'Menlo,PlemolJP35,Arial,Hiragino Sans', `code: ${names('', 'code')}`)
  assert(names('', 'latin') === pool.join(), 'latin keeps the plain order')
  assert(names('ひらぎの', 'cjk') === 'Hiragino Sans', 'localized names learned from the catalog are searchable')
  h.learnFamilies([{ name: 'Lucida Grande', aka: [], locals: [], scripts: [], mono: false, latin: true }])
  const lucida = h.filterFonts([...pool, 'Lucida Grande'], 'l', 50, 'code').map((m) => m.name).join()
  assert(lucida === 'Menlo,PlemolJP35,Lucida Grande,Arial', `suitable substring matches beat an unsuitable prefix match: ${lucida}`)
  assert(h.fontBadges('PlemolJP35').join() === 'JP,Mono' && h.fontBadges('Arial').length === 0, 'badges')
  assert(h.fontBadges('Unknown').length === 0, 'unknown families have no badges')
})

await check('client: a loopback page lists the Host fonts; a remote page does not ask', async () => {
  const families = [
    { name: 'Hiragino Sans', aka: [], locals: ['ヒラギノ角ゴシック'], scripts: ['ja'], mono: false, latin: true },
    { name: 'Menlo', aka: [], locals: [], scripts: [], mono: true, latin: true },
  ]
  const calls = []
  const rpc = { call: async (channel, method, payload) => { calls.push([channel, method]); return { ok: true, value: { families, files: 2, ms: 1 } } } }
  const local = mountClient(createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } }), undefined, { isLoopback: true, rpc })
  const text = () => collectText(local.page()).join(' ')
  assert(text().includes('Detect installed fonts'), 'button shown before the first scan')
  local.button('Detect installed fonts').props.onClick()
  await sleep(0)
  await sleep(0)
  assert(calls.length === 1 && calls[0][0] === '/api' && calls[0][1] === 'dsh-custom-fonts.list', `host asked once: ${JSON.stringify(calls)}`)
  assert(text().includes('2 installed fonts found on this computer'), `status: ${text()}`)
  local.unload()

  const remoteCalls = []
  const remote = mountClient(createFakeForm({ value: { en: '', zh: '', code: '', size: 0 } }), undefined,
    { isLoopback: false, rpc: { call: async () => { remoteCalls.push(1); return { ok: false } } } })
  remote.button('Detect installed fonts').props.onClick()
  await sleep(0)
  assert(remoteCalls.length === 0, 'a non-loopback page never asks the Host for its fonts')
  assert(collectText(remote.page()).join(' ').includes('cannot list installed fonts'), 'falls back to the browser path')
  remote.unload()
})

// --- host font catalog ------------------------------------------------------
await check('host catalog: lists, merges, caches per file, and reuses fresh results', async () => {
  const { createFontCatalog } = await import(pathToFileURL(join(root, 'lib', 'fonts.js')).href)
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-custom-fonts-'))
  try {
    const regular = join(dir, 'a.ttf'), bold = join(dir, 'b.otf'), junk = join(dir, 'c.ttf')
    writeFileSync(regular, makeFont({ names: [[3, 1, 0x409, 16, utf16('Test Sans')], [3, 1, 0x411, 16, utf16('テスト')]], os2: { codePages1: 1 << 17 } }))
    writeFileSync(bold, makeFont({ names: [[3, 1, 0x409, 1, utf16('Test Sans Bold')], [3, 1, 0x409, 16, utf16('Test Sans')]], os2: {} }))
    writeFileSync(junk, 'not a font')
    let described = 0
    const catalog = createFontCatalog({
      persist: false,
      listFiles: async () => [regular, bold, junk, join(dir, 'missing.ttf')],
      describe: async (path) => { described++; const { readFontFaces } = await import(pathToFileURL(join(root, 'lib', 'font-tables.js')).href); const buf = readFileSync(path); return readFontFaces(async (f, t) => new DataView(buf.buffer, buf.byteOffset + Math.min(f, buf.length), Math.max(0, Math.min(t, buf.length) - Math.min(f, buf.length)))) },
    })
    const [first, again] = await Promise.all([catalog.list(), catalog.list()])
    assert(first === again, 'concurrent calls share one scan')
    assert(first.families.length === 1, `one merged family: ${JSON.stringify(first.families)}`)
    const f = first.families[0]
    assert(f.name === 'Test Sans' && f.locals.join() === 'テスト' && f.scripts.join() === 'ja' && f.aka.includes('Test Sans Bold'), `merged: ${JSON.stringify(f)}`)
    assert(described === 3, `each existing file read once, got ${described}`)
    assert((await catalog.list()) === first, 'fresh result reused')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('host route: answers dsh-custom-fonts.list through connection.fetch', async () => {
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  const routes = []
  const ctx = {
    inject: (deps, fn) => {
      assert(JSON.stringify(deps) === '["connection"]', 'route waits for connection only')
      fn({ get: () => ({ fetch: { register: (route) => { routes.push(route); return async () => {} } } }), effect: (f) => f() })
    },
  }
  mod.apply(ctx)
  assert(routes.length === 1 && routes[0].path === '/api/dsh-custom-fonts.list' && routes[0].methods.join() === 'POST', 'route registered')
  const bad = await routes[0].fetch(new Request('http://x/api/dsh-custom-fonts.list', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'other' }) }))
  const badBody = await bad.json()
  assert(badBody.rpcId === 'r1' && badBody.result.ok === false, 'mismatched method rejected')
})

// --- manifest self-consistency -------------------------------------------
await check('package.json dsh fields are consistent', async () => {
  const manifest = require(join(root, 'package.json'))
  for (const file of [manifest.main, manifest.dsh?.bundle?.patch, manifest.exports?.['./client']]) {
    assert(typeof file === 'string' && file.startsWith('./'), `bad artifact ref: ${file}`)
    assert(existsSync(join(root, file)), `missing artifact: ${file}`)
  }
  assert(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform must be web')
  assert(manifest.peerDependencies?.['@deepseek-ai/schemastery'], 'schemastery must be a peer (shared with the host)')
  assert(!manifest.dependencies?.['@deepseek-ai/schemastery'], 'schemastery must not be bundled as a dependency')
})

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
