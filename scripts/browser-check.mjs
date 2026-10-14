// Real-browser regression test for the font size offset.
//
// Builds a page whose stylesheets follow DeepSeek Harness conventions (design
// tokens on <body>, `font: var(--token)` shorthands, fixed px sizes, em-based
// inline code, deep nesting), loads the real client bundle, and measures the
// computed font sizes in headless Chrome or Edge for several offsets.
//
// It also measures the pre-fix rule (`body, body * { font-size: calc(1em + N) }`)
// to document the cumulative blow-up it caused.
//
// Run: node scripts/browser-check.mjs   (or: npm run test:browser)
// Set CHROME_PATH to pick a browser. Exits 0 with a notice if none is found.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..')

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean)
const browser = candidates.find((path) => existsSync(path))
if (!browser) {
  console.log('skip: no Chrome/Edge found (set CHROME_PATH to run the browser check)')
  process.exit(0)
}

// Stylesheet modelled on the DSH Web UI (values copied from its theme tokens).
const PAGE_CSS = `
body {
  --dsh-content-font-delta: calc(var(--dsh-content-font-size, 14px) - 14px);
  --dsw-font-family: system-ui, sans-serif;
  --ds-font-family-code: Consolas, monospace;
  --dsw-font-xs-13: 13px/20px var(--dsw-font-family);
  --dsw-font-xs-13-line-height: 20px;
  --dsw-font-xs-13-font-size: 13px;
  --dsw-font-markdown-base: var(--dsh-content-font-size, 14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family);
  --dsw-font-markdown-base-font-size: var(--dsh-content-font-size, 14px);
  --dsw-font-markdown-base-line-height: calc(24px + var(--dsh-content-font-delta));
  --dsw-font-markdown-h1: 700 calc(21px + var(--dsh-content-font-delta)) / calc(30px + var(--dsh-content-font-delta)) var(--dsw-font-family);
  --dsw-font-markdown-h1-font-size: calc(21px + var(--dsh-content-font-delta));
  --dsw-font-markdown-h1-line-height: calc(30px + var(--dsh-content-font-delta));
  --dsw-font-markdown-code: 12px/19px var(--ds-font-family-code);
  --dsw-font-markdown-code-font-size: 12px;
  --dsw-font-markdown-code-line-height: 19px;
  --dsw-font-markdown-code-block: 11px/19px var(--ds-font-family-code);
  --dsw-font-markdown-code-block-font-size: 11px;
  --dsw-font-markdown-code-block-line-height: 19px;
  --dsh-content-font-size-secondary: min(calc(var(--dsh-content-font-size, 14px) - 1px), max(13px, calc(var(--dsh-content-font-size, 14px) - 2px)));
}
html, body { margin: 0 }
.sidebar { font-size: 14px }
.sidebar .brand { font-size: 18px }
.sidebar .row { font: inherit }
.markdown { font: var(--dsw-font-markdown-base) }
.markdown h1 { font: var(--dsw-font-markdown-h1); margin: 32px 0 16px }
.markdown :not(pre) > code { font: var(--dsw-font-markdown-code); font-family: var(--ds-font-family-code); font-size: .875em !important }
.markdown pre { font: var(--dsw-font-markdown-code-block) }
.tool { font: var(--dsw-font-xs-13); font-family: Inter, var(--dsw-font-family) }
.title { font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(24px + var(--dsh-content-font-delta, 0px)) }
.nest { font-size: 1em }
.nest-pct { font-size: 100% }
.hidden-gap { font-size: 0 }
.icon { width: 16px; height: 16px; font-size: 0 }
input, button { font: 400 13px/20px system-ui }
@media (min-width: 1px) { .mq { font-size: 15px } }
`

