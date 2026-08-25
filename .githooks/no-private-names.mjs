#!/usr/bin/env node
/**
 * Refuse a push that would put a private name into a public repository.
 *
 * The control that replaces a rule. There was a rule - in a project document and
 * in an agent's memory - and on 2026-08-25 it was broken fifteen times in one
 * evening by somebody who had read it and meant to follow it. A colleague's
 * first name, a real project name and a real product name all reached a public
 * repository through test fixtures and code comments, because writing a fixture
 * is exactly the moment nobody is thinking about visibility.
 *
 * A rule that depends on remembering is a reminder. This runs whether anybody
 * remembers or not.
 *
 * The terms are derived from the private data these apps already hold, never
 * from a list in the repository: a file naming every colleague, committed to the
 * repository it is protecting, would be the leak itself. See keel/privacy.
 *
 * Pre-push and not pre-commit on purpose. A commit is fixable with an amend; a
 * push to a public repository is in somebody's clone, in a fork, and in
 * GitHub's caches within seconds.
 *
 * Skip one push with: git push --no-verify
 */

/*
 * Nothing is named here. Terms that no roster knows - an employer, a client -
 * go in `private-terms.txt` beside the Tend data, one per line. Writing them in
 * this file would put them in every repository this hook protects, which is the
 * mistake the derived terms exist to prevent; the guard caught exactly that in
 * its own source on the first push.
 */

/**
 * Loaded dynamically so a clone where `npm install` has not run reports rather
 * than crashes. A hook that throws on a missing dependency is a hook somebody
 * disables, and then nothing is protected at all.
 */
let privacy;
try {
  privacy = await import("keel/privacy");
} catch (error) {
  console.warn(
    `[privacy] keel is not installed here, so this push was not checked: ${
      error instanceof Error ? error.message : error
    }`
  );
  console.warn("[privacy] run npm install to turn the check back on.");
  process.exit(0);
}

let result;
try {
  result = privacy.checkOutgoing();
} catch (error) {
  // A guard that breaks the push when the guard itself is broken is a guard
  // that gets deleted. Say so loudly and let the push through.
  console.warn(
    `[privacy] the check could not run: ${error instanceof Error ? error.message : error}`
  );
  console.warn("[privacy] pushing anyway - but this check is not protecting you right now.");
  process.exit(0);
}

if (!result.checked) {
  console.log(`[privacy] not checked: ${result.why}`);
  process.exit(0);
}

if (result.hits.length === 0) {
  console.log(
    `[privacy] clean - ${result.terms} private terms checked against this push, from ${result.sources.length} source(s).`
  );
  process.exit(0);
}

console.error(privacy.report(result));
process.exit(1);
