// Exposes a tiny, fixed API to the page. The page gets no Node access and
// can't send arbitrary IPC: only these named calls exist.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nimbusDesktop", {
  pickFolder: () => ipcRenderer.invoke("nimbus:pick-folder"),
  saveTextFile: (defaultName, text) => ipcRenderer.invoke("nimbus:save-text", String(defaultName ?? ""), String(text ?? "")),
  onNewChat: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("nimbus:new-chat", handler);
    return () => ipcRenderer.removeListener("nimbus:new-chat", handler);
  },
  onMenu: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on("nimbus:menu", handler);
    return () => ipcRenderer.removeListener("nimbus:menu", handler);
  },
});
