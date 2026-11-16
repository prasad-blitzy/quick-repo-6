/**
 * Bundle leak gate: builds the client, then reads every file the build produced and fails the run
 * if the artefact holds anything that must never reach a browser.
 *
 * What it searches for, and why each is banned:
 *   - the model credential's variable name and the leading shape of its value: the client must
 *     never be able to name a credential it must not carry;
 *   - the hostname of every vendor endpoint, because the model has exactly one gateway and a second
 *     hostname in the bundle would be a second egress path;
 *   - a distinctive phrase from each of the two built-in instruction texts, which live only in the
 *     server's prompt modules and must not be inlined into the client.
 *
 * The prompt phrases are derived from those modules at run time rather than repeated here: each
 * instruction text has exactly one copy in the build, and a second copy in this script would be a
 * second source of truth that nothing keeps in step with the first. A module that cannot be read,
 * or whose text cannot be delimited, fails the gate, because a scan whose needle set came out empty
 * would pass silently and that is the one outcome a leak gate must never produce.
 *
 * The scan is exported so it can be pointed at a staged directory without running a build; the
 * build and the exit code live in the guarded entry point below.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Repository root: build and scan run there whatever directory the script started in. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The directory the client build writes: the only artefact this gate reads. */
const CLIENT_DIST = resolve(ROOT, 'client', 'dist');

const IS_WINDOWS = process.platform === 'win32';
const NPM_COMMAND = IS_WINDOWS ? 'npm.cmd' : 'npm';

/** The client build as the workspace declares it, so the gate builds what the operator builds. */
const CLIENT_BUILD_ARGS = ['run', 'build', '-w', '@trade-read/client'];

/** The credential's variable name. Its presence in a bundle means the client can name the key. */
const CREDENTIAL_VARIABLE = 'OPENROUTER_API_KEY';

/**
 * The leading shape of a vendor key, assembled from parts at run time so this file does not hold
 * the string a secret scanner looks for. The gate's subject is the shape of a key, never a key.
 */
const CREDENTIAL_KEY_PREFIX = ['sk', 'or'].join('-') + '-';

/**
 * Hostnames the build may not contain. The first is the one gateway the server uses (the client
 * reaches it through its own proxy prefix, never by name); the rest are the vendors a second egress
 * path would introduce. A Bedrock endpoint ends in `amazonaws.com`, so that suffix covers it.
 */
const PROVIDER_HOSTS = [
  'openrouter.ai',
  'openai.com',
  'anthropic.com',
  'googleapis.com',
  'amazonaws.com',
];

/**
 * The instruction texts and where their single copy lives: one module each, and the exported
 * template literal whose body the server sends to the model.
 */
const PROMPT_MODULES = [
  {
    label: 'extraction',
    path: resolve(ROOT, 'server', 'src', 'adapters', 'prompts', 'extraction-prompt.ts'),
    exportName: 'EXTRACTION_PROMPT_V1',
  },
  {
    label: 'synthesis',
    path: resolve(ROOT, 'server', 'src', 'adapters', 'prompts', 'synthesis-prompt.ts'),
    exportName: 'SYNTHESIS_PROMPT_V1',
  },
];

/**
 * Shortest phrase this gate accepts as a prompt needle. A shorter one would be a phrase ordinary
 * prose could contain by accident, and a coincidental match would fail a clean bundle.
 */
const MIN_NEEDLE_LENGTH = 16;

/** Characters kept either side of a masked span in a reported excerpt. */
const EXCERPT_RADIUS = 40;

/**
 * Longest masked run still reported with its context. Past this the excerpt carries the span's
 * length and no surrounding text, so one pathological inline blob is neither reprinted nor turned
 * into a multi-kilobyte report line.
 */
const MASKED_SPAN_LIMIT = 200;

/**
 * Characters that can belong to the same token: the base64/base64url and vendor-key alphabet plus
 * the word characters a prompt phrase carries. Whitespace, a quote, a brace, a bracket, a comma and
 * every other delimiter end the run.
 */
const TOKEN_CHARACTER = /[A-Za-z0-9_\-./+=]/;

/**
 * Skips a `${...}` interpolation beginning just after its opening brace, returning the index of the
 * first character past its closing brace, or `null` when the source ends inside it.
 *
 * Braces are counted rather than a full expression parsed: an interpolation in a prompt module is
 * an imported constant, never a construct that would put an unmatched brace inside a string.
 */
function skipInterpolation(source, start) {
  let depth = 1;
  let index = start;

  while (index < source.length) {
    const character = source[index];

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }

    index += 1;
  }

  return null;
}

/**
 * The literal segments of an exported template literal, in source order. An interpolated expression
 * is skipped instead of returned, because its value is not part of the text the gate searches for
 * and its placeholder form would never appear in a built bundle.
 *
 * Returns `null` when the export is absent or its body cannot be delimited, so the caller fails the
 * gate instead of scanning for a phrase it never derived.
 */
export function readTemplateSegments(source, exportName) {
  const literal = exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`export\\s+const\\s+${literal}\\s*(?::\\s*string)?\\s*=\\s*\``);
  const opening = declaration.exec(source);

  if (opening === null) {
    return null;
  }

  const segments = [];
  let current = '';
  let index = opening.index + opening[0].length;

  while (index < source.length) {
    const character = source[index];

    if (character === '\\') {
      const next = source[index + 1];

      if (next === undefined) {
        return null;
      }

      // An escape is kept as written: a bundle that carried the text would carry the same escape.
      current += character + next;
      index += 2;
      continue;
    }

    if (character === '`') {
      segments.push(current);
      return segments;
    }

    if (character === '$' && source[index + 1] === '{') {
      segments.push(current);
      current = '';

      const resume = skipInterpolation(source, index + 2);

      if (resume === null) {
        return null;
      }

      index = resume;
      continue;
    }

    current += character;
    index += 1;
  }

  // The literal was never closed.
  return null;
}

/**
 * Two needles per instruction text: the body's first non-empty line and its longest line, trimmed.
 *
 * A line that an interpolation cuts in half is dropped, because what a bundle would hold is the
 * interpolated value and not the source form of that line. Lines shorter than `MIN_NEEDLE_LENGTH`
 * are dropped for the same reason the threshold exists.
 */
export function derivePromptNeedles(source, exportName, label) {
  const segments = readTemplateSegments(source, exportName);

  if (segments === null) {
    return {
      needles: [],
      problem:
        `${label}: ${exportName} is not a template literal in its module, ` +
        'so no phrase could be derived from it',
    };
  }

  const lines = [];

  segments.forEach((segment, segmentIndex) => {
    const parts = segment.split('\n');

    parts.forEach((text, partIndex) => {
      // The first part of every segment but the first begins mid-line, and so does the last part of
      // every segment but the last: an interpolation sits on that side of it.
      const partial =
        (partIndex === 0 && segmentIndex > 0) ||
        (partIndex === parts.length - 1 && segmentIndex < segments.length - 1);

      if (!partial) {
        const trimmed = text.trim();

        if (trimmed !== '') {
          lines.push(trimmed);
        }
      }
    });
  });

  if (lines.length === 0) {
    return {
      needles: [],
      problem:
        `${label}: ${exportName} holds no complete non-empty line, ` +
        'so no phrase could be derived from it',
    };
  }

  let longest = lines[0];

  for (const line of lines) {
    if (line.length > longest.length) {
      longest = line;
    }
  }

  const needles = [...new Set([lines[0], longest])].filter(
    (line) => line.length >= MIN_NEEDLE_LENGTH,
  );

  if (needles.length === 0) {
    return {
      needles: [],
      problem:
        `${label}: every line of ${exportName} is shorter than ${MIN_NEEDLE_LENGTH} ` +
        'characters, so no phrase from it would be distinctive',
    };
  }

  return { needles, problem: null };
}

/**
 * The full needle set: the constant ones, plus two phrases derived from each instruction text.
 *
 * `problems` collects every reason a prompt phrase could not be derived; the caller treats a
 * non-empty list as a failed gate.
 */
export function buildScanNeedles(modules = PROMPT_MODULES) {
  const needles = [
    { label: 'the credential variable name', value: CREDENTIAL_VARIABLE },
    { label: 'the credential key shape', value: CREDENTIAL_KEY_PREFIX },
    ...PROVIDER_HOSTS.map((host) => ({ label: `the provider host ${host}`, value: host })),
  ];

  const problems = [];

  for (const module of modules) {
    let source;

    try {
      source = readFileSync(module.path, 'utf8');
    } catch (error) {
      problems.push(
        `${module.label}: its prompt module could not be read (${module.path}): ${error.message}`,
      );
      continue;
    }

    const derived = derivePromptNeedles(source, module.exportName, module.label);

    if (derived.problem !== null) {
      problems.push(derived.problem);
      continue;
    }

    for (const phrase of derived.needles) {
      needles.push({ label: `the ${module.label} prompt text`, value: phrase });
    }
  }

  return { needles, problems };
}

/** Every regular file under `directory`, depth first, as absolute paths. */
function walkFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
      continue;
    }

    if (entry.isFile()) {
      files.push(path);
      continue;
    }

    // A symlink is followed only when it lands on a regular file, so a link loop cannot hang the
    // scan and a link to a directory is covered through the directory itself.
    if (entry.isSymbolicLink()) {
      try {
        if (statSync(path).isFile()) {
          files.push(path);
        }
      } catch {
        // A dangling link holds no bytes to scan.
      }
    }
  }

  return files;
}

/** The whole token a match sits in: the match extended both ways over `TOKEN_CHARACTER`. */
function tokenSpanAt(text, index, length) {
  let start = index;
  let end = index + length;

  while (start > 0 && TOKEN_CHARACTER.test(text[start - 1])) {
    start -= 1;
  }

  while (end < text.length && TOKEN_CHARACTER.test(text[end])) {
    end += 1;
  }

  return { start, end };
}

/**
 * A window of context around a match with the whole key-shaped run it sits in masked, so a report
 * never reprints a secret. Masking the match alone would not be enough: two of the needles are the
 * six characters of a key's leading shape, so the text right after such a hit is the credential's
 * own body. The masked span is therefore the token the match belongs to — extended over every
 * character that can belong to it — and the context window sits outside that span. A span past
 * `MASKED_SPAN_LIMIT` is reported by its length alone, with no surrounding text.
 */
function redactExcerpt(text, index, length) {
  const span = tokenSpanAt(text, index, length);
  const maskedLength = span.end - span.start;

  if (maskedLength > MASKED_SPAN_LIMIT) {
    return `[REDACTED: ${maskedLength} characters]`;
  }

  const start = Math.max(0, span.start - EXCERPT_RADIUS);
  const end = Math.min(text.length, span.end + EXCERPT_RADIUS);
  const before = text.slice(start, span.start).replace(/\s+/g, ' ');
  const after = text.slice(span.end, end).replace(/\s+/g, ' ');

  return `${start > 0 ? '...' : ''}${before}[REDACTED]${after}${end < text.length ? '...' : ''}`;
}

/**
 * The pure scanning surface: reads every file under `distDir` and reports each needle found.
 *
 * Files are read as bytes and decoded as UTF-8 with replacement, so a binary asset is scanned
 * instead of skipped. A missing or empty directory is a failure in its own right and is reported as
 * `ok: false` with no matches, which the caller must not mistake for a clean scan.
 */
