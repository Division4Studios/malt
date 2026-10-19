/**
 * A minimal, text-only DOM so browser views can be rendered and inspected in
 * Node tests without a frontend dependency. Elements keep document order,
 * attributes, dataset and listeners, and views may set plain properties such as
 * a meter's value; `innerHTML` throws, so a view that tried to parse markup
 * fails instead of hiding hostile text.
 *
 * @file
 */

/** Anything an element can take as a child. */
type Child = FakeElement | FakeText | string;

/** A text node. */
export class FakeText {
  /** Text content. */
  public data: string;

  /**
   * Hold literal text.
   *
   * @param data - Characters kept exactly, never parsed as markup.
   */
  public constructor(data: string) {
    this.data = data;
  }

  /**
   * Text of this node.
   *
   * @returns The literal text.
   */
  public get textContent(): string {
    return this.data;
  }
}

/** One element in the fake tree. */
export class FakeElement {
  /** Upper-case tag name, as browsers report it. */
  public readonly tagName: string;
  /** Children in document order. */
  public readonly childNodes: (FakeElement | FakeText)[] = [];
  /** Attributes by name. */
  public readonly attributes = new Map<string, string>();
  /** `data-*` attributes, camel-cased like `HTMLElement.dataset`. */
  public readonly dataset: Record<string, string>;
  /** Registered listeners by event type. */
  public readonly listeners = new Map<string, unknown[]>();

  /**
   * Create a detached element.
   *
   * @param tag - Element kind, in any case.
   */
  public constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    const { attributes } = this;
    this.dataset = new Proxy<Record<string, string>>(
      {},
      {
        get: (_target, key) => (typeof key === 'string' ? attributes.get(dataName(key)) : undefined),
        set: (_target, key, value) => {
          if (typeof key === 'string') {
            attributes.set(dataName(key), String(value));
          }
          return true;
        },
        has: (_target, key) => typeof key === 'string' && attributes.has(dataName(key)),
      },
    );
  }

  /**
   * Child elements only, in order.
   *
   * @returns Elements among the children, without text nodes.
   */
  public get children(): FakeElement[] {
    return this.childNodes.filter((node) => node instanceof FakeElement);
  }

  /**
   * The `class` attribute, as views set it.
   *
   * @returns Space-separated CSS classes, empty when unset.
   */
  public get cssClass(): string {
    return this.attributes.get('class') ?? '';
  }

  /**
   * Concatenated text of every descendant.
   *
   * @returns All descendant text in document order.
   */
  public get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  /**
   * Replace every child with one text node, like the DOM property.
   *
   * @param value - Literal text.
   */
  public set textContent(value: string) {
    this.childNodes.length = 0;
    if (value !== '') {
      this.childNodes.push(new FakeText(value));
    }
  }

  /**
   * Refuse markup parsing: views must build text nodes.
   *
   * @param markup - Markup a view tried to parse.
   * @throws {Error} Always.
   */
  public set innerHTML(markup: string) {
    throw new Error(`innerHTML is not available in the text-only test DOM (${String(markup.length)} characters).`);
  }

  /**
   * Append nodes or text in order.
   *
   * @param nodes - Elements, text nodes or strings.
   */
  public append(...nodes: Child[]): void {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeText(node) : node;
      this.childNodes.push(child);
    }
  }

  /**
   * Replace every child.
   *
   * @param nodes - New children.
   */
  public replaceChildren(...nodes: Child[]): void {
    this.childNodes.length = 0;
    this.append(...nodes);
  }

  /**
   * Store an attribute value.
   *
   * @param name - Attribute such as `class` or `aria-label`.
   * @param value - Text stored verbatim.
   */
  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /**
   * Read an attribute.
   *
   * @param name - Attribute such as `class` or `aria-label`.
   * @returns Stored text, or null when absent.
   */
  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  /**
   * Record a listener; the test DOM never dispatches events by itself.
   *
   * @param type - Event such as `click` or `toggle`.
   * @param listener - Callback a test may invoke directly.
   */
  public addEventListener(type: string, listener: unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Make this the document's focused element, as the DOM method does. */
  public focus(): void {
    Reflect.set(Reflect.get(globalThis, 'document') ?? {}, 'activeElement', this);
  }

  /**
   * Whether a node is this element or inside it.
   *
   * @param node - Candidate descendant.
   * @returns True for this element and its descendants.
   */
  public contains(node: unknown): boolean {
    return node === this || (node instanceof FakeElement && this.descendants().includes(node));
  }

  /**
   * Every descendant element, depth first in document order.
   *
   * @returns Nested elements, parents before their children.
   */
  public descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  /**
   * First descendant matching a tag name or one `[attribute]` selector.
   *
   * @param selector - `tag` or `[name]`.
   * @returns Match, or null.
   */
  public querySelector(selector: string): FakeElement | null {
    return this.descendants().find(matcher(selector)) ?? null;
  }

  /**
   * Descendants matching a tag name or one `[attribute]` selector.
   *
   * @param selector - `tag` or `[name]`.
   * @returns Matches in document order.
   */
  public querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter(matcher(selector));
  }
}

