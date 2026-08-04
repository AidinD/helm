// A new line inside a list continues the list, and a numbered one counts up.
//
// Task bd0900eb: "i prompten på claude desktop appen kan man göra ordentliga
// bulletlists som då automatiskt incrementerar etc. Jag vill ha stöd för det här
// också."
//
// Driven in the real app, twice over: the rule is checked over the real function,
// and then the real textarea is typed into with real Shift+Enter events - because
// the thing that must work is the box he types in, not a helper that returns the
// right object. Enter SENDS in Helm and Shift+Enter is the newline key, so the test
// also pins that plain Enter is left completely alone.
//
// Run:  node scripts/e2e/test-composer-list-continuation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-list-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9489";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { navigateToPage("chat"); return true; })()`);
  await app.waitForSelector("#chatPage .composer-shell textarea", 10000);

  // --- the rule, over the real function ------------------------------------
  const rule = await app.eval(`(() => {
    // "|" marks the caret in each case below.
    const at = (s) => {
      const caret = s.indexOf("|");
      return listContinuation(s.replace("|", ""), caret);
    };
    const applied = (s) => {
      const caret = s.indexOf("|");
      const v = s.replace("|", "");
      const step = listContinuation(v, caret);
      if (!step) {
        return null;
      }
      return JSON.stringify(v.slice(0, step.from) + step.text + v.slice(step.to));
    };
    return {
      dash: applied("- milk|"),
      star: applied("* milk|"),
      plus: applied("+ milk|"),
      numbered: applied("1. first|"),
      numberedNine: applied("9. ninth|"),
      paren: applied("3) third|"),
      nested: applied("    - deep|"),
      tabbed: applied("\\t- tabbed|"),
      checkbox: applied("- [ ] todo|"),
      checked: applied("- [x] done|"),
      emptyItem: applied("- |"),
      emptyNumbered: applied("1. |"),
      emptyNested: applied("  - |"),
      plain: at("just a sentence|"),
      dashInProse: at("a - b|"),
      selection: (() => {
        const v = "- milk";
        return listContinuation(v, 2, 5);
      })(),
      midLine: applied("- mi|lk"),
      afterBlank: applied("- milk\\n\\nnot a list|"),
    };
  })()`);

  ok(rule.dash === JSON.stringify("- milk\n- "), `a dash list continues (${rule.dash})`);
  ok(rule.star === JSON.stringify("* milk\n* ") && rule.plus === JSON.stringify("+ milk\n+ "), `so do * and + (${rule.star}, ${rule.plus})`);
  ok(rule.numbered === JSON.stringify("1. first\n2. "), `a numbered list COUNTS UP - the part he named (${rule.numbered})`);
  ok(rule.numberedNine === JSON.stringify("9. ninth\n10. "), `including across a digit (${rule.numberedNine})`);
  ok(rule.paren === JSON.stringify("3) third\n4) "), `and keeps the delimiter it was written with (${rule.paren})`);
  ok(rule.nested === JSON.stringify("    - deep\n    - "), `indentation is carried, so a nested list stays nested (${rule.nested})`);
  ok(rule.tabbed === JSON.stringify("\t- tabbed\n\t- "), `tabs count as indentation too (${rule.tabbed})`);
  ok(rule.checkbox === JSON.stringify("- [ ] todo\n- [ ] "), `a checklist continues as a checklist (${rule.checkbox})`);
  ok(rule.checked === JSON.stringify("- [x] done\n- [ ] "), `and the next box is UNCHECKED - the next thing you write is a new task (${rule.checked})`);

  ok(rule.emptyItem === JSON.stringify("\n"), `an empty item drops its marker instead of adding another (${rule.emptyItem})`);
  ok(rule.emptyNumbered === JSON.stringify("\n"), `same for a numbered one (${rule.emptyNumbered})`);
  ok(rule.emptyNested === JSON.stringify("\n"), `and a nested one (${rule.emptyNested})`);

  ok(rule.plain === null, "an ordinary line is not touched - the browser's own newline is right there");
  ok(rule.dashInProse === null, `a dash mid-sentence is not a list (${JSON.stringify(rule.dashInProse)})`);
  ok(rule.selection === null, "a selection is a replace, not a continuation");
  ok(rule.midLine === JSON.stringify("- mi\n- lk"), `splitting an item mid-word still continues (${rule.midLine})`);
  ok(rule.afterBlank === null, "only the caret's OWN line decides - an earlier list does not make prose a list");

  // --- Tab indents the item, Shift+Tab takes it back out --------------------
  // "jag vill att 1. space ska indentera raden" (Aidin, bouncing this task back). Two
  // spaces per level, which Markdown reads as a nested item, so the indent means the
  // same thing to whatever reads the prompt as it looks like on screen.
  const indent = await app.eval(`(() => {
    const at = (s, opts) => {
      const caret = s.indexOf("|");
      const v = s.replace("|", "");
      const step = listIndentStep(v, caret, caret, opts || {});
      if (!step) { return null; }
      return JSON.stringify(v.slice(0, step.from) + step.text + v.slice(step.to));
    };
    return {
      numbered: at("1. one|"),
      dash: at("- milk|"),
      already: at("  - nested|"),
      outdent: at("  - nested|", { outdent: true }),
      outdentTab: at("\t- tabbed|", { outdent: true }),
      atMargin: (() => {
        const v = "- milk";
        const step = listIndentStep(v, 6, 6, { outdent: true });
        return step ? { noop: !!step.noop, text: step.text } : null;
      })(),
      plainLine: at("just prose|"),
      plainOutdent: at("just prose|", { outdent: true }),
      caretKept: (() => {
        // The step REPLACES the line's prefix (indent + marker) rather than only
        // inserting spaces, because moving level has to renumber the marker too. The
        // caret is kept on the word being written by the caller, from the length delta.
        const v = "1. one";
        const step = listIndentStep(v, 6, 6, {});
        return step.from === 0 && step.to === 2 && step.text === "  1.";
      })(),
    };
  })()`);

  ok(indent.numbered === JSON.stringify("  1. one"), `Tab indents a numbered item by two spaces (${indent.numbered})`);
  ok(indent.dash === JSON.stringify("  - milk"), `and a bullet (${indent.dash})`);
  ok(indent.already === JSON.stringify("    - nested"), `indenting again goes one level deeper (${indent.already})`);
  ok(indent.outdent === JSON.stringify("- nested"), `Shift+Tab takes a level back off (${indent.outdent})`);
  ok(indent.outdentTab === JSON.stringify("- tabbed"), `including one indented with a tab (${indent.outdentTab})`);
  ok(indent.atMargin?.noop === true, "at the left margin Shift+Tab is a no-op that STILL swallows the key - or focus would jump out of the composer mid-list");
  ok(indent.plainLine === null && indent.plainOutdent === null, "on ordinary text Tab is left alone, so it still moves focus");
  ok(indent.caretKept, "the edit goes in at the line start, and the caller keeps the caret on the word you were writing");

  // --- starting a list indents it, with nothing pressed ---------------------
  // "jag menar att jag trodde den skulle autoindentera bulletlist vid skapandet".
  // Driven with the browser's OWN insert command so the input event carries a real
  // inputType and data - the feature is gated on those, and a hand-made Event() would
  // pass the assertion while the real typing path stayed broken.
  const auto = await app.eval(`(async () => {
    const ta = document.querySelector("#chatPage .composer-shell textarea");
    const typeReal = (s) => { ta.focus(); document.execCommand("insertText", false, s); };
    const out = {};

    ta.value = ""; ta.setSelectionRange(0, 0);
    typeReal("-"); typeReal(" ");
    out.dash = ta.value;
    typeReal("milk");
    out.dashItem = ta.value;

    ta.value = ""; ta.setSelectionRange(0, 0);
    typeReal("1"); typeReal("."); typeReal(" ");
    out.numbered = ta.value;

    // Continuation must carry the indent the first item just got, so the whole list
    // lines up rather than only its first row. Content FIRST: Shift+Enter on an empty
    // item deliberately leaves the list, which is what the earlier version of this probe
    // accidentally tested.
    typeReal("one");
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    typeReal("two");
    out.secondItem = ta.value;

    // Mid-sentence must be left alone.
    ta.value = "a -"; ta.setSelectionRange(3, 3);
    typeReal(" ");
    out.midSentence = ta.value;

    // An already-indented marker must not gain another level from this.
    ta.value = "  -"; ta.setSelectionRange(3, 3);
    typeReal(" ");
    out.alreadyIndented = ta.value;

    // A PASTE that happens to end in "- " must not be reformatted.
    ta.value = ""; ta.setSelectionRange(0, 0);
    ta.value = "- ";
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: null, bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    out.pasted = ta.value;

    ta.value = "";
    return out;
  })()`);

  ok(auto.dash === "  - ", `typing "- " indents the new list item on its own (${JSON.stringify(auto.dash)})`);
  ok(auto.dashItem === "  - milk", `and typing continues normally after it (${JSON.stringify(auto.dashItem)})`);
  ok(auto.numbered === "  1. ", `a numbered list indents the same way (${JSON.stringify(auto.numbered)})`);
  ok(auto.secondItem === "  1. one\n  2. two", `the next item lines up under the first (${JSON.stringify(auto.secondItem)})`);
  ok(auto.midSentence === "a - ", `a dash mid-sentence is not a list and is left alone (${JSON.stringify(auto.midSentence)})`);
  ok(auto.alreadyIndented === "  - ", `an already-indented marker does not gain another level (${JSON.stringify(auto.alreadyIndented)})`);
  ok(auto.pasted === "- ", `a paste ending in a marker is NOT reformatted (${JSON.stringify(auto.pasted)})`);

  // --- a sublist numbers itself, and the parent level resumes ---------------
  // Aidin's own example, typed key for key. He wrote out what he expected and what Helm
  // did instead: "helm gör inte skillnad på parent - child bullets" - the first sub-item
  // came out as 2 and its sibling as 3, because the count walked straight down the lines
  // instead of looking for the previous SIBLING at the same level.
  const levels = await app.eval(`(async () => {
    const ta = document.querySelector("#chatPage .composer-shell textarea");
    ta.focus();
    ta.value = "";
    ta.setSelectionRange(0, 0);
    const typeReal = (s) => { ta.focus(); document.execCommand("insertText", false, s); };
    const key = (k, shift) => ta.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: !!shift, bubbles: true, cancelable: true }));
    const markers = [];
    const marker = () => {
      const start = ta.value.lastIndexOf("\\n", ta.selectionStart - 1) + 1;
      return ta.value.slice(start, ta.selectionStart);
    };
    typeReal("1"); typeReal("."); typeReal(" ");
    markers.push(marker());
    typeReal("den här är första");
    key("Enter", true);
    key("Tab");
    markers.push(marker());
    typeReal("nu börjar den om på ett");
    key("Enter", true);
    markers.push(marker());
    typeReal("det här är andra subbulleten");
    key("Enter", true);
    key("Tab", true);
    markers.push(marker());
    typeReal("här är nästa riktiga bullet");
    const out = ta.value;
    ta.value = "";
    return { out, markers };
  })()`);

  const expected = ["  1. ", "    1. ", "    2. ", "  2. "];
  ok(
    JSON.stringify(levels.markers) === JSON.stringify(expected),
    `the markers are ${JSON.stringify(expected)} - a sublist starts over at one and the parent level resumes (got ${JSON.stringify(levels.markers)})`
  );
  ok(
    levels.out ===
      "  1. den här är första\n    1. nu börjar den om på ett\n    2. det här är andra subbulleten\n  2. här är nästa riktiga bullet",
    `and the whole block reads as he wrote it out (${JSON.stringify(levels.out)})`
  );

  // The rule underneath, so a third level and a resumed count are covered too rather
  // than just the one shape in his example.
  const siblings = await app.eval(`(() => {
    const v = "1. one\\n  1. sub\\n    1. deep\\n    2. deeper\\n  2. sub two\\n";
    const at = (needle) => v.indexOf(needle);
    return {
      thirdLevelFresh: previousSiblingNumber(v, at("    1. deep"), 4),
      thirdLevelSecond: previousSiblingNumber(v, at("    2. deeper"), 4),
      secondLevelResumes: previousSiblingNumber(v, at("  2. sub two"), 2),
      topLevelNothingAbove: previousSiblingNumber(v, 0, 0),
      widths: [indentWidth(""), indentWidth("  "), indentWidth("\\t"), indentWidth("    ")],
    };
  })()`);

  ok(siblings.thirdLevelFresh === null, `the first item at a new depth has no sibling, so it starts at one (${siblings.thirdLevelFresh})`);
  ok(siblings.thirdLevelSecond === 1, `its sibling counts from it (${siblings.thirdLevelSecond})`);
  ok(siblings.secondLevelResumes === 1, `coming back out resumes the level's own count, skipping the sublist between (${siblings.secondLevelResumes})`);
  ok(siblings.topLevelNothingAbove === null, "nothing above means nothing to continue from");
  ok(JSON.stringify(siblings.widths) === JSON.stringify([0, 2, 2, 4]), `a tab counts as one level, same as two spaces (${JSON.stringify(siblings.widths)})`);

  // --- the surface: the real textarea, real Shift+Enter ---------------------
  const typed = await app.eval(`(async () => {
    const ta = document.querySelector("#chatPage .composer-shell textarea");
    ta.focus();
    ta.value = "";
    const shiftEnter = () => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    const type = (s) => {
      const at = ta.selectionStart;
      ta.value = ta.value.slice(0, at) + s + ta.value.slice(ta.selectionEnd);
      ta.setSelectionRange(at + s.length, at + s.length);
    };
    type("- milk");
    shiftEnter();
    type("bread");
    shiftEnter();
    const afterTwo = ta.value;
    shiftEnter(); // empty item -> leave the list
    const afterExit = ta.value;
    type("1. one");
    shiftEnter();
    type("two");
    shiftEnter();
    const numbered = ta.value;

    // Plain Enter must still SEND, not make a list. If this ever stops being true
    // the whole feature is a regression, so it is asserted here rather than assumed.
    ta.value = "- milk";
    ta.setSelectionRange(6, 6);
    const plain = new KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true, cancelable: true });
    ta.dispatchEvent(plain);
    return { afterTwo, afterExit, numbered, plainAddedNothing: ta.value === "- milk" || ta.value === "", plainPrevented: plain.defaultPrevented };
  })()`);

  ok(typed.afterTwo === "- milk\n- bread\n- ", `typing it for real produces the list (${JSON.stringify(typed.afterTwo)})`);
  ok(typed.afterExit === "- milk\n- bread\n\n", `and one more newline leaves the list cleanly (${JSON.stringify(typed.afterExit)})`);
  ok(/1\. one\n2\. two\n3\. $/.test(typed.numbered), `numbering counts up as typed (${JSON.stringify(typed.numbered.slice(-24))})`);
  ok(typed.plainPrevented, "plain Enter is still handled by the send path");
  ok(typed.plainAddedNothing, "and never inserts a list marker");

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: Shift+Enter continues a list, numbering counts up, indentation and checkboxes carry, an empty item leaves the list, and plain Enter still sends."
    : "VERIFY FAILED."
);
process.exit(exit);
