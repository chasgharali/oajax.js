# Contributing

The most useful contribution right now is a **real-browser report**: open `examples/index.html` in a browser or WebView (Chrome, Firefox, Safari, a Cordova or Capacitor app), go offline, queue a few writes, come back online, and open an issue saying what you ran it in and whether they replayed in order.

For code changes:

```sh
npm install
npm run check      # typecheck, tests, build, package lint
```

Ground rules that come from what the package is for:

- **Say what is tested and what is not.** Do not describe behaviour as "works in Safari" unless someone ran it in Safari. Claims in the README should match a test or a report.
- **Order and idempotency are the product.** Any change to replay needs a test showing that later writes never overtake earlier ones and that the idempotency key does not change between attempts.
- **No runtime dependencies.** Test-only packages go in `devDependencies`.
- **No browser access at import time.** Everything that touches `window`, `indexedDB` or `localStorage` must run lazily, so the package can be imported during server rendering.
- Keep the v1-style adapter honest: a failure goes to `error`, never to `success`.
