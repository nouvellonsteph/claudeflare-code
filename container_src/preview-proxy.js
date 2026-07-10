// ---------------------------------------------------------------------------
// Preview proxy for the Claudeflare Code IDE.
// Runs inside the container on port 8083.
//
// Reverse-proxies requests to a user's dev server running on a configurable
// port (default 3000). The target port can be changed via:
//   POST /api/preview/port  { "port": 5173 }
//   GET  /api/preview/port  → { "port": 3000 }
//
// All other requests are proxied to http://localhost:<target-port>
// ---------------------------------------------------------------------------

const http = require("http");

const PROXY_PORT = 8083;
let targetPort = 3000;

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PROXY_PORT}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    return res.end();
  }

  // --- Get current target port ---
  if (url.pathname === "/api/preview/port" && req.method === "GET") {
    return sendJson(res, 200, { port: targetPort });
  }

  // --- Set target port ---
  if (url.pathname === "/api/preview/port" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const newPort = parseInt(data.port, 10);
        if (isNaN(newPort) || newPort < 1 || newPort > 65535) {
          return sendJson(res, 400, { error: "Invalid port" });
        }
        targetPort = newPort;
        console.log(`[preview-proxy] Target port changed to ${targetPort}`);
        return sendJson(res, 200, { port: targetPort });
      } catch (err) {
        return sendJson(res, 400, { error: "Invalid JSON" });
      }
    });
    return;
  }

  // --- Health ---
  if (url.pathname === "/api/preview/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "preview-proxy",
      targetPort,
    });
  }

  // --- Proxy everything else to the target dev server ---
  const proxyOptions = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${targetPort}`,
    },
  };

  const proxyReq = http.request(proxyOptions, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", () => {
    // Dev server not running yet — show a helpful placeholder
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html>
<head><style>
  body { background: #0d1117; color: #8b949e; font-family: monospace;
         display: flex; align-items: center; justify-content: center;
         height: 100vh; margin: 0; text-align: center; }
  .box { max-width: 400px; }
  h2 { color: #c9d1d9; margin-bottom: 12px; }
  code { background: #161b22; padding: 2px 8px; border-radius: 4px; color: #f6821f; }
  .port { color: #58a6ff; font-size: 24px; font-weight: bold; }
</style></head>
<body>
<div class="box">
  <div class="port">:${targetPort}</div>
  <h2>No dev server detected</h2>
  <p>Start a dev server in the auxiliary terminal, e.g.:</p>
  <p><code>npm run dev</code></p>
  <p><code>python -m http.server ${targetPort}</code></p>
  <p style="margin-top:16px;font-size:12px;color:#484f58">
    Change the preview port with the port selector above.
  </p>
</div>
</body></html>`);
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`[preview-proxy] Listening on :${PROXY_PORT} → localhost:${targetPort}`);
});
