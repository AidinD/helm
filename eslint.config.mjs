/**
 * Two rules. Not a style pass.
 *
 * This exists because of one bug and the note it left behind. The crew tier guard shipped on
 * 2026-08-31 with `runIteration` reading a `guard` it was never given - a free variable, so
 * every crew iteration threw ReferenceError before it spawned anything and the whole
 * goal-run feature was dead from the moment it landed. `--fast` was 125/125 green throughout,
 * and it was found by reading a run record, not by a test.
 *
 * test-no-undefined-calls.mjs, which exists for exactly that family, had already written the
 * conclusion in its own header: this repo has no lint of any kind, so a class of error a
 * linter catches in milliseconds could only be caught by running the app. It asks a narrow
 * question about CALLS; the bug was a property read.
 *
 * So: `no-undef` and `no-unused-vars`, and deliberately nothing else. Every stylistic rule
 * this could carry would produce a wall of findings on 40,000 lines written without one, and
 * a check that reports a hundred things reports nothing. These two are the ones that catch a
 * name that does not exist and a name nobody uses - the shape of the bug, and the shape of
 * its neighbour (an import removed while a caller survived, which is what
 * test-no-undefined-calls.mjs was written for in the first place).
 *
 * The two source trees are different environments and get different globals: src/lib and
 * src/main.js are Node in the main process, src/renderer is a browser with no imports at all
 * (renderer.js is a classic script, not a module - see its own header). Getting that wrong in
 * either direction is how a linter starts lying: browser globals in Node would hide a real
 * undefined, and Node globals missing in the renderer would bury the real findings under
 * hundreds of false ones.
 */

const NODE_GLOBALS = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  fetch: "readonly",
  structuredClone: "readonly",
  performance: "readonly",
  // Node has had a global WebSocket since 22; the harness uses it to drive Chrome DevTools.
  WebSocket: "readonly",
  crypto: "readonly",
  global: "readonly",
  globalThis: "readonly",
};

const BROWSER_GLOBALS = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  location: "readonly",
  console: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  queueMicrotask: "readonly",
  getComputedStyle: "readonly",
  matchMedia: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  Element: "readonly",
  HTMLElement: "readonly",
  Node: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  KeyboardEvent: "readonly",
  MouseEvent: "readonly",
  DragEvent: "readonly",
  ClipboardEvent: "readonly",
  FormData: "readonly",
  Blob: "readonly",
  File: "readonly",
  FileReader: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  Image: "readonly",
  MutationObserver: "readonly",
  ResizeObserver: "readonly",
  IntersectionObserver: "readonly",
  AbortController: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  structuredClone: "readonly",
  performance: "readonly",
  alert: "readonly",
  atob: "readonly",
  btoa: "readonly",
  crypto: "readonly",
  DOMParser: "readonly",
  XMLHttpRequest: "readonly",
  WebSocket: "readonly",
  Audio: "readonly",
  MediaRecorder: "readonly",
  AudioContext: "readonly",
  OfflineAudioContext: "readonly",
  speechSynthesis: "readonly",
  SpeechSynthesisUtterance: "readonly",
  Worker: "readonly",
  globalThis: "readonly",
};

/**
 * `args: "none"` on no-unused-vars, and that is a judgement rather than laziness.
 *
 * An unused ARGUMENT is usually a signature being honest about a contract it does not need
 * every part of - an Electron `(_event, payload)` handler, a callback that ignores its index.
 * Flagging those would mean renaming dozens of parameters to `_` for no defect, and the
 * findings that matter would be lost among them. An unused VARIABLE is a different thing: it
 * is nearly always a leftover, and it is the half that catches an import whose last caller
 * went away.
 */
const RULES = {
  "no-undef": "error",
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
};

export default [
  {
    ignores: ["node_modules/**", "dist/**", "spike/**", "docs/**", "**/*.min.js"],
  },
  {
    // Node, ESM: the main process and every library it loads.
    files: ["src/**/*.js", "src/**/*.mjs", "scripts/**/*.mjs", "worker/**/*.mjs", "eslint.config.mjs"],
    ignores: ["src/renderer/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: NODE_GLOBALS,
    },
    rules: RULES,
  },
  {
    // The renderer is a CLASSIC SCRIPT, not a module - it cannot import, and everything it
    // defines is a global to every other part of itself. sourceType "script" is what makes
    // that true here; "module" would report every cross-file reference as undefined.
    files: ["src/renderer/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: BROWSER_GLOBALS,
    },
    rules: RULES,
  },
];
