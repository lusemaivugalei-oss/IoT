// Shared by the dashboard and sign-in pages. GitHub Pages only hosts the page,
// so there the API calls go to this PC's server through the Cloudflare tunnel
// (npm run tunnel). Its free address changes on every restart; tunnel.js
// rewrites the line below and pushes it to GitHub automatically.
const TUNNEL_API = "https://peoples-yen-conclusions-swim.trycloudflare.com";
let API_BASE = location.hostname.endsWith("github.io") ? TUNNEL_API : "";
const SESSION_KEY = "microgridSession";

// The login is kept as a token rather than a cookie because browsers block
// cookies from the tunnel when the page itself is on github.io.
function getSessionToken() { try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; } }
function setSessionToken(token) { try { if (token) localStorage.setItem(SESSION_KEY, token); else localStorage.removeItem(SESSION_KEY); } catch {} }

// GitHub Pages lets browsers cache this file for 10 minutes, so after the
// tunnel restarts a page can still hold the old, dead address. On a failed
// request, read the current address from a fresh copy of this file.
async function refreshTunnelAddress() {
    try {
        const source = await (await fetch(`api.js?t=${Date.now()}`, { cache: "no-store" })).text();
        const match = source.match(/^const TUNNEL_API = "(.*)";$/m);
        if (!match || match[1] === API_BASE) return false;
        API_BASE = match[1];
        return true;
    } catch { return false; }
}

async function apiFetch(path, options = {}) {
    // Skips the ngrok "You are about to visit" page, which would break API calls.
    const headers = { "ngrok-skip-browser-warning": "1", ...options.headers };
    const token = getSessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const send = () => fetch(API_BASE + path, { cache: "no-store", ...options, headers });
    try {
        return await send();
    } catch (error) {
        if (API_BASE && await refreshTunnelAddress()) return send();
        throw error;
    }
}
