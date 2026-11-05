import http from "node:http";
import fs from "node:fs";
import { loadConfig } from "./dist/config.js";
import { createServer } from "./dist/server.js";
import { createMcpHandler } from "@modelcontextprotocol/server";

// Guard against unhandled socket timeouts (e.g. imap connection idle drops)
process.on("uncaughtException", (err) => {
  console.error("imap-mcp: uncaught exception (handled):", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("imap-mcp: unhandled rejection at:", promise, "reason:", reason);
});

if (!process.env.IMAP_PASSWORD) {
  const possiblePaths = ["/config/password", "./config/password", "password"];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      process.env.IMAP_PASSWORD = fs.readFileSync(p, "utf-8").trim();
      break;
    }
  }
}

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const PORT = parseInt(process.env.PORT || "8087", 10);
const HOST = process.env.HOST || "0.0.0.0";

const config = loadConfig();
if (config.imap.insecureTls) {
  console.error("imap-mcp: IMAP_INSECURE_TLS=true — certificate validation is disabled");
}
if (config.readOnly) {
  console.error("imap-mcp: IMAP_READ_ONLY is not false — mailbox write tools are not registered");
}

const handler = createMcpHandler(() => createServer(config), { responseMode: "json" });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  let pathname = url.pathname;
  let pathHasToken = false;
  if (AUTH_TOKEN) {
    const tokenPrefix = `/${AUTH_TOKEN}`;
    if (pathname === tokenPrefix || pathname.startsWith(`${tokenPrefix}/`)) {
      pathHasToken = true;
      pathname = pathname.slice(tokenPrefix.length) || "/";
    }
    const authHeader = req.headers["authorization"];
    const queryToken = url.searchParams.get("token");
    if (authHeader !== `Bearer ${AUTH_TOKEN}` && queryToken !== AUTH_TOKEN && !pathHasToken) {
      res.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": "Bearer",
      });
      res.end("Unauthorized\n");
      return;
    }
  }

  // Support /, /mcp, and /sse
  if (pathname !== "/mcp" && pathname !== "/" && pathname !== "" && pathname !== "/sse") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found\n");
    return;
  }

  // Health check on GET without event-stream
  if (req.method === "GET" && !req.headers.accept?.includes("text/event-stream")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", service: "ufsc-imap-mcp" }));
    return;
  }

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else if (value !== undefined) {
        headers.set(key, value);
      }
    }

    const init = {
      method: req.method,
      headers,
    };
    if (req.method !== "GET" && req.method !== "HEAD" && body.length > 0) {
      init.body = body;
    }

    const webRequest = new Request(url.href, init);
    const webResponse = await handler.fetch(webRequest);

    const resHeaders = {};
    for (const [k, v] of webResponse.headers.entries()) {
      resHeaders[k] = v;
    }

    // For POST requests where legacy fallback wrapped a single JSON-RPC response in text/event-stream,
    // unwrap and return direct application/json for instant delivery without SSE buffering.
    if (req.method === "POST" && (resHeaders["content-type"] || "").includes("text/event-stream") && webResponse.body) {
      const text = await webResponse.text();
      const dataLines = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6).trim())
        .filter(Boolean);
      if (dataLines.length === 1) {
        const jsonPayload = Buffer.from(dataLines[0], "utf-8");
        resHeaders["content-type"] = "application/json; charset=utf-8";
        resHeaders["content-length"] = String(jsonPayload.length);
        res.writeHead(webResponse.status, resHeaders);
        res.end(jsonPayload);
        return;
      }
      resHeaders["x-accel-buffering"] = "no";
      res.writeHead(webResponse.status, resHeaders);
      res.end(text);
      return;
    }

    if ((resHeaders["content-type"] || "").includes("text/event-stream")) {
      resHeaders["x-accel-buffering"] = "no";
    }
    res.writeHead(webResponse.status, resHeaders);

    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      res.end();
    }
  } catch (err) {
    console.error("imap-mcp-http: error handling request:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error\n");
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`UFSC IMAP MCP HTTP Server listening on ${HOST}:${PORT}`);
  if (AUTH_TOKEN) {
    console.log("Bearer authentication enabled");
  }
});

const shutdown = async () => {
  console.log("Shutting down UFSC IMAP MCP server...");
  server.close(async () => {
    await handler.close();
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
