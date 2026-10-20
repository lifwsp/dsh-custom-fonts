import z from '@deepseek-ai/schemastery'

import { createFontCatalog } from './fonts.js'

/**
 * dsh-custom-fonts — host half.
 *
 * Owns the settings schema and serves the list of fonts installed on the Host
 * machine (./fonts.js). Every visible behaviour lives in the browser half
 * (./client); the schema lets the plugin's preferences be stored in the Host
 * settings document instead of being lost on reload.
 *
 * Three things make the namespace appear at all, and all three are load-bearing:
 *   - `name`   — the loader's runtime identity for this plugin;
 *   - `inject` — left empty on purpose. Declaring `settings` here would make
 *                 this plugin's fiber wait for the settings service before it
 *                 could activate, and a fiber that never activates never runs
 *                 `apply`. The browser half claims the form lazily instead.
 *   - `Config` — read as `entry.fiber.runtime.Config`; without it the settings
 *                 service skips this entry entirely.
 *
 * Every field is `.volatile()`: the settings form is projected from volatile
 * fields only, so an unmarked field produces no form at all.
 *
 * The Host stores the values in the profile's `cordis.patch.yml`, as the
 * `config` of this plugin's entry. The size range (-4..+8, 0.5px steps) is
 * enforced by the browser half, which clamps and rounds out-of-range values
 * rather than rejecting them.
 *
 * Originally contributed by tom613951 in
 * https://github.com/lsh2002/dsh-custom-fonts/pull/1
 */

/** Loader runtime identity for this plugin. */
export const name = 'dsh-custom-fonts'

/** No host-side service dependencies; see the note on `inject` above. */
export const inject = []

/** Settings namespace owned by this plugin (equals its loader entry id). */
export const FONT_SETTINGS_NAMESPACE = 'dsh-custom-fonts'

/**
 * Stored preferences. An empty string means "use the product default"; a size
 * offset of 0 means "do not adjust".
 */
export const Config = z.object({
  en: z.string().default('').description('UI font for Latin letters, numbers, and punctuation. Comma-separated list; empty uses the default.').volatile(),
  zh: z.string().default('').description('Fallback UI font for Japanese, Chinese, and Korean text. Comma-separated list; empty uses the default.').volatile(),
  code: z.string().default('').description('Font for code blocks and inline code. Comma-separated list; empty uses the default.').volatile(),
  size: z.number().default(0).description('Font size offset in pixels (-4 to +8, in 0.5px steps); 0 means no change.').volatile(),
  tightFix: z.boolean().default(false).description('Fix tight letter spacing in session titles on Safari / the macOS app by fading truncated titles instead of using an ellipsis.').volatile(),
})

/** Shared-channel RPC method answering the installed-font catalog. */
export const FONT_LIST_METHOD = 'dsh-custom-fonts.list'

/** One catalog per process: its cache outlives plugin reloads. */
let catalog = null

function serverResponse(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * Answer `rpc.call('/api', FONT_LIST_METHOD, {})` from the browser half with
 * the fonts installed on the Host machine. The route sits behind Connection's
 * Host/Origin checks and browser authentication like every `/api` route; the
 * browser half asks only when the page itself is on loopback, because only
 * then are the Host's fonts the ones the browser can draw.
 */
function fontListRoute() {
  return {
    path: '/api/' + FONT_LIST_METHOD,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch (error) {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
      if (!body || body.type !== 'client-request' || body.method !== FONT_LIST_METHOD) {
        return serverResponse(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } } })
      }
      try {
        if (catalog === null) catalog = createFontCatalog()
        const { families, files, ms } = await catalog.list()
        return serverResponse(rpcId, { ok: true, value: { families, files, ms } })
      } catch (error) {
        return serverResponse(rpcId, { ok: false, error: { code: 'internal', message: String(error && error.message ? error.message : error) } })
      }
    },
  }
}

/**
 * Host half: serve the installed-font catalog.
 *
 * The settings service derives a form from `Config` automatically; nothing has
 * to be registered for it. `configure({ auto: false })` is deliberately NOT
 * called — this plugin renders its own page, and claiming the presentation
 * would suppress the schema that the browser half reads its stored values from.
 *
 * The font route waits for `connection` through a nested `ctx.inject`, so the
 * plugin itself still activates without it (headless profiles have none).
 */
export function apply(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') return
    inner.effect(() => connection.fetch.register(fontListRoute()), 'dsh-custom-fonts: /api/' + FONT_LIST_METHOD + ' route')
  })
}
