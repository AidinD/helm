#!/usr/bin/env node
/**
 * Refuse to commit files that tend to carry real content.
 *
 * Why this exists: on 2026-08-23 an audit found seven screenshots of Helm's own
 * dashboard committed to a PUBLIC repo. They showed the actual session sidebar -
 * a group labelled with the employer's name, and entries naming real prospects
 * and a client pitch. They had been there since 2026-07-04, were forked by
 * someone on 2026-08-09, and removing them meant rewriting 734 commits of
 * history and force-pushing 84 tags.
 *
 * Nobody committed them carelessly; they were the output of an E2E screenshot
 * harness, and `git add -A` did the rest. That is exactly the kind of mistake a
 * hook is for and a convention is not.
 *
 * The rule: an image or a data file may only be added inside a directory the
 * family actually keeps assets in. Everything else is refused, including
 * anything whose path mentions a screenshot.
 *
 * Canonical copy lives in keel/hooks. If you change it, copy it to the siblings -
 * a git hook cannot be loaded out of node_modules, because it has to work in a
 * clone where nothing is installed yet.
 *
 * Override for a genuine exception:  git commit --no-verify
 */

import { execFileSync } from 'node:child_process'

/** Where the suite legitimately keeps committed binaries. */
const ALLOWED = [
  /^resources\//,
  /^build\//,
  /^assets\//,
  /^src\/renderer\/assets\//,
  /^src\/renderer\/public\//
]

/** Extensions that carry pixels, frames or logs rather than source. */
const SUSPECT_EXTENSION =
  /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|ico|svg|mp4|mov|webm|pdf|jsonl|ndjson|csv|har|zip|db|sqlite3?|pem|key|p12|pfx)$/i

/** Paths that are a screenshot whatever they are called. */
const SUSPECT_PATH = /(^|\/)(screenshots?|captures?|recordings?)(\/|$)/i

/**
 * Filenames that are a capture of a running app, wherever they sit.
 *
 * The allowlist exists for icons and artwork. A file called `01-dashboard.png`
 * dropped straight into `build/` matched none of the other rules and committed
 * cleanly - and `01-dashboard.png` is the exact name of one of the seven
 * screenshots that caused the 2026 leak. Names beat directories here.
 */
const SUSPECT_FILENAME =
  /(^|\/)[^/]*(dashboard|screen(shot)?|sidebar|window|dev-badge|preview|capture|now-view|\d{2}-[a-z]+)[^/]*\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$/i

/** Files that are configuration or data rather than code, and often secret. */
const SUSPECT_NAME = /(^|\/)(\.env(\..*)?|todos\.json|prefs\.json|config\.json)$/i

/**
 * Ids that only exist in a real notebook, in the text of a change.
 *
 * The hook was written for binaries, and prose walked straight past it: a comment
 * explaining this app's reference feature shipped a colleague's name and the real
 * note id it belonged to, into a public repo, as an example. An id like that is
 * not sensitive on its own - it is that it points at one specific note in one
 * specific person's notebook, and it invites the name of what it holds as the
 * explanation.
 *
 * Matched on shape rather than on a list of names, because a list of the people
 * who must not be mentioned is itself the thing it is trying to protect. Sixteen
 * hex characters is what `newId` mints; the short ids in fixtures are untouched.
 */
const REAL_ID = /(?:note|drw|alert)-[0-9a-f]{16}/

function stagedAdditions() {
  const out = execFileSync('git', ['diff', '--cached', '--unified=0'], { encoding: 'utf-8' });
  const hits = [];
  let file = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length);
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }
    const found = line.slice(1).match(REAL_ID);
    if (found !== null) {
      hits.push([file, found[0]]);
    }
  }
  return hits;
}

function staged() {
  // ACR: added, copied, renamed. A file already tracked is not this hook's
  // business - it was reviewed once, and re-flagging it would train people to
  // pass --no-verify by reflex.
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACR'], {
    encoding: 'utf-8'
  })
  return out.split('\n').filter((line) => line.length > 0)
}

const offenders = []
for (const path of staged()) {
  // SUSPECT_PATH is checked BEFORE the allowlist, deliberately. It used to come
  // after, and a screenshot committed to `build/` or `assets/` was never
  // examined at all - proven by test, and made worse by the refusal message
  // below, which tells people to move images into exactly those directories.
  // The allowlist exists for icons and artwork, not for a captures folder that
  // happens to sit inside it.
  if (SUSPECT_PATH.test(path)) {
    offenders.push([path, 'looks like a screenshot'])
    continue
  }
  if (SUSPECT_FILENAME.test(path)) {
    offenders.push([path, 'named like a capture of a running app'])
    continue
  }
  if (ALLOWED.some((allow) => allow.test(path))) {
    continue
  }
  if (SUSPECT_NAME.test(path)) {
    offenders.push([path, 'configuration or data, not source'])
  } else if (SUSPECT_EXTENSION.test(path)) {
    offenders.push([path, 'a binary outside the asset directories'])
  }
}

for (const [where, id] of stagedAdditions()) {
  // Deliberately not named after the obvious word: the suite's pre-push privacy
  // guard derives its terms from private data, and an ordinary identifier can
  // collide with one. Renaming costs nothing; bypassing the guard to keep a
  // variable name teaches the bypass.
  offenders.push([where, `mentions a real notebook id (${id})`]);
}

if (offenders.length > 0) {
  const width = Math.max(...offenders.map(([path]) => path.length))
  console.error('\nRefusing to commit - these carry content, not code:\n')
  for (const [path, why] of offenders) {
    console.error(`  ${path.padEnd(width)}   ${why}`)
  }
  console.error(
    [
      '',
      'A screenshot of your own app shows whatever was on screen: session names,',
      'client names, file paths, a board full of real work. Helm shipped seven of',
      'them to a public repo and it cost a history rewrite to take back.',
      '',
      'A real note id points at one note in one notebook, and the sentence',
      'explaining it usually names what is in it. Write `note-<id>` instead.',
      '',
      'If it belongs in the repo, put it under resources/, build/ or assets/.',
      'If it is test output, add it to .gitignore.',
      'If you are certain:  git commit --no-verify',
      ''
    ].join('\n')
  )
  process.exit(1)
}
