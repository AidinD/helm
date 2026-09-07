// Which URLs the app will hand to the operating system, and why the answer is not "any".
//
// shell.openExternal takes a string and asks Windows to open it, which means the OS picks the
// handler. That is fine for https and emphatically not fine in general: a file: URL opens a
// file, and a registered custom protocol can start a program with arguments. The first caller
// of this in Helm passes a GitHub Actions run URL that arrived over the network from `gh`, so
// the string is not something Helm authored - and "it comes from a source I trust" is the
// reasoning that makes injection bugs, because the trust is in the SOURCE while the risk is in
// the STRING.
//
// So the rule is a scheme allowlist, checked by parsing rather than by pattern. A startsWith
// test on "https://" is defeated by "https:/\\evil" and by whitespace, and a regexp for it
// grows a hole every time somebody remembers another form. URL parsing is the thing that
// actually knows what a scheme is.
//
// HONEST LIMIT, stated here because the test that found it prints it and a reader deserves the
// same answer from the code. This decides the SCHEME, not the destination. `https:/\evil.example.com`
// and `https:evil` both parse as https - the WHATWG parser treats those forms as a host - so they
// are allowed, and they go to whatever host they name. What this guard buys is that Helm never
// asks Windows to open something that could START A PROGRAM: no file:, no data:, no javascript:,
// no registered app protocol. Where an https link POINTS is the caller's problem, and the CI
// widget's links come from gh listing runs in the captain's own repositories.
//
// A caller that ever passes a URL from somewhere less trusted owes its own host check. This is
// not that check and must not be mistaken for one.
//
// Pure and exported so the refusal has a test that does not need a window.

/** The only schemes Helm will ask the OS to open. */
export const OPENABLE_SCHEMES = Object.freeze(["https:"]);

/**
 * Why this URL cannot be opened, or null when it can.
 *
 * Returns the REASON rather than a boolean: a button that goes dead with no message is the
 * failure mode this repo keeps writing guards against, so the caller always has something to
 * say.
 */
export function externalLinkProblem(url) {
  if (typeof url !== "string" || !url.trim()) {
    return "no link to open";
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "that does not parse as a link";
  }
  if (!OPENABLE_SCHEMES.includes(parsed.protocol)) {
    // Named in the message, because the useful half is WHICH scheme was refused - a bare
    // "not allowed" leaves somebody guessing at their own data.
    return `Helm only opens https links, and that one is ${parsed.protocol}`;
  }
  return null;
}
