# quick-repo-6

Reads a trade from screenshots of your own trading charts.

## What it does

Drop one to six screenshots of your charts on the upload surface and submit without typing anything. Within thirty seconds the application returns a trade read: the side to take (`LONG`, `SHORT` or `NO_TRADE`), the price that triggers entry, the price that invalidates the read, and the timing (`NOW`, `ON_RETEST`, `ON_BREAK` or `WAIT`). Every price in the read resolves to a level extracted from one of the submitted images, and the analysis shows which image each level came from and which levels the read rests on. There is no order entry, no position sizing and no broker connectivity: the application reads screenshots and nothing else.

The interface has three surfaces: the upload of a new submission, the analysis of a stored read, and the newest-first history of past reads.

## Requirements

Node.js 22 LTS within the 22.x line — `.nvmrc` pins `22` and every package's `engines` is `>=22 <23` — plus npm. Two things narrow that range further, and the next section records both.

Verified in this environment: Node v22.23.5, npm 11.21.0.

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

## Install

Run these from the repository root; the project is one npm workspace of three packages, `shared`, `server` and `client`.

```bash
npm install                            # all three workspaces
npm run setup                          # the Chromium build Playwright needs
node fixtures/generate-fixtures.mjs    # re-render the PNG fixtures (optional)
```

`npm run setup` runs `playwright install chromium` and is a precondition for two things: `fixtures/generate-fixtures.mjs`, which renders the chart pages under `fixtures/render/` in headless Chromium, and `npm run test:e2e`, which drives Playwright. The screenshots under `fixtures/screenshots/` are committed, so the third command is only needed after a page under `fixtures/render/` changes.

Build the workspace once before starting the API; the compiled API runs from `server/dist`, and `npm run verify:bundle` scans the `client/dist` the build produces:

```bash
npm run build                          # shared, then server, then the client bundle
```

## Configuration

Nine environment variables, all read by `server/src/config/env.ts` and no other module. `.env.example` is the template. The server scripts run with the package directory as their working directory, so copy it there:

```bash
cp .env.example server/.env
```

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | unset | The only model credential. Unset, `GET /api/v1/health` reports `providerConfigured: false` and every submission returns `503 PROVIDER_NOT_CONFIGURED`. |
| `OPENROUTER_MODEL` | `google/gemini-2.5-flash` | The one vision-capable slug used for both the extraction and the synthesis call. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | The base the adapter appends `/chat/completions` to. |
| `OPENROUTER_REFERER` | unset | Sent as the optional `HTTP-Referer` attribution header when set. |
| `OPENROUTER_APP_TITLE` | unset | Sent as the optional `X-Title` attribution header when set. |
| `DATA_DIR` | `<repo>/.data` | Where analysis documents and their retained image bytes are written. Gitignored; anchored to the repository, so the store does not move with the directory the server is started from. |
| `PORT` | `3001` | API port. `0` asks the operating system for a free port, and an unparseable or out-of-range value falls back to the default rather than failing the start. |
| `HOST` | `127.0.0.1` | Bind address. The loopback default is required, because the API has no authentication. |
| `STUB_PROVIDER` | unset | `1` selects the recorded-response provider instead of the OpenRouter adapter, so a run needs no credential and no network. |

A blank value counts as unset. There is no `.env` loader dependency in the build: the server's `start` script passes Node's built-in `--env-file-if-exists=.env` and its `dev` script passes `--env-file=.env` only when that file is present, so exporting the same names in your shell works equally well.

The analysis budget is not one of these variables. The 30 000 ms deadline is the `ANALYSIS_BUDGET_MS` constant in `shared/src/limits.ts`, so no deployment can drift from the value the tests assert.

The client dev server reads two variables of its own, `VITE_PORT` (default `5173`) and `VITE_API_TARGET` (default `http://127.0.0.1:3001`), from `client/vite.config.ts`; the server never reads them. They exist so a checkout can run on its own port block without editing source.

Keep the credential out of every committed file: `.env` is gitignored and only `.env.example` is tracked. The credential is read once by the server's configuration module and is never written to a log line, a response body or the client bundle.

## Run

```bash
npm run dev                                    # server compiler in watch mode + Vite dev server
npm run start --workspace @trade-read/server   # the API, in a second terminal
```

`npm run dev` runs the server's TypeScript compiler in watch mode and the Vite dev server together and prints both URLs. It compiles the API; it does not start the API process, so start that with the command the banner prints — `npm run start --workspace @trade-read/server` once `server/dist` has been built, or `npm run dev --workspace @trade-read/server`, which watches the built output and restarts the API on change.

- API: `http://127.0.0.1:3001`, loopback unless `HOST` is set.
- Client: `http://localhost:5173`, with `/api` proxied to the API. The server's CORS allowlist admits exactly `http://localhost:5173` and `http://127.0.0.1:5173`.

