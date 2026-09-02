// IPC bridge behind Helm's embedded Jot tab ("one Jot, two mounts"). Jot's BUILT
// renderer talks to a `window.jot` that invokes a fixed set of IPC channels
// (todos:add, state:get, ...). To mount that same renderer inside Helm's webview,
// Helm's main must answer those SAME channels - backed by the @jot/core host store
// (src/lib/jotHostStore.js) instead of Jot's own main. This is what lets the
// identical UI run in both shells with no fork.
//
// The channel -> store-method mapping is a PURE function (applyJotOp) so it's
// unit-testable without electron. registerJotIpc is the thin electron wiring on
// top, called by main.js's jot:mount handler when the Jot tab first opens.
//
// Channel surface mirrors Jot's preload (src/preload/index.ts). The board (App)
// needs the data channels below; capture:* (popover) and update:* (Jot self-update)
// are standalone-shell concerns and are intentionally NOT bridged.

import path from "node:path";

// Pure dispatch: run one Jot data channel against the store. Returns the store
// result (state, new id, count, or undefined). Throws on an unknown channel so a
// missing binding is loud, not silent.
export function applyJotOp(store, channel, args = []) {
  switch (channel) {
    case "state:get":
      return store.getState();
    case "todos:add":
      return store.addTodo(args[0], args[1], args[2], args[3]);
    case "todos:setStatus":
      return store.setStatus(args[0], args[1], args[2]);
    case "todos:setPriority":
      return store.setTodoPriority(args[0], args[1]);
    case "todos:setDeadline":
      return store.setTodoDeadline(args[0], args[1]);
    case "todos:addSubtask":
      return store.addSubtask(args[0], args[1]);
    case "todos:update":
      return store.updateTodo(args[0], args[1]);
    case "todos:remove":
      return store.removeTodo(args[0]);
    case "todos:setCategory":
      return store.setTodoCategory(args[0], args[1]);
    case "todos:reorder":
      return store.reorderTodos(args[0]);
    case "todos:clearCompleted":
      return store.clearCompleted();
    case "todos:archiveCompleted":
      return store.archiveCompleted();
    case "todos:setTags":
      return store.setTodoTags(args[0], args[1]);
    case "todos:addImageData":
      return store.addImageFromBytes(args[0], args[1], args[2]);
    case "todos:removeImage":
      return store.removeImage(args[0], args[1]);
    case "categories:add":
      return store.addCategory(args[0]);
    case "categories:remove":
      return store.removeCategory(args[0]);
    case "categories:rename":
      return store.renameCategory(args[0], args[1]);
    case "categories:reorder":
      return store.reorderCategories(args[0]);
    case "categories:setDomain":
      return store.setCategoryDomain(args[0], args[1]);
    case "categories:setRepoPath":
      return store.setCategoryRepoPath(args[0], args[1]);
    case "tags:add":
      return store.addTag(args[0], args[1], args[2]);
    case "tags:remove":
      return store.removeTag(args[0]);
    case "tags:update":
      return store.updateTag(args[0], args[1]);
    default:
      throw new Error(`Unsupported Jot channel: ${channel}`);
  }
}

// The store-backed channels applyJotOp handles (used to register handlers + for
// tests to assert coverage against Jot's preload surface).
export const JOT_STORE_CHANNELS = [
  "state:get",
  "todos:add",
  "todos:setStatus",
  "todos:setPriority",
  "todos:setDeadline",
  "todos:addSubtask",
  "todos:update",
  "todos:remove",
  "todos:setCategory",
  "todos:reorder",
  "todos:clearCompleted",
  "todos:archiveCompleted",
  "todos:setTags",
  "todos:addImageData",
  "todos:removeImage",
  "categories:add",
  "categories:remove",
  "categories:rename",
  "categories:reorder",
  "categories:setDomain",
  "categories:setRepoPath",
  "tags:add",
  "tags:remove",
  "tags:update",
];

// Thin electron wiring. Registers a handler per store channel (delegating to
// applyJotOp), plus the two channels that need the shell (images:resolve, which
// needs the data dir; dialog:pickFolder, deferred), and broadcasts store changes
// to the embedded Jot webview as 'state:changed' (what window.jot.onChanged waits
// on). Returns an unregister function.
//
// opts: { ipcMain, store, dataDir, getTargets, dialog }
//   getTargets(): WebContents[]  - the frames to push 'state:changed' to (the Jot webview)
//   dialog: electron.dialog       - optional; enables dialog:pickFolder
// opts.skipChannels: channels the HOST already answers (e.g. Helm has its own
// dialog:pickFolder) - don't re-register those (ipcMain.handle throws on a double
// registration); the webview's invoke falls through to the host's handler.
export function registerJotIpc({ ipcMain, store, dataDir, getTargets, dialog, skipChannels = [] }) {
  const skip = new Set(skipChannels);
  const registered = [];
  const handle = (channel, fn) => {
    if (skip.has(channel)) {
      return;
    }
    ipcMain.handle(channel, fn);
    registered.push(channel);
  };

  for (const channel of JOT_STORE_CHANNELS) {
    handle(channel, (_event, ...args) => applyJotOp(store, channel, args));
  }

  // images:resolve - the renderer asks for the absolute path of a stored image.
  handle("images:resolve", (_event, relativePath) => path.join(dataDir, relativePath));

  // dialog:pickFolder - the category repo-path picker. Skipped when the host owns
  // it (Helm does); otherwise provided here if a dialog was passed.
  handle("dialog:pickFolder", async (_event, defaultPath) => {
    if (!dialog) {
      return null;
    }
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: defaultPath || undefined });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  // Push canonical state to the embedded Jot renderer(s) on every change (the
  // store's own file-watch also feeds this when a standalone Jot edits the file).
  const unsubscribe = store.subscribe((state) => {
    for (const wc of getTargets() || []) {
      if (wc && !wc.isDestroyed()) {
        wc.send("state:changed", state);
      }
    }
  });

  return () => {
    unsubscribe();
    for (const channel of registered) {
      ipcMain.removeHandler(channel);
    }
  };
}
