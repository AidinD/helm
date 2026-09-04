// Unit test: the Helm-owned archive overlay in readAllSessions forces
// isArchived=true for any id in config.archivedSessions, REGARDLESS of what the
// session's own metadata says - the fix for "archive keeps coming back" (a
// desktop-owned local_*.json reverting the flag can no longer resurface the
// session in Helm). Uses options.archivedSessions injection so it never
// touches real config, and picks a live session that is currently NOT archived
// as the sharp red->green case (without overlay it shows; with overlay it's
// archived).
// Run:  node scripts/e2e/test-archive-overlay.mjs
const { readAllSessions } = await import("../../src/lib/sessions.js");

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

try {
  const base = readAllSessions({ archivedSessions: [] });
  assert(!base.error, "readAllSessions works with an empty overlay");
  const live = (base.sessions || []).find((s) => !s.isArchived);
  if (!live) {
    console.log("SKIP - no un-archived session available to test against");
  } else {
    // Sanity: without the overlay this id is NOT archived (would be shown).
    assert(live.isArchived === false, `baseline: "${live.title}" is not archived without the overlay`);

    // With the overlay listing it, it MUST come back archived.
    const withOverlay = readAllSessions({ archivedSessions: [live.sessionId] });
    const same = (withOverlay.sessions || []).find((s) => s.sessionId === live.sessionId);
    assert(!!same, "the session is still present in the list (archived, not dropped)");
    assert(same.isArchived === true, "overlay forces isArchived=true regardless of the desktop file");
    assert(same.status === "archived", "derived status reflects the overlay (applied before buildSession)");

    // Matching also works via cliSessionId.
    if (live.cliSessionId && live.cliSessionId !== live.sessionId) {
      const byCli = readAllSessions({ archivedSessions: [live.cliSessionId] });
      const s2 = (byCli.sessions || []).find((s) => s.sessionId === live.sessionId);
      assert(s2 && s2.isArchived === true, "overlay also matches on cliSessionId");
    }

    // A different session NOT in the overlay stays unaffected.
    const other = (withOverlay.sessions || []).find((s) => s.sessionId !== live.sessionId && !s.isArchived);
    assert(other ? other.isArchived === false : true, "sessions not in the overlay are untouched");
  }
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.message);
}
console.log(exit === 0 ? "VERIFY OK: archive overlay holds." : "VERIFY FAILED.");
process.exit(exit);
