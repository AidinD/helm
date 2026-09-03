// One atomic write, used by every durable store (task efcaf486).
//
// The implementation moved to `keel/storage` on 2026-08-24, shared with Jot, Nib
// and Brief. It is the same code - Helm's version was the one the shared module
// was built from, because Helm had learned the most:
//
//  - The rename needs retrying. On Windows it fails with EPERM while another
//    process holds the target, and Helm's durable state lives under a
//    Dropbox-synced meta-home, so a sync client holding a file mid-rename is the
//    normal operating condition, not an edge case. Observed for real on
//    2026-07-27: a board update returned "EPERM ... rename" and the change was
//    simply gone.
//  - So does the temp cleanup. The obvious "unlinkSync and swallow" loses a race:
//    the sync client can grab a lock on the temp the instant it appears, so a
//    single silent unlink leaves it behind. That is how the dispatch directory
//    accumulated 1462 orphaned `.fleet-state.json.<uuid>.tmp` files (found
//    2026-08-12) - fleet state is rewritten every ~5s, so each lost cleanup
//    compounds fast.
//
// Jot's and Nib's copies only knew the first half. Moving this out is what fixed
// them; keel's own tests then found a case Helm had missed too, ENOTDIR, which
// used to leak a raw errno into a toast.
//
// This file stays as the import path because fourteen modules import from it and
// the name is right. What it adds is Helm's name for the plain-language failure
// messages, so a permission problem still reads "Helm isn't allowed to write in
// ...".
import {
  writeFileAtomicSync as keelWriteFileAtomicSync,
  writeJsonAtomicSync as keelWriteJsonAtomicSync
} from "keel/storage";

// `isTransientLock` and `sleepSync` used to be exported from here and nothing
// outside this file ever imported them - sleepSync was on the known-dead list for
// exactly that reason. They live in `keel/storage` now, so re-exporting them would
// be dead surface pointing at another package. Import them from keel directly if
// something ever needs them.

/**
 * Write `contents` to `filePath` atomically, retrying while the target is locked.
 *
 * Returns { ok: true } or { ok: false, error } - it does NOT throw, because every
 * caller here has a meaningful "the write did not happen" path and a throw was how
 * these failures got lost in the first place.
 *
 * @param {string} filePath
 * @param {string} contents
 * @param {{ onBeforeRename?: () => string|null }} [opts] - a hook to re-check
 *   preconditions immediately before the rename (jot.js uses it for its
 *   concurrent-edit guard); return a reason string to REFUSE the write. It is asked
 *   once, under the write lock, and a refusal comes back as
 *   `{ ok: false, aborted: true, error }` - it is not retried, because the contents
 *   and the hook's expectation are both fixed before the call, so re-asking can only
 *   give the same answer. The retry that can succeed is the caller re-reading and
 *   re-applying; see mutateJotFile in jot.js. This comment described the opposite
 *   until 2026-09-03.
 */
export function writeFileAtomicSync(filePath, contents, opts = {}) {
  return keelWriteFileAtomicSync(filePath, contents, { ...opts, app: "Helm" });
}

/** The common case: pretty-printed JSON with a trailing newline. */
export function writeJsonAtomicSync(filePath, value) {
  return keelWriteJsonAtomicSync(filePath, value, { app: "Helm" });
}
