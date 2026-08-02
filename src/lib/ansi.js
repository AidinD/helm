// Turn a build tool's coloured terminal output into something readable.
//
// Why this exists: the script-run panel appended raw stdout straight into the
// page, so `npm run dev` on a Vite project rendered as
//   [2m14:11:14[22m [36m[1mvite[22m[39m ...
// - every colour instruction shown as literal junk, with the escape byte drawn as
// a box glyph. The captain hit this the first time he ran a real dev server through it
// (2026-08-02), which is exactly the "terminalen ar inte tydlig" complaint the
// panel was supposed to fix.
//
// Two things were possible: suppress colour at the source (NO_COLOR in the child's
// env) or interpret it. Interpreting wins - a build log's colour is information,
// not decoration: Vite highlights its URLs, and errors are red. Suppressing would
// have removed the very emphasis that makes a long log scannable.
//
// Deliberately NOT a terminal emulator. It understands colour and it discards
// everything else (cursor moves, line erases, the spinner's carriage returns).
// A real emulator would mean a grid, scrollback and reflow, which is a large thing
// to own for a panel that shows build output.

// ESC [ ... <final byte>. `m` is SGR (colour); everything else is movement,
// erasing, mode setting - all meaningless without a grid, so they are dropped.
const CSI = /\x1b\[([0-9;?]*)([A-Za-z])/g;
// The other escape families that show up in tool output: OSC (window title, and
// hyperlinks) terminated by BEL or ST, and single-character escapes.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SINGLE = /\x1b[()#][0-9A-Za-z]|\x1b[=>]/g;

// The 16 basic colours, picked to stay legible on the panel's dark background
// rather than being the raw terminal palette (pure blue on near-black is a
// well-known unreadable combination).
const FG = {
  30: "#5c6370", // black -> a visible grey
  31: "#e06c75",
  32: "#98c379",
  33: "#d19a66",
  34: "#7aa6da",
  35: "#c678dd",
  36: "#56b6c2",
  37: "#c8ccd4",
  90: "#7f848e",
  91: "#f08d94",
  92: "#b5e08c",
  93: "#e5c07b",
  94: "#9fc4f0",
  95: "#dba0e8",
  96: "#7fd4de",
  97: "#ffffff",
};

function emptyState() {
  return { fg: null, bold: false, dim: false, underline: false, pending: "" };
}

/** A fresh parser state - one per output panel, carried across chunks. */
export function newAnsiState() {
  return emptyState();
}

function applySgr(state, params) {
  // A bare ESC[m means ESC[0m.
  const codes = (params === "" ? "0" : params).split(";").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) {
      state.fg = null;
      state.bold = false;
      state.dim = false;
      state.underline = false;
    } else if (c === 1) {
      state.bold = true;
    } else if (c === 2) {
      state.dim = true;
    } else if (c === 4) {
      state.underline = true;
    } else if (c === 22) {
      state.bold = false;
      state.dim = false;
    } else if (c === 24) {
      state.underline = false;
    } else if (c === 39) {
      state.fg = null;
    } else if (FG[c]) {
      state.fg = FG[c];
    } else if (c === 38 && codes[i + 1] === 5) {
      // 256-colour: keep it simple and fold onto the basic palette rather than
      // building a 256-entry table for output nobody reads that closely.
      const n = codes[i + 2];
      state.fg = FG[30 + (n % 8)] || null;
      i += 2;
    } else if (c === 38 && codes[i + 1] === 2) {
      state.fg = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`;
      i += 4;
    }
  }
}

/**
 * Parse a chunk of terminal output into styled segments.
 *
 * `state` is mutated and must be reused across chunks: streamed output splits at
 * arbitrary byte offsets, so an escape sequence can be cut in half. A chunk ending
 * mid-sequence parks the tail in state.pending and it is completed by the next one
 * - without that, a split sequence would print as garbage exactly like the bug this
 * fixes, just more rarely and so harder to notice.
 *
 * @returns {{text: string, style: {color?: string, bold?: boolean, dim?: boolean, underline?: boolean}}[]}
 */
export function parseAnsi(chunk, state) {
  let input = (state.pending || "") + String(chunk == null ? "" : chunk);
  state.pending = "";

  // Hold back a trailing partial escape for the next chunk. Anything after the
  // last ESC that hasn't been terminated yet is incomplete.
  const lastEsc = input.lastIndexOf("\x1b");
  if (lastEsc !== -1) {
    const tail = input.slice(lastEsc);
    // A complete CSI/OSC/single escape ends with a final byte; if the tail has
    // none, it is still arriving. Cap the hold-back so a stray ESC in binary
    // output can't swallow the rest of the log forever.
    const complete = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#][0-9A-Za-z]|\x1b[=>]/.test(tail);
    if (!complete && tail.length < 64) {
      state.pending = tail;
      input = input.slice(0, lastEsc);
    }
  }

  input = input.replace(OSC, "").replace(SINGLE, "");
  // Carriage returns are the spinner overwriting its own line. Without a grid to
  // overwrite, keep the LAST thing written on that line and drop the rest -
  // otherwise a progress spinner floods the panel with near-identical lines.
  const segments = [];
  let last = 0;
  let m;
  CSI.lastIndex = 0;
  const push = (text) => {
    if (!text) {
      return;
    }
    const style = {};
    if (state.fg) {
      style.color = state.fg;
    }
    if (state.bold) {
      style.bold = true;
    }
    if (state.dim) {
      style.dim = true;
    }
    if (state.underline) {
      style.underline = true;
    }
    segments.push({ text, style });
  };
  while ((m = CSI.exec(input)) !== null) {
    push(input.slice(last, m.index));
    if (m[2] === "m") {
      applySgr(state, m[1]);
    }
    // every other final byte is a movement/erase - dropped
    last = m.index + m[0].length;
  }
  push(input.slice(last));
  return segments;
}

/**
 * Collapse carriage-return overwrites in a plain string: for each line, keep only
 * what follows the last \r. Applied to the assembled text, not per segment, so a
 * spinner that colours its frames still collapses correctly.
 */
export function collapseCarriageReturns(text) {
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  return String(text || "")
    .split(NL)
    .map((line) => (line.includes(CR) ? line.slice(line.lastIndexOf(CR) + 1) : line))
    .join(NL);
}

/** Everything the panel would show, with all styling removed - for "Copy output". */
export function stripAnsi(text) {
  return collapseCarriageReturns(
    String(text == null ? "" : text)
      .replace(OSC, "")
      .replace(SINGLE, "")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
  );
}
