/**
 * Native radial workflow visualization. Initial history is static; only newly
 * observed durable messages move, with bounded packets and no animation loop.
 *
 * @file
 */
import { child, records, text, number, firstText } from './api.js';
import { element } from './worker-ui.js';

import type { Data, Snapshot } from './api.js';

/** Fixed original scene geometry. */
const SCENE = { width: 1000, height: 640, x: 500, y: 320, outerX: 370, outerY: 220, innerX: 230, innerY: 140 };
/** Bound visible history and rendering independently of durable storage. */
const LIMITS = { nodes: 32, ring: 16, messages: 40, paths: 16, packets: 8, excerpts: 320, scopes: 8, name: 24 };
/** One selected project's observation cursor; switching projects never replays history. */
const cursor = { project: '', sequence: 0, selected: '' };
/** Complete angular rotation. */
const TAU = Math.PI * 2;
/** Drawing namespace. */
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Small scene tilt communicates depth without moving tickets or inventing activity. */
const TILT_DEGREES = 2;
/** Center of normalized scene coordinates. */
const MIDPOINT = 0.5;
/** A node position is derived from the actual projected roster, not role names. */
interface Point {
  /** Internal horizontal scene position. */
  readonly x: number;
  /** Internal vertical scene position. */
  readonly y: number;
  /** Validated public roster record. */
  readonly node: Data;
}

/**
 * Create internal SVG nodes without HTML parsing or script-capable attributes.
 *
 * @param tag - Native drawing element.
 * @param attributes - Internal drawing attributes.
 * @returns Safe SVG node.
 */
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }
  return node;
}

/**
 * Follow fine-pointer movement with at most one pending animation frame.
 * No timer or animation loop survives pointer exit; reduced motion stays flat.
 *
 * @param surface - Owned local drawing surface.
 * @param scene - Current scene, with native hit targets and keyboard focus.
 */
function pointerDepth(surface: HTMLElement, scene: SVGSVGElement): void {
  let frame: number | null = null;
  let x = 0;
  let y = 0;
  surface.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType !== 'mouse' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }
      const bounds = surface.getBoundingClientRect();
      x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - MIDPOINT) * 2));
      y = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - MIDPOINT) * 2));
      if (frame !== null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        scene.style.setProperty('--scene-x', `${String(-y * TILT_DEGREES)}deg`);
        scene.style.setProperty('--scene-y', `${String(x * TILT_DEGREES)}deg`);
      });
    },
    { passive: true },
  );
  surface.addEventListener('pointerleave', () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    frame = null;
    scene.style.removeProperty('--scene-x');
    scene.style.removeProperty('--scene-y');
  });
}

/**
 * Position dynamically discovered peers in bounded concentric rings.
 *
 * @param nodes - Actual workflow roster.
 * @returns Original radial layout.
 */
function positions(nodes: Data[]): Point[] {
  return nodes.slice(0, LIMITS.nodes).map((node, index) => {
    const isOuter = index < LIMITS.ring;
    const count = isOuter ? Math.min(nodes.length, LIMITS.ring) : nodes.length - LIMITS.ring;
    const angle = ((index % LIMITS.ring) * TAU) / count - Math.PI / 2;
    return {
      node,
      x: SCENE.x + Math.cos(angle) * (isOuter ? SCENE.outerX : SCENE.innerX),
      y: SCENE.y + Math.sin(angle) * (isOuter ? SCENE.outerY : SCENE.innerY),
    };
  });
}

/**
 * Build one directional message route through the local broker hub.
 *
 * @param from - Real sender's visible node.
 * @param to - Real recipient's visible node.
 * @returns Internal geometry, never a project-provided path string.
 */
function route(from: Point, to: Point): string {
  return `M${String(from.x)} ${String(from.y)} Q${String(SCENE.x)} ${String(SCENE.y)} ${String(to.x)} ${String(to.y)}`;
}

/**
 * Read bounded string lists from authenticated but still validated JSON.
 *
 * @param value - External JSON list.
 * @returns Plain names only.
 */
function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry: unknown): entry is string => typeof entry === 'string').slice(0, LIMITS.nodes)
    : [];
}

/**
 * Render actual message paths; fresh observations animate once per sequence.
 *
 * @param scene - Owned drawing.
 * @param points - Current selected project nodes.
 * @param state - Authoritative snapshot.
 */
