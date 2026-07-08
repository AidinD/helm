// Minimal TOON (Token-Oriented Object Notation) encoder.
//
// TOON is a compact, model-readable alternative to JSON for embedding
// structured data in a prompt: an array of uniform objects becomes a header
// row of column names plus one delimited row per item, instead of repeating
// every key and brace for every element. Models read the tabular form fine;
// it just costs far fewer tokens for the same information (see DECISIONS.md
// 2026-07-04, "AXI ecosystem mapped" — ~30-40% fewer tokens vs JSON for
// arrays of uniform objects).
//
// This is a small, purpose-built encoder — NOT a full TOON spec
// implementation. It covers exactly the shapes Helm embeds in its own
// prompts:
//   - an array of uniform (or near-uniform) objects -> tabular header + rows
//   - a plain object (nested/irregular) -> indented "key: value" lines
//   - scalars / arrays of scalars -> a single delimited or literal line
//
// No dependency. Deliberately simple: correctness and readability over spec
// completeness.

const DELIMITER = ",";

/**
 * Encodes a JS value as TOON text.
 *
 * @param {*} value
 * @returns {string}
 */
export function encodeToon(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return encodeArray(value);
  }
  if (typeof value === "object") {
    return encodeObject(value, 0);
  }
  return encodeScalar(value);
}

function encodeArray(list) {
  if (list.length === 0) {
    return "(empty)";
  }
  const allUniformObjects = list.every(
    (item) => item !== null && typeof item === "object" && !Array.isArray(item)
  );
  if (allUniformObjects) {
    return encodeTabular(list);
  }
  // Array of scalars (or a mixed/irregular array) — one delimited line if
  // every item is a scalar, otherwise fall back to an indexed block so
  // nested arrays/objects inside the array are never silently dropped.
  const allScalars = list.every((item) => item === null || typeof item !== "object");
  if (allScalars) {
    return list.map(encodeScalar).join(DELIMITER);
  }
  const lines = [];
  list.forEach((item, i) => {
    if (item !== null && typeof item === "object") {
      lines.push(`[${i}]:`);
      lines.push(indent(encodeToon(item), 1));
    } else {
      lines.push(`[${i}]: ${encodeScalar(item)}`);
    }
  });
  return lines.join("\n");
}

/**
 * Encodes an array of objects as a TOON table: a header line listing the
 * union of all keys actually present (so a field that's missing on some rows
 * doesn't get silently dropped for the rows that DO have it), then one
 * delimited row per item. Nested (non-scalar) field values are JSON-encoded
 * inline within their cell — this only tabularizes the outer shape, it does
 * not attempt to flatten arbitrarily deep structures into columns.
 */
function encodeTabular(list) {
  const keys = [];
  const seen = new Set();
  for (const item of list) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  const header = `${list.length}{${keys.join(DELIMITER)}}:`;
  const rows = list.map((item) => {
    const cells = keys.map((key) => encodeCell(item[key]));
    return cells.join(DELIMITER);
  });
  return [header, ...rows].join("\n");
}

/** Encodes a single object as indented "key: value" lines. */
function encodeObject(obj, depth) {
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return "(empty)";
  }
  const lines = [];
  for (const key of keys) {
    const val = obj[key];
    if (val !== null && typeof val === "object") {
      if (Array.isArray(val) && val.length > 0 && val.every((v) => v !== null && typeof v === "object")) {
        // Nested array-of-objects: keep it tabular, indented under the key.
        lines.push(`${key}:`);
        lines.push(indent(encodeArray(val), depth + 1));
      } else if (Array.isArray(val)) {
        lines.push(`${key}: ${encodeArray(val)}`);
      } else {
        lines.push(`${key}:`);
        lines.push(indent(encodeObject(val, depth + 1), depth + 1));
      }
    } else {
      lines.push(`${key}: ${encodeScalar(val)}`);
    }
  }
  return lines.join("\n");
}

/** Encodes a table cell: scalars as-is (quoted/escaped), objects/arrays inline as JSON. */
function encodeCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    // Inline JSON for a nested structure inside a tabular cell — rare in
    // practice for Helm's payloads, but keeps the encoding lossless
    // instead of silently dropping data.
    return quoteIfNeeded(JSON.stringify(value));
  }
  return encodeScalar(value);
}

function encodeScalar(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return quoteIfNeeded(String(value));
}

// Quotes a string value if it contains the delimiter, a newline, or a
// double quote (which would otherwise be ambiguous against the delimiter or
// break row alignment). Matches JSON's own escaping for embedded quotes so
// a model already used to reading JSON strings parses it the same way.
function quoteIfNeeded(str) {
  if (/[,\n"]/.test(str)) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

function indent(text, depth) {
  const prefix = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}
