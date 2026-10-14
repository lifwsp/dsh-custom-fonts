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

`scripts/verify.mjs` checks the host and client load contracts, persistence against a fake settings form, the font table reader, suggestion ranking, the Host font catalog and route, and that the settings page has no untranslated text.

`lib/font-tables.js` is the source of the OpenType reader. `client/client.js` carries a verbatim copy between the `BEGIN font-tables` / `END font-tables` markers (the browser half cannot import modules); after editing the library, copy the block over, and `npm test` fails until the two match.

`@deepseek-ai/schemastery` is a **peer dependency**: DSH provides its own copy at runtime. See [PUBLISHING.md](../PUBLISHING.md) for release steps.
