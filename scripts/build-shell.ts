/**
 * Fingerprint compiled public assets so installed shell updates are reproducible.
 *
 * @file
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Only public shell assets contribute to the offline cache revision. */
const FILES = [
  'index.html',
  'style.css',
  'terminal.css',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'dist/app.js',
  'dist/history.js',
  'dist/activity-ui.js',
  'dist/api.js',
  'dist/views.js',
  'dist/worker-ui.js',
  'dist/learning-ui.js',
  'dist/pwa.js',
  'dist/brand-ui.js',
  'dist/workflow-ui.js',
  'dist/organization-ui.js',
  'dist/triage-ui.js',
  'dist/recovery-ui.js',
  'dist/report-ui.js',
  'dist/navigation.js',
  'dist/freshness.js',
  'dist/console-clock.js',
  'dist/capacity-details.js',
  'dist/capacity-view.js',
  'dist/admission-ui.js',
  'dist/model-policy-ui.js',
  'dist/selection-ui.js',
  'dist/terminal-parser.js',
  'dist/terminal-style.js',
  'dist/terminal-grid.js',
  'dist/terminal-width.js',
  'dist/terminal-screen.js',
  'dist/terminal-render-model.js',
  'dist/terminal-render.js',
  'dist/terminal-contract.js',
  'dist/terminal-stream.js',
  'dist/terminal-pane.js',
  'dist/terminal-workspace.js',
  'dist/terminal-keys.js',
  'dist/terminal-writes.js',
  'dist/terminal-input.js',
  'dist/telemetry-format.js',
  'dist/transcript-ui.js',
  'dist/sessions-ui.js',
  'dist/cost-chart.js',
  'dist/price-editor.js',
  'dist/costs-ui.js',
  'dist/theme.js',
  'dist/objective-ui.js',
  'dist/console-views.js',
  'dist/log-tails.js',
  'dist/console-model.js',
  'dist/board-model.js',
  'dist/approval-model.js',
  'dist/console-dom.js',
  'dist/approval-dialog.js',
  'dist/inbox-ui.js',
  'dist/board-actions.js',
  'dist/board-ui.js',
  'dist/automations-model.js',
  'dist/automations-ui.js',
  'dist/delivery-ui.js',
  'sessions.css',
  'board.css',
  'dist/workflow-model.js',
  'dist/workflow-checks.js',
  'dist/workflow-dom.js',
  'dist/workflow-preview.js',
  'dist/workflow-step-editor.js',
  'dist/workflow-editor.js',
  'dist/workflows-ui.js',
  'workflows.css',
] as const;
/** Fixed build output root independent of the invocation directory. */
const ROOT = path.resolve(import.meta.dirname, '..', 'web');
/** Exact compiled service-worker output. */
const WORKER = path.join(ROOT, 'dist', 'sw.js');
/** A fresh compilation leaves this sentinel for deterministic replacement. */
const SENTINEL = 'malt-public-shell-v1';
/** Read bounded fixed build inputs concurrently, never project operational state. */
const contents = await Promise.all(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Build inputs come only from the fixed public-shell allowlist above.
  FILES.map(async (file) => readFile(path.join(ROOT, file))),
);
/** Ordered filename and content inputs distinguish both renamed and changed assets. */
const hash = createHash('sha256');
for (const [index, file] of FILES.entries()) {
  hash.update(file);
  const content = contents[index];
  if (content === undefined) {
    throw new Error('A public app-shell build input is missing.');
  }
  hash.update(content);
}
/** Content-specific revision; no current time or runtime data affects the build. */
const revision = hash.digest('hex');
const source = await readFile(WORKER, 'utf8');
if (!source.includes(SENTINEL)) {
  throw new Error('Compile the service worker before fingerprinting its shell.');
}
await writeFile(
  WORKER,
  source.replace(SENTINEL, () => `malt-public-shell-${revision}`),
);
