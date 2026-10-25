// Shared by the dashboard and sign-in pages. GitHub Pages only hosts the page,
// so there the API calls go to this PC's server through the Cloudflare tunnel
// (npm run tunnel). Its free address changes on every restart, so update it here.
const TUNNEL_API = "https://deposits-oscar-copies-dont.trycloudflare.com";
const API_BASE = location.hostname.endsWith("github.io") ? TUNNEL_API : "";
const SESSION_KEY = "microgridSession";

// The login is kept as a token rather than a cookie because browsers block
// cookies from the tunnel when the page itself is on github.io.
function getSessionToken() { try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; } }
function setSessionToken(token) { try { if (token) localStorage.setItem(SESSION_KEY, token); else localStorage.removeItem(SESSION_KEY); } catch {} }

function apiFetch(path, options = {}) {
    // Skips the ngrok "You are about to visit" page, which would break API calls.
    const headers = { "ngrok-skip-browser-warning": "1", ...options.headers };
    const token = getSessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(API_BASE + path, { cache: "no-store", ...options, headers });
}
