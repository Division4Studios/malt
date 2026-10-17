/**
 * Accessible inline-SVG stacked bar chart of daily cost by role, with a
 * legend, native hover titles and a data-table fallback. Colors come from
 * fixed categorical classes in sessions.css; series follow the role, never
 * its rank, and specialist seats fold into a neutral "Other" series.
 *
 * @file
 */
import { child, number, records, text } from './api.js';
import { t } from './i18n.js';
import { formatUsd, OTHER_SERIES, ROLE_SLOTS, stackBars } from './telemetry-format.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/** SVG namespace. */
const SVG = 'http://www.w3.org/2000/svg';
/** Chart width in viewBox units. */
const WIDTH = 720;
/** Chart height in viewBox units. */
const HEIGHT = 240;
/** Left gutter for value labels. */
const LEFT = 56;
/** Bottom gutter for day labels. */
const BOTTOM = 28;
/** Top padding. */
const TOP = 12;
/** Surface gap between stacked segments and between bars. */
const GAP = 2;
/** Most day labels drawn under the axis. */
const DAY_LABELS = 8;
/** Width of the `MM-DD` part of a day key. */
const MONTH_DAY = 5;
/** Text baseline offset under the axis. */
const LABEL_OFFSET = 18;
/** Horizontal offset of value labels from the plot. */
const VALUE_OFFSET = 8;
/** Gridline positions as fractions of the scale maximum. */
const GRID_FRACTIONS = [0, 1 / 2, 1] as const;
/** Vertical centering nudge for value labels. */
const VALUE_NUDGE = 4;

/**
 * Create one SVG element with attributes.
 *
 * @param tag - SVG tag name.
 * @param attributes - Attribute values.
 * @returns SVG element.
 */
function svg(tag: string, attributes: Readonly<Record<string, string | number>>): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

/**
 * Name a series for legends and titles.
 *
 * @param series - Role or the shared "Other" key.
 * @returns Display label.
 */
function seriesLabel(series: string): string {
  return series === OTHER_SERIES ? t('Other (specialist seats)') : series;
}

/**
 * CSS class carrying a series' fixed color.
 *
 * @param series - Role or the shared "Other" key.
 * @returns Trusted class name.
 */
function seriesClass(series: string): string {
  const slot = ROLE_SLOTS.get(series);
  return slot === undefined ? 'series-other' : `series-${String(slot)}`;
}

/**
 * Read the daily series from a validated cost summary.
 *
 * @param summary - Validated cost summary.
 * @returns Days with per-role USD.
 */
function dailyRows(summary: Data): { day: string; totalUsd: number; byRole: Record<string, number> }[] {
  return records(summary['daily']).map((day) => {
    const roles = child(day, 'byRole');
    const byRole = Object.fromEntries(
      Object.entries(roles).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    );
    return { day: text(day, 'day'), totalUsd: number(day, 'totalUsd'), byRole };
  });
}

/**
 * Draw the plot: recessive gridlines, stacked bars and sparse day labels.
 *
 * @param bars - Laid-out bars.
 * @param max - Scale maximum in USD.
 * @returns SVG chart.
 */
function plot(bars: ReturnType<typeof stackBars>['bars'], max: number): SVGElement {
  const chart = svg('svg', { viewBox: `0 0 ${String(WIDTH)} ${String(HEIGHT)}`, class: 'cost-chart', role: 'img' });
  const plotHeight = HEIGHT - TOP - BOTTOM;
  for (const fraction of GRID_FRACTIONS) {
    const y = TOP + plotHeight * (1 - fraction);
    chart.append(svg('line', { x1: LEFT, x2: WIDTH, y1: y, y2: y, class: 'cost-grid' }));
    const label = svg('text', { x: LEFT - VALUE_OFFSET, y: y + VALUE_NUDGE, class: 'cost-axis', 'text-anchor': 'end' });
    label.textContent = formatUsd(max * fraction);
    chart.append(label);
  }
  const slot = (WIDTH - LEFT) / Math.max(bars.length, 1);
  const every = Math.max(1, Math.ceil(bars.length / DAY_LABELS));
  for (const [index, bar] of bars.entries()) {
    const x = LEFT + index * slot + GAP / 2;
    for (const segment of bar.segments) {
      const rect = svg('rect', {
        x,
        y: TOP + segment.y,
        width: Math.max(slot - GAP, 1),
        height: segment.height,
        rx: Math.min(2, segment.height / 2),
        class: `cost-bar ${seriesClass(segment.series)}`,
      });
      const title = svg('title', {});
      title.textContent = t('{day} · {series}: {cost} (day total {total})', {
        day: bar.day,
        series: seriesLabel(segment.series),
        cost: formatUsd(segment.value),
        total: formatUsd(bar.total),
      });
      rect.append(title);
      chart.append(rect);
    }
    if (index % every !== 0) {
      continue;
    }
    const label = svg('text', {
      x: x + slot / 2,
      y: HEIGHT - BOTTOM + LABEL_OFFSET,
      class: 'cost-axis',
      'text-anchor': 'middle',
    });
    label.textContent = bar.day.slice(-MONTH_DAY);
    chart.append(label);
  }
  return chart;
}

/**
 * Build the data table fallback for the chart.
 *
 * @param bars - Laid-out bars.
 * @param series - Series present in the window.
 * @returns Table inside a disclosure.
 */
function dataTable(bars: ReturnType<typeof stackBars>['bars'], series: readonly string[]): HTMLElement {
  const table = element('table', 'cost-table');
  table.append(element('caption', 'sr-only', t('Daily cost by role')));
  const head = element('tr');
  head.append(
    element('th', '', t('Day')),
    ...series.map((name) => element('th', '', seriesLabel(name))),
    element('th', '', t('Total')),
  );
  table.append(head);
  for (const bar of bars) {
    const row = element('tr');
    row.append(element('th', '', bar.day));
    for (const name of series) {
      const value = bar.segments.find((segment) => segment.series === name)?.value ?? 0;
      row.append(element('td', '', formatUsd(value)));
    }
    row.append(element('td', '', formatUsd(bar.total)));
    table.append(row);
  }
  const details = element('details', 'cost-chart-data');
  details.append(element('summary', '', t('Show chart data as a table')), table);
  return details;
}

/**
 * Render the daily cost chart with its legend and table fallback.
 *
 * @param summary - Validated cost summary.
 * @returns Chart figure.
 */
export function costChart(summary: Data): HTMLElement {
  const figure = element('figure', 'cost-figure');
  const { bars, series, max } = stackBars(dailyRows(summary), HEIGHT - TOP - BOTTOM, GAP);
  if (max === 0) {
    figure.append(
      element('p', 'subtle', t('No priced cost in this window. Unpriced attempts are counted in the tiles.')),
    );
    return figure;
  }
  const chart = plot(bars, max);
  const peak = bars.toSorted((left, right) => right.total - left.total)[0] ?? { day: '', total: 0 };
  chart.setAttribute(
    'aria-label',
    t(
      'Daily known cost by role from {from} to {to}. Highest day {day} at {cost}. {length} role series; a data table follows.',
      {
        from: text(summary, 'from'),
        to: text(summary, 'to'),
        day: peak.day,
        cost: formatUsd(peak.total),
        length: String(series.length),
      },
    ),
  );
  const legend = element('ul', 'cost-legend');
  legend.setAttribute('aria-label', t('Legend'));
  for (const name of series) {
    const item = element('li');
    item.append(element('span', `cost-swatch ${seriesClass(name)}`), element('span', '', seriesLabel(name)));
    legend.append(item);
  }
  figure.append(legend, chart, dataTable(bars, series));
  return figure;
}
