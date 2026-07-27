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
  // Launched, but nothing has come back yet (Epic f3d096fa's `launching` state).
  // Keyed by launchId rather than session id for a good reason: a FRESH launch has
  // no session id until the CLI reports one, which is exactly the window this
  // state covers. Without it, a just-started session reads as whatever the
  // transcript last said - which for a brand new one is nothing at all.
  const launching = new Map();
  const isLive = (id) => !!id && counts.has(id);
  return {
    // A turn for `id` (a cliSessionId) just started.
    markLive(id) {
      if (!id) {
        return;
      }
      counts.set(id, (counts.get(id) || 0) + 1);
    },
    // Helm just spawned a launch; no session id or output exists yet.
    markLaunching(launchId, sessionId = null) {
      if (!launchId) {
        return;
      }
      launching.set(launchId, sessionId);
    },
    // The launch produced its session id (or ended) - it is no longer launching.
    clearLaunching(launchId) {
      if (launchId) {
        launching.delete(launchId);
      }
    },
    /** Is any launch still in its pre-first-output window for this session? */
    isLaunching(id) {
      if (!id) {
        return false;
      }
      for (const sessionId of launching.values()) {
        if (sessionId === id) {
          return true;
        }
      }
      return false;
    },
    /** How many launches are in flight with no session id yet. */
    pendingLaunchCount() {
      let n = 0;
      for (const sessionId of launching.values()) {
        if (!sessionId) {
          n += 1;
        }
      }
      return n;
    },
    /** Attach a session id to a launch once the CLI reports it. */
    bindLaunch(launchId, sessionId) {
      if (launchId && launching.has(launchId)) {
        launching.set(launchId, sessionId || null);
      }
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