const BODY = `
<nav class="sidebar"><div class="brand" id="brand">DSH</div><div class="row" id="row">Session <span class="hidden-gap" id="gap">x</span></div></nav>
<main class="markdown" id="md">
  <h1 id="h1">Heading 見出し</h1>
  <p id="p">Body text 本文 <code id="code">inline()</code></p>
  <pre id="pre">block code</pre>
  <div class="nest"><div class="nest"><div class="nest"><div class="nest"><div class="nest"><div class="nest"><div class="nest"><div class="nest"><span id="deep">deep 深い</span></div></div></div></div></div></div></div></div>
  <div class="nest-pct"><div class="nest-pct"><div class="nest-pct"><span id="deeppct">pct</span></div></div></div>
</main>
<div class="tool" id="tool">tool row</div>
<div class="title" id="title">title</div>
<div id="plain"><div><div><div><span id="plaindeep">plain</span></div></div></div></div>
<span class="icon" id="icon"></span>
<input id="input" value="input"><button id="button">button</button>
<div class="mq" id="mq">media</div>
<div id="legacy"></div>
`

const IDS = ['brand', 'row', 'gap', 'md', 'h1', 'p', 'code', 'pre', 'deep', 'deeppct', 'tool', 'title', 'plain', 'plaindeep', 'icon', 'input', 'button', 'mq']

const HARNESS = `
const results = {}
const measure = () => Object.fromEntries(${JSON.stringify(IDS)}.map((id) => {
  const cs = getComputedStyle(document.getElementById(id))
  return [id, { fs: parseFloat(cs.fontSize), lh: cs.lineHeight, ff: cs.fontFamily }]
}))
const listeners = new Set()
const form = {
  snap: { status: 'ready', mode: 'host', value: { en: '', zh: '', code: '', size: 0 } },
  getSnapshot() { return this.snap },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  async mutate() { return true },
  set(value) { this.snap = { ...this.snap, value }; for (const fn of listeners) fn() },
}
let handoff
window.__ModuleLoader__ = { load: (h) => { handoff = h } }
${readFileSync(join(root, 'client', 'client.js'), 'utf8')}
const surface = handoff.factory(() => ({ createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {} }))
const disposers = []
surface.apply({
  effect: (fn) => { disposers.push(fn()) },
  configForms: { get: () => form },
  slots: { inject: () => {}, register: () => {} },
})
const base = { en: '', zh: '', code: '' }
results.baseline = measure()
for (const size of [0, 0.5, -0.5, 2, -2, 8, -4]) {
  form.set({ ...base, size })
  results['size:' + size] = measure()
}
// Font-family settings keep working together with the offset.
form.set({ en: 'Georgia', zh: 'Yu Gothic', code: 'Courier New', size: 1.5 })
results.fonts = measure()
results.styleTags = document.querySelectorAll('style[data-dsh-custom-fonts]').length
// A stylesheet added later (lazily loaded plugin CSS) gets its twin.
const late = document.createElement('style')
late.textContent = '.late { font-size: 10px }'
document.head.appendChild(late)
const lateEl = document.createElement('div'); lateEl.className = 'late'; document.body.appendChild(lateEl)
await new Promise((r) => setTimeout(r, 200))
results.late = parseFloat(getComputedStyle(lateEl).fontSize)
results.lastIsOurs = document.head.lastElementChild.hasAttribute('data-dsh-custom-fonts')
// Unload removes everything.
for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
results.afterUnload = measure()
results.tagsAfterUnload = document.querySelectorAll('style[data-dsh-custom-fonts]').length
// Pre-fix rule, for the record.
const legacy = document.createElement('style')
legacy.textContent = 'body, body * { font-size: calc(1em + 2px) !important; }'
document.head.appendChild(legacy)
results.legacy = measure()
legacy.remove()
document.body.setAttribute('data-results', JSON.stringify(results))
`

