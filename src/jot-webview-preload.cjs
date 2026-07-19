// Preload for Helm's embedded Jot webview. Exposes the exact `window.jot` (JotApi)
// that Jot's built renderer expects, backed by the IPC channels Helm's main answers
// via jotIpcBridge.js (which delegates to the @jot/core host store). This is the
// last link in "one Jot, two mounts": Jot's unmodified renderer runs in Helm's
// webview and drives the same data as a standalone Jot.
//
// A byte-mirror of Jot's own preload surface (jot/src/preload/index.ts). Plain CJS
// because Helm has no renderer build step. capture:*/update:* (popover, self-update)
// are standalone-only and intentionally absent - the embedded board never uses them.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jot", {
  getState: () => ipcRenderer.invoke("state:get"),
  addTodo: (text, categoryId, priority, deadline) => ipcRenderer.invoke("todos:add", text, categoryId, priority, deadline),
  setStatus: (id, status, toTop) => ipcRenderer.invoke("todos:setStatus", id, status, toTop),
  setTodoPriority: (id, priority) => ipcRenderer.invoke("todos:setPriority", id, priority),
  setTodoDeadline: (id, deadline) => ipcRenderer.invoke("todos:setDeadline", id, deadline),
  addSubtask: (parentId, text) => ipcRenderer.invoke("todos:addSubtask", parentId, text),
  updateTodo: (id, patch) => ipcRenderer.invoke("todos:update", id, patch),
  removeTodo: (id) => ipcRenderer.invoke("todos:remove", id),
  setTodoCategory: (id, categoryId) => ipcRenderer.invoke("todos:setCategory", id, categoryId),
  reorderTodos: (orderedVisibleIds) => ipcRenderer.invoke("todos:reorder", orderedVisibleIds),
  clearCompleted: () => ipcRenderer.invoke("todos:clearCompleted"),
  archiveCompleted: () => ipcRenderer.invoke("todos:archiveCompleted"),
  addCategory: (name) => ipcRenderer.invoke("categories:add", name),
  renameCategory: (id, name) => ipcRenderer.invoke("categories:rename", id, name),
  setCategoryRepoPath: (id, repoPath) => ipcRenderer.invoke("categories:setRepoPath", id, repoPath),
  setCategoryDomain: (id, domain) => ipcRenderer.invoke("categories:setDomain", id, domain),
  pickFolder: (defaultPath) => ipcRenderer.invoke("dialog:pickFolder", defaultPath),
  removeCategory: (id) => ipcRenderer.invoke("categories:remove", id),
  reorderCategories: (orderedIds) => ipcRenderer.invoke("categories:reorder", orderedIds),
  addTag: (name, color, description) => ipcRenderer.invoke("tags:add", name, color, description),
  updateTag: (id, patch) => ipcRenderer.invoke("tags:update", id, patch),
  removeTag: (id) => ipcRenderer.invoke("tags:remove", id),
  setTodoTags: (todoId, tagIds) => ipcRenderer.invoke("todos:setTags", todoId, tagIds),
  addImage: (todoId) => ipcRenderer.invoke("todos:addImage", todoId),
  addImageData: (todoId, bytes, ext) => ipcRenderer.invoke("todos:addImageData", todoId, bytes, ext),
  removeImage: (todoId, imagePath) => ipcRenderer.invoke("todos:removeImage", todoId, imagePath),
  getImagePath: (relativePath) => ipcRenderer.invoke("images:resolve", relativePath),
  onChanged: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("state:changed", handler);
    return () => ipcRenderer.removeListener("state:changed", handler);
  },
});
