# dsh-custom-fonts

Customize the **Latin** and **CJK** UI fonts, the **code font**, and the **global font size** of the DeepSeek Harness (DSH) Web UI from a settings page, with a live preview. Your settings are **saved automatically** and restored after a page reload or a DSH restart.

> This is a maintained fork of [lsh2002/dsh-custom-fonts](https://github.com/lsh2002/dsh-custom-fonts). It adds settings persistence (based on [PR #1](https://github.com/lsh2002/dsh-custom-fonts/pull/1)) and an English settings page. See [Credits](#credits).

Documentation in this fork is maintained in English. CJK means Chinese, Japanese, and Korean.

## Features

Once installed, the plugin adds a **Fonts** page under **Settings**:

- **UI font · Latin**: used for Latin letters, digits, and punctuation (Segoe UI, Arial, Georgia, Consolas, and others).
- **UI font · CJK**: a fallback font for Japanese, Chinese, and Korean text. Choose a font that supports your language, such as Noto Sans CJK JP, Yu Gothic, Meiryo, Noto Sans CJK SC, Microsoft YaHei, Noto Sans CJK TC, Noto Sans CJK KR, or Malgun Gothic.
- **Code font**: a separate monospace font for code blocks and inline code (`pre`/`code`/`kbd`/`samp`), such as Consolas, JetBrains Mono, Fira Code, Cascadia Code, or Sarasa Mono SC.
- **Font size offset**: a global slider from -4 to +8 px in 0.5 px steps that adds the same amount to every text size, however deeply it is nested (see [How it works](#how-it-works)). **Reset** next to the slider sets it back to 0.
- **Live preview**: Latin, Japanese, Chinese, and Korean samples and a code sample update as you type. Each font field accepts any font name or a comma-separated list of fonts.
- **Restore defaults**: clears every setting, removes the injected styles, and deletes the saved values.
- **Automatic saving**: changes apply immediately and are saved after a short pause in typing. A status line under the page reports whether the latest changes were saved.

## Install

Install it into the DSH profile you use. Replace `web` with your profile name; the desktop app uses the `desktop` profile.

From this fork:

```sh
dsh plugin --profile web add github:lifwsp/dsh-custom-fonts
```

From a local checkout (useful while developing):

```sh
dsh plugin --profile web add file:/path/to/dsh-custom-fonts
```

Restart DSH after installing. The plugin has a small host half that holds the settings schema, so DSH must load it once before settings can be saved.

> **Upgrading from upstream 1.0/1.1?** Those versions had no host half and never saved anything, so you need to enter your fonts once more. Run the same `add` command to replace the upstream package, then restart DSH.

## Usage

1. Open **Settings → Fonts**.
2. Type a font name, pick one from the suggestions, or enter a comma-separated list such as `Inter, Segoe UI`. Leave a field empty to keep the default font.
3. Move the **Font size offset** slider if you want larger or smaller text. Keep it at `0px` for no change.
4. Changes apply right away and are saved automatically. Use **Restore defaults** to go back to the original fonts.

The status line at the bottom of the page shows one of the following:

| Message | Meaning |
| --- | --- |
| Changes are saved automatically. | Ready, and nothing is waiting to be saved. |
| Saving… | A write to the DSH settings file is in progress. |
| All changes saved. | DSH accepted the latest changes. |
| Could not save font settings (…) | The write failed. Your changes still apply in this window; edit any setting to try again. |
| DSH did not accept the font settings … | The settings changed elsewhere (for example, the file was edited by hand). The saved values were reloaded. |
| This connection cannot save DSH settings … | DSH only saves settings from a local (loopback) connection. Changes apply until you reload. |
| … DSH has not loaded this plugin's settings … | The host half is not active, usually because of an invalid hand-edited value or because DSH has not been restarted since the install. |

## How settings are saved

The plugin uses DSH's built-in settings service instead of browser storage, so settings are tied to the DSH profile rather than to one browser.

- The **host half** ([lib/index.js](lib/index.js)) declares a settings schema (`Config`) with four fields: `en`, `zh`, `code` (strings, default `""`), and `size` (number, default `0`). The stored keys `en` and `zh` retain their original names for compatibility; they now represent Latin and CJK fonts. Each field is marked `.volatile()`, so DSH can edit it live without restarting the plugin.
- The **browser half** ([client/client.js](client/client.js)) gets the shared settings form with `ctx.configForms.get('dsh-custom-fonts')`, provided by `@deepseek-ai/dsh-client-ui-settings`. It applies the stored values when the page loads and whenever they change.
- **Edits** are applied to the page immediately and written with one atomic `mutate` call after 400 ms without further changes, so typing a font name does not rewrite the file on every keystroke. A pending change is also written when the page is hidden or the plugin unloads. DSH queues writes in order and checks the revision, so concurrent edits cannot silently overwrite each other.
- **Restore defaults** removes (`unset`s) the four stored fields instead of writing empty values. The plugin then falls back to its defaults, or to values set by a lower profile layer.
- DSH writes the values to the profile's patch file, `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`DSH_HOME` defaults to `~/.dsh`):

  ```yaml
  - id: dsh-custom-fonts
    name: dsh-custom-fonts
    config:
      en: Georgia
      zh: SimSun
      code: Courier New
      size: 3
  ```

  You can edit this entry by hand. Missing fields fall back to the defaults, a `size` outside -4..+8 is clamped, and it is rounded to the nearest 0.5 (integer values from earlier versions keep working). A value of the wrong type (for example `en: 42`) fails DSH's schema validation, which stops the host half from loading. The page still works, but it cannot save until you fix the entry.
- On a fresh install, nothing is written until you change a setting. Before then, no stylesheet is injected and DSH looks exactly as it does without the plugin.

## How it works

The plugin injects up to two stylesheets at the end of `<head>`. The font one:

```css
:root { --dsh-custom-fonts-en: 'Latin font'; --dsh-custom-fonts-zh: 'CJK font'; }
body, body * { font-family: 'Latin font', 'CJK font' !important; }
pre, code, kbd, samp { font-family: 'Code font' !important; }
```

and, only while the offset is not 0, the size one:

```css
:root { --dsh-custom-fonts-size-offset: 2px; }                /* in the font stylesheet */
html { font-size: calc(100% + var(--dsh-custom-fonts-size-offset, 0px)); }
.sidebar { font-size: calc(14px + var(--dsh-custom-fonts-size-offset, 0px)); }
.markdown { font-size: calc(var(--dsw-font-markdown-base-font-size) + var(...)); line-height: calc(... + var(...)); }
.markdown code { font-size: .875em !important; }              /* relative: repeated unchanged */
```

- The `font-family` fallback chain tries the Latin font first, then the CJK font for missing glyphs. It does not detect languages: a glyph already covered by the first font will not use the second. Choose a CJK font appropriate for your language, since shared Han characters can have different regional forms. No DOM changes are needed.
- The code-font rule comes later, so it wins inside code regions only.
- The size offset is added once, where a size is *declared*. Earlier versions used `body, body * { font-size: calc(1em + N) }`; because `1em` is the parent's size, which already included N, the offset was added again on every nesting level (text 8 levels deep at +2 px grew from 14 px to 38 px). Now the plugin reads the page's own stylesheets and, for every rule that sets an absolute `font-size` (px, `calc()`, a design token, or the size inside a `font` shorthand), adds a rule with the same selector and `calc(<original> + offset)`. Its line-height moves by the same amount, so lines do not get cramped. Same specificity plus a later position means each copy wins exactly where its original did. Relative sizes (`em`, `%`, keywords) are not offset because they already follow their offset parent; they are repeated unchanged only to keep the original tie-breaking order. Sizes of `0` stay `0`.
- The slider only changes the `--dsh-custom-fonts-size-offset` variable, so live preview stays cheap; the size rules are rebuilt only when the page's stylesheets change (watched with a `MutationObserver`). An offset of 0 removes the size stylesheet, leaving the page exactly as it was.
- Characters that could break out of a CSS declaration (`; { } < > \`) are removed from font names before they are injected.

### Limitations

- Sizes set in inline `style="..."` attributes or in cross-origin stylesheets cannot be read, so they keep their original size. The DSH Web UI uses stylesheets for almost all text, and this plugin's own settings page routes its inline sizes through the offset variable.
- Browsers draw text that only has the generic `monospace` family at 13 px instead of 16 px by default. That reduction is lost once the root size is offset, so such text grows by about 3 px more. DSH styles its code with a named font stack, which avoids this.

## Uninstall

```sh
dsh plugin --profile web remove dsh-custom-fonts
```

You can also remove it from **Settings → Plugins**. Refresh the page and the fonts revert automatically. The saved `dsh-custom-fonts` entry may remain in `cordis.patch.yml`; you can delete it.

## Development

The package has no build step: [client/client.js](client/client.js) and [lib/index.js](lib/index.js) are maintained by hand.

```sh
npm install   # installs @deepseek-ai/schemastery for local tests only
npm test      # runs scripts/verify.mjs
npm run test:browser   # measures computed sizes in headless Chrome/Edge (scripts/browser-check.mjs)
```

`scripts/verify.mjs` checks the host and client load contracts, the persistence logic against a fake settings form that mirrors DSH's `ConfigForm` API (restore on load, debounced saving, reset, malformed data, save failures, unload), and that the settings page contains no untranslated text.

`@deepseek-ai/schemastery` is a **peer dependency**: DSH provides its own copy at runtime, the same way the official `dsh-plugin-subscriptions` plugin does. See [PUBLISHING.md](PUBLISHING.md) for the release steps.

## Credits

- **Original plugin**: [AgustD (@lsh2002)](https://github.com/lsh2002), [lsh2002/dsh-custom-fonts](https://github.com/lsh2002/dsh-custom-fonts). This covers the font settings page, the CSS font-application logic, the code font, and the size offset.
- **Settings persistence**: [@tom613951](https://github.com/tom613951), [PR #1 "Persist font preferences in the Host settings document"](https://github.com/lsh2002/dsh-custom-fonts/pull/1). The PR commit is merged into this fork's history unchanged, with its original authorship. This fork builds on it with debounced saving, reset by `unset`, input validation, error reporting, and tests.
- **Fork maintenance, English UI, and documentation**: [@lifwsp](https://github.com/lifwsp).

## License

[MIT](LICENSE). Copyright (c) 2026 AgustD. The original copyright notice is kept unchanged; contributions in this fork are released under the same license.
