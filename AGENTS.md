# Barrow Alley repository instructions

- Read `DESIGN.md` before changing the implementation, and work on only the assigned milestone or narrowly defined issue.
- Keep this repository as one standard Obsidian plug-in package with one root `package.json` and one root lockfile. Do not add npm workspaces, a monorepo, or a separately published core package.
- Keep `src/core` host-neutral. It must not import Obsidian, Svelte, browser UI adapters, DOM presentation code, or `src/obsidian`.
- Keep the browser interoperability client under `test/web`. It may import host-neutral core and transport modules, but it must not import `obsidian`, `src/main.ts`, `src/obsidian`, or the Obsidian Fancy Kit adapter.
- Use only documented Fancy Kit public entry points. Keep binary Vault operations in Barrow Alley rather than expanding Fancy Kit's text and frontmatter boundary.
- Run focused tests while iterating, then run the plug-in gate `npm run check` before declaring a milestone complete. Run the browser gate `npm run check:web` separately when the browser harness changes and during full repository validation. Keep broad Node.js validation sequential and set `NODE_OPTIONS=--max-old-space-size=3072`; keep the same limit in the lint script itself so direct lint runs remain bounded.
- Keep the official `eslint-plugin-obsidianmd` lint in `npm run check`; outside the documented `src/compat-global.ts` runtime workaround, do not suppress production findings or narrow its source scope merely to make validation pass.
- Community Directory scanning ignores the exact root names `test` and `scripts`; keep test and Node-only tooling under those names. Treat the remote scanner as authoritative even when local ESLint, TypeScript, or Git exclusions differ.
- Keep the root `build` script as the production plug-in build. It is the first recognised script used by Community Directory scanning; do not turn it into an aggregate repository check.
- Keep `src/main.ts` limited to the plug-in entry point and lifecycle delegation. Use stable command IDs, register host-managed resources through Obsidian's public lifecycle helpers where applicable, and leave no listeners or intervals active after unload.
- Preserve mobile compatibility: do not introduce Node.js or Electron runtime APIs into the plug-in, and keep `manifest.json`'s `isDesktopOnly` value accurate.
- Route host-neutral access to browser or Node globals through `src/compat-global.ts`. Treat that module's documented `globalThis` fallback as the single reviewed workaround; do not scatter direct global-object access or lint suppressions through production code.
- Required plug-in release artefacts are root `main.js`, `manifest.json`, and `styles.css`. Keep generated `main.js` out of Git and do not include `dist-web/` in an Obsidian release.
- Add behavioural regression coverage before fixing a defect. Confirm that the new test fails for the expected reason before changing production code.
- Write repository documentation and user-facing text in British English, with Oxford commas and logical punctuation.
- Respond to the user in the same language that they use. When the user requests a specific conversation language, continue in that language until they change it.
- Do not add networking, Trystero, protocol messages, file transfer, QR codes, TURN, accounts, pairing, history, or synchronisation before the corresponding milestone is explicitly assigned.
- Do not commit, push, publish, tag, or open or merge a pull request without explicit approval for that individual operation.