/**
 * A predicate for a tag name, `#id` or one `[attribute]` selector.
 *
 * @param selector - `tag`, `#id` or `[name]`.
 * @returns Whether an element matches.
 */
function matcher(selector: string): (node: FakeElement) => boolean {
  const attribute = /^\[(?<name>[\w\-]+)\]$/v.exec(selector)?.groups?.['name'];
  return selector.startsWith('#')
    ? (node) => node.attributes.get('id') === selector.slice(1)
    : (node) => (attribute === undefined ? node.tagName === selector.toUpperCase() : node.attributes.has(attribute));
}

/**
 * Map a dataset key to its attribute name.
 *
 * @param key - Camel-cased dataset key.
 * @returns `data-` attribute name.
 */
function dataName(key: string): string {
  const kebab = key.replaceAll(/\p{Lu}/gv, (letter) => `-${letter.toLowerCase()}`);
  return `data-${kebab}`;
}

/** The installed fake document. */
export interface FakeDocument {
  /** Root that rendered views can be attached to. */
  readonly body: FakeElement;
  /** Element factory used by every view. */
  readonly createElement: (tag: string) => FakeElement;
  /** Document-level lookup over the body. */
  readonly querySelector: (selector: string) => FakeElement | null;
  /** Element that last received focus. */
  readonly activeElement: FakeElement | null;
}

/**
 * Install the fake document globally for one test, restoring any previous one.
 *
 * @param t - Test context that owns the installation.
 * @param t.after - Registers the restore callback.
 * @returns The installed document.
 */
export function installDom(t: { after: (callback: () => void) => void }): FakeDocument {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const body = new FakeElement('body');
  const installed: FakeDocument = {
    body,
    createElement: (tag) => new FakeElement(tag),
    querySelector: (selector) => body.querySelector(selector),
    activeElement: null,
  };
  Object.defineProperty(globalThis, 'document', { value: installed, configurable: true, writable: true });
  const element = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  Object.defineProperty(globalThis, 'HTMLElement', { value: FakeElement, configurable: true, writable: true });
  t.after(() => {
    if (element === undefined) {
      Reflect.deleteProperty(globalThis, 'HTMLElement');
    } else {
      Object.defineProperty(globalThis, 'HTMLElement', element);
    }
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, 'document');
    } else {
      Object.defineProperty(globalThis, 'document', previous);
    }
  });
  return installed;
}

/**
 * Narrow a rendered view to the fake element it must be.
 *
 * @param node - Value a browser view returned.
 * @returns The same node as a fake element.
 * @throws {Error} When the view returned something else.
 */
export function fake(node: unknown): FakeElement {
  if (!(node instanceof FakeElement)) {
    throw new TypeError('Expected a rendered test-DOM element.');
  }
  return node;
}

/**
 * Text of each heading and paragraph-like block, in document order.
 *
 * @param root - Rendered view.
 * @returns Readable lines, as a screen reader would meet them.
 */
export function readingOrder(root: FakeElement): string[] {
  const blocks = new Set(['H2', 'H3', 'P', 'LI', 'SUMMARY', 'DT', 'DD', 'CAPTION', 'TH', 'TD', 'STRONG', 'SPAN']);
  return root
    .descendants()
    .filter((node) => blocks.has(node.tagName) && node.children.every((child) => !blocks.has(child.tagName)))
    .map((node) => node.textContent);
}
