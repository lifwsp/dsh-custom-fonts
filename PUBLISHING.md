# Publishing & Listing

How this plugin gets released and listed.

> **Fork note:** The listing paths below (`lsh2002__dsh-custom-fonts.yml`, the `lsh2002` repository URL) belong to the upstream project. If this fork is ever listed separately, use `lifwsp__dsh-custom-fonts.yml` and `https://github.com/lifwsp/dsh-custom-fonts`, and choose a distinct npm package name to avoid clashing with the upstream `dsh-custom-fonts`.
>
> **Before any release:** start DSH with the plugin installed, set a font, reload the page, restart DSH, and confirm the font is restored. `npm install` first so the smoke test can import the host half (it needs `@deepseek-ai/schemastery`).

## 1. Release checklist

1. Bump `version` in `package.json` and add a CHANGELOG entry.
2. Rebuild nothing (zero-build package — `client/client.js` and `lib/index.js` are hand-maintained), but run the smoke test:

   ```sh
   node scripts/verify.mjs
   ```

3. Stage the prebuilt tarball (this is what plugin markets install from):

   ```sh
   npm pack
   ```

4. Create a GitHub Release for the version tag and attach the generated
   `dsh-custom-fonts-<version>.tgz`. Keep asset name and version aligned.
5. Update the `tarball:` line in `data/plugins/lsh2002__dsh-custom-fonts.yml`
   (awesome-dsh-plugin) if it names a versioned asset URL.

## 2. Marketplace listing

The community catalog lives at
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin);
submissions are one YAML file per plugin:

- File: `data/plugins/lsh2002__dsh-custom-fonts.yml`
- Category: `ui`
- The repo must exist for **at least 1 day** and carry **at least 10 commits**
  (automated CI checks).
- The `dsh-plugin` topic must be set on the repository.
- After adding/updating the YAML, regenerate the two READMEs with
  `node scripts/generate-readme.mjs` in that repo and commit together with the YAML.
- Optional but recommended: screenshots under `data/screenshots.json` keyed by
  `https://github.com/lsh2002/dsh-custom-fonts`, pointing at images hosted on
  GitHub (e.g. `raw.githubusercontent.com`).

## 3. npm (optional)

Publishing to the public npm registry is optional — listing works without it.
If published, the package `repository` field already points back at this repo,
which is what links the two. Install from GitHub or from a Release tarball
works either way.