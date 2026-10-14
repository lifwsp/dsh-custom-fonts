# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- **Suggestions are drawn in their own typeface, and Japanese names work.** Each suggested family is previewed in that font. Typing a localized name (for example 游ゴシック, メイリオ, ＭＳ ゴシック, 明朝) finds the family and shows the localized name next to it. Search ignores case, spaces, full/half-width and hiragana/katakana differences. Localized names come from a built-in table of well-known fonts plus the name table read from the installed font files after detection (no data leaves the browser).
- **Installed-font suggestions.** A **Detect installed fonts** button reads the fonts installed on the device (Local Font Access API, Chrome/Edge) and the font fields then suggest matching families as you type (case-insensitive, partial match, works per entry in a comma-separated list). Fonts that are not installed are flagged under the field. Browsers without the API keep the built-in common-name suggestions.
- **Fix the font size offset growing with DOM depth.** The old `body, body * { font-size: calc(1em + N) }` rule added the offset again at every nesting level, so a small change made deeply nested text jump (at +2 px, 8-deep text went from 14 px to 38 px). The offset is now added once, only to rules that declare an absolute size, with line-height following along; relative sizes (`em`, `%`) keep their ratio, and an offset of 0 injects nothing.
- The font size offset now moves in 0.5 px steps. Stored integer offsets keep working; non-numeric stored values fall back to 0.
- Dragging the slider only updates a CSS variable, keeping the live preview fast. The settings page's own text follows the offset too.
- Add `scripts/browser-check.mjs` (`npm run test:browser`), a headless-browser regression test for the offset.
- Rename UI font fields to **Latin** and **CJK**, keeping stored setting keys compatible.
- Add Japanese and Korean font suggestions and multilingual CJK previews.
- Standardize documentation and package metadata on English.

## [1.2.0] - 2026-10-14

First release of the [lifwsp/dsh-custom-fonts](https://github.com/lifwsp/dsh-custom-fonts) fork.

### Added

- **Preferences now persist** (from [PR #1](https://github.com/lsh2002/dsh-custom-fonts/pull/1) by @tom613951). The four settings (UI English font, UI Chinese font, code font, size offset) are stored in the Host settings document under the `dsh-custom-fonts` namespace and re-applied on load, so they survive a page reload and a restart. Previously they lived only in the bundle closure and were lost on every reload.
- A minimal host half (PR #1): it declares the settings schema (`Config`, every field `.volatile()`) and nothing else. `inject` is deliberately empty — declaring `settings` there would make the plugin's fiber wait for the settings service and never activate. Fields now carry English descriptions.
- Save status line on the settings page: saving, saved, and clear error messages when a save fails, is refused, or is not possible on this connection.
- `npm test` runs an extended `scripts/verify.mjs` covering persistence, reset, malformed data, error handling, unload, and untranslated text.

### Changed

- **The settings page is now in English** (section label **Fonts**, field labels, placeholders, tooltips, buttons, status messages). Chinese font names and the Chinese preview sentence are kept on purpose.
- The browser half injects `configForms` and reads the namespace through `configForms.get('dsh-custom-fonts')` (PR #1). Edits still apply immediately, but writes are now debounced (400 ms) and sent as one atomic `mutate`, instead of one write per keystroke and field. A pending edit is flushed on `pagehide` and on unload.
- Stored values from the Host and local edits are reconciled: a Host refresh no longer overwrites an edit that is still waiting to be saved.
- **Restore defaults** now `unset`s the stored fields (falling back to the defaults) instead of writing empty values.
- Stored values are validated before use: wrong types fall back to defaults, and the size offset is clamped to -4..+8.
- `@deepseek-ai/schemastery` is a `peerDependency` (provided by DSH, as in the official subscriptions plugin) plus a `devDependency` for tests, instead of a regular dependency.
- Package metadata points to the fork and lists the original author and contributors.

### Fixed

- Font names containing `;`, `{`, `}`, `<`, `>`, `\`, or line breaks can no longer break out of the injected CSS rule. Mismatched quotes are normalized.
- The settings page now re-renders when stored settings arrive or change while it is open (previously it only read state on mount).

## [1.1.0] - 2026-08-24

### Added

- **Code font**: a separate mono face for `pre`/`code`/`kbd`/`samp` regions (Consolas, JetBrains Mono, Fira Code, Cascadia Code, Sarasa Mono SC …), overriding the UI stack inside code regions.
- **Global font-size offset**: a -4..+8 px slider; implemented as `calc(1em ± Npx)` relative to each element's own size, so the shift stays flat across nesting (no cascade blow-up). Zero restores the default.
- Separate code-font preview line on the settings page.

### Changed

- Settings page labels now distinguish **UI fonts (English / Chinese)** from the **code font**; the reset button clears all four controls.

## [1.0.0] - 2026-08-24

### Added

- Settings page **Fonts** under Settings: customize the UI's English font and Chinese font independently.
- Live mixed Chinese/English preview that renders with the current font stack as you type.
- Comma-separated font lists and free-form font names (with common-font suggestions via `<datalist>`).
- Global stylesheet injection via a CSS `font-family` fallback chain: Latin characters run through the English font, Han characters fall back to the Chinese font — no language detection.
- **Restore defaults** button that clears both fields and removes every injected style.
- Pure client-side plugin: no host behavior, applies on page refresh, unloads cleanly.