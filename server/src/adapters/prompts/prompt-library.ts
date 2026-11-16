/**
 * The single access point to the two built-in instruction texts, and the only source of the version
 * string every analysis records.
 *
 * Nothing downstream reads a prompt module directly: the provider adapter asks this library for the
 * text it sends, and the document builder asks it for the version it persists, so the wording a
 * model saw and the revision written beside a stored read cannot disagree. No getter takes an
 * argument and none reads configuration, a request or the environment, so no caller can substitute,
 * extend or suppress an instruction: the prompts are this system's, never the operator's.
 *
 * Each text lives in its own sibling module beside its own version constant, which is the only place
 * either version is written. A wording change bumps that constant, and the derived version below
 * follows without a second edit.
 */

import { EXTRACTION_PROMPT_V1, EXTRACTION_PROMPT_VERSION } from './extraction-prompt.js';
import { SYNTHESIS_PROMPT_V1, SYNTHESIS_PROMPT_VERSION } from './synthesis-prompt.js';

/**
 * Returns the extraction instruction text the per-image call sends: the module constant itself, with
 * no trim, normalisation or re-evaluation, so the text sent and the text asserted on the outgoing
 * request are one and the same string.
 */
export function getExtractionPrompt(): string {
  return EXTRACTION_PROMPT_V1;
}

/**
 * Returns the synthesis instruction text the single synthesis call sends: the module constant itself,
 * unmodified for the same reason as the extraction text.
 */
export function getSynthesisPrompt(): string {
  return SYNTHESIS_PROMPT_V1;
}

/**
 * Returns `extraction@<version>;synthesis@<version>`, the exact value persisted to
 * `modelUsage.promptVersion` so a stored analysis stays traceable to the two texts that produced it.
 * Both halves are derived from the prompt modules' own version constants when called, so a bump
 * there reaches the recorded document with no change here.
 */
export function getPromptVersion(): string {
  return `extraction@${EXTRACTION_PROMPT_VERSION};synthesis@${SYNTHESIS_PROMPT_VERSION}`;
}

/**
 * The same version string as `getPromptVersion`, evaluated once at module load for a caller that
 * wants it as a constant rather than a call.
 */
export const PROMPT_VERSION: string = getPromptVersion();
