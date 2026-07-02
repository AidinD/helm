import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imagesDir = path.join(__dirname, "..", "..", "pasted-images");

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // pasted screenshots are throwaway context, not archives

/**
 * Saves a pasted image to disk and returns its absolute path, so it can be
 * referenced by path in a prompt — verified in spike/test-image-via-path.mjs
 * that Claude Code's own Read tool picks up an image from a plain file path
 * mentioned in the prompt text, with no change needed to the `-p` CLI-wrapping
 * architecture (no base64-in-stream-json, no SDK migration, subscription auth
 * and --resume keep working exactly as before).
 */
export function savePastedImage(base64Data, ext) {
  fs.mkdirSync(imagesDir, { recursive: true });
  const safeExt = /^[a-z0-9]+$/i.test(ext || "") ? ext : "png";
  const name = `pasted-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${safeExt}`;
  const filePath = path.join(imagesDir, name);
  fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
  return filePath;
}

/**
 * Deletes pasted images older than MAX_AGE_MS. Called once at app startup —
 * these are ephemeral clipboard pastes, not something worth keeping or
 * backing up, and they can contain screenshots of anything on screen.
 */
export function prunePastedImages() {
  let entries;
  try {
    entries = fs.readdirSync(imagesDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(imagesDir, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // best-effort cleanup; a locked/already-gone file is not worth failing startup over
    }
  }
}
