// Verifies that a packed app.asar's DATA actually matches its own header.
//
// Why this exists: electron-builder writes the asar header (per-file offset,
// size and sha256) from a directory scan, then streams the file contents in a
// second pass. If any file changes size between those two passes, every file
// after it lands at the wrong offset - and nothing complains. The archive still
// parses, `asar list` still works, the installer still builds. But the app's
// own main.js now reads as another file's bytes, so the packaged app dies at
// startup with exit code 1 and NOT ONE LINE of output (Windows Electron builds
// are GUI-subsystem, so even the syntax error goes nowhere).
//
// That shipped for real: build 0.2.78 packaged `.claude/worktrees/<agent>` -
// a live agent worktree - and a file inside it changed mid-pack, shifting all
// 834 following files including src/main.js. See DECISIONS.md 2026-08-20.
// `.claude` is excluded from the package now, but the class of bug is wider
// than that one directory (any concurrently-written file does it), so the build
// verifies the archive it just produced instead of trusting the packer.
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function verifyAsar(asarPath) {
  const buf = readFileSync(asarPath);
  if (buf.length < 16) {
    return { ok: false, checked: 0, mismatches: [], fatal: `archive is only ${buf.length} bytes` };
  }
  const pickleSize = buf.readUInt32LE(4);
  const jsonSize = buf.readUInt32LE(12);
  const dataOffset = 8 + pickleSize;
  let header;
  try {
    header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString("utf8"));
  } catch (err) {
    return { ok: false, checked: 0, mismatches: [], fatal: `header is not valid JSON: ${err.message}` };
  }

  const mismatches = [];
  let checked = 0;
  let unhashed = 0;
  let declaredEnd = dataOffset;

  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const rel = `${prefix}/${name}`;
      if (entry.files) {
        walk(entry, rel);
        continue;
      }
      if (entry.unpacked) continue;
      const start = dataOffset + Number(entry.offset);
      const end = start + entry.size;
      declaredEnd = Math.max(declaredEnd, end);
      const hash = entry.integrity && entry.integrity.hash;
      if (!hash) {
        unhashed++;
        continue;
      }
      checked++;
      const actual = createHash("sha256").update(buf.subarray(start, end)).digest("hex");
      if (actual !== hash) mismatches.push({ rel, offset: Number(entry.offset) });
    }
  };
  walk(header, "");

  // Sorted by offset so mismatches[0] is the file whose size actually drifted -
  // everything after it in the stream is collateral damage, not a second cause.
  mismatches.sort((a, b) => a.offset - b.offset);
  const truncatedBy = declaredEnd > buf.length ? declaredEnd - buf.length : 0;
  return {
    ok: mismatches.length === 0 && !truncatedBy,
    checked,
    unhashed,
    mismatches: mismatches.map((m) => m.rel),
    truncatedBy,
    fatal: truncatedBy ? `archive is truncated by ${truncatedBy} bytes` : null,
  };
}

export function formatVerifyFailure(asarPath, result) {
  const lines = [`[verify-asar] CORRUPT ARCHIVE: ${asarPath}`];
  if (result.fatal) lines.push(`               ${result.fatal}`);
  if (result.mismatches.length) {
    lines.push(
      `               ${result.mismatches.length} of ${result.checked} files do not match their own header hash.`,
      `               first mismatch: ${result.mismatches[0]}`
    );
    lines.push(
      `               A file changed size while electron-builder was packing, so every`,
      `               file after it sits at the wrong offset - including src/main.js.`,
      `               Find what writes to that path during a build and exclude it from`,
      `               "build.files" (or stop it running while building), then rebuild.`
    );
  }
  return lines.join("\n");
}

// CLI: node scripts/verifyAsar.mjs [path-to-app.asar]
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const target = process.argv[2] || "dist/win-unpacked/resources/app.asar";
  statSync(target);
  const result = verifyAsar(target);
  if (result.ok) {
    console.log(`[verify-asar] ok - ${result.checked} files match their header hash (${target})`);
    process.exit(0);
  }
  console.error(formatVerifyFailure(target, result));
  process.exit(1);
}