function traffic(scene: SVGSVGElement, points: Point[], state: Snapshot): void {
  const brokers = records(child(state.factory, 'workflow')['brokers']);
  const endpoints = [...points, ...brokers.map((node) => ({ node, x: SCENE.x, y: SCENE.y }))];
  const messages = records(state.factory['conversations']).slice(-LIMITS.messages);
  const project = `${text(state.project, 'id')}:${text(state.project, 'root')}`;
  const isInitial = cursor.project !== project;
  const fresh = isInitial
    ? []
    : messages.filter((message) => number(message, 'seq') > cursor.sequence).slice(-LIMITS.packets);
  if (isInitial) {
    cursor.sequence = 0;
    cursor.selected = '';
  }
  cursor.project = project;
  for (const message of messages) {
    cursor.sequence = Math.max(cursor.sequence, number(message, 'seq'));
  }
  const routes = new Map<string, { from: Point; to: Point; message: Data }>();
  for (const message of messages) {
    const from = endpoints.find((point) => text(point.node, 'name') === text(message, 'sender_name'));
    const to = endpoints.find((point) => text(point.node, 'name') === text(message, 'recipient_name'));
    if (from !== undefined && to !== undefined && from !== to) {
      routes.set(`${text(from.node, 'id')}:${text(to.node, 'id')}`, { from, to, message });
    }
  }
  const observedRoutes = routes.values().toArray();
  const visible = observedRoutes.slice(-LIMITS.paths);
  for (const connection of visible) {
    const path = route(connection.from, connection.to);
    scene.append(
      svg('path', {
        d: path,
        class: 'message-route',
        'marker-end': 'url(#malt-direction)',
        'data-from': text(connection.from.node, 'id'),
        'data-to': text(connection.to.node, 'id'),
      }),
    );
    if (
      fresh.every((message) => number(message, 'seq') !== number(connection.message, 'seq')) ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      continue;
    }
    const packet = svg('circle', { r: '5', class: 'message-packet' });
    const motion = svg('animateMotion', { path, dur: '1.2s', repeatCount: '1', fill: 'freeze' });
    packet.append(motion);
    motion.addEventListener(
      'endEvent',
      () => {
        packet.remove();
      },
      { once: true },
    );
    scene.append(packet);
  }
}

/**
 * Inspect real role ownership without suggesting an attached session has owned logs.
 *
 * @param point - Selected actual node.
 * @param detail - Read-only role inspector.
 * @param inspect - Existing managed worker control.
 */
function selectNode(point: Point, detail: HTMLElement, inspect: (role: string) => void): void {
  const { node } = point;
  cursor.selected = text(node, 'id');
  highlightSelection(detail);
  detail.replaceChildren(
    element('h3', '', text(node, 'label')),
    element('p', '', `${text(node, 'kind')} · ${text(node, 'state')}`),
  );
  const issue = number(node, 'issue');
  detail.append(
    element(
      'p',
      'subtle',
      issue > 0
        ? `Associated issue #${String(issue)} · current stage ${text(node, 'stage')}`
        : 'No delivery currently associated with this role.',
    ),
  );
  if (text(node, 'kind') === 'managed') {
    const button = element('button', 'button secondary', 'Open worker workspace');
    button.type = 'button';
    button.addEventListener('click', () => {
      inspect(text(node, 'role'));
    });
    detail.append(button);
  } else {
    detail.append(
      element(
        'p',
        'subtle',
        'Attached cooperative peer. Process ownership and captured output are not managed by this factory.',
      ),
    );
  }
}

/**
 * Emphasize only the selected peer and its observed connections.
 *
 * @param detail - Inspector belonging to this drawing only.
 */
function highlightSelection(detail: HTMLElement): void {
  const root = detail.closest('.workflow-root');
  if (root === null) {
    return;
  }
  const peers = root.querySelectorAll<SVGElement>('[data-workflow-role]');
  for (const peer of peers) {
    peer.setAttribute('aria-pressed', peer.dataset['workflowRole'] === cursor.selected ? 'true' : 'false');
  }
  const paths = root.querySelectorAll<SVGElement>('.message-route');
  for (const path of paths) {
    const isRelated = path.dataset['from'] === cursor.selected || path.dataset['to'] === cursor.selected;
    path.classList.toggle('route-muted', !isRelated);
  }
}

