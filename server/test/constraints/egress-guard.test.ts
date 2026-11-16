/**
 * Static-scan constraint suite: the repository's required absences, proven by reading text.
 *
 * Every case here reads file text with `node:fs` and parses it, and none imports a server or client
 * module: importing would execute it, and the question is what the source declares, not what it
 * does. The suite fails when a second vendor endpoint, a provider SDK, a database or object-store
 * driver, or the model credential's name or value appears where the AAP says it must never appear
 * (AAP §0.6.5), which is the evidence column for success criterion 9's source-side half.
 *
 * The scan is on resolved dependency names, import specifiers and URL hosts, never on raw
 * substrings of a file, so a comment or a test title cannot make a case fail. Host scans read
 * comment-stripped text, because real egress lives in string literals while prose about it lives in
 * comments; import scans read raw text, because imports are syntax and appear in no comment.
 *
 * This file lives in `server/test/constraints/`, outside the three scanned roots and outside
 * `fixtures/`, so the literal tokens it must look for - the credential's variable name, the
 * key-shape patterns, the vendor hostnames - cannot make it trip on itself. Nothing here prints a
 * file body or a matched value: a hit reports `relative/path: token`, and a token is a package
 * name, a variable name or a hostname, never a credential.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_DEV_ORIGINS } from '@trade-read/shared';
import { describe, expect, it } from 'vitest';

// -------------------------------------------------------------------------------------------------
// Scanned locations
// -------------------------------------------------------------------------------------------------

/**
 * Repository root, derived from this file's own URL instead of the process working directory, so the
 * suite reports the same result however it is started. The file sits three directories below the
 * root (`server/test/constraints/`); the URL form carries a trailing separator that `resolve` drops.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/**
 * The three source roots the guard scans (AAP §0.4.1). Tests, `fixtures/`, `e2e/` and `scripts/`
 * are deliberately outside the list: this suite's own tokens live under `server/test/`, and the
 * only assertion that covers `fixtures/` is the credential-value scan.
 */
const SOURCE_ROOTS = ['client/src', 'server/src', 'shared/src'] as const;

/** The one root scanned on its own by the single-egress-module assertion. */
const SERVER_SOURCE_ROOT = 'server/src';

/** The fixtures tree, scanned for credential values only. */
const FIXTURES_ROOT = 'fixtures';

/** Extensions read as source text; an asset is never parsed as source. */
const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
]);

/** Directory names skipped anywhere in a walk: dependencies, build output and runtime state. */
const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.data',
  '.e2e',
  'playwright-report',
  'test-results',
]);

// -------------------------------------------------------------------------------------------------
// Explicit allow and deny tables
//
// Each entry below names the AAP row it enforces. The permitted egress host and the loopback origins
// are the exception, and deliberately so: they are derived at run time - the host from
// server/src/config/env.ts, the origins from `@trade-read/shared` - so this guard cannot drift from
// the build it guards (D4: one implementation of every shared fact).
// -------------------------------------------------------------------------------------------------

/**
 * Forbidden model-provider and cloud-AI hostnames (AAP §0.4.1, §0.6.5), suffix-matched so every
 * subdomain is caught. `openrouter.ai` is deliberately absent: it is the single permitted egress and
 * is derived from `server/src/config/env.ts` at run time rather than listed here.
 */
const FORBIDDEN_EGRESS_HOSTS = [
  'openai.com',
  'openai.azure.com',
  'azure.com',
  'anthropic.com',
  'claude.ai',
  'googleapis.com',
  'generativelanguage.googleapis.com',
  'google.com',
  'amazonaws.com',
  'bedrock.amazonaws.com',
  'cohere.ai',
  'cohere.com',
  'mistral.ai',
  'groq.com',
  'together.ai',
  'together.xyz',
  'replicate.com',
  'huggingface.co',
  'ai21.com',
  'voyageai.com',
  'perplexity.ai',
  'deepseek.com',
  'x.ai',
  'meta.ai',
  'ollama.com',
  'openrouter.com',
] as const;

/**
 * Provider SDK and orchestration packages the build must never declare or import (AAP §0.9.1,
 * §0.9.3). Matched against resolved dependency names and import specifiers, never file text.
 */
