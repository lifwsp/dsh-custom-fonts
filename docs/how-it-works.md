# How it works

This page covers the details that most users do not need. For install and usage, see the [README](../README.md).

## Status messages

The line at the bottom of the settings page shows one of these:

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

The plugin uses DSH's built-in settings service instead of browser storage, so settings belong to the DSH profile, not to one browser.

- The **host half** ([lib/index.js](../lib/index.js)) declares the settings schema (`Config`) with four fields: `en`, `zh`, `code` (strings, default `""`), and `size` (number, default `0`). The keys `en` and `zh` keep their original names for compatibility; they now hold the Latin and CJK fonts. Each field is `.volatile()`, so DSH can edit it live without restarting the plugin.
- The **browser half** ([client/client.js](../client/client.js)) gets the settings form with `ctx.configForms.get('dsh-custom-fonts')`. It applies stored values on load and whenever they change.
- **Edits** apply immediately and are written with one atomic `mutate` call after 400 ms without further changes. A pending change is also written when the page is hidden or the plugin unloads. DSH queues writes in order and checks the revision, so concurrent edits cannot silently overwrite each other.
- **Restore defaults** `unset`s the four fields instead of writing empty values, so the plugin falls back to its defaults (or to a lower profile layer).
- DSH writes the values to `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`DSH_HOME` defaults to `~/.dsh`):

  ```yaml
  - id: dsh-custom-fonts
    name: dsh-custom-fonts
    config:
      en: Georgia
      zh: SimSun
      code: Courier New
      size: 3
  ```

  You can edit this entry by hand. Missing fields use the defaults. A `size` outside -4..+8 is clamped and rounded to the nearest 0.5. A value of the wrong type (for example `en: 42`) fails schema validation and stops the host half from loading; the page still works but cannot save until you fix the entry.
- On a fresh install nothing is written until you change a setting, and no stylesheet is injected.

## Injected CSS

The plugin injects up to two stylesheets at the end of `<head>`. The font one:

```css
:root { --dsh-custom-fonts-en: 'Latin font'; --dsh-custom-fonts-zh: 'CJK font'; }
body, body * { font-family: 'Latin font', 'CJK font' !important; }
pre, code, kbd, samp { font-family: 'Code font' !important; }
```

- The fallback chain tries the Latin font first, then the CJK font for missing glyphs. It does not detect languages: a glyph already covered by the first font never uses the second. Pick a CJK font for your language, since shared Han characters have regional forms.
- The code-font rule comes later, so it wins inside code only.
- Characters that could break out of a CSS declaration (`; { } < > \`) are removed from font names.

## Font size offset

The size stylesheet exists only while the offset is not 0:

```css
:root { --dsh-custom-fonts-size-offset: 2px; }   /* in the font stylesheet */
html { font-size: calc(100% + var(--dsh-custom-fonts-size-offset, 0px)); }
.sidebar { font-size: calc(14px + var(--dsh-custom-fonts-size-offset, 0px)); }
```

The offset is added once, where a size is *declared*. The plugin reads the page's stylesheets and, for each rule with an absolute `font-size` (px, `calc()`, a design token, or the size inside a `font` shorthand), adds a rule with the same selector and `calc(<original> + offset)`. Line height moves by the same amount. Same specificity plus a later position means each copy wins exactly where its original did.

- Relative sizes (`em`, `%`, keywords) are not offset, because they already follow their parent. They are repeated unchanged only to keep the original ordering.
- Sizes of `0` stay `0`.
- The slider changes only the CSS variable, so the live preview stays cheap. The size rules are rebuilt only when the page's stylesheets change (watched with a `MutationObserver`).
- An offset of 0 removes the size stylesheet.

## Limitations

- Sizes in inline `style="..."` attributes or in cross-origin stylesheets cannot be read, so they keep their original size. DSH uses stylesheets for almost all text.
- Text that only has the generic `monospace` family is drawn by browsers at 13 px instead of 16 px. That reduction is lost once the root size is offset, so such text grows by about 3 px more. DSH names its code fonts, so this normally does not apply.
