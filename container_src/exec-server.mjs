// ---------------------------------------------------------------------------
// Lightweight command execution server for the IDE file explorer.
//
// Runs on port 8081 inside the container. Only accessible from the Worker
// via containerFetch (not exposed to the internet).
//
// POST /exec  { cmd: "ls -la /workspace" }  → stdout as text/plain
// GET  /health → { ok: true }
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { exec } from "node:child_process";

const PORT = 8081;
const MAX_OUTPUT = 512 * 1024; // 512 KB max output

const server = createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Execute command
  if (req.method === "POST" && req.url === "/exec") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { cmd } = JSON.parse(body);
        if (!cmd || typeof cmd !== "string") {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("cmd required");
          return;
        }

        exec(cmd, {
          cwd: "/workspace",
          maxBuffer: MAX_OUTPUT,
          timeout: 10000, // 10 second timeout
          env: { ...process.env, HOME: process.env.HOME || "/home/coder" },
        }, (error, stdout, stderr) => {
          // Return stdout even if there was an error (partial output)
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(stdout || stderr || "");
        });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid JSON body");
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[exec-server] Listening on 127.0.0.1:${PORT}`);
});
