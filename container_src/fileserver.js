// ---------------------------------------------------------------------------
// Lightweight file-system browser API for the Claudeflare Code IDE.
// Runs inside the container on port 8082.
//
// Endpoints:
//   GET /api/files?path=/workspace         — list directory contents
//   GET /api/files/read?path=/workspace/x  — read file contents
//   GET /api/files/stat?path=/workspace/x  — stat a path
// ---------------------------------------------------------------------------

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8082;
const WORKSPACE = "/workspace";

// Security: only allow paths under /workspace
function safePath(requestedPath) {
  const resolved = path.resolve(requestedPath || WORKSPACE);
  if (!resolved.startsWith(WORKSPACE) && resolved !== "/home/coder") {
    return null;
  }
  return resolved;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    return res.end();
  }

  // --- List directory ---
  if (pathname === "/api/files" || pathname === "/api/files/") {
    const dirPath = safePath(url.searchParams.get("path") || WORKSPACE);
    if (!dirPath) return sendJson(res, 403, { error: "Forbidden path" });

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith(".") || e.name === ".claude")
        .map((e) => {
          const fullPath = path.join(dirPath, e.name);
          let size = 0;
          let mtime = null;
          try {
            const stat = fs.statSync(fullPath);
            size = stat.size;
            mtime = stat.mtime.toISOString();
          } catch {}
          return {
            name: e.name,
            path: fullPath,
            type: e.isDirectory() ? "directory" : "file",
            size,
            mtime,
          };
        })
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return sendJson(res, 200, { path: dirPath, entries: items });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }

  // --- Read file ---
  if (pathname === "/api/files/read") {
    const filePath = safePath(url.searchParams.get("path"));
    if (!filePath) return sendJson(res, 403, { error: "Forbidden path" });

    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return sendJson(res, 400, { error: "Cannot read directory" });
      }
      // Limit to 1MB for safety
      if (stat.size > 1024 * 1024) {
        return sendJson(res, 413, {
          error: "File too large (>1MB)",
          size: stat.size,
        });
      }
      const content = fs.readFileSync(filePath, "utf-8");
      return sendJson(res, 200, {
        path: filePath,
        content,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }

  // --- Stat path ---
  if (pathname === "/api/files/stat") {
    const targetPath = safePath(url.searchParams.get("path"));
    if (!targetPath) return sendJson(res, 403, { error: "Forbidden path" });

    try {
      const stat = fs.statSync(targetPath);
      return sendJson(res, 200, {
        path: targetPath,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        mode: stat.mode.toString(8),
      });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }

  // --- Health ---
  if (pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "fileserver" });
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[fileserver] Listening on :${PORT}`);
});
