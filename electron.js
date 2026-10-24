const { app, BrowserWindow, Menu, shell, clipboard } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const PORT = process.env.NIMBUS_PORT || 3000;
let serverProcess = null;
let win = null;

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http
        .get(url, (res) => {
          res.destroy();
          resolve();
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) {
            reject(new Error("Timed out waiting for the local server to start."));
          } else {
            setTimeout(tryOnce, 250);
          }
        });
    };
    tryOnce();
  });
}

/* Packaged builds ship a standalone Next.js server (output: "standalone")
   so API routes keep working — a static export can't serve /api routes. */
function startStandaloneServer() {
  const serverEntry = path.join(process.resourcesPath, "standalone", "server.js");
  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT),
      NODE_ENV: "production",
      // Persistent memory must live in a writable per-user location, not in
      // the (possibly read-only) install directory, and must survive updates.
      NIMBUS_DATA_DIR: process.env.NIMBUS_DATA_DIR || path.join(app.getPath("userData"), "nimbus-data"),
    },
    stdio: "inherit",
  });
  serverProcess.on("exit", (code) => {
    if (code !== 0) console.error(`Standalone server exited with code ${code}`);
  });
}

/* Right-click menu. Electron windows have none by default, so right-clicking
   selected text or the message box did nothing. Uses built-in roles so the OS
   handles the clipboard, and only shows actions that apply to what was clicked. */
function shareMenu(text) {
  if (process.platform === "darwin") {
    return { role: "shareMenu", sharingItem: { texts: [text] } };
  }
  // Windows/Linux: Electron has no native share sheet, so offer the useful targets.
  const snippet = text.length > 1800 ? `${text.slice(0, 1800)}…` : text;
  return {
    label: "Share",
    submenu: [
      {
        label: "Email…",
        click: () => shell.openExternal(`mailto:?body=${encodeURIComponent(snippet)}`),
      },
      {
        label: "Search the web",
        click: () =>
          shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(text.slice(0, 300))}`),
      },
    ],
  };
}

function attachContextMenu(window) {
  window.webContents.on("context-menu", (_event, params) => {
    const { editFlags, isEditable, linkURL } = params;
    const selection = params.selectionText.trim();
    const items = [];

    if (isEditable) {
      items.push(
        { role: "undo", enabled: editFlags.canUndo },
        { role: "redo", enabled: editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: editFlags.canCut },
        { role: "copy", enabled: editFlags.canCopy },
        { role: "paste", enabled: editFlags.canPaste },
        { role: "selectAll" }
      );
    } else if (selection) {
      items.push({ role: "copy" }, shareMenu(selection), { type: "separator" }, { role: "selectAll" });
    }

    if (linkURL) {
      if (items.length) items.push({ type: "separator" });
      items.push(
        { label: "Open Link in Browser", click: () => shell.openExternal(linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(linkURL) }
      );
    }

    if (!items.length) items.push({ role: "selectAll" });
    Menu.buildFromTemplate(items).popup({ window });
  });
}

async function createWindow() {
  const isDev = !app.isPackaged;
  const url = `http://localhost:${PORT}`;

  win = new BrowserWindow({ width: 1200, height: 800 });
  attachContextMenu(win);

  if (isDev) {
    win.loadURL(url);
    return;
  }

  startStandaloneServer();
  try {
    await waitForServer(url);
    win.loadURL(url);
  } catch (err) {
    console.error(err);
  }
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("before-quit", () => {
  serverProcess?.kill();
});
