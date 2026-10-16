const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const ESP32_INGEST_TOKEN = process.env.ESP32_INGEST_TOKEN || "";
const SESSION_COOKIE = "microgrid_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PUBLIC_FILES = new Set(["index.html", "iot.html", "manifest.webmanifest", "sw.js", "alarm.mp3"]);
const sessions = new Map();
let latestReading;
let authorizedUsers;

try {
    const configuredUsers = JSON.parse(process.env.MICROGRID_USERS_JSON || "null");
    if (!configuredUsers || typeof configuredUsers !== "object" || Array.isArray(configuredUsers)) {
        throw new Error();
    }
    const entries = Object.entries(configuredUsers);
    if (!entries.length || entries.some(([username, password]) => !username.trim() || typeof password !== "string" || !password)) {
        throw new Error();
    }
    authorizedUsers = new Map(entries);
} catch {
    console.error('Set MICROGRID_USERS_JSON to a JSON object of authorized usernames and passwords, e.g. {"user":"strong-password"}.');
    process.exit(1);
}

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

function getSessionToken(req) {
    const cookie = (req.headers.cookie || "")
        .split(";")
        .map(value => value.trim())
        .find(value => value.startsWith(`${SESSION_COOKIE}=`));
    return cookie ? cookie.slice(SESSION_COOKIE.length + 1) : "";
}

function hasValidSession(req) {
    const token = getSessionToken(req);
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        sessions.delete(token);
        return false;
    }
    return true;
}

function secureCookie(req, value, maxAge) {
    const forwardedProtocol = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const secure = req.socket.encrypted || forwardedProtocol === "https";
    return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
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

function passwordMatches(expected, provided) {
    const expectedHash = crypto.createHash("sha256").update(expected).digest();
    const providedHash = crypto.createHash("sha256").update(provided).digest();
    return crypto.timingSafeEqual(expectedHash, providedHash);
}

async function handleLogin(req, res) {
    if (!req.headers["content-type"]?.startsWith("application/json")) {
        return sendText(res, 415, "Expected application/json");
    }

    let body;
    try {
        body = await readJsonBody(req);
    } catch (error) {
        return sendText(res, error.statusCode || 400, "Invalid login request");
    }

    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const expectedPassword = authorizedUsers.get(username);
    const validPassword = passwordMatches(expectedPassword || "invalid-user-password", password);
    if (!expectedPassword || !validPassword) {
        return sendJson(res, 401, { error: "Username or password is not authorised." });
    }

    const now = Date.now();
    for (const [token, expiresAt] of sessions) {
        if (expiresAt <= now) sessions.delete(token);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, now + SESSION_TTL_MS);
    return sendJson(res, 200, { authenticated: true }, {
        "Set-Cookie": secureCookie(req, token, SESSION_TTL_MS / 1000)
    });
}

function handleLogout(req, res) {
    sessions.delete(getSessionToken(req));
    return sendJson(res, 200, { authenticated: false }, {
        "Set-Cookie": secureCookie(req, "", 0)
    });
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
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname);
    } catch {
        return sendText(res, 400, "Bad Request");
    }

    if (pathname === "/api/login") {
        return req.method === "POST" ? handleLogin(req, res) : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/logout") {
        return req.method === "POST" ? handleLogout(req, res) : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/session") {
        return req.method === "GET"
            ? sendJson(res, 200, { authenticated: hasValidSession(req) })
            : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/health") {
        return req.method === "GET"
            ? sendJson(res, 200, { status: "ok" })
            : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/ingest") {
        return req.method === "POST" ? handleIngest(req, res) : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/data") {
        if (req.method !== "GET") return sendText(res, 405, "Method Not Allowed");
        if (!hasValidSession(req)) return sendJson(res, 401, { error: "Authentication required" });
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
            "Cache-Control": "no-store"
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