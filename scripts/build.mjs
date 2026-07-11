// Build entrypoint for `npm run dist` / `npm run release`.
//
// Stamps the SAME version the app computes from git (major.minor.commitcount)
// into both the packaged app and the installer artifact, so they all agree -
// fixing "the installer version doesn't match the app's". Two moving parts:
//   1. writes src/lib/build-version.json - a packaged build has no .git, so
//      version.js reads this baked value instead of computing from git.
//   2. passes the same version to electron-builder via extraMetadata, so the
//      installer/exe metadata (e.g. "Helm Setup 0.1.305.exe") matches.
//
// Pass --stamp-only to just write build-version.json (used by tests) without
// running the (slow) electron-builder pack. Pass --publish to release.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeVersionString } from "../src/lib/version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const version = computeVersionString().replace(/^v/, ""); // "v0.1.305" -> "0.1.305"
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
} catch {
  // best-effort - the version string above is what matters
}
writeFileSync(
  path.join(repoRoot, "src", "lib", "build-version.json"),
  JSON.stringify({ version, commit }, null, 2) + "\n",
  "utf8"
);
console.log(`[build] stamped version ${version}${commit ? ` (${commit})` : ""}`);

if (process.argv.includes("--stamp-only")) {
  process.exit(0);
}

const args = ["electron-builder", `--config.extraMetadata.version=${version}`];
if (process.argv.includes("--publish")) {
  args.push("--publish", "always");
}
console.log(`[build] electron-builder ${args.slice(1).join(" ")}`);
execFileSync("npx", args, { cwd: repoRoot, stdio: "inherit", shell: true });