/**
 * Add keyboard-accessible radial role nodes with actual states and scope labels.
 *
 * @param scene - Original SVG scene.
 * @param points - Actual roster positions.
 * @param detail - Read-only inspector.
 * @param inspect - Existing managed worker control.
 */
function drawNodes(scene: SVGSVGElement, points: Point[], detail: HTMLElement, inspect: (role: string) => void): void {
  for (const point of points) {
    const label = text(point.node, 'label');
    const node = svg('g', {
      transform: `translate(${String(point.x)} ${String(point.y)})`,
      class: 'workflow-node',
      role: 'button',
      tabindex: '0',
      'aria-label': `${label}: ${text(point.node, 'state')}. Inspect role.`,
      'data-state': text(point.node, 'state'),
      'data-workflow-role': text(point.node, 'id'),
      'aria-pressed': text(point.node, 'id') === cursor.selected ? 'true' : 'false',
    });
    node.append(svg('circle', { r: '28' }));
    const hint = svg('title', {});
    hint.textContent = `${label} · ${text(point.node, 'state')} · Select to inspect current work and captured evidence.`;
    node.append(hint);
    const title = svg('text', { y: '48', 'text-anchor': 'middle', class: 'network-label' });
    title.textContent = label.slice(0, LIMITS.name);
    const stateLabel = svg('text', { y: '65', 'text-anchor': 'middle', class: 'network-state' });
    stateLabel.textContent = text(point.node, 'state');
    const initials = svg('text', { y: '5', 'text-anchor': 'middle', class: 'network-initials' });
    initials.textContent = label
      .split(' ')
      .map((word) => word[0] ?? '')
      .join('')
      .toUpperCase();
    node.append(title, stateLabel, initials);
    node.addEventListener('click', () => {
      selectNode(point, detail, inspect);
    });
    node.addEventListener('keydown', (event) => {
      if (!(event.key === 'Enter' || event.key === ' ')) {
        return;
      }

      event.preventDefault();
      selectNode(point, detail, inspect);
    });
    scene.append(node);
  }
}

/**
 * Provide a readable native selector when a compact screen shrinks the graph.
 *
 * @param points - Actual visible roster, including inactive peers.
 * @param detail - Shared role inspector.
 * @param inspect - Existing managed worker control.
 * @returns Keyboard and touch-accessible alternative to the drawing.
 */
function rosterSelector(points: Point[], detail: HTMLElement, inspect: (role: string) => void): HTMLElement {
  const label = element('label', 'network-selector', 'Inspect team member');
  const select = element('select');
  select.setAttribute('aria-label', 'Inspect team member');
  const placeholder = element('option', '', 'Select a role or attached peer');
  placeholder.value = '';
  select.append(placeholder);
  for (const point of points) {
    const option = element('option', '', `${text(point.node, 'label')} · ${text(point.node, 'state')}`);
    option.value = text(point.node, 'id');
    select.append(option);
  }
  select.addEventListener('change', () => {
    const point = points.find((entry) => text(entry.node, 'id') === select.value);
    if (point !== undefined) {
      selectNode(point, detail, inspect);
    }
  });
  label.append(select);
  select.value = cursor.selected;
  return label;
}

/**
 * Display real issue stages and their conditional next gate beside traffic.
 *
 * @param state - Selected project's actual workflow.
 * @returns Bounded ticket-stage list.
 */
function scopePanel(state: Snapshot): HTMLElement {
  const body = element('section', 'workflow-scopes');
  body.append(element('h2', '', 'Delivery signals'));
  const scopes = records(child(state.factory, 'workflow')['handoffs']).slice(-LIMITS.scopes);
  const repository = text(child(state.github, 'connection'), 'repository');
  for (const scope of scopes) {
    const card = element('article', 'scope-signal');
    const issue = number(scope, 'issue');
    const title = element('a', '', `#${String(issue)} · ${text(scope, 'title')}`);
    if (repository !== '') {
      title.href = `https://github.com/${repository}/issues/${String(issue)}`;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }
    const next = child(scope, 'next');
    const owner = firstText(text(scope, 'owner'), 'unassigned');
    const nextLabel = firstText(names(next['roles']).join(', '), 'none');
    card.append(
      title,
      element('p', '', `NOW / ${text(scope, 'stage')} · ${owner}`),
      element('p', 'subtle', `NEXT / ${nextLabel}`),
      element('p', 'subtle', text(next, 'gate')),
    );
    body.append(card);
  }
  if (scopes.length === 0) {
    body.append(
      element('p', 'subtle', 'No delivery scope yet. Conditional handoffs appear after real tickets are provisioned.'),
    );
  }
  return body;
}

