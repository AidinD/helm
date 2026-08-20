// electron-builder afterPack hook.
//
// Runs right after the app dir (and its app.asar) is written, BEFORE NSIS
// packaging and before any publish - the only seam where refusing to continue
// still prevents a broken installer from existing at all. See verifyAsar.mjs
// for what "broken" means here and how it shipped once.
import path from "node:path";
import { existsSync } from "node:fs";
import { verifyAsar, formatVerifyFailure } from "./verifyAsar.mjs";

export default async function afterPack(context) {
  const asarPath = path.join(context.appOutDir, "resources", "app.asar");
  if (!existsSync(asarPath)) {
    // asar disabled (or a target that doesn't use one) - nothing to verify.
    console.log(`[verify-asar] skipped - no app.asar at ${asarPath}`);
    return;
  }
  const result = verifyAsar(asarPath);
  if (!result.ok) {
    // Thrown, not process.exit: electron-builder reports the message and stops
    // the whole build, publish included.
    throw new Error(formatVerifyFailure(asarPath, result));
  }
  console.log(`[verify-asar] ok - ${result.checked} files match their header hash`);
}
