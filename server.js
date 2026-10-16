const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DASHBOARD_ORIGIN = "https://lusemaivugalei-oss.github.io";
const ESP32_INGEST_TOKEN = process.env.ESP32_INGEST_TOKEN || "";
const PUBLIC_FILES = new Set(["index.html", "iot.html", "manifest.webmanifest", "sw.js"]);
let latestReading;

if (ESP32_INGEST_TOKEN.length < 32) {
    console.error("Set ESP32_INGEST_TOKEN to a random value of at least 32 characters before starting the server.");
    process.exit(1);
}

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav"
};

function sendText(res, code, message) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
}

function sendJson(res, code, value, headers = {}) {
    res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers
    });
    res.end(JSON.stringify(value));
}

function applyCors(req, res) {
    res.setHeader("Vary", "Origin");
    if (req.headers.origin === DASHBOARD_ORIGIN) {
        res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
}

async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) {
            const error = new Error("Request body too large");
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validIngestToken(req) {
    const authorization = req.headers.authorization || "";
    const providedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const expected = Buffer.from(ESP32_INGEST_TOKEN);
    const provided = Buffer.from(providedToken);
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

async function handleIngest(req, res) {
    if (!validIngestToken(req)) return sendJson(res, 401, { error: "Invalid ingest token" });
    if (!req.headers["content-type"]?.startsWith("application/json")) {
        return sendText(res, 415, "Expected application/json");
    }

    let reading;
    try {
        reading = await readJsonBody(req);
    } catch (error) {
        return sendText(res, error.statusCode || 400, "Invalid sensor upload");
    }

    if (!Number.isFinite(reading?.voltage) || !Number.isFinite(reading?.current)) {
        return sendJson(res, 400, { error: "Voltage and current must be finite numbers" });
    }

    latestReading = {
        voltage: reading.voltage,
        current: reading.current,
        timestamp: Date.now()
    };
    return sendJson(res, 200, { accepted: true });
}

async function handleRequest(req, res) {
    applyCors(req, res);

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname);
    } catch {
        return sendText(res, 400, "Bad Request");
    }

    if (pathname.startsWith("/api/") && req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }
    if (pathname === "/api/health") {
        return req.method === "GET"
            ? sendJson(res, 200, { status: "ok", hasReading: Boolean(latestReading) })
            : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/ingest") {
        return req.method === "POST" ? handleIngest(req, res) : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/data") {
        if (req.method !== "GET") return sendText(res, 405, "Method Not Allowed");
        if (!latestReading) return sendJson(res, 503, { error: "No sensor reading has been received yet" });
        return sendJson(res, 200, latestReading);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
        return sendText(res, 405, "Method Not Allowed");
    }

    const relativePath = pathname === "/" ? "iot.html" : pathname.replace(/^\/+/, "");
    if (!PUBLIC_FILES.has(relativePath)) return sendText(res, 404, "Not Found");

    const filePath = path.resolve(ROOT, relativePath);
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            if (err && err.code !== "ENOENT") console.error(`Could not inspect ${filePath}:`, err);
            return sendText(res, 404, "Not Found");
        }

        res.writeHead(200, {
            "Content-Type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
            "Cache-Control": "no-cache"
        });
        if (req.method === "HEAD") return res.end();

        const fileStream = fs.createReadStream(filePath);
        fileStream.on("error", streamError => {
            console.error(`Could not read ${filePath}:`, streamError);
            if (!res.headersSent) sendText(res, 500, "Internal Server Error");
            else res.destroy();
        });
        fileStream.pipe(res);
    });
}

const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
        console.error("Request failed:", error);
        if (!res.headersSent) sendText(res, 500, "Internal Server Error");
        else res.destroy();
    });
});

server.on("clientError", (error, socket) => {
    console.error("HTTP client error:", error.message);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.on("error", error => {
    if (error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. Stop the other server and try again.`);
    } else {
        console.error("Server error:", error);
    }
    process.exitCode = 1;
});

server.listen({ port: PORT, host: "::", ipv6Only: false }, () => {
    console.log(`API listening on port ${PORT}`);
});