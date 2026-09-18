// Browser stand-in for Node's 'node:module', wired up in vite.config.ts.
//
// The Emscripten loader (nec2c.mjs) is built for browsers, workers AND Node, so that
// the test suite can run the real engine. Its Node branch does
// `await import('node:module')` behind an `if (ENVIRONMENT_IS_NODE)` check, so this
// function is never called in a browser; it exists so the bundler has something to
// resolve.

export function createRequire(): never {
  throw new Error("'node:module' is not available in the browser");
}
