/**
 * Global names for web types that Node.js implements but `@types/node` does
 * not declare globally.
 *
 * The MCP SDK's declarations refer to `HeadersInit`, a type normally supplied
 * by TypeScript's DOM library. Including the DOM library would also declare
 * browser globals (`window`, `document`, ...) that do not exist in Node.js,
 * hiding real mistakes. Instead, this file derives the one missing name from
 * Node's own global `Headers` constructor, so it always matches the runtime.
 *
 * @file
 */

declare global {
  /** Anything accepted by the `Headers` constructor (record, pairs or Headers). */
  type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
}

// Makes this file a module, which `declare global` requires.
export {};
