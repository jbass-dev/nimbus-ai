const { app, BrowserWindow, Menu, Tray, shell, clipboard, dialog, globalShortcut, ipcMain, nativeImage, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const { safeFileName, usableBounds, isAppUrl } = require("./desktop-helpers");
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
let tray = null;
let quitting = false;
const SHORTCUT = "CommandOrControl+Shift+Space";

/* ---- window position/size is remembered between launches ---- */
const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
function loadWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return { bounds: usableBounds(saved, screen.getAllDisplays()), maximized: saved.maximized === true };
  } catch {
    return { bounds: null, maximized: false };
  }
}
function saveWindowState(window) {
  try {
    const maximized = window.isMaximized();
    const bounds = maximized ? (window.getNormalBounds?.() ?? window.getBounds()) : window.getBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...bounds, maximized }));
  } catch {
    // Not worth interrupting the user for.
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}
function sendToApp(channel, ...args) {
  showWindow();
  win?.webContents.send(channel, ...args);
}

/* Only pages served by the local Nimbus server may use the desktop bridge. */
function fromApp(event) {
  return isAppUrl(event.senderFrame?.url ?? event.sender.getURL(), PORT);
}

function registerIpc() {
  ipcMain.handle("nimbus:pick-folder", async (event) => {
    if (!fromApp(event)) return null;
    const r = await dialog.showOpenDialog(win, { title: "Open a project folder", properties: ["openDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle("nimbus:save-text", async (event, defaultName, text) => {
    if (!fromApp(event) || typeof text !== "string" || text.length > 5_000_000) return { ok: false };
    const base = safeFileName(defaultName);
    const r = await dialog.showSaveDialog(win, {
      title: "Export chat",
      defaultPath: path.join(app.getPath("documents"), `${base}.md`),
      filters: [{ name: "Markdown", extensions: ["md"] }, { name: "Text", extensions: ["txt"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, text, "utf8");
      return { ok: true, path: r.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function buildAppMenu() {
  const mac = process.platform === "darwin";
  const template = [
    ...(mac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CommandOrControl+N", click: () => sendToApp("nimbus:new-chat") },
        { label: "Export Chat…", accelerator: "CommandOrControl+Shift+E", click: () => sendToApp("nimbus:menu", "export-chat") },
        { label: "Open Project Folder…", accelerator: "CommandOrControl+Shift+O", click: () => sendToApp("nimbus:menu", "open-project") },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }])],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Nimbus", click: showWindow },
      { label: "New Chat", click: () => sendToApp("nimbus:new-chat") },
      { type: "separator" },
      ...(app.isPackaged && process.platform !== "linux"
        ? [{ label: "Start at login", type: "checkbox", checked: loginEnabled(), click: (item) => setLogin(item.checked) }]
        : []),
      ...(updateReady ? [{ label: `Update ready (${updateReady}): restart to install`, click: () => { quitting = true; require("electron-updater").autoUpdater.quitAndInstall(); } }] : []),
      { type: "separator" },
      { label: `Nimbus v${app.getVersion()}`, enabled: false },
      { label: "Quit Nimbus", click: () => { quitting = true; app.quit(); } },
    ])
  );
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, "tray-icon.png")).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip("Nimbus");
    refreshTrayMenu();
    tray.on("click", showWindow);
  } catch (err) {
    console.error("Tray unavailable:", err.message);
  }
}

/* ---- start at login (off unless the user turns it on; packaged builds only) ---- */
const startedHidden = process.argv.includes("--hidden");
function loginEnabled() {
  return app.isPackaged && app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin;
}
function setLogin(enabled) {
  if (!app.isPackaged) return;
  // Windows/macOS only; Linux ignores this.
  app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
  refreshTrayMenu();
}

/* ---- updates: GitHub Releases via electron-updater (packaged builds only) ---- */
let updateReady = null; // version string once downloaded
function setupAutoUpdate() {
  if (!app.isPackaged || process.env.NIMBUS_NO_UPDATE === "1") return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    console.warn("Auto-update unavailable:", err.message);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // never interrupts: installs when you next quit
  autoUpdater.on("error", (err) => console.warn("Update check failed:", err?.message));
  autoUpdater.on("update-downloaded", async (info) => {
    updateReady = info.version;
    refreshTrayMenu();
    const r = await dialog.showMessageBox(win ?? undefined, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 1,
      message: `Nimbus ${info.version} is ready`,
      detail: "Restart to finish updating. Otherwise it installs the next time you quit Nimbus.",
    });
    if (r.response === 0) {
      quitting = true;
      autoUpdater.quitAndInstall();
    }
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15_000);
  setInterval(check, 6 * 60 * 60 * 1000).unref?.();
}

function registerShortcut() {
  // Another program may already own the shortcut; that's fine, Nimbus just works without it.
  if (!globalShortcut.register(SHORTCUT, toggleWindow)) console.warn(`Could not register ${SHORTCUT}`);
}

// Probe 127.0.0.1 directly: "localhost" can resolve to ::1 first, and the
// server only listens on IPv4 loopback.
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
      // Next's standalone server defaults to 0.0.0.0, which would expose the
      // API (and the OpenRouter key behind it) to everyone on the same network.
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      // The coding workspace (read project files, stage edits) is a desktop-only feature.
      NIMBUS_WORKSPACE: "1",
      // Scheduled background tasks run while Nimbus sits in the tray.
      NIMBUS_BACKGROUND: "1",
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

/* Links (including ones the model writes) open in the system browser, never
   inside the Nimbus window, and only for web/mail schemes. */
function isSafeExternal(url) {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function lockNavigation(window, appOrigin) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === appOrigin) return;
    event.preventDefault();
    if (isSafeExternal(url)) shell.openExternal(url);
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
        { label: "Open Link in Browser", enabled: isSafeExternal(linkURL), click: () => shell.openExternal(linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(linkURL) }
      );
    }

    if (!items.length) items.push({ role: "selectAll" });
    Menu.buildFromTemplate(items).popup({ window });
  });
}

async function createWindow() {
  const isDev = !app.isPackaged;

  const saved = loadWindowState();
  win = new BrowserWindow({
    width: 1200, height: 800, ...(saved.bounds ?? {}), minWidth: 600, minHeight: 400,
    show: !(startedHidden && tray),
    title: `Nimbus ${app.getVersion()}`,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (saved.maximized) win.maximize();
  // Launched by the login item: wait quietly in the tray (only if there is one to bring it back from).
  win.on("close", () => saveWindowState(win));
  // Closing the window hides Nimbus to the tray (when there is one) so the shortcut can bring it back instantly.
  win.on("close", (event) => {
    if (!quitting && tray && process.platform !== "darwin") {
      event.preventDefault();
      win.hide();
    }
  });
  attachContextMenu(win);
  lockNavigation(win, `http://localhost:${PORT}`);
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
    await waitForServer(`http://127.0.0.1:${PORT}`);
    win.loadURL(url);
  } catch (err) {
    console.error(err);
    // Without this the user just gets a blank window and no explanation.
    dialog.showErrorBox("Nimbus can't start", `The local Nimbus server didn't start within 15 seconds.\n\n${err.message}\n\nTry closing Nimbus and opening it again.`);
    app.quit();
  }
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    registerIpc();
    buildAppMenu();
    createTray();
    registerShortcut();
    setupAutoUpdate();
    return createWindow();
  });

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

app.on("before-quit", () => { quitting = true; stopServer(); });
app.on("will-quit", () => globalShortcut.unregisterAll());
process.on("exit", stopServer);
