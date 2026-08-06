const { app, BrowserWindow } = require("electron");
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
    },
    stdio: "inherit",
  });
  serverProcess.on("exit", (code) => {
    if (code !== 0) console.error(`Standalone server exited with code ${code}`);
  });
}

async function createWindow() {
  const isDev = !app.isPackaged;
  const url = `http://localhost:${PORT}`;

  win = new BrowserWindow({ width: 1200, height: 800 });

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
