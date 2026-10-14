# dsh-custom-fonts

Change the **Latin** and **CJK** UI fonts, the **code font**, and the **text size** of the DeepSeek Harness (DSH) Web UI from a settings page. Changes show up live and are saved automatically.

![Fonts settings page](docs/images/settings.png)

> A maintained fork of [lsh2002/dsh-custom-fonts](https://github.com/lsh2002/dsh-custom-fonts) that adds settings persistence and an English UI. See [Credits](#credits).

## Features

- **Separate fonts** for Latin text, CJK text (Chinese, Japanese, Korean), and code.
- **Font size offset** from -4 to +8 px, applied evenly to all text.
- **Live preview** with Latin, Japanese, Chinese, Korean, and code samples.
- **Installed-font suggestions** in Chrome and Edge, each shown in its own typeface. Japanese font names such as 游ゴシック work too.
- **Saved automatically** in your DSH profile and restored after a reload or restart.

## Install

Replace `web` with your DSH profile name (the desktop app uses `desktop`).

```sh
dsh plugin --profile web add github:lifwsp/dsh-custom-fonts
```

Then **restart DSH** once. The plugin needs to be loaded before it can save settings.

> Coming from upstream 1.0 or 1.1? Those versions never saved anything. Run the command above to replace them, restart DSH, and enter your fonts again.

## Usage

1. Open **Settings → Fonts**.
2. Type a font name, pick a suggestion, or enter a comma-separated list such as `Inter, Segoe UI`. An empty field keeps the default font.
3. Click **Detect installed fonts** (Chrome and Edge) to get suggestions from the fonts on your device.
4. Move the **Font size offset** slider. `0px` means no change.
5. Use **Restore defaults** to undo everything.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The **Fonts** page is missing | Restart DSH after installing, then refresh the page. |
| Changes apply but are lost on reload | Check the status line at the bottom of the page. DSH saves settings only from a local (loopback) connection, and only after restarting once with the plugin installed. |
| "Could not save font settings" | Edit any setting to try again. If it keeps failing, check the entry in `cordis.patch.yml` for a wrong value type. |
| Font name has no effect | Check the spelling, or use **Detect installed fonts** to see which names are installed. |

For the status messages and the stored format, see [How it works](docs/how-it-works.md).

## Uninstall

```sh
dsh plugin --profile web remove dsh-custom-fonts
```

You can also remove it from **Settings → Plugins**. After a refresh the original fonts return. The saved entry may remain in `cordis.patch.yml`, and you can delete it.

## More

- [How it works](docs/how-it-works.md): saved settings, injected CSS, the size offset, limitations, and status messages.
- [Development](docs/development.md): tests and local setup.
- [Changelog](CHANGELOG.md)

## Credits

- **Original plugin**: [AgustD (@lsh2002)](https://github.com/lsh2002), [lsh2002/dsh-custom-fonts](https://github.com/lsh2002/dsh-custom-fonts).
- **Settings persistence**: [@tom613951](https://github.com/tom613951), [PR #1](https://github.com/lsh2002/dsh-custom-fonts/pull/1).
- **Fork maintenance, English UI, and documentation**: [@lifwsp](https://github.com/lifwsp).

## License

[MIT](LICENSE). Copyright (c) 2026 AgustD.