To run with no credential and no egress, select the stub provider, which replays recorded provider responses:

```bash
STUB_PROVIDER=1 npm run start --workspace @trade-read/server
```

Every port is overridable per checkout — `PORT` and `HOST` for the API, `VITE_PORT` and `VITE_API_TARGET` for the client — and the dev server binds `VITE_PORT` strictly, so a collision fails loudly instead of drifting.

## API

Every route is mounted under `/api/v1`, needs no authentication, and answers JSON except the image route, which streams bytes.

| Method and path | Request | Success | Failure |
| --- | --- | --- | --- |
| `POST /api/v1/analyses` | `multipart/form-data`: `images` (1–6 files, PNG, JPEG or WebP, ≤10 MiB each, ≤24 MiB total, long edge ≤2048 px), optional `instrument` (≤16 characters), optional `context` (≤500 characters). There is no prompt parameter. | `200` with the analysis document | `400` `NO_IMAGES`, `TOO_MANY_IMAGES`, `UNSUPPORTED_IMAGE_TYPE`, `IMAGE_TOO_LARGE`, `IMAGE_TOO_LARGE_DIMENSIONS`; `422` `NO_READABLE_IMAGES`; `503` `PROVIDER_NOT_CONFIGURED`, `PROVIDER_QUOTA_EXCEEDED`, `PROVIDER_MODEL_UNSUPPORTED`; `504` `ANALYSIS_TIMEOUT`; `502` `ANALYSIS_FAILED` |
| `GET /api/v1/analyses/:id` | path id | `200` with the stored document | `404` `NOT_FOUND` |
| `GET /api/v1/analyses?limit=N` | query `limit`, default 20, capped at 100 | `200` with `{ "items": [...] }`, newest first, or `{ "items": [] }` when the store is empty | — |
| `GET /api/v1/analyses/:id/images/:imageId` | path ids | `200` with the retained image bytes and the content type they were stored with | `404` `NOT_FOUND` |
| `DELETE /api/v1/analyses/:id` | path id | `204`, no body; the document and its image bytes are both removed | `404` `NOT_FOUND` |
| `GET /api/v1/health` | — | `200` with `{ "status": "ok", "providerConfigured": boolean, "model": string }` | cannot fail while the process is up |

Errors are always `{ "code": "<CODE>", "message": "<sentence>" }`. A message names the offending file, or the configured model slug where that is the cause, and no response body carries a stack trace, a filesystem path or the credential. Every code, its status and its default sentence are declared once in `shared/src/errors.ts`; `INTERNAL_ERROR` is the generic `500` fallback for an unexpected failure, not a trigger of its own.

The analysis document carries the submitted `instrument` and `context`, one `images[]` entry per submission with its dimensions and its `status` (`ANALYZED` or `UNREADABLE`), the `levels[]` read from those images, the `recommendation`, the server-built `rationale[]` and `assumptions[]`, `modelUsage` (model, prompt version, extraction call count, synthesis completion tokens, latency) and the disclaimer. The recommendation refers to levels by id — `triggerLevelId`, `entryLevelId`, `invalidationLevelId`, `targetLevelIds` — and carries no price of its own, so every price shown in a read is a stored level. A `NO_TRADE` / `WAIT` read is a complete result, not an error. The document types, the twelve level types and the model's short-code maps are declared once, in `shared/src/contract.ts` and `shared/src/vocabulary.ts`.

## Data and deletion

Each analysis is one JSON document plus the image bytes it retained, under `DATA_DIR`:

```text
$DATA_DIR/analyses/<analysisId>/document.json
$DATA_DIR/analyses/<analysisId>/images/<imageId>
```

The image bytes are written first, then the document is written to a temporary name and renamed into place, so a half-written analysis is never observable and two concurrent submissions cannot collide. `DELETE /api/v1/analyses/:id` removes the document and the bytes together. An id arriving in a path is checked against its pattern before any path is built, so a crafted id cannot reach outside `DATA_DIR`.

## Prompts and versioning

Both instruction texts are built-in server modules — `server/src/adapters/prompts/extraction-prompt.ts` and `server/src/adapters/prompts/synthesis-prompt.ts` — read only by `server/src/adapters/prompts/prompt-library.ts` and applied to every request. Changing either text requires bumping its version constant in the same change, and a test fails if a text's content changes without its version changing.

The version that produced an analysis is stored as `modelUsage.promptVersion`, the string `extraction@<v>;synthesis@<v>` read from the prompt library at request time, and displayed beside the result in the interface.

No request can alter, replace or suppress that text: there is no prompt input, prompt field, query parameter or header the server reads for instruction content, and every submitted field other than `images`, `instrument` and `context` is dropped before the domain sees the request. `instrument` and `context` are appended by `server/src/adapters/prompts/render-input.ts` as clearly labelled data, inside a frame stating that they are data and not instructions.

## Limits

