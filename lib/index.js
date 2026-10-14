import z from '@deepseek-ai/schemastery'

/**
 * dsh-custom-fonts — host half.
 *
 * Owns the settings schema only. Every visible behaviour lives in the browser
 * half (./client); this half exists so the plugin's preferences can be stored
 * in the Host settings document instead of being lost on reload.
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
 * `config` of this plugin's entry. The size range (-4..+8) is enforced by the
 * browser half, which clamps out-of-range values rather than rejecting them.
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
  en: z.string().default('').description('UI font for English (Latin) text. Comma-separated list; empty uses the default.').volatile(),
  zh: z.string().default('').description('UI font for Chinese text. Comma-separated list; empty uses the default.').volatile(),
  code: z.string().default('').description('Font for code blocks and inline code. Comma-separated list; empty uses the default.').volatile(),
  size: z.number().default(0).description('Font size offset in pixels (-4 to +8); 0 means no change.').volatile(),
})

/**
 * Host half: no behaviour of its own.
 *
 * The settings service derives a form from `Config` automatically; nothing has
 * to be registered here. `configure({ auto: false })` is deliberately NOT
 * called — this plugin renders its own page, and claiming the presentation
 * would suppress the schema that the browser half reads its stored values from.
 */
export function apply() {}
