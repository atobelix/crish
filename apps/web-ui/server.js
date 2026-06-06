const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");

const PORT = process.env.PORT || 3001;
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf"
};

function loadConfig() {
    try {
        const raw = fs.readFileSync(path.join(__dirname, "config.json"), "utf-8");
        return JSON.parse(raw);
    } catch {
        return { api: { baseUrl: "https://token-plan-cn.xiaomimimo.com", token: "", model: "mimo-v2.5" } };
    }
}

function serveStatic(filePath, res) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("404 Not Found");
            return;
        }
        res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": ext === ".json" ? "no-cache" : "public, max-age=3600",
            "Access-Control-Allow-Origin": "*"
        });
        res.end(data);
    });
}

function proxyApiRequest(req, res, body) {
    const config = loadConfig();
    const baseUrl = (config.api && config.api.baseUrl) || "https://token-plan-cn.xiaomimimo.com";
    const token = (config.api && config.api.token) || "";

    const targetUrl = new URL(req.url.replace(/^\/api/, ""), baseUrl);

    const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Authorization": "Bearer " + token,
            "api-key": token
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
            "Content-Type": proxyRes.headers["content-type"] || "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
        });
        proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
        console.error("[proxy error]", err.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "proxy_error", message: err.message }));
    });

    if (body.length > 0) {
        proxyReq.write(body);
    }
    proxyReq.end();
}

const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, api-key",
            "Access-Control-Max-Age": "86400"
        });
        res.end();
        return;
    }

    if (req.url.startsWith("/api/")) {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            proxyApiRequest(req, res, body);
        });
        return;
    }

    let filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);
    filePath = path.normalize(filePath);

    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("403 Forbidden");
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            filePath = path.join(__dirname, "index.html");
        }
        serveStatic(filePath, res);
    });
});

server.listen(PORT, () => {
    console.log("Crish UI Dev Server running at http://localhost:" + PORT);
    console.log("API proxy: /api/* -> " + (loadConfig().api || {}).baseUrl);
});