Every bound is declared once in `shared/src/limits.ts` and enforced in code:

- 6 images per submission, 10 MiB per file, 24 MiB in total.
- 2048 px on the long edge. The browser downscales before upload as a courtesy; the control is the server, which re-reads the dimensions from the received bytes and rejects anything larger.
- 30 000 ms for a whole analysis (`ANALYSIS_BUDGET_MS`), shared across all provider calls of one submission. It is a constant rather than configuration, and expiry returns `504 ANALYSIS_TIMEOUT` with nothing persisted.
- `max_tokens` 400 on the extraction call and 150 on the synthesis call.
- History `limit` defaults to 20 and is capped at 100; a non-numeric or non-positive value falls back to 20.
- `instrument` is truncated to 16 characters and `context` to 500 by the server, and the client caps both inputs, so the truncation is normally never reached. There is no error code for an over-long field.
- Every model answer must be exactly one line of JSON. An answer that spans more than one line, carries a code fence or surrounding text, is not valid JSON, uses a code outside the shared vocabulary, or arrives truncated at its ceiling gets one silent retry of that call, then `502 ANALYSIS_FAILED` with nothing persisted.

## Testing

```bash
npm test                 # test:server, then test:client
npm run test:server      # API contract, domain, adapter, store and startup suites
npm run test:client      # component suites in jsdom
npm run test:e2e         # Playwright against the stub, driven by scripts/run-e2e.mjs
npm run test:live        # the only command that reaches the real provider
npm run verify:bundle    # build the client, then scan client/dist for leaks
```

`npm test` passes on a machine with no credential and no network: every server suite replays recorded provider responses through the stub provider instead of calling OpenRouter, and the client suites stub `fetch` rather than reaching the API.

`npm run test:e2e` builds `shared` and `server`, starts the API with `STUB_PROVIDER=1` over a temporary data directory, starts the Vite dev server, runs Playwright, and then fails the run if the captured `.e2e/server.log` holds the credential's name or value shape, or a base64 payload. It needs the Chromium binary installed by `npm run setup`.

`npm run test:live` is the only command that reaches the real model. It needs `OPENROUTER_API_KEY` and a vision-capable `OPENROUTER_MODEL`, and it is what checks reading quality and latency against the live provider rather than against recorded answers.

`npm run verify:bundle` builds the client and reads every byte of `client/dist`, failing the run if the bundle carries the credential's variable name or value shape, a model provider hostname, or a phrase from either built-in prompt.

## Pinned versions

Every dependency resolves to an exact version in `package-lock.json`.

| Package | Range | Resolved | Used by |
| --- | --- | --- | --- |
| `react`, `react-dom` | `^19.2` | 19.3.1 | client |
| `vite` | `^7` | 7.3.8 | client, root |
| `@vitejs/plugin-react` | `^5.1` | 5.2.0 | client |
| `typescript` | `^5` | 5.9.3 | all three |
| `express` | `^5.1` | 5.3.0 | server |
| `multer` | `^2` | 2.5.0 | server |
| `zod` | `^4` | 4.6.7 | server |
| `vitest` | `^5.1.0` | 5.1.0 | server, client, root |
| `supertest` | `^7.3.2` | 7.3.2 | server |
| `@testing-library/react` | `^16.3.3` | 16.3.3 | client |
| `@testing-library/dom` | `^10.4.2` | 10.4.2 | client |
| `@testing-library/user-event` | `^14.6.12` | 14.6.12 | client |
| `@testing-library/jest-dom` | `^7.0.1` | 7.0.1 | client |
| `jsdom` | `^31.0.1` | 31.0.1 | client |
| `playwright` | `^1.65.1` | 1.65.1 | root |
| `@types/node` | `^22` | 22.20.5 | server, root |
| `@types/express` | `^5.0.6` | 5.0.6 | server |
| `@types/multer` | `^2.3.0` | 2.3.0 | server |
| `@types/supertest` | `^7.2.1` | 7.2.1 | server |
| `@types/react`, `@types/react-dom` | `^19` | 19.3.0 | client |

Four ranges stop below the registry's newest release for a compatibility reason. Vite is `^7` because the 8.x line falls outside the range the project declares. `@vitejs/plugin-react` is `^5.1` because no 7.x of that package exists, and 5.2.0 is the highest release whose peer range admits Vite 7. TypeScript is `^5` because its newest major lies outside the range. `@types/node` tracks the runtime's 22.x line rather than the newest release.

## Not included

Stated so no reader goes looking for them: no order entry, position sizing or broker integration; no live market-data feed, because every price comes from a submitted screenshot; no user-authored or overridable prompts; no authentication or accounts; no database or object store, because the filesystem under `DATA_DIR` is the only store; and no Docker, Terraform or CI configuration.

## Disclaimer

> Analysis of the screenshots you provided. It is not investment advice and not a recommendation to trade any instrument.
