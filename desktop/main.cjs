const {
  app,
  BrowserWindow,
  dialog,
  session,
  shell,
  safeStorage,
} = require("electron");
const { spawn } = require("node:child_process");
const { readFile, writeFile, mkdir, chmod } = require("node:fs/promises");
const { join } = require("node:path");
const { createToken, isTrustedUrl } = require("./security.cjs");

let window,
  backend,
  origin,
  quitting = false;
app.setName("TRACEFOLIO");
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

function childEnv(dataDir, secret, token) {
  // Deliberately exclude developer API keys, Git credentials and external NODE_OPTIONS.
  const env = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    NODE_ENV: "production",
    ELECTRON_RUN_AS_NODE: "1",
    TRACEFOLIO_DESKTOP_NODE: "1",
    DATABASE_URL: `file:${join(dataDir, "career.db").replace(/\\/g, "/")}`,
    LUJIE_SETTINGS_SECRET: secret,
    TRACEFOLIO_DESKTOP_TOKEN: token,
    TRACEFOLIO_DESKTOP_DATA: dataDir,
  };
}

async function localSecret(dataDir) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("系统安全存储不可用，无法保存模型凭证。");
  const path = join(dataDir, "device-key.enc");
  try {
    return safeStorage.decryptString(await readFile(path));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("无法解锁本机凭证，请保留数据并检查系统钥匙串。");
    const secret = createToken();
    await writeFile(path, safeStorage.encryptString(secret), {
      mode: 0o600,
      flag: "wx",
    });
    return secret;
  }
}

async function start() {
  const dataDir = app.getPath("userData");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dataDir, 0o700);
  const root = app.isPackaged
    ? join(process.resourcesPath, "backend")
    : join(__dirname, "../.desktop/backend");
  const token = createToken(),
    secret = await localSecret(dataDir);
  backend = spawn(
    process.execPath,
    [join(root, "runtime/desktop-server.mjs")],
    {
      cwd: root,
      env: childEnv(dataDir, secret, token),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Never forward backend/provider output; startup failures have a controlled UI.
  backend.stderr.resume();
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () => reject(new Error("本机服务启动超时。")),
      90_000,
    );
    backend.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("无法启动本机服务。"));
    });
    backend.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("本机服务启动失败。"));
    });
    backend.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 20_000) buffer = buffer.slice(-10_000);
      const ready = buffer.match(/TRACEFOLIO_READY:(\d+)\n/);
      if (ready) {
        clearTimeout(timeout);
        resolve(Number(ready[1]));
        buffer = "";
      }
    });
  });
  origin = `http://127.0.0.1:${port}`;
  const localSession = session.fromPartition("persist:tracefolio");
  localSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  localSession.setPermissionCheckHandler(() => false);
  localSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!isTrustedUrl(details.url, origin)) {
      callback({ cancel: true });
      return;
    }
    details.requestHeaders["X-Tracefolio-Desktop"] = token;
    callback({ requestHeaders: details.requestHeaders });
  });
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: "TRACEFOLIO",
    backgroundColor: "#f3f6fa",
    webPreferences: {
      session: localSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedUrl(url, origin)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  localSession.on("will-download", (event, item) => {
    if (!isTrustedUrl(item.getURL(), origin)) event.preventDefault();
  });
  backend.once("exit", () => {
    if (!quitting) {
      dialog.showErrorBox(
        "TRACEFOLIO",
        "本机服务已停止。请重新启动应用；本地资料已保留。",
      );
      app.quit();
    }
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    window = null;
  });
  await window.loadURL(`${origin}/intelligence`);
}
function openExternal(value) {
  try {
    const url = new URL(value);
    if (
      ["https:", "http:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      void shell.openExternal(url.toString());
  } catch {}
}
app
  .whenReady()
  .then(start)
  .catch(() => {
    dialog.showErrorBox(
      "TRACEFOLIO",
      "无法启动桌面应用。请确认安装完整、系统安全存储可用，并保留本机数据目录。应用不会自动删除资料。",
    );
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  backend?.kill("SIGTERM");
});
