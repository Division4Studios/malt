/**
 * MALT's own package manifest facts, read once from `package.json` beside
 * the source tree: the released version and the supported Node.js range.
 * Read once at import.
 *
 * @file
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

/** The manifest fields MALT reads about itself. */
const manifestSchema = z.object({
  version: z.string().default('0.0.0'),
  engines: z.object({ node: z.string().default('>=0.0.0') }).default({}),
});

/** Manifest text beside the source tree. */
const MANIFEST_TEXT = readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8');
/** Parsed manifest. */
const MANIFEST = manifestSchema.parse(JSON.parse(MANIFEST_TEXT));

/**
 * MALT's released version.
 *
 * @returns Semantic version from `package.json`.
 */
export function packageVersion(): string {
  return MANIFEST.version;
}

/**
 * The Node.js range MALT supports.
 *
 * @returns Engines range from `package.json`, for example `>=24.15.0`.
 */
export function packageEngines(): string {
  return MANIFEST.engines.node;
}