const FORBIDDEN_PROVIDER_SDK_PACKAGES = [
  'openai',
  '@anthropic-ai/sdk',
  '@google-cloud/aiplatform',
  '@google/generative-ai',
  '@google/genai',
  '@aws-sdk/client-bedrock-runtime',
  'langchain',
  'langchain-core',
  '@langchain/core',
  '@langchain/openai',
  'cohere-ai',
  '@mistralai/mistralai',
  'groq-sdk',
  '@huggingface/inference',
  'ai',
] as const;

/**
 * Database, cache and object-store drivers the build must never declare or import (AAP §0.6.5,
 * §0.9.3): persistence is one JSON document per analysis on the filesystem, behind the
 * `AnalysisRepository` port.
 */
const FORBIDDEN_DATA_STORE_PACKAGES = [
  'mongodb',
  'mongoose',
  'pg',
  'pg-promise',
  'mysql',
  'mysql2',
  'redis',
  'ioredis',
  '@aws-sdk/client-s3',
  'sqlite3',
  'better-sqlite3',
  '@prisma/client',
  'prisma',
  'knex',
  'typeorm',
  'sequelize',
  'cassandra-driver',
  'dynamodb',
  'minio',
] as const;

/** The complete approved runtime dependency set of `server/package.json` (AAP §0.9.1). */
const APPROVED_SERVER_DEPENDENCIES = [
  'express',
  'multer',
  'zod',
  '@trade-read/shared',
] as const;

/** The complete approved development dependency set of `server/package.json` (AAP §0.9.1). */
const APPROVED_SERVER_DEV_DEPENDENCIES = [
  'vitest',
  'supertest',
  'typescript',
  '@types/node',
  '@types/express',
  '@types/multer',
  '@types/supertest',
] as const;

/** The only model credential in the build, by name (AAP §0.4.5). */
const CREDENTIAL_VARIABLE_NAME = 'OPENROUTER_API_KEY';

/** The single file permitted to name the credential (AAP §0.4.5): the configuration boundary. */
const CREDENTIAL_OWNER_PATH = 'server/src/config/env.ts';

/** Holds the documented `OPENROUTER_BASE_URL` default, from which the permitted host is derived. */
const EGRESS_CONFIGURATION_PATH = 'server/src/config/env.ts';

/**
 * The only module permitted to perform server-side network I/O (AAP §0.4.1).
 *
 * Both cases that read this constant are deliberately strict about it: an absent egress module has
 * to fail the guard, not pass it, because a check that tolerates the module's absence proves nothing
 * once the module is missing - which is exactly when a second endpoint could appear unnoticed. If
 * the sole HTTP call ever moves, this constant is the one line to update.
 */
const SERVER_EGRESS_MODULE_PATH = 'server/src/adapters/openrouter/openrouter-client.ts';

/**
 * Credential shapes, never credential values (AAP §0.4.5). A hit reports the file path and never the
 * matched text, so no failure output can carry a secret. Neither pattern is global: a stateful
 * `lastIndex` would make repeated tests disagree.
 */
const KEY_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bsk-or-[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9]{16,}/,
];

/** A credential variable assigned or defaulted with a value, as only a fixture could hold one. */
const CREDENTIAL_ASSIGNMENT_PATTERN = /OPENROUTER_API_KEY\s*[=:]\s*\S+/;

/** The workspace manifests whose declared dependencies are inventoried (AAP §0.9.1). */
const WORKSPACE_MANIFEST_PATHS = [
  'package.json',
  'shared/package.json',
  'server/package.json',
  'client/package.json',
] as const;

/** Manifest sections that declare a package; all four are inventoried. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** Tokens that appear only when a module performs network I/O itself. */
const NETWORK_IO_TOKENS = ['fetch(', 'http.request', 'https.request', 'undici'] as const;

/**
 * Extensions that mark a bare token as a file name rather than a hostname, so `document.json` and
 * `analysis-service.ts` are discarded before the deny list is consulted.
 */
const NON_HOST_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.md',
  '.txt',
  '.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '.pdf',
]);

// -------------------------------------------------------------------------------------------------
// Path arithmetic and filesystem walking
// -------------------------------------------------------------------------------------------------

