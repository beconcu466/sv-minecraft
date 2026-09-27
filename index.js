const express = require("express");
const multer = require("multer");

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const { spawn, execFile } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const BASE_DIR = __dirname;

const MINECRAFT_DIR = path.join(BASE_DIR, "minecraft");
const FRP_DIR = path.join(BASE_DIR, "frp");
const DATA_DIR = path.join(BASE_DIR, "data");
const PUBLIC_DIR = path.join(BASE_DIR, "");
const TEMP_UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const SERVER_PROPERTIES = path.join(MINECRAFT_DIR, "server.properties");
const EULA_FILE = path.join(MINECRAFT_DIR, "eula.txt");
const FRP_CONFIG = path.join(FRP_DIR, "exfrpc.toml");

const MINECRAFT_VERSION = "1.20.1";
const MINECRAFT_PORT = 25565;

const MAX_LOGS = 3000;

let minecraftProcess = null;
let frpProcess = null;

let runGeneration = 0;

const state = {
  /* ⭐ LUÔN MẶC ĐỊNH LÀ AUTO KHI BOOT */
  mode: "auto",

  minecraft: {
    status: "stopped",
    running: false,
    ready: false,
    pid: null,
    progress: 0,
    progressText: "",
    portDetected: false,
    bindFailed: false,
    jar: null,
    error: null,

    startupCompleted: false,
    startupCompletedAt: null,

    hasServer: false
  },

  frp: {
    running: false,
    ready: false,
    status: "stopped",
    pid: null,
    attempt: 0,
    serverAddr: null,
    remotePort: null,
    publicAddress: null,
    successSeen: false,
    error: null
  },

  logs: []
};

