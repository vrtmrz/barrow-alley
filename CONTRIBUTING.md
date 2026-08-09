# Contributing to Barrow Alley

Barrow Alley is developed as a standard Obsidian plug-in repository. It uses one root npm package for the plug-in, tests, and the browser interoperability harness.

Install the pinned dependency tree and run all automated checks:

```sh
npm ci
NODE_OPTIONS=--max-old-space-size=3072 npm run check
NODE_OPTIONS=--max-old-space-size=3072 npm run check:web
```

During development, use `npm run dev` for the plug-in build watcher and `npm run web:dev` for the browser harness. The production plug-in bundle is written to `main.js`; the browser build is isolated in `dist-web/` and is not a plug-in release asset.

Run `npm run lint` for a focused pass of the official Obsidian-specific ESLint rules. The script gives ESLint a 3 GB V8 heap limit, and `npm run check` includes the same bounded lint pass. The plug-in and browser harness have separate check commands so Community Review sees a production-only plug-in build. GitHub Actions runs both checks as separate steps on the supported Node.js 22 and 24 release lines for every pushed branch and pull request.

Read `DESIGN.md` before making changes. Implement one milestone at a time, preserve the dependency boundaries enforced by the unit tests, and document any deliberate design deviation before extending the scope.
