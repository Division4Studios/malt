/**
 * Simplified Chinese messages, keyed by their English source text and split
 * by console area so each catalog stays small. Keys are unique across areas;
 * the catalog test enforces it.
 *
 * @file
 */
import { ZH_BOARD } from './catalog-zh-board.js';
import { ZH_COSTS } from './catalog-zh-costs.js';
import { ZH_FACTORY } from './catalog-zh-factory.js';
import { ZH_PROJECT } from './catalog-zh-project.js';
import { ZH_SHELL } from './catalog-zh-shell.js';
import { ZH_WORKFLOWS } from './catalog-zh-workflows.js';

/** Catalog parts by area, for the uniqueness check. */
export const ZH_PARTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  shell: ZH_SHELL,
  factory: ZH_FACTORY,
  board: ZH_BOARD,
  workflows: ZH_WORKFLOWS,
  project: ZH_PROJECT,
  costs: ZH_COSTS,
};

/** Every Simplified Chinese message. */
export const ZH_CN: Readonly<Record<string, string>> = {
  ...ZH_SHELL,
  ...ZH_FACTORY,
  ...ZH_BOARD,
  ...ZH_WORKFLOWS,
  ...ZH_PROJECT,
  ...ZH_COSTS,
};
