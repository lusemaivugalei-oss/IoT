const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { logReading } = require("./logger");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DASHBOARD_ORIGIN = "https://lusemaivugalei-oss.github.io";
const configuredToken = process.env.ESP32_INGEST_TOKEN || "";
const ESP32_INGEST_TOKEN = configuredToken.length >= 32
    ? configuredToken
    : crypto.randomBytes(32).toString("hex");
const PUBLIC_FILES = new Set([
    "api.js",
    "index.html",
    "iot.html",
    "login.html",
    "microgrid-icon-192.png",
    "microgrid-icon-512.png",
    "microgrid-icon.svg",
    "sw.js"
]);
// Pages that only the signed-in admin may open.
const ADMIN_FILES = new Set(["index.html", "iot.html"]);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const configuredPassword = process.env.ADMIN_PASSWORD || "";
const ADMIN_PASSWORD = configuredPassword
    ? configuredPassword
    : crypto.randomBytes(9).toString("base64url");
const SESSION_COOKIE = "microgrid_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 60 * 1000;
// session id -> expiry time; only one admin account exists
const sessions = new Map();
// client address -> { failures, lockedUntil }
const loginAttempts = new Map();
let latestReading;
// Recent readings so any device sees full graphs as soon as it opens the dashboard.
const HISTORY_WINDOW_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 300;
let readingHistory = [];
// requested: what the dashboard asked for; state: what the ESP32 last reported (null = unknown)
const RELAY_STATES = ["open", "closed"];
const relay = { requested: null, state: null };

