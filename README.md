# quick-repo-6

## Runtime requirements

Node.js 22.22.2 or newer, within the 22.x line, is the runtime this project actually needs. The
manifests declare a wider range: `package.json`, `shared/package.json`, `server/package.json` and
`client/package.json` each set `"engines": { "node": ">=22 <23" }`, and `.nvmrc` pins the major line
(`22`). A 22.x runtime below 22.22.2 therefore satisfies every declared range and still fails. The
bounds that narrow it:

- **jsdom 31.0.1 sets the floor at 22.22.2.** The client suite runs under jsdom
  (`client/vitest.config.ts` sets `environment: 'jsdom'`), and jsdom declares
  `"node": "^22.22.2 || ^24.15.0 || >=26.0.0"`, as does its `w3c-xmlserializer` dependency 6.0.0. On
  a runtime below 22.22.2, `npm install` reports `EBADENGINE` for jsdom even though the project's own
  `engines` range admits that runtime.
- **The server's `start` script needs Node 22.9.0 on its own account.** `server/package.json` starts
  the API with `node --env-file-if-exists=.env dist/index.js`, and `--env-file-if-exists` did not
  exist before Node 22.9.0, so on Node 22.8 and earlier `npm run start --workspace server` stops on
  an unrecognised option. The `dev` script avoids that flag: it tests for `.env` in a shell guard and
  passes `--env-file=.env` only when the file is present.
- **The other floors sit below 22.22.2 and do not raise it.** vitest 5.1.0 declares `^22.12.0`, vite
  7.3.8 declares `^20.19.0 || >=22.12.0`, and undici 8.12.4 declares `>=22.19.0`. Every one of the
  184 packages in `package-lock.json` that declares a Node range admits 22.22.2, so jsdom's bound is
  the binding one.

The runtime this project is developed and tested against is Node 22.23.5. The declared `engines`
ranges remain `>=22 <23`; this section records the narrower floor the resolved dependency tree and
the server scripts impose on top of them.
