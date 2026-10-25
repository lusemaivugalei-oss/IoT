// Cloudflare tunnel for the GitHub Pages dashboard
// ---------------------------------------------------------------
// Starts a free Cloudflare tunnel to the local dashboard server
// (http://localhost:3000). The free tunnel gets a new address every
// time it starts, so when the address changes this script writes it
// into api.js and pushes it to GitHub, which redeploys the GitHub
// Pages dashboard (about 30 seconds later).
//
// Run it in a second terminal, while "npm start" is running:
//     npm run tunnel
// Stop it with Ctrl+C.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const API_FILE = path.join(__dirname, "api.js");
const TUNNEL_LINE = /^const TUNNEL_API = ".*";$/m;
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function git(...args) { return execFileSync("git", args, { cwd: __dirname, stdio: "pipe" }).toString(); }

function publishTunnelUrl(url) {
    const source = fs.readFileSync(API_FILE, "utf8");
    if (!TUNNEL_LINE.test(source)) return console.error("[tunnel] Could not find TUNNEL_API in api.js; update it by hand.");
    if (source.includes(`"${url}"`)) return console.log("[tunnel] api.js already uses this address; nothing to publish.");
    fs.writeFileSync(API_FILE, source.replace(TUNNEL_LINE, `const TUNNEL_API = "${url}";`));
    try {
        // --only commits api.js alone, leaving any other work in progress untouched.
        git("commit", "--only", "api.js", "-m", `Point GitHub Pages dashboard at tunnel ${url}`);
        git("push", "origin", "HEAD:main");
        console.log("[tunnel] Pushed new address to GitHub; the online dashboard updates in about 30 seconds.");
    } catch (error) {
        console.error(`[tunnel] api.js updated, but publishing to GitHub failed; commit and push it by hand.\n${error.stderr || error.message}`);
    }
}

const cloudflared = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", "http://localhost:3000"], { stdio: ["ignore", "inherit", "pipe"] });
let published = false;
cloudflared.stderr.on("data", chunk => {
    process.stderr.write(chunk);
    const match = !published && chunk.toString().match(TUNNEL_URL);
    if (!match) return;
    published = true;
    console.log(`[tunnel] Dashboard server is public at ${match[0]}`);
    publishTunnelUrl(match[0]);
});
cloudflared.on("error", error => {
    console.error(error.code === "ENOENT" ? "[tunnel] cloudflared is not installed; run: winget install Cloudflare.cloudflared" : error);
    process.exit(1);
});
cloudflared.on("exit", code => process.exit(code ?? 0));
process.on("SIGINT", () => cloudflared.kill());
