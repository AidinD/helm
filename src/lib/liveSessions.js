// Authoritative "a turn is running RIGHT NOW" registry (task 5939df: sessions
// showed "idle" while genuinely working).
//
// The file-based status heuristic (sessions.js deriveStatus) can't see a live
// turn: it reads the transcript's last role + age. A long agentic turn outruns
// its ACTIVE_WINDOW while the last transcript line is still the user prompt, so it
// decays to "idle" mid-run; and a mid-turn tool/assistant line makes it read
// "waiting". But Helm LAUNCHED the turn, so it knows the truth. Every launch path
// marks its session id live for the turn's duration; sessions:get then forces
// those to "active", overriding whatever the heuristic decayed to.
//
// Refcounted (not a Set) so a rare fresh+relay overlap on the same id doesn't
// clear the live state when only the first of two turns ends. In-memory only: a
// fresh process has nothing live yet, so there is nothing to persist.
export function createLiveSessionRegistry() {
  const counts = new Map();
  const isLive = (id) => !!id && counts.has(id);
  return {
    // A turn for `id` (a cliSessionId) just started.
    markLive(id) {
      if (!id) {
        return;
      }
      counts.set(id, (counts.get(id) || 0) + 1);
    },
    // A turn for `id` just ended (close or error). Removes the id only when its
    // last live turn ends, so overlapping turns keep it live until both finish.
    markDone(id) {
      if (!id) {
        return;
      }
      const n = (counts.get(id) || 0) - 1;
      if (n > 0) {
        counts.set(id, n);
      } else {
        counts.delete(id);
      }
    },
    isLive,
    // Force a session to "active" when a turn is live for it (matched on either id
    // form the session carries). Mutates + returns the session. No-op otherwise,
    // so a genuinely idle/waiting session keeps its heuristic status.
    applyStatus(session) {
      if (session && (isLive(session.cliSessionId) || isLive(session.sessionId))) {
        session.status = "active";
      }
      return session;
    },
    // Test/diagnostic only.
    size() {
      return counts.size;
    },
  };
}
