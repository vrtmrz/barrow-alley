# Barrow Alley repository instructions

- Read `DESIGN.md` before changing the implementation, and work on only the assigned milestone or narrowly defined issue.
- Keep this repository as one standard Obsidian plug-in package with one root `package.json` and one root lockfile. Do not add npm workspaces, a monorepo, or a separately published core package.
- Keep `src/core` host-neutral. It must not import Obsidian, Svelte, browser UI adapters, DOM presentation code, or `src/obsidian`.
- Keep the browser interoperability client under `test/web`. It may import host-neutral core and transport modules, but it must not import `obsidian`, `src/main.ts`, `src/obsidian`, or the Obsidian Fancy Kit adapter.
- Use only documented Fancy Kit public entry points. Keep binary Vault operations in Barrow Alley rather than expanding Fancy Kit's text and frontmatter boundary.
- Run focused tests while iterating, then run `npm run check` before declaring a milestone complete. Keep broad Node.js validation sequential and set `NODE_OPTIONS=--max-old-space-size=3072`.
- Add behavioural regression coverage before fixing a defect. Confirm that the new test fails for the expected reason before changing production code.
- Write repository documentation and user-facing text in British English, with Oxford commas and logical punctuation.
- Respond to the user in the same language that they use. When the user requests a specific conversation language, continue in that language until they change it.
- Do not add networking, Trystero, protocol messages, file transfer, QR codes, TURN, accounts, pairing, history, or synchronisation before the corresponding milestone is explicitly assigned.
- Do not commit, push, publish, tag, or open or merge a pull request without explicit approval for that individual operation.