const dir = mkdtempSync(join(tmpdir(), 'dsh-custom-fonts-'))
let results
try {
  const page = join(dir, 'page.html')
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body>${BODY}<script type="module">${HARNESS}</script></body></html>`)
  const out = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=5000', '--dump-dom',
    pathToFileURL(page).href,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 })
  const match = /data-results="([^"]*)"/.exec(out)
  if (!match) throw new Error('page did not report results:\n' + out.slice(0, 2000))
  results = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log(`ok   ${name}`)
  else { failures += 1; console.error(`FAIL ${name}${detail ? ': ' + detail : ''}`) }
}
const near = (a, b) => Math.abs(a - b) < 0.01
const base = results.baseline

// Which elements carry text whose size should move by exactly N.
const TEXT = ['brand', 'row', 'md', 'h1', 'p', 'pre', 'deep', 'deeppct', 'tool', 'title', 'plain', 'plaindeep', 'input', 'button', 'mq']

check('offset 0 leaves every size untouched', IDS.every((id) => near(results['size:0'][id].fs, base[id].fs) && results['size:0'][id].lh === base[id].lh))
for (const n of [0.5, -0.5, 2, -2, 8, -4]) {
  const r = results['size:' + n]
  const wrong = TEXT.filter((id) => !near(r[id].fs, base[id].fs + n)).map((id) => `${id} ${base[id].fs}->${r[id].fs}`)
  check(`offset ${n > 0 ? '+' : ''}${n}px shifts every text size by exactly ${n}px`, wrong.length === 0, wrong.join(', '))
  check(`offset ${n}px: inline code keeps its .875em ratio`, near(r.code.fs, r.p.fs * 0.875), `${r.code.fs} vs ${r.p.fs}`)
  check(`offset ${n}px: zero-size helpers stay 0`, r.gap.fs === 0 && r.icon.fs === 0)
}
const r2 = results['size:2']
check('nested em (8 levels) does not accumulate', near(r2.deep.fs - base.deep.fs, 2), `${base.deep.fs} -> ${r2.deep.fs}`)
check('heading > body > code order is preserved', r2.h1.fs > r2.p.fs && r2.p.fs > r2.code.fs && r2.code.fs > r2.pre.fs)
check('line-height follows the offset for token fonts', parseFloat(r2.p.lh) === parseFloat(base.p.lh) + 2 && parseFloat(r2.tool.lh) === parseFloat(base.tool.lh) + 2, `${base.p.lh}->${r2.p.lh}, ${base.tool.lh}->${r2.tool.lh}`)
check('font-family settings still apply with an offset', /Georgia/.test(results.fonts.p.ff) && /Yu Gothic/.test(results.fonts.p.ff) && /Courier New/.test(results.fonts.code.ff) && near(results.fonts.p.fs, base.p.fs + 1.5))
check('a non-zero offset uses two style elements', results.styleTags === 2, String(results.styleTags))
check('late stylesheets are mirrored and ours stay last', near(results.late, 11.5) && results.lastIsOurs, `${results.late} ${results.lastIsOurs}`)
check('unload restores the original sizes', IDS.every((id) => near(results.afterUnload[id].fs, base[id].fs)) && results.tagsAfterUnload === 0)

const legacyGrowth = results.legacy.deep.fs - base.deep.fs
check(`reproduced the old bug: calc(1em + 2px) grew 8-deep text by ${legacyGrowth}px`, legacyGrowth > 2)

console.log('\nfont-size (px)   ' + ['base', '-4', '-2', '-0.5', '0', '+0.5', '+2', '+8', 'old +2'].map((s) => s.padStart(7)).join(''))
for (const id of ['brand', 'h1', 'p', 'code', 'pre', 'deep', 'tool', 'title', 'plaindeep', 'button']) {
  const cols = [base, results['size:-4'], results['size:-2'], results['size:-0.5'], results['size:0'], results['size:0.5'], results['size:2'], results['size:8'], results.legacy]
  console.log(id.padEnd(17) + cols.map((r) => String(Math.round(r[id].fs * 100) / 100).padStart(7)).join(''))
}

if (failures > 0) {
  console.error(`\n${failures} browser check(s) failed`)
  process.exit(1)
}
console.log('\nall browser checks passed')