/** One scanned source file: where it is, how it is reported, and the text the scanners read. */
interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Whether a filesystem error means the path simply is not there.
 *
 * A missing directory is not a scan failure in itself - the integrity cases decide whether an absent
 * root is legitimate - so the walk treats `ENOENT` as "nothing to walk" and rethrows everything else.
 */
function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Every file beneath a directory, as absolute paths, sorted for deterministic reporting.
 *
 * The walk is an explicit stack rather than a recursive function, skips the dependency, build and
 * runtime-state directories by name, and skips symbolic links: a link could lead the scan outside
 * the repository or into a directory that is being written concurrently.
 *
 * @param absoluteDir - Directory to walk.
 * @returns Absolute paths of the files found, sorted.
 */
function walkFiles(absoluteDir: string): string[] {
  const collected: string[] = [];
  const pending: string[] = [absoluteDir];

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined) {
      break;
    }

    let entries: Dirent[];

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }

      throw error;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absolute = join(current, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          pending.push(absolute);
        }

        continue;
      }

      if (entry.isFile()) {
        collected.push(absolute);
      }
    }
  }

  return collected.sort();
}

/**
 * The files beneath a directory, or nothing when the directory does not exist.
 *
 * The integrity cases require the roots and `fixtures/` to exist, so an absent directory is reported
 * there rather than passing silently through every scan as an empty result.
 *
 * @param absoluteDir - Directory to walk.
 * @returns Absolute paths of the files found, sorted.
 */
function listFilesIfPresent(absoluteDir: string): string[] {
  return existsSync(absoluteDir) ? walkFiles(absoluteDir) : [];
}

/**
 * A path relative to the repository root, with forward slashes, so a reported violation reads the
 * same on every platform and names no absolute location.
 *
 * @param absolute - Absolute path inside the repository.
 * @returns Repository-relative path.
 */
function toRepoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

/**
 * Read a file as UTF-8 text.
 *
 * @param absolute - Absolute path of the file.
 * @returns The file's text.
 */
function readText(absolute: string): string {
  return readFileSync(absolute, 'utf8');
}

/**
 * Read a repository-relative file, failing with the path that is missing.
 *
 * @param repoPath - Repository-relative path of the file.
 * @returns The file's text.
 */
function readRepoText(repoPath: string): string {
  const absolute = join(REPO_ROOT, repoPath);

  if (!existsSync(absolute)) {
    throw new Error(`required file is missing: ${repoPath}`);
  }

  return readText(absolute);
}

/** Source files of the three scanned roots, read once per run. */
let cachedSourceFiles: readonly SourceFile[] | null = null;

/**
 * The source files of every scanned root, read on first use and reused afterwards.
 *
 * @returns The scanned source files, sorted by repository path.
 */
function sourceFiles(): readonly SourceFile[] {
  if (cachedSourceFiles === null) {
    cachedSourceFiles = SOURCE_ROOTS.flatMap((root) => listFilesIfPresent(join(REPO_ROOT, root)))
      .filter((absolute) => TEXT_FILE_EXTENSIONS.has(extname(absolute)))
      .sort()
      .map((absolute) => ({ path: toRepoPath(absolute), text: readText(absolute) }));
  }

  return cachedSourceFiles;
}

// -------------------------------------------------------------------------------------------------
// Text scanners
// -------------------------------------------------------------------------------------------------

/**
 * The source with comments removed and every string literal preserved.
 *
 * Real egress lives in string literals while prose about it lives in comments, so a hostname scan on
 * comment-stripped text reports what the code would actually contact and ignores documentation. The
 * scanner is a single pass over characters: inside `'…'`, `"…"` and `` `…` `` nothing is treated as a
 * comment (backslash escapes are honoured), and outside them `//` to end of line and `/* … *\/` are
 * dropped. A template literal's `${…}` is treated as literal text, which can only make the scan miss
 * a comment - never invent one.
 *
 * @param source - Raw file text.
 * @returns The text with comments replaced by nothing.
 */
