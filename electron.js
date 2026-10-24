const { app, BrowserWindow, Menu, shell, clipboard, dialog } = require("electron");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const net = require("net");

// Fixed port on purpose: chats, settings and the memory cookie are stored per
// origin (http://localhost:3000), so changing the port would hide them.
const PORT = Number(process.env.NIMBUS_PORT) || 3000;
let serverProcess = null;

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

/* If an old Nimbus server is still holding the port (left behind by a crash
   or by updating while it ran), the new window would connect to it and show
   the OLD app. Find whoever is listening and stop it if it's a Nimbus process. */
function stopStaleNimbusServer(port) {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === "TCP" && /LISTENING/i.test(cols[3] ?? "") && cols[1]?.endsWith(`:${port}`)) pids.add(cols[4]);
    }
    let stopped = false;
    for (const pid of pids) {
      if (!pid || pid === String(process.pid)) continue;
      const info = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      if (/^"nimbus\.exe"/i.test(info.trim())) {
        execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true });
        stopped = true;
      }
    }
    return stopped;
  } catch {
    return false;
  }
}
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
function startStandaloneServer(port) {
  const serverEntry = path.join(process.resourcesPath, "standalone", "server.js");
  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
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

  win = new BrowserWindow({ width: 1200, height: 800, title: `Nimbus ${app.getVersion()}` });
  attachContextMenu(win);
  // Keep the version in the title bar so it's obvious which build is running.
  win.on("page-title-updated", (event, title) => {
    event.preventDefault();
    win.setTitle(`${title} — v${app.getVersion()}`);
  });

  if (isDev) {
    win.loadURL(`http://localhost:${PORT}`);
    return;
  }

  const url = `http://localhost:${PORT}`;
  if (!(await isPortFree(PORT))) {
    stopStaleNimbusServer(PORT);
    await new Promise((r) => setTimeout(r, 500));
    if (!(await isPortFree(PORT))) {
      dialog.showErrorBox(
        "Nimbus can't start",
        `Port ${PORT} is already in use by another program (for example a dev server from "npm run dev"). Close it and open Nimbus again.`
      );
      app.quit();
      return;
    }
  }
  startStandaloneServer(PORT);
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

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  // On Windows, kill() can leave the server running; end the whole process tree.
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"], { windowsHide: true });
  } else {
    serverProcess.kill();
  }
}

app.on("before-quit", stopServer);
process.on("exit", stopServer);
