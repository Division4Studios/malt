/**
 * Simplified Chinese messages, keyed by their English source text and split
 * by console area so each catalog stays small. Keys are unique across areas;
 * the catalog test enforces it.
 *
 * @file
 */
import { ZH_SHELL } from './catalog-zh-shell.js';

/** Catalog parts by area, for the uniqueness check. */
export const ZH_PARTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  shell: ZH_SHELL,
};

/** Every Simplified Chinese message. */
export const ZH_CN: Readonly<Record<string, string>> = {
  ...ZH_SHELL,
};
