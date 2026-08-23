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
const SUSPECT_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|ico|svg|mp4|mov|webm|pdf|jsonl)$/i

/** Paths that are a screenshot whatever they are called. */
const SUSPECT_PATH = /(^|\/)(screenshots?|captures?|recordings?)(\/|$)/i

/** Files that are configuration or data rather than code, and often secret. */
const SUSPECT_NAME = /(^|\/)(\.env(\..*)?|todos\.json|prefs\.json|config\.json)$/i

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
  if (ALLOWED.some((allow) => allow.test(path))) {
    continue
  }
  if (SUSPECT_PATH.test(path)) {
    offenders.push([path, 'looks like a screenshot'])
  } else if (SUSPECT_NAME.test(path)) {
    offenders.push([path, 'configuration or data, not source'])
  } else if (SUSPECT_EXTENSION.test(path)) {
    offenders.push([path, 'a binary outside the asset directories'])
  }
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
      'If it belongs in the repo, put it under resources/, build/ or assets/.',
      'If it is test output, add it to .gitignore.',
      'If you are certain:  git commit --no-verify',
      ''
    ].join('\n')
  )
  process.exit(1)
}