if (!configuredToken || configuredToken.length < 32) {
    console.warn("ESP32_INGEST_TOKEN was missing or too short; using a generated local-only token. Set it explicitly to keep the token stable across restarts.");
    console.warn(`Current ingest token: ${ESP32_INGEST_TOKEN}`);
}
if (!configuredPassword) {
    console.warn("ADMIN_PASSWORD was not set; using a generated password. Set it explicitly to keep the login stable across restarts.");
    console.warn(`Admin login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
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
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ngrok-skip-browser-warning");
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

function isLoopbackAddress(address) {
    return address === "::1" ||
        address === "127.0.0.1" ||
        address?.startsWith("::ffff:127.");
}

// True only for a program on this PC talking to the server directly. Tunnels
// such as ngrok connect from 127.0.0.1 too, so forwarded requests and
// non-localhost Host names are rejected as well.
function isLocalRequest(req) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
    if (req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] ||
        req.headers.forwarded || req.headers["x-real-ip"]) return false;
    const hostname = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

// Address used for login lockouts. Behind ngrok every request comes from
// 127.0.0.1, so use the visitor address the tunnel appends instead.
function clientAddress(req) {
    const address = req.socket.remoteAddress || "unknown";
    const forwardedFor = req.headers["x-forwarded-for"];
    if (!isLoopbackAddress(address) || !forwardedFor) return address;
    return String(forwardedFor).split(",").pop().trim() || address;
}

function validIngestToken(req) {
    const authorization = req.headers.authorization || "";
    const providedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const expected = Buffer.from(ESP32_INGEST_TOKEN);
    const provided = Buffer.from(providedToken);
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function sameSecret(expectedValue, providedValue) {
    // Hash first so the comparison takes the same time whatever the lengths.
    const expected = crypto.createHash("sha256").update(String(expectedValue)).digest();
    const provided = crypto.createHash("sha256").update(String(providedValue)).digest();
    return crypto.timingSafeEqual(expected, provided);
}

// The session comes from the cookie (pages served by this server) or from a
// bearer token (the GitHub Pages dashboard, where cross-site cookies are blocked).
function readSessionId(req) {
    const authorization = req.headers.authorization || "";
    if (authorization.startsWith("Bearer ")) return authorization.slice(7);
    for (const part of (req.headers.cookie || "").split(";")) {
        const [name, ...value] = part.trim().split("=");
        if (name === SESSION_COOKIE) return value.join("=");
    }
    return "";
}

function isAdmin(req) {
    const sessionId = readSessionId(req);
    const expiresAt = sessions.get(sessionId);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
        sessions.delete(sessionId);
        return false;
    }
    return true;
}

function sessionCookie(req, value, maxAgeSeconds) {
    const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function redirect(res, location) {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
    res.end();
}

// Checks the admin username and password in a request body, counting failures
// towards the lockout. Returns null when they match, otherwise the error to send.
function credentialFailure(req, body, purpose) {
    const client = clientAddress(req);
    const attempt = loginAttempts.get(client) || { failures: 0, lockedUntil: 0 };
    if (attempt.lockedUntil > Date.now()) {
        const wait = Math.ceil((attempt.lockedUntil - Date.now()) / 1000);
        return { status: 429, error: `Too many failed attempts. Try again in ${wait}s.` };
    }
    const usernameOk = sameSecret(ADMIN_USERNAME, body?.username ?? "");
    const passwordOk = sameSecret(ADMIN_PASSWORD, body?.password ?? "");
    if (!usernameOk || !passwordOk) {
        attempt.failures += 1;
        if (attempt.failures >= LOGIN_MAX_FAILURES) {
            attempt.failures = 0;
            attempt.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
        }
        loginAttempts.set(client, attempt);
        console.warn(`Failed admin ${purpose} from ${client}`);
        return { status: 401, error: "Incorrect username or password" };
    }
    loginAttempts.delete(client);
    return null;
}

async function handleLogin(req, res) {
    const client = clientAddress(req);
    if (!req.headers["content-type"]?.startsWith("application/json")) {
        return sendText(res, 415, "Expected application/json");
    }
    let body;
    try {
        body = await readJsonBody(req);
    } catch (error) {
        return sendText(res, error.statusCode || 400, "Invalid login request");
    }

    const failure = credentialFailure(req, body, "login");
    if (failure) return sendJson(res, failure.status, { error: failure.error });

    for (const [id, expiresAt] of sessions) if (expiresAt < Date.now()) sessions.delete(id);
    const sessionId = crypto.randomBytes(32).toString("hex");
    sessions.set(sessionId, Date.now() + SESSION_TTL_MS);
    console.log(`Admin signed in from ${client}`);
    return sendJson(res, 200, { signedIn: true, token: sessionId }, {
        "Set-Cookie": sessionCookie(req, sessionId, SESSION_TTL_MS / 1000)
    });
}

function handleLogout(req, res) {
    sessions.delete(readSessionId(req));
    return sendJson(res, 200, { signedIn: false }, { "Set-Cookie": sessionCookie(req, "", 0) });
}

async function storeReading(req, res) {
    if (!req.headers["content-type"]?.startsWith("application/json")) {
        return sendText(res, 415, "Expected application/json");
    }

    let reading;
    try {
        reading = await readJsonBody(req);
    } catch (error) {
        return sendText(res, error.statusCode || 400, "Invalid sensor upload");
    }

    const fields = ["voltage", "current", "voltage32", "current33", "soc"];
    const validReading = fields.every((field, index) =>
        Number.isFinite(reading?.[field]) || reading?.[field] === null ||
        (index > 1 && !Object.hasOwn(reading || {}, field))
    );
    const hasReading = fields.some(field => Number.isFinite(reading?.[field]));
    if (!validReading || !hasReading) {
        return sendJson(res, 400, { error: "At least one sensor reading must be a finite number; unavailable readings must be null" });
    }

    latestReading = {
        voltage: Number.isFinite(reading.voltage) ? reading.voltage : null,
        current: Number.isFinite(reading.current) ? reading.current : null,
        voltage32: Number.isFinite(reading.voltage32) ? reading.voltage32 : null,
        current33: Number.isFinite(reading.current33) ? reading.current33 : null,
        soc: Number.isFinite(reading.soc) ? reading.soc : null,
        timestamp: Date.now()
    };
    readingHistory.push(latestReading);
    logReading(latestReading, relay.state);
    const oldest = latestReading.timestamp - HISTORY_WINDOW_MS;
    readingHistory = readingHistory.filter(entry => entry.timestamp >= oldest).slice(-HISTORY_LIMIT);
    return sendJson(res, 200, { accepted: true });
}

async function readRelayBody(req, res, allowNull) {
    if (!req.headers["content-type"]?.startsWith("application/json")) {
        sendText(res, 415, "Expected application/json");
        return undefined;
    }
    let body;
    try {
        body = await readJsonBody(req);
    } catch (error) {
        sendText(res, error.statusCode || 400, "Invalid relay request");
        return undefined;
    }
    if (!RELAY_STATES.includes(body?.state) && !(allowNull && body?.state === null)) {
        sendJson(res, 400, { error: 'state must be "open" or "closed"' });
        return undefined;
    }
    return body;
}

// Dashboard request to switch the relay; only from the dashboard opened on this
// computer or the GitHub Pages dashboard (through the tunnel), and the admin
// must re-enter their username and password each time.
async function handleRelayRequest(req, res) {
    const origin = req.headers.origin;
    const fromThisComputer = isLocalRequest(req) && (!origin || origin === `http://${req.headers.host}`);
    if (!fromThisComputer && origin !== DASHBOARD_ORIGIN) {
        return sendJson(res, 403, { error: "Load switching is allowed only from the microgrid dashboard" });
    }
    const body = await readRelayBody(req, res, false);
    if (body === undefined) return;
    const failure = credentialFailure(req, body, "relay confirmation");
    // 403 rather than 401 so the dashboard keeps the session and lets the admin retry.
    if (failure) return sendJson(res, failure.status === 401 ? 403 : failure.status, { error: failure.error });
    const { state } = body;
    relay.requested = state;
    console.log(`Dashboard requested relay ${state}`);
    return sendJson(res, 200, relay);
}

// BLE bridge report of the relay state confirmed by the ESP32.
async function handleRelayState(req, res) {
    if (!isLocalRequest(req)) {
        return sendJson(res, 403, { error: "Bluetooth bridge uploads are allowed only from this computer" });
    }
    const body = await readRelayBody(req, res, true);
    if (body === undefined) return;
    relay.state = body.state;
    return sendJson(res, 200, relay);
}

async function handleIngest(req, res) {
    if (!validIngestToken(req)) return sendJson(res, 401, { error: "Invalid ingest token" });
    return storeReading(req, res);
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
    if (pathname === "/api/ble-ingest") {
        if (!isLocalRequest(req)) {
            return sendJson(res, 403, { error: "Bluetooth bridge uploads are allowed only from this computer" });
        }
        return req.method === "POST" ? storeReading(req, res) : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/login") {
        return req.method === "POST" ? handleLogin(req, res) : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/logout") {
        return req.method === "POST" ? handleLogout(req, res) : sendText(res, 405, "Method Not Allowed");
    }
    // The BLE bridge on this PC polls the requested relay state without a login.
    const bridgeRelayPoll = pathname === "/api/relay" && req.method === "GET" && isLocalRequest(req) && !req.headers.origin;
    if (["/api/relay", "/api/data", "/api/history"].includes(pathname) && !isAdmin(req) && !bridgeRelayPoll) {
        return sendJson(res, 401, { error: "Sign in as admin to view the dashboard" });
    }
    if (pathname === "/api/relay") {
        if (req.method === "GET") return sendJson(res, 200, relay);
        return req.method === "POST" ? handleRelayRequest(req, res) : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/relay-state") {
        return req.method === "POST" ? handleRelayState(req, res) : sendText(res, 405, "Method Not Allowed");
    }
    if (pathname === "/api/history") {
        if (req.method !== "GET") return sendText(res, 405, "Method Not Allowed");
        const oldest = Date.now() - HISTORY_WINDOW_MS;
        return sendJson(res, 200, readingHistory.filter(entry => entry.timestamp >= oldest));
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
    if (ADMIN_FILES.has(relativePath) && !isAdmin(req)) return redirect(res, "/login.html");

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