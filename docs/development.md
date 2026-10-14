# Development

The package has no build step: [client/client.js](../client/client.js) and [lib/index.js](../lib/index.js) are maintained by hand.

Install from a local checkout:

```sh
dsh plugin --profile web add file:/path/to/dsh-custom-fonts
```

Run the tests:

```sh
npm install            # installs @deepseek-ai/schemastery for tests only
npm test               # scripts/verify.mjs
npm run test:browser   # scripts/browser-check.mjs, measures computed sizes in headless Chrome/Edge
```

`scripts/verify.mjs` checks the host and client load contracts, persistence against a fake settings form, and that the settings page has no untranslated text.

`@deepseek-ai/schemastery` is a **peer dependency**: DSH provides its own copy at runtime. See [PUBLISHING.md](../PUBLISHING.md) for release steps.