export function collectBundleLeaks(distDir, needles) {
  for (const needle of needles) {
    if (typeof needle.value !== 'string' || needle.value === '') {
      throw new Error('collectBundleLeaks: every needle needs a non-empty string value');
    }
  }

  const root = resolve(distDir);

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return {
      ok: false,
      reason: `${root} does not exist, so there was no bundle to scan`,
      filesScanned: 0,
      bytesScanned: 0,
      matches: [],
    };
  }

  const files = walkFiles(root);

  if (files.length === 0) {
    return {
      ok: false,
      reason: `${root} holds no files, so there was no bundle to scan`,
      filesScanned: 0,
      bytesScanned: 0,
      matches: [],
    };
  }

  const matches = [];
  let bytesScanned = 0;

  for (const file of files) {
    const buffer = readFileSync(file);
    bytesScanned += buffer.length;

    const text = buffer.toString('utf8');

    for (const needle of needles) {
      const first = text.indexOf(needle.value);

      if (first === -1) {
        continue;
      }

      let occurrences = 0;
      let from = first;

      while (from !== -1) {
        occurrences += 1;
        from = text.indexOf(needle.value, from + needle.value.length);
      }

      matches.push({
        file: relative(ROOT, file),
        label: needle.label,
        occurrences,
        excerpt: redactExcerpt(text, first, needle.value.length),
      });
    }
  }

  return {
    ok: matches.length === 0,
    reason: null,
    filesScanned: files.length,
    bytesScanned,
    matches,
  };
}

function formatCommand(args) {
  return [NPM_COMMAND, ...args].join(' ');
}

/** Prints a failing gate with one line per reason, and marks the exit code. */
function fail(reason, details = []) {
  console.error('\nverify:bundle FAILED');
  console.error(`  reason  ${reason}`);

  for (const detail of details) {
    console.error(`  ${detail}`);
  }

  process.exitCode = 1;
}

/**
 * Builds the client exactly as the workspace build does. The bundle the scan reads has to be the
 * one the operator's `npm run build` produces, so a stale `client/dist` is never accepted.
 */
function buildClient() {
  const command = formatCommand(CLIENT_BUILD_ARGS);

  console.log(
    `verify:bundle: building the client\n  step     build client bundle\n  command  ${command}`,
  );

  const result = spawnSync(NPM_COMMAND, CLIENT_BUILD_ARGS, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });

  if (result.error) {
    fail('the client build could not be started', [
      `step     build client bundle`,
      `command  ${command}`,
      `error    ${result.error.message}`,
    ]);
    return false;
  }

  if (result.status !== 0) {
    const outcome =
      result.status === null ? `signal ${result.signal}` : `exit code ${result.status}`;

    fail('the client build failed, so there is no fresh bundle to scan', [
      `step     build client bundle`,
      `command  ${command}`,
      `outcome  ${outcome}`,
    ]);
    return false;
  }

  return true;
}

function main() {
  if (!buildClient()) {
    return;
  }

  const { needles, problems } = buildScanNeedles();

  if (problems.length > 0) {
    fail('a prompt phrase could not be derived, so the prompt half of the scan was not run', [
      ...problems.map((problem) => `problem  ${problem}`),
      `expected  ${PROMPT_MODULES.map((module) => module.path).join(', ')}`,
    ]);
    return;
  }

  const result = collectBundleLeaks(CLIENT_DIST, needles);

  if (!result.ok && result.matches.length === 0) {
    fail(result.reason, [`expected  a built bundle at ${CLIENT_DIST}`]);
    return;
  }

  if (!result.ok) {
    fail(`${result.matches.length} banned string(s) found in the built client`, [
      ...result.matches.map(
        (match) =>
          `hit      ${match.file}: ${match.label} (${match.occurrences}x) "${match.excerpt}"`,
      ),
    ]);
    return;
  }

  const labels = needles.map((needle) => needle.label).join(', ');

  console.log(
    `verify:bundle: clean - ${result.filesScanned} file(s), ${result.bytesScanned} byte(s) ` +
      `scanned for ${needles.length} needle(s): ${labels}`,
  );
}

// The entry point, guarded so the scan can be re-run against a staged directory without a build.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