function stripComments(source: string): string {
  let result = '';
  let index = 0;
  let quote: '"' | "'" | '`' | null = null;

  while (index < source.length) {
    const character = source.charAt(index);
    const next = index + 1 < source.length ? source.charAt(index + 1) : '';

    if (quote !== null) {
      result += character;

      if (character === '\\' && next !== '') {
        result += next;
        index += 2;
        continue;
      }

      if (character === quote) {
        quote = null;
      }

      index += 1;
      continue;
    }

    if (character === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index);
      index = lineEnd === -1 ? source.length : lineEnd;
      continue;
    }

    if (character === '/' && next === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 2;
      // One space keeps the tokens on either side of a removed comment apart.
      result += ' ';
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
    }

    result += character;
    index += 1;
  }

  return result;
}

/**
 * Sources of the module specifier forms an import or re-export can take: `import … from 'S'`,
 * `import 'S'`, `export … from 'S'`, `import('S')` and `require('S')`. Every form allows a newline
 * before `from`.
 */
const IMPORT_SPECIFIER_PATTERN_SOURCES: readonly string[] = [
  String.raw`\bimport\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]`,
  String.raw`\bexport\s+[^'"]*?\sfrom\s*['"]([^'"]+)['"]`,
  String.raw`\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)`,
  String.raw`\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)`,
];

/**
 * Every module specifier a file imports or re-exports, de-duplicated and sorted.
 *
 * This is what makes "no provider SDK import resolves" a real check rather than a substring search:
 * only specifiers, which are syntax, are collected, so a comment or a prompt string that happens to
 * name a package is invisible to it.
 *
 * @param source - Raw file text.
 * @returns The distinct import specifiers, sorted.
 */
function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();

  for (const patternSource of IMPORT_SPECIFIER_PATTERN_SOURCES) {
    const pattern = new RegExp(patternSource, 'gu');

    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];

      if (specifier !== undefined && specifier.length > 0) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers].sort();
}