/* =========================================================
   MULTER
========================================================= */
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const safeName =
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(file.originalname)}`;

    cb(null, safeName);
  }
});

const upload = multer({
  storage: uploadStorage,
  preservePath: true,
  limits: {
    files: 50000,
    fileSize: 4 * 1024 * 1024 * 1024
  }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================================================
   BASIC HELPERS
========================================================= */

async function ensureDirectories() {
  await fs.promises.mkdir(MINECRAFT_DIR, { recursive: true });
  await fs.promises.mkdir(FRP_DIR, { recursive: true });
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.promises.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
}

/**
 * Xóa file config.json cũ (nếu còn) để không load mode cũ.
 */
async function removeOldConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      await fs.promises.rm(CONFIG_FILE, { force: true });
      console.log("Đã xóa config.json cũ — mode reset về auto.");
    }
  } catch (error) {
    console.error("Không xóa được config.json:", error.message);
  }
}

function stripAnsi(value) {
  return String(value ?? "").replace(
    /\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g,
    ""
  );
}

function addLog(source, stream, text) {
  const clean = stripAnsi(String(text ?? ""));
  const lines = clean.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    state.logs.push({
      time: new Date().toLocaleTimeString(),
      source,
      stream,
      text: line
    });
  }

  if (state.logs.length > MAX_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_LOGS);
  }
}

function setMinecraftProgress(progress, text) {
  state.minecraft.progress = Math.max(0, Math.min(100, progress));
  state.minecraft.progressText = text || "";
}

function resetStartupCompleted() {
  state.minecraft.startupCompleted = false;
  state.minecraft.startupCompletedAt = null;
}

function refreshHasServerFlag() {
  try {
    const jar = findServerJar();

    if (jar) {
      state.minecraft.hasServer = true;
      state.minecraft.jar = path.relative(BASE_DIR, jar);
      return true;
    }

    state.minecraft.hasServer = false;
    return false;
  } catch {
    state.minecraft.hasServer = false;
    return false;
  }
}

function safeJoin(base, relativePath) {
  const normalized = path
    .normalize(relativePath)
    .replace(/^(\.\.(\/|\\|$))+/, "");

  const resolved = path.resolve(base, normalized);
  const baseResolved = path.resolve(base);

  if (
    resolved !== baseResolved &&
    !resolved.startsWith(baseResolved + path.sep)
  ) {
    throw new Error("Đường dẫn upload không hợp lệ.");
  }

  return resolved;
}

function normalizeUploadPath(input) {
  let p = String(input || "").replace(/\\/g, "/");
  p = p.replace(/^\/+/, "");
  p = path.posix.normalize(p);

  if (!p || p === "." || p === "..") {
    throw new Error("Tên file upload không hợp lệ.");
  }

  if (
    p.startsWith("../") ||
    p.includes("/../") ||
    path.posix.isAbsolute(p) ||
    /^[A-Za-z]:/.test(p)
  ) {
    throw new Error(`Đường dẫn upload không hợp lệ: ${input}`);
  }

  return p;
}

async function clearDirectoryContents(directory) {
  await fs.promises.mkdir(directory, { recursive: true });

  const entries = await fs.promises.readdir(directory);

  for (const entry of entries) {
    const target = path.join(directory, entry);

    await fs.promises.rm(target, {
      recursive: true,
      force: true
    });
  }

  return entries.length;
}

async function cleanupUploadedTempFiles(files) {
  if (!Array.isArray(files)) return;

  for (const file of files) {
    try {
      if (file?.path) {
        await fs.promises.rm(file.path, { force: true });
      }
    } catch {}
  }
}

/* =========================================================
   HTTP DOWNLOAD
========================================================= */

function requestBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) {
      reject(new Error("Quá nhiều redirect."));
      return;
    }

    const client = url.startsWith("https://") ? https : http;

    const request = client.get(
      url,
      { headers: { "User-Agent": "Minecraft-Server-Panel/1.0" } },
      (response) => {
        const status = response.statusCode || 0;

        if (
          status >= 300 &&
          status < 400 &&
          response.headers.location
        ) {
          response.resume();

          const redirected = new URL(
            response.headers.location,
            url
          ).toString();

          requestBuffer(redirected, redirectCount + 1)
            .then(resolve)
            .catch(reject);

          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`HTTP ${status} khi tải ${url}`));
          return;
        }

        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      }
    );

    request.on("error", reject);
  });
}

async function downloadFile(url, destination) {
  const buffer = await requestBuffer(url);

  await fs.promises.mkdir(path.dirname(destination), {
    recursive: true
  });

  await fs.promises.writeFile(destination, buffer);
}

async function getJson(url) {
  const buffer = await requestBuffer(url);
  return JSON.parse(buffer.toString("utf8"));
}

/* =========================================================
   MINECRAFT SERVER FILES
========================================================= */

async function ensureServerJar() {
  const jar = path.join(MINECRAFT_DIR, "server.jar");

  if (fs.existsSync(jar)) return jar;

  setMinecraftProgress(10, "Đang tải Minecraft Server...");

  addLog(
    "minecraft",
    "info",
    "Không tìm thấy server.jar. Đang tải Minecraft 1.20.1..."
  );

  const manifestUrl =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

  const manifest = await getJson(manifestUrl);

  const versionInfo = manifest.versions.find(
    (item) => item.id === MINECRAFT_VERSION
  );

  if (!versionInfo) {
    throw new Error(
      `Không tìm thấy Minecraft ${MINECRAFT_VERSION}.`
    );
  }

  const versionJson = await getJson(versionInfo.url);
  const serverDownload = versionJson.downloads?.server?.url;

  if (!serverDownload) {
    throw new Error("Minecraft version không có server download.");
  }

  await downloadFile(serverDownload, jar);

  addLog("minecraft", "info", "Đã tải server.jar.");

  return jar;
}

function findServerJar() {
  const preferred = path.join(MINECRAFT_DIR, "server.jar");
  if (fs.existsSync(preferred)) return preferred;

  if (!fs.existsSync(MINECRAFT_DIR)) return null;

  return findJarRecursive(MINECRAFT_DIR);
}

function findJarRecursive(dir) {
  if (!fs.existsSync(dir)) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  const jarsHere = entries.filter(
    (entry) =>
      entry.isFile() && entry.name.toLowerCase().endsWith(".jar")
  );

  if (jarsHere.length) {
    const priority = [
      /^server\.jar$/i,
      /^paper.*\.jar$/i,
      /^purpur.*\.jar$/i,
      /^fabric.*\.jar$/i,
      /^forge.*\.jar$/i,
      /^spigot.*\.jar$/i,
      /^bukkit.*\.jar$/i
    ];

    for (const regex of priority) {
      const match = jarsHere.find((entry) => regex.test(entry.name));
      if (match) return path.join(dir, match.name);
    }

    return path.join(dir, jarsHere[0].name);
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = findJarRecursive(path.join(dir, entry.name));
      if (nested) return nested;
    }
  }

  return null;
}

/* =========================================================
   SERVER.PROPERTIES + EULA
========================================================= */

async function updateServerProperties() {
  let content = "";

  if (fs.existsSync(SERVER_PROPERTIES)) {
    content = await fs.promises.readFile(SERVER_PROPERTIES, "utf8");
  }

  const lines = content.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();

    return ![
      "online-mode=",
      "server-port=",
      "server-ip=",
      "enable-query=",
      "enable-rcon="
    ].some((prefix) => trimmed.startsWith(prefix));
  });

  const filtered = lines.filter((line, index, array) => {
    if (line === "" && index === array.length - 1) return false;
    return true;
  });

  filtered.push(
    "online-mode=false",
    `server-port=${MINECRAFT_PORT}`,
    "server-ip=",
    "enable-query=false",
    "enable-rcon=false"
  );

  await fs.promises.writeFile(
    SERVER_PROPERTIES,
    filtered.join("\n") + "\n",
    "utf8"
  );
}

async function ensureEula() {
  let content = "";

  if (fs.existsSync(EULA_FILE)) {
    content = await fs.promises.readFile(EULA_FILE, "utf8");
  }

  const lines = content
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("eula="));

  lines.push("eula=true");

  await fs.promises.writeFile(
    EULA_FILE,
    lines.join("\n") + "\n",
    "utf8"
  );
}

/* =========================================================
   PORT CHECK
========================================================= */

function checkPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(true);
      else resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(false));
    });

    server.listen(port, host);
  });
}

function waitForPortOpen(
  port,
  host = "127.0.0.1",
  timeout = 30000
) {
  return new Promise((resolve) => {
    const start = Date.now();

    const attempt = () => {
      const socket = new net.Socket();
      let finished = false;

      const finish = (result) => {
        if (finished) return;
        finished = true;

        socket.destroy();

        if (result) {
          resolve(true);
          return;
        }

        if (Date.now() - start >= timeout) {
          resolve(false);
          return;
        }

        setTimeout(attempt, 500);
      };

      socket.setTimeout(1000);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(port, host);
    };

    attempt();
  });
}

function getPortOwner() {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile(
        "cmd.exe",
        [
          "/c",
          `netstat -ano -p tcp | findstr :${MINECRAFT_PORT}`
        ],
        (error, stdout) => {
          if (error || !stdout) {
            resolve(null);
            return;
          }

          const lines = stdout.trim().split(/\r?\n/);

          for (const line of lines) {
            const match = line.match(/\s+(\d+)\s*$/);

            if (match) {
              resolve({ pid: Number(match[1]), raw: line.trim() });
              return;
            }
          }

          resolve(null);
        }
      );

      return;
    }

    execFile(
      "sh",
      [
        "-c",
        `lsof -nP -iTCP:${MINECRAFT_PORT} -sTCP:LISTEN -t 2>/dev/null | head -n 1`
      ],
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null);
          return;
        }

        const pid = Number(stdout.trim());
        if (!pid) {
          resolve(null);
          return;
        }

        resolve({ pid, raw: stdout.trim() });
      }
    );
  });
}

/* =========================================================
   MINECRAFT START
========================================================= */

function attachMinecraftOutput(generation) {
  if (!minecraftProcess) return;

  const handleData = (source, stream, data) => {
    const text = stripAnsi(data.toString());
    addLog(source, stream, text);

    const lower = text.toLowerCase();

    if (lower.includes("failed to bind to port")) {
      state.minecraft.bindFailed = true;
      state.minecraft.error = "Minecraft không thể bind port 25565.";
      state.minecraft.status = "error";
      addLog("minecraft", "error", "FAILED TO BIND TO PORT 25565.");
    }

    if (lower.includes("starting minecraft server on")) {
      state.minecraft.portDetected = true;
      setMinecraftProgress(65, "Minecraft đã bắt đầu mở port...");
    }

    if (lower.includes("done (") && lower.includes("for help")) {
      state.minecraft.portDetected = true;
      setMinecraftProgress(100, "Minecraft đã sẵn sàng");

      if (!state.minecraft.startupCompleted) {
        state.minecraft.startupCompleted = true;
        state.minecraft.startupCompletedAt = Date.now().toString();

        addLog(
          "minecraft",
          "info",
          "Minecraft khởi động hoàn tất (Done)."
        );
      }
    }
  };

  minecraftProcess.stdout.on("data", (data) =>
    handleData("minecraft", "stdout", data)
  );

  minecraftProcess.stderr.on("data", (data) =>
    handleData("minecraft", "stderr", data)
  );

  minecraftProcess.once("exit", (code, signal) => {
    if (generation !== runGeneration) return;

    minecraftProcess = null;

    state.minecraft.running = false;
    state.minecraft.ready = false;
    state.minecraft.pid = null;

    resetStartupCompleted();

    if (code === 0) {
      state.minecraft.status = "stopped";
    } else if (state.minecraft.bindFailed) {
      state.minecraft.status = "error";
    } else {
      state.minecraft.status = "stopped";

      if (state.minecraft.error === null) {
        state.minecraft.error = `Minecraft dừng. code=${code}, signal=${signal || "none"}`;
      }
    }

    state.frp.running = false;
    state.frp.ready = false;
    state.frp.publicAddress = null;

    if (frpProcess) {
      try { frpProcess.kill(); } catch {}
      frpProcess = null;
    }

    addLog(
      "minecraft",
      "info",
      `Minecraft process đã dừng. code=${code}, signal=${signal || "none"}`
    );
  });
}

async function waitForMinecraftReady(generation) {
  const timeout = 120000;
  const start = Date.now();

  let sawStartingLog = false;

  while (Date.now() - start < timeout) {
    if (generation !== runGeneration) return false;
    if (!minecraftProcess || minecraftProcess.killed) return false;
    if (state.minecraft.bindFailed) return false;

    if (state.minecraft.portDetected) sawStartingLog = true;

    if (sawStartingLog) {
      const open = await waitForPortOpen(
        MINECRAFT_PORT,
        "127.0.0.1",
        2000
      );

      if (open) return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function startMinecraft() {
  if (state.minecraft.running || minecraftProcess) {
    throw new Error("Minecraft đang chạy.");
  }

  if (state.mode === "upload") {
    const hasJar = refreshHasServerFlag();

    if (!hasJar) {
      throw new Error(
        "Vui lòng upload folder Minecraft trước khi Start server."
      );
    }
  }

  state.minecraft.error = null;
  state.minecraft.bindFailed = false;
  state.minecraft.portDetected = false;
  resetStartupCompleted();

  state.frp.error = null;
  state.frp.publicAddress = null;
  state.frp.successSeen = false;
  state.frp.ready = false;
  state.frp.running = false;
  state.frp.status = "stopped";

  setMinecraftProgress(2, "Đang kiểm tra port...");

  const occupied = await checkPortInUse(MINECRAFT_PORT);

  if (occupied) {
    const owner = await getPortOwner();

    let message = `Port ${MINECRAFT_PORT} đang được sử dụng.`;

    if (owner?.pid) {
      message += ` PID: ${owner.pid}.`;
    }

    state.minecraft.error = message;
    state.minecraft.status = "error";

    setMinecraftProgress(0, message);

    addLog("panel", "error", message);

    throw new Error(message);
  }

  setMinecraftProgress(8, "Đang kiểm tra server...");

  let jar;

  if (state.mode === "auto") {
    jar = await ensureServerJar();
  } else {
    jar = findServerJar();

    if (!jar) {
      throw new Error(
        "Upload mode: không tìm thấy file .jar trong minecraft/."
      );
    }
  }

  state.minecraft.jar = path.relative(BASE_DIR, jar);
  state.minecraft.hasServer = true;

  setMinecraftProgress(20, "Đang kiểm tra cấu hình...");

  await updateServerProperties();
  await ensureEula();

  const javaCommand = process.env.JAVA_BIN || "java";

  const jarDir = path.dirname(jar);
  const jarName = path.basename(jar);

  const javaArgs = [
    "-Xms1G",
    "-Xmx2G",
    "-jar",
    jarName,
    "nogui"
  ];

  runGeneration++;

  const generation = runGeneration;

  setMinecraftProgress(30, "Đang khởi động Minecraft...");

  addLog(
    "minecraft",
    "info",
    `Starting: ${javaCommand} ${javaArgs.join(" ")} (cwd=${path.relative(BASE_DIR, jarDir)})`
  );

  minecraftProcess = spawn(javaCommand, javaArgs, {
    cwd: jarDir,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });

  state.minecraft.running = true;
  state.minecraft.ready = false;
  state.minecraft.status = "starting";
  state.minecraft.pid = minecraftProcess.pid;

  attachMinecraftOutput(generation);

  minecraftProcess.once("error", (error) => {
    if (generation !== runGeneration) return;

    state.minecraft.error = error.message;
    state.minecraft.status = "error";
    state.minecraft.running = false;
    state.minecraft.ready = false;
    state.minecraft.pid = null;

    resetStartupCompleted();

    addLog("minecraft", "error", error.message);
  });

  setMinecraftProgress(45, "Đang chờ Minecraft mở port...");

  const ready = await waitForMinecraftReady(generation);

  if (!ready) {
    if (state.minecraft.bindFailed) {
      throw new Error("Minecraft failed to bind port 25565.");
    }

    if (generation === runGeneration && minecraftProcess) {
      state.minecraft.error =
        "Minecraft không sẵn sàng trong thời gian chờ.";

      await stopMinecraftOnly();
    }

    throw new Error("Minecraft không sẵn sàng.");
  }

  if (generation !== runGeneration) return;

  state.minecraft.ready = true;
  state.minecraft.status = "ready";

  addLog("minecraft", "info", "Minecraft READY (port mở).");

  startFrpWithRetries(generation).catch((error) => {
    addLog("frp", "error", error.message);
  });
}

/* =========================================================
   FRP
========================================================= */

function getFrpBinary() {
  const platform = process.platform;
  const arch = process.arch;

  let filename;

  if (platform === "win32" && arch === "x64") {
    filename = "exfrpc_windows_amd64.exe";
  } else if (platform === "linux" && arch === "x64") {
    filename = "exfrpc_linux_amd64";
  } else if (platform === "linux" && arch === "arm64") {
    filename = "exfrpc_linux_arm64";
  } else if (
    platform === "linux" &&
    (arch === "arm" || arch === "armv7l")
  ) {
    filename = "exfrpc_linux_arm";
  } else {
    throw new Error(`Không hỗ trợ FRP cho ${platform}/${arch}.`);
  }

  return path.join(FRP_DIR, filename);
}

async function readFrpConfig() {
  if (!fs.existsSync(FRP_CONFIG)) {
    throw new Error("Không tìm thấy frp/exfrpc.toml.");
  }

  const content = await fs.promises.readFile(FRP_CONFIG, "utf8");

  const serverAddrMatch = content.match(
    /^\s*serverAddr\s*=\s*["']([^"']+)["']/mi
  );

  const remotePortMatch = content.match(
    /^\s*remotePort\s*=\s*(\d+)/mi
  );

  if (!serverAddrMatch) {
    throw new Error("Không tìm thấy serverAddr trong exfrpc.toml.");
  }

  if (!remotePortMatch) {
    throw new Error("Không tìm thấy remotePort trong exfrpc.toml.");
  }

  return {
    serverAddr: serverAddrMatch[1],
    remotePort: Number(remotePortMatch[1])
  };
}

function killFrpProcess() {
  if (!frpProcess) return;

  try {
    frpProcess.kill();
  } catch {}

  frpProcess = null;
}

function startFrpAttempt(generation, attempt, config) {
  return new Promise((resolve, reject) => {
    if (generation !== runGeneration) {
      reject(new Error("FRP run đã hết hiệu lực."));
      return;
    }

    const binary = getFrpBinary();

    if (!fs.existsSync(binary)) {
      reject(
        new Error(
          `Không tìm thấy FRP binary: ${path.basename(binary)}`
        )
      );
      return;
    }

    if (process.platform !== "win32") {
      try { fs.chmodSync(binary, 0o755); } catch {}
    }

    state.frp.attempt = attempt;
    state.frp.status = "starting";
    state.frp.running = true;
    state.frp.ready = false;
    state.frp.successSeen = false;
    state.frp.serverAddr = config.serverAddr;
    state.frp.remotePort = config.remotePort;
    state.frp.publicAddress = null;

    addLog(
      "frp",
      "info",
      `FRP attempt ${attempt}: ${path.basename(binary)}`
    );

    const child = spawn(binary, ["-c", FRP_CONFIG], {
      cwd: BASE_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    frpProcess = child;
    state.frp.pid = child.pid;

    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;

      try { child.kill(); } catch {}

      reject(
        new Error(
          "FRP timeout: không nhận được start proxy success."
        )
      );
    }, 20000);

    const processLine = (stream, data) => {
      const text = stripAnsi(data.toString());
      addLog("frp", stream, text);

      if (text.toLowerCase().includes("start proxy success")) {
        state.frp.successSeen = true;
        state.frp.ready = true;
        state.frp.status = "ready";
        state.frp.publicAddress =
          `${config.serverAddr}:${config.remotePort}`;
        state.frp.running = true;
        state.frp.error = null;

        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(true);
        }
      }
    };

    child.stdout.on("data", (data) => processLine("stdout", data));
    child.stderr.on("data", (data) => processLine("stderr", data));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      if (frpProcess === child) frpProcess = null;
      if (state.frp.successSeen) return;

      state.frp.running = false;
      state.frp.ready = false;
      state.frp.pid = null;

      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `FRP exited. code=${code}, signal=${signal || "none"}`
          )
        );
      }
    });
  });
}

async function startFrpWithRetries(generation) {
  const config = await readFrpConfig();
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (generation !== runGeneration) return;
    if (!state.minecraft.ready) return;

    try {
      await startFrpAttempt(generation, attempt, config);

      if (state.frp.successSeen) {
        addLog(
          "frp",
          "info",
          `FRP READY: ${state.frp.publicAddress}`
        );
        return;
      }
    } catch (error) {
      state.frp.error = error.message;
      state.frp.status = "error";
      state.frp.running = false;
      state.frp.ready = false;
      state.frp.publicAddress = null;

      addLog(
        "frp",
        "error",
        `FRP attempt ${attempt} failed: ${error.message}`
      );

      killFrpProcess();

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  addLog(
    "frp",
    "error",
    "FRP đã thử 3 lần nhưng không nhận được start proxy success."
  );
}

/* =========================================================
   STOP
========================================================= */

async function stopMinecraftOnly() {
  const child = minecraftProcess;

  if (!child) {
    state.minecraft.running = false;
    state.minecraft.ready = false;
    state.minecraft.pid = null;
    resetStartupCompleted();
    return;
  }

  try {
    if (child.stdin && child.stdin.writable) {
      child.stdin.write("stop\n");
    }
  } catch {}

  await new Promise((resolve) => setTimeout(resolve, 5000));

  if (minecraftProcess === child) {
    try { child.kill(); } catch {}
  }

  minecraftProcess = null;

  state.minecraft.running = false;
  state.minecraft.ready = false;
  state.minecraft.pid = null;
  state.minecraft.status = "stopped";

  resetStartupCompleted();

  setMinecraftProgress(0, "");
}

async function stopAll() {
  runGeneration++;

  killFrpProcess();
  frpProcess = null;

  state.frp.running = false;
  state.frp.ready = false;
  state.frp.status = "stopped";
  state.frp.pid = null;
  state.frp.publicAddress = null;

  await stopMinecraftOnly();

  state.minecraft.status = "stopped";
  state.minecraft.error = null;

  resetStartupCompleted();

  addLog("panel", "info", "Đã stop Minecraft và FRP.");
}

/* =========================================================
   UPLOAD FOLDER
========================================================= */

app.post(
  "/api/upload-folder",
  upload.array("files", 50000),
  async (req, res) => {
    const files = req.files || [];

    try {
      if (state.minecraft.running || minecraftProcess) {
        throw new Error(
          "Hãy Stop Minecraft trước khi upload server mới."
        );
      }

      if (!files.length) {
        throw new Error("Folder upload không có file.");
      }

      addLog(
        "upload",
        "info",
        `Bắt đầu upload ${files.length} file...`
      );

      state.mode = "upload";

      addLog(
        "upload",
        "info",
        "Đang xóa toàn bộ folder minecraft/ cũ..."
      );

      await clearDirectoryContents(MINECRAFT_DIR);

      addLog(
        "upload",
        "info",
        "Đã xóa sạch folder minecraft/ cũ."
      );

      let copied = 0;

      for (const file of files) {
        const relative = normalizeUploadPath(file.originalname);
        const destination = safeJoin(MINECRAFT_DIR, relative);

        await fs.promises.mkdir(path.dirname(destination), {
          recursive: true
        });

        await fs.promises.copyFile(file.path, destination);

        copied++;

        if (copied % 20 === 0 || copied === files.length) {
          const progress = Math.round(
            (copied / files.length) * 100
          );

          setMinecraftProgress(
            progress,
            `Đang upload server... ${progress}%`
          );
        }
      }

      const jar = findServerJar();

      if (!jar) {
        throw new Error(
          "Upload xong nhưng không tìm thấy file .jar trong folder server."
        );
      }

      state.minecraft.jar = path.relative(BASE_DIR, jar);
      state.minecraft.hasServer = true;

      await updateServerProperties();
      await ensureEula();

      state.minecraft.status = "stopped";
      state.minecraft.running = false;
      state.minecraft.ready = false;
      state.minecraft.pid = null;

      resetStartupCompleted();

      setMinecraftProgress(100, "Upload hoàn tất");

      addLog(
        "upload",
        "info",
        `Upload hoàn tất: ${copied} file.`
      );

      addLog(
        "upload",
        "info",
        `Server JAR: ${path.basename(jar)}`
      );

      res.json({
        ok: true,
        message: "Upload folder thành công.",
        files: copied,
        jar: path.relative(BASE_DIR, jar),
        hasServer: true
      });
    } catch (error) {
      addLog("upload", "error", error.message);
      setMinecraftProgress(0, "Upload thất bại");
      res.status(400).json({ ok: false, error: error.message });
    } finally {
      await cleanupUploadedTempFiles(files);
    }
  }
);

/* =========================================================
   DELETE FOLDER
========================================================= */

app.post("/api/delete-folder", async (req, res) => {
  try {
    if (state.minecraft.running || minecraftProcess) {
      throw new Error(
        "Hãy Stop Minecraft trước khi xóa folder."
      );
    }

    addLog("delete", "info", "Đang xóa folder minecraft/...");

    const deleted = await clearDirectoryContents(MINECRAFT_DIR);

    state.minecraft.status = "stopped";
    state.minecraft.running = false;
    state.minecraft.ready = false;
    state.minecraft.pid = null;
    state.minecraft.jar = null;
    state.minecraft.error = null;
    state.minecraft.hasServer = false;

    resetStartupCompleted();

    setMinecraftProgress(0, "");

    addLog(
      "delete",
      "info",
      `Đã xóa ${deleted} mục trong folder minecraft/.`
    );

    res.json({
      ok: true,
      deleted,
      hasServer: false,
      message: "Xóa folder thành công."
    });
  } catch (error) {
    addLog("delete", "error", error.message);
    res.status(400).json({ ok: false, error: error.message });
  }
});

/* =========================================================
   API
========================================================= */

app.get("/api/status", (req, res) => {
  refreshHasServerFlag();

  res.json({
    mode: state.mode,
    minecraft: { ...state.minecraft },
    frp: { ...state.frp }
  });
});

app.get("/api/logs", (req, res) => {
  res.json({ logs: state.logs });
});

app.get("/api/mode", (req, res) => {
  res.json({ mode: state.mode });
});

app.post("/api/mode", async (req, res) => {
  try {
    if (state.minecraft.running || minecraftProcess) {
      throw new Error(
        "Không thể đổi mode khi Minecraft đang chạy."
      );
    }

    const mode = req.body?.mode;

    if (mode !== "auto" && mode !== "upload") {
      throw new Error("Mode không hợp lệ.");
    }

    state.mode = mode;

    refreshHasServerFlag();

    addLog("panel", "info", `Đã chuyển sang mode: ${mode}`);

    res.json({
      ok: true,
      mode,
      hasServer: state.minecraft.hasServer
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/start", async (req, res) => {
  try {
    await startMinecraft();
    res.json({ ok: true });
  } catch (error) {
    addLog("panel", "error", error.message);
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/stop", async (req, res) => {
  try {
    await stopAll();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/restart", async (req, res) => {
  try {
    if (state.mode === "upload") {
      const hasJar = refreshHasServerFlag();

      if (!hasJar) {
        throw new Error(
          "Vui lòng upload folder Minecraft trước khi Restart server."
        );
      }
    }

    await stopAll();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await startMinecraft();
    res.json({ ok: true });
  } catch (error) {
    addLog("panel", "error", error.message);
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/command", (req, res) => {
  const command = String(req.body?.command || "").trim();

  if (!command) {
    res.status(400).json({ ok: false, error: "Command trống." });
    return;
  }

  if (!minecraftProcess || !state.minecraft.running) {
    res.status(400).json({ ok: false, error: "Minecraft chưa chạy." });
    return;
  }

  try {
    minecraftProcess.stdin.write(command + "\n");
    addLog("minecraft", "command", `> ${command}`);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

/* =========================================================
   STATIC — có chống cache cho index.html
========================================================= */

app.use(
  express.static(PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
      );
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  })
);

app.get("/", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({
      ok: false,
      error: `Upload error: ${error.message}`
    });
    return;
  }

  console.error(error);

  res.status(500).json({
    ok: false,
    error: error.message || "Internal server error"
  });
});

/* =========================================================
   START SERVER
========================================================= */

async function main() {
  await ensureDirectories();

  /* ⭐ XÓA FILE config.json CŨ NẾU CÒN */
  await removeOldConfig();

  /* ⭐ FORCE AUTO MODE KHI BOOT */
  state.mode = "auto";

  refreshHasServerFlag();

  addLog(
    "panel",
    "info",
    `Minecraft Panel đang chạy mode: ${state.mode}`
  );

  app.listen(PORT, HOST, () => {
    console.log("========================================");
    console.log(`Minecraft Panel: http://${HOST}:${PORT}`);
    console.log(`mode = ${state.mode}`);
    console.log(`hasServer = ${state.minecraft.hasServer}`);
    console.log("========================================");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await stopAll();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await stopAll();
  process.exit(0);
});