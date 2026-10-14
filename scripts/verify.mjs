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
//      font-name suggestions and the Chinese preview sample.
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
function mountClient(form, sheets) {
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
    input: (listId) => findAll(page(), (n) => n.type === 'input' && n.props.list === listId)[0],
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
  const fontLists = /const (LATIN|CJK|CODE)_FONTS = \[[\s\S]*?\]/g
  const stripped = source.replace(fontLists, '').replace(/'日本語：[^']*'|'中文：[^']*'|'한국어:[^']*'/g, '')
  const match = stripped.match(/[\u3400-\u9fff]+/)
  assert(match === null, `Chinese text left in client source: ${match && match[0]}`)
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