/** Matches an absolute `http` or `https` URL; a `data:` URL and a relative path cannot match. */
const URL_PATTERN = /https?:\/\/[^\s"'`<>)\]]+/gu;

/**
 * The hostnames of every absolute URL in the text, lower-cased, de-duplicated and sorted.
 *
 * Only an `http`/`https` scheme is matched, so an inline `data:image/png;base64,…` payload is never
 * mistaken for a request target and no base64 content is ever parsed.
 *
 * @param source - Comment-stripped file text.
 * @returns The distinct URL hostnames, sorted.
 */
function extractUrlHosts(source: string): string[] {
  const hosts = new Set<string>();

  for (const match of source.matchAll(URL_PATTERN)) {
    try {
      hosts.add(new URL(match[0]).hostname.toLowerCase());
    } catch {
      // Not a parseable URL, so not an egress target either.
      continue;
    }
  }

  return [...hosts].sort();
}

/**
 * Host-shaped tokens: dotted labels ending in a two-letter-or-longer alphabetic suffix.
 *
 * The lookbehind keeps the match from starting inside a path, an import specifier or another token,
 * so `client/vite.config.ts` and `./contract.js` never produce one.
 */
const BARE_HOST_PATTERN = /(?<![\w./@-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w-])/gu;

/**
 * Host-shaped tokens in the text, for the deny list only, with file names discarded.
 *
 * A token is kept only when it could be read as a hostname: it carries a dot, and its extension is
 * not one that marks a file, so `document.json` and `analysis-service.ts` are dropped before the
 * deny list sees them. Tokens are compared to `FORBIDDEN_EGRESS_HOSTS` alone; the general
 * "no other URL host" case reads `extractUrlHosts` instead, so a dotted fragment that is not a host
 * cannot fail the suite.
 *
 * @param source - Comment-stripped file text.
 * @returns The distinct host-shaped tokens, lower-cased and sorted.
 */
function extractBareHostTokens(source: string): string[] {
  const tokens = new Set<string>();

  for (const match of source.matchAll(BARE_HOST_PATTERN)) {
    const token = match[0].toLowerCase();

    if (!token.includes('.') || NON_HOST_FILE_EXTENSIONS.has(extname(token))) {
      continue;
    }

    tokens.add(token);
  }

  return [...tokens].sort();
}

/**
 * Whether a hostname is the given host or one of its subdomains.
 *
 * Suffix matching on label boundaries catches `api.openai.com` and `openai.azure.com` for the entry
 * `openai.com`, while `notopenai.com.example` is not a match.
 *
 * @param hostname - Hostname to test, already lower-cased.
 * @param suffix - Deny-list or allow-list entry.
 * @returns Whether the hostname belongs to the entry.
 */
function hostMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/**
 * Whether a dependency name or import specifier names the given package or one of its entry points.
 *
 * Equality, or a `/`-separated descent into the package - never a substring test, so `ai` does not
 * match `vitest` and `pg` does not match `png`.
 *
 * @param specifier - Declared dependency name or import specifier.
 * @param packageName - Deny-list entry.
 * @returns Whether the specifier resolves to that package.
 */
function packageMatches(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

// -------------------------------------------------------------------------------------------------
// Violation reporting
// -------------------------------------------------------------------------------------------------

/** One reported hit: where it was found, and the token that identifies what was found. */
interface Violation {
  readonly path: string;
  readonly token: string;
}

/**
 * Render hits as one `path: token` line each, for the failure message.
 *
 * @param violations - Hits to render.
 * @returns The lines, newline-separated.
 */
const formatViolations = (violations: readonly Violation[]): string =>
  violations.map((violation) => `${violation.path}: ${violation.token}`).join('\n');

/**
 * De-duplicate hits and sort them, so a failure reads the same on every run.
 *
 * @param violations - Hits to normalise.
 * @returns The distinct hits, sorted by path then token.
 */
function normaliseViolations(violations: readonly Violation[]): Violation[] {
  const seen = new Map<string, Violation>();

  for (const violation of violations) {
    seen.set(`${violation.path}\u0000${violation.token}`, violation);
  }

  return [...seen.values()].sort((left, right) =>
    left.path === right.path
      ? left.token.localeCompare(right.token)
      : left.path.localeCompare(right.path),
  );
}

/**
 * Whether any declared entry, import specifier or hostname resolves to one of the denied names.
 *
 * @param candidates - Names to test.
 * @param denied - Deny list.
 * @returns The matching candidates, in input order.
 */
function findDeniedNames(candidates: readonly string[], denied: readonly string[]): string[] {
  return candidates.filter((candidate) => denied.some((name) => packageMatches(candidate, name)));
}

/**
 * Whether a name appears in one of the explicit inventory lists.
 *
 * @param name - Declared package name.
 * @param list - Approved inventory.
 * @returns Whether the list carries the name.
 */
function isListed(name: string, list: readonly string[]): boolean {
  return list.includes(name);
}

/**
 * Narrow an unknown JSON value to a plain object, so no cast is needed to read its keys.
 *
 * @param value - Parsed JSON value.
 * @returns Whether the value is a non-array object.
 */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// -------------------------------------------------------------------------------------------------
// Workspace manifests
// -------------------------------------------------------------------------------------------------

/** A parsed workspace manifest: where it came from, and its top-level fields. */
interface WorkspaceManifest {
  readonly path: string;
  readonly document: Record<string, unknown>;
}

/**
 * Read and parse a workspace manifest.
 *
 * @param repoPath - Repository-relative path of the manifest.
 * @returns The parsed manifest.
 * @throws When the file is missing or does not hold a JSON object.
 */
function readManifest(repoPath: string): WorkspaceManifest {
  const parsed: unknown = JSON.parse(readRepoText(repoPath));

  if (!isUnknownRecord(parsed)) {
    throw new Error(`manifest is not a JSON object: ${repoPath}`);
  }

  return { path: repoPath, document: parsed };
}

/**
 * The declared package names of one manifest section.
 *
 * @param manifest - Parsed manifest.
 * @param field - Section name, one of `DEPENDENCY_FIELDS`.
 * @returns The declared package names, empty when the section is absent or malformed.
 */
function manifestSection(manifest: WorkspaceManifest, field: string): readonly string[] {
  const section = manifest.document[field];

  return isUnknownRecord(section) ? Object.keys(section) : [];
}

/**
 * Every package name a manifest declares, across all four dependency sections.
 *
 * @param manifest - Parsed manifest.
 * @returns The declared package names.
 */
function declaredPackageNames(manifest: WorkspaceManifest): readonly string[] {
  return DEPENDENCY_FIELDS.flatMap((field) => manifestSection(manifest, field));
}

/**
 * Every file beneath `fixtures/`, repository-relative.
 *
 * @returns The fixture files, sorted.
 * @throws When the tree is absent, because the recorded envelopes, screenshots and unsupported-type
 *   fixture are required by the analysis contract and a missing tree would make the scan vacuous.
 */
function fixtureFiles(): readonly string[] {
  const absoluteDir = join(REPO_ROOT, FIXTURES_ROOT);

  if (!existsSync(absoluteDir)) {
    throw new Error(
      `${FIXTURES_ROOT}/ missing - the recorded envelopes and screenshots are required by the analysis contract`,
    );
  }

  return walkFiles(absoluteDir).map(toRepoPath);
}

// -------------------------------------------------------------------------------------------------
// Egress allowlist (AAP §0.4.1, §0.6.5: one destination, one credential)
// -------------------------------------------------------------------------------------------------

describe('egress allowlist', () => {
  it('derives the permitted egress host from the server configuration', () => {
    const hosts = extractUrlHosts(readRepoText(EGRESS_CONFIGURATION_PATH));

    expect(hosts, `no URL host found in ${EGRESS_CONFIGURATION_PATH}`).not.toEqual([]);
    expect(hosts).toContain('openrouter.ai');
  });

  it('denies every vendor host the AAP names', () => {
    expect(FORBIDDEN_EGRESS_HOSTS.length).toBeGreaterThanOrEqual(10);

    for (const required of ['openai.com', 'anthropic.com', 'googleapis.com', 'amazonaws.com']) {
      expect([...FORBIDDEN_EGRESS_HOSTS]).toContain(required);
    }

    const violations = extractUrlHosts(readRepoText(EGRESS_CONFIGURATION_PATH)).flatMap((host) =>
      FORBIDDEN_EGRESS_HOSTS.filter((denied) => hostMatches(host, denied)).map((denied) => ({
        path: EGRESS_CONFIGURATION_PATH,
        token: `${host} (denied by ${denied})`,
      })),
    );
    const hits = normaliseViolations(violations);

    expect(hits, formatViolations(hits)).toEqual([]);
  });

  it('finds no vendor hostname in server/src, client/src or shared/src', () => {
    const violations: Violation[] = [];

    for (const file of sourceFiles()) {
      const stripped = stripComments(file.text);
      const hosts = new Set([...extractUrlHosts(stripped), ...extractBareHostTokens(stripped)]);

      for (const host of hosts) {
        for (const denied of FORBIDDEN_EGRESS_HOSTS) {
          if (hostMatches(host, denied)) {
            violations.push({ path: file.path, token: host });
          }
        }
      }
    }

    const hits = normaliseViolations(violations);

    expect(hits, formatViolations(hits)).toEqual([]);
  });

  it('uses no URL host other than the permitted egress or the loopback dev origins', () => {
    const allowedHosts = new Set<string>(extractUrlHosts(readRepoText(EGRESS_CONFIGURATION_PATH)));

    for (const origin of CLIENT_DEV_ORIGINS) {
      allowedHosts.add(new URL(origin).hostname.toLowerCase());
    }

    for (const loopback of ['localhost', '127.0.0.1', '::1']) {
      allowedHosts.add(loopback);
    }

    expect(allowedHosts.size).toBeGreaterThanOrEqual(4);

    const violations: Violation[] = [];

    for (const file of sourceFiles()) {
      for (const host of extractUrlHosts(stripComments(file.text))) {
        if (!allowedHosts.has(host)) {
          violations.push({ path: file.path, token: host });
        }
      }
    }

    const hits = normaliseViolations(violations);

    expect(hits, formatViolations(hits)).toEqual([]);
  });

  it('performs server-side network I/O in exactly one module', () => {
    const ioModules = listFilesIfPresent(join(REPO_ROOT, SERVER_SOURCE_ROOT))
      .filter((absolute) => TEXT_FILE_EXTENSIONS.has(extname(absolute)))
      .filter((absolute) => {
        const stripped = stripComments(readText(absolute));

        return NETWORK_IO_TOKENS.some((token) => stripped.includes(token));
      })
      .map(toRepoPath)
      .sort();

    const offenders = ioModules.filter((modulePath) => modulePath !== SERVER_EGRESS_MODULE_PATH);
    const ioReport =
      ioModules.length === 0
        ? `no module under ${SERVER_SOURCE_ROOT} performs network I/O, so ${SERVER_EGRESS_MODULE_PATH} is absent`
        : `server-side network I/O belongs in ${SERVER_EGRESS_MODULE_PATH} alone, but it also appears in: ${offenders.join(', ')}`;

    expect(ioModules, ioReport).toEqual([SERVER_EGRESS_MODULE_PATH]);
  });
});

// -------------------------------------------------------------------------------------------------
// Provider SDKs (AAP §0.6.5, §0.9.1: no provider SDK dependency or import)
// -------------------------------------------------------------------------------------------------

describe('provider SDK imports', () => {
  it('declares no provider SDK in any workspace manifest', () => {
    const violations: Violation[] = [];

    for (const repoPath of WORKSPACE_MANIFEST_PATHS) {
      if (!existsSync(join(REPO_ROOT, repoPath))) {
        continue;
      }

      for (const name of findDeniedNames(
        declaredPackageNames(readManifest(repoPath)),
        FORBIDDEN_PROVIDER_SDK_PACKAGES,
      )) {
        violations.push({ path: repoPath, token: name });
      }
    }

    const hits = normaliseViolations(violations);

    expect(hits, formatViolations(hits)).toEqual([]);
  });

  it('imports no provider SDK in any scanned source file', () => {
    const violations: Violation[] = [];

    for (const file of sourceFiles()) {
      for (const specifier of findDeniedNames(
        extractImportSpecifiers(file.text),
        FORBIDDEN_PROVIDER_SDK_PACKAGES,
      )) {
        violations.push({ path: file.path, token: specifier });
      }
    }

    const hits = normaliseViolations(violations);

    expect(hits, formatViolations(hits)).toEqual([]);
  });

  it('cannot resolve a provider SDK from the server package', () => {
    const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));

    for (const name of FORBIDDEN_PROVIDER_SDK_PACKAGES) {
      expect(
        () => requireFromServer.resolve(name),
        `${name} resolves from the server package`,
      ).toThrow();
    }
  });

  it('keeps the server dependency set inside the approved inventory', () => {
    const manifest = readManifest('server/package.json');
    const declared = manifestSection(manifest, 'dependencies');
    const declaredDev = manifestSection(manifest, 'devDependencies');

    const unexpected = [
      ...declared.filter((name) => !isListed(name, APPROVED_SERVER_DEPENDENCIES)),
      ...declaredDev.filter((name) => !isListed(name, APPROVED_SERVER_DEV_DEPENDENCIES)),
    ];
    const hits = normaliseViolations(unexpected.map((token) => ({ path: manifest.path, token })));

    expect(hits, formatViolations(hits)).toEqual([]);

    for (const required of APPROVED_SERVER_DEPENDENCIES) {
      expect(declared).toContain(required);
    }

    for (const required of APPROVED_SERVER_DEV_DEPENDENCIES) {
      expect(declaredDev).toContain(required);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Database and object-store drivers (AAP §0.6.5, §0.9.3: filesystem persistence only)
// -------------------------------------------------------------------------------------------------

describe('database and object-store drivers', () => {
  it('declares no database or object-store driver in any workspace manifest', () => {
    const violations: Violation[] = [];

    for (const repoPath of WORKSPACE_MANIFEST_PATHS) {
      if (!existsSync(join(REPO_ROOT, repoPath))) {
        continue;
      }

      for (const name of findDeniedNames(
        declaredPackageNames(readManifest(repoPath)),
        FORBIDDEN_DATA_STORE_PACKAGES,
      )) {
        violations.push({ path: repoPath, token: name });
      }
    }

    const hits = normaliseViolations(violations);

    expect(hits, formatViolations(hits)).toEqual([]);
  });

  it('imports no database or object-store driver in any scanned source file', () => {
    const violations: Violation[] = [];

    for (const file of sourceFiles()) {
      for (const specifier of findDeniedNames(
        extractImportSpecifiers(file.text),
        FORBIDDEN_DATA_STORE_PACKAGES,
      )) {
        violations.push({ path: file.path, token: specifier });
      }
    }

    const hits = normaliseViolations(violations);

    expect(hits, formatViolations(hits)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Credential containment (AAP §0.4.5, §0.6.5: the credential never leaves configuration)
// -------------------------------------------------------------------------------------------------

describe('credential containment', () => {
  it('mentions the credential variable in exactly one source file', () => {
    const owners = sourceFiles()
      .filter((file) => file.text.includes(CREDENTIAL_VARIABLE_NAME))
      .map((file) => file.path);

    expect(
      owners,
      formatViolations(owners.map((path) => ({ path, token: CREDENTIAL_VARIABLE_NAME }))),
    ).toEqual([CREDENTIAL_OWNER_PATH]);
  });

  it('exposes no key-shaped string in the three source roots', () => {
    // Only the path is reported: the matched text would be the credential itself.
    const offenders = sourceFiles()
      .filter((file) => KEY_SHAPE_PATTERNS.some((pattern) => pattern.test(file.text)))
      .map((file) => ({ path: file.path, token: 'credential-shaped string' }));
    const hits = normaliseViolations(offenders);

    expect(hits, formatViolations(hits)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Fixtures (AAP §0.6.5: no recorded key, in any file)
// -------------------------------------------------------------------------------------------------

describe('fixtures', () => {
  it('holds no key-shaped string in any fixture file', () => {
    // Only the path is reported: the matched text would be the credential itself.
    const offenders = fixtureFiles()
      .filter((repoPath) =>
        KEY_SHAPE_PATTERNS.some((pattern) => pattern.test(readText(join(REPO_ROOT, repoPath)))),
      )
      .map((path) => ({ path, token: 'credential-shaped string' }));
    const hits = normaliseViolations(offenders);

    expect(hits, formatViolations(hits)).toEqual([]);
  });

  it('holds no credential variable assignment with a value', () => {
    const offenders = fixtureFiles()
      .filter((repoPath) =>
        CREDENTIAL_ASSIGNMENT_PATTERN.test(readText(join(REPO_ROOT, repoPath))),
      )
      .map((path) => ({ path, token: 'credential assignment' }));
    const hits = normaliseViolations(offenders);

    expect(hits, formatViolations(hits)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Scan integrity (a guard that scans nothing must not pass)
// -------------------------------------------------------------------------------------------------

describe('scan integrity', () => {
  it('finds all three scanned source roots', () => {
    for (const root of SOURCE_ROOTS) {
      expect(existsSync(join(REPO_ROOT, root)), `${root} is missing`).toBe(true);
      expect(
        listFilesIfPresent(join(REPO_ROOT, root)).length,
        `${root} holds no file`,
      ).toBeGreaterThan(0);
    }

    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it('finds the known configuration and adapter files', () => {
    const serverFiles = new Set(
      listFilesIfPresent(join(REPO_ROOT, SERVER_SOURCE_ROOT)).map(toRepoPath),
    );

    expect(serverFiles.has(EGRESS_CONFIGURATION_PATH), `${EGRESS_CONFIGURATION_PATH} was not found`).toBe(
      true,
    );
    expect(
      serverFiles.has(SERVER_EGRESS_MODULE_PATH),
      `${SERVER_EGRESS_MODULE_PATH} was not found - update SERVER_EGRESS_MODULE_PATH if the module moved`,
    ).toBe(true);
  });

  it('finds the workspace manifests', () => {
    for (const repoPath of ['package.json', 'server/package.json']) {
      expect(existsSync(join(REPO_ROOT, repoPath)), `${repoPath} is missing`).toBe(true);
      expect(() => readManifest(repoPath), `${repoPath} does not parse`).not.toThrow();
    }
  });

  it('finds the fixtures tree', () => {
    expect(existsSync(join(REPO_ROOT, FIXTURES_ROOT)), `${FIXTURES_ROOT}/ is missing`).toBe(true);
    expect(fixtureFiles().length).toBeGreaterThan(0);
  });
});