/**
 * Compose the actual team graph, durable recent traffic and conditional handoffs.
 *
 * @param state - Authenticated selected project snapshot.
 * @param inspect - Existing managed-role workspace control.
 * @returns Semantic workflow view.
 */
export function workflowView(state: Snapshot, inspect: (role: string) => void): HTMLElement {
  const root = element('div', 'workflow-root');
  const grid = element('div', 'workflow-grid');
  const surface = element('section', 'network-surface');
  const detail = element('section', 'network-detail');
  detail.setAttribute('aria-live', 'polite');
  detail.append(
    element('h3', '', 'Select a role'),
    element('p', 'subtle', 'Inspect its real session state and associated work.'),
  );
  const workflow = child(state.factory, 'workflow');
  const roster = records(workflow['nodes']);
  const points = positions(roster);
  const scene = svg('svg', {
    viewBox: `0 0 ${String(SCENE.width)} ${String(SCENE.height)}`,
    class: 'network-scene',
    'aria-label': 'Workflow role and message map',
  });
  const definitions = svg('defs', {});
  const marker = svg('marker', {
    id: 'malt-direction',
    viewBox: '0 0 10 10',
    refX: '9',
    refY: '5',
    markerWidth: '5',
    markerHeight: '5',
    orient: 'auto-start-reverse',
  });
  marker.append(svg('path', { d: 'M0 0L10 5L0 10Z', class: 'direction-head' }));
  definitions.append(marker);
  scene.append(definitions);
  scene.append(
    svg('ellipse', {
      cx: String(SCENE.x),
      cy: String(SCENE.y),
      rx: String(SCENE.outerX),
      ry: String(SCENE.outerY),
      class: 'network-orbit',
    }),
  );
  for (const point of points) {
    scene.append(
      svg('path', {
        d: `M${String(SCENE.x)} ${String(SCENE.y)}L${String(point.x)} ${String(point.y)}`,
        class: 'logical-link',
      }),
    );
  }
  traffic(scene, points, state);
  scene.append(svg('image', { href: '/icon.svg', x: '465', y: '275', width: '70', height: '70' }));
  const hub = svg('text', { x: String(SCENE.x), y: '375', 'text-anchor': 'middle', class: 'network-label' });
  hub.textContent = 'MALT / LOCAL BROKER';
  scene.append(hub);
  drawNodes(scene, points, detail, inspect);
  surface.append(rosterSelector(points, detail, inspect), scene);
  pointerDepth(surface, scene);
  grid.append(surface, scopePanel(state));
  root.append(
    element(
      'p',
      'subtle',
      'Spokes show logical membership. Directed arcs show recent real messages; moving packets are newly observed messages, never historical replay. Next-stage labels are conditional gates, not approvals.',
    ),
    grid,
    detail,
  );
  const messages = records(state.factory['conversations']).slice(-LIMITS.packets).toReversed();
  const history = element('section', 'panel-body');
  history.append(element('h2', '', 'Observed message traffic'));
  for (const message of messages) {
    const row = element('article', 'scope-signal');
    const sequence = String(number(message, 'seq'));
    row.append(
      element('h3', '', `${text(message, 'sender_name')} → ${text(message, 'recipient_name')}`),
      element('p', 'subtle', `Message ${sequence} · ${text(message, 'type')}`),
      element('p', '', text(message, 'body').slice(0, LIMITS.excerpts)),
    );
    history.append(row);
  }
  if (messages.length === 0) {
    history.append(element('p', 'subtle', 'No broker messages observed. Idle roles are not spending model tokens.'));
  }
  root.append(history);
  const selected = points.find((point) => text(point.node, 'id') === cursor.selected);
  if (selected !== undefined) {
    selectNode(selected, detail, inspect);
  }
  const omittedPeers = number(workflow, 'omittedPeers');
  const omittedScopes = number(workflow, 'omittedScopes');
  if (omittedPeers > 0 || omittedScopes > 0) {
    root.append(
      element(
        'p',
        'subtle',
        `Bounded map: ${String(omittedPeers)} additional peers and ${String(omittedScopes)} earlier deliveries are outside this view. Durable history is retained.`,
      ),
    );
  }
  return root;
}
