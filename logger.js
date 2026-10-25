// Microgrid data logger
// ---------------------------------------------------------------
// The server (server.js) calls logReading() for every reading the
// ESP32 sends, so logging runs automatically whenever "npm start" is
// running. Readings are saved to a CSV file on your Desktop, with a
// new file each day. The CSV opens directly in Excel and loads into
// MATLAB with readtable().
//
// Options (environment variables or .env, optional):
//     LOG_DIR=C:\path\to\folder   save somewhere other than the Desktop
// ---------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");

const HEADER = [
    "Timestamp", "Unix_ms",
    "Solar_Voltage_V", "Solar_Current_A", "Solar_Power_W",
    "Battery_Voltage_V", "Battery_Current_A", "Battery_Power_W"
].join(",");

// ---------- where to save ----------
function findDesktop() {
    if (process.env.LOG_DIR) return process.env.LOG_DIR;
    const home = os.homedir();
    const candidates = [
        process.env.OneDrive && path.join(process.env.OneDrive, "Desktop"), // OneDrive-synced Desktop
        path.join(home, "OneDrive", "Desktop"),
        path.join(home, "Desktop")
    ].filter(Boolean);
    return candidates.find(dir => fs.existsSync(dir)) || home;
}
const LOG_DIR = findDesktop();
fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- helpers ----------
const pad = n => String(n).padStart(2, "0");
function localDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function localStamp(d) { return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function num(value, digits) { return Number.isFinite(value) ? value.toFixed(digits) : ""; }
function power(v, i) { return Number.isFinite(v) && Number.isFinite(i) ? v * i : NaN; }
function logFileFor(d) { return path.join(LOG_DIR, `microgrid_log_${localDate(d)}.csv`); }  // new file each day

// ---------- writing (survives the file being open in Excel) ----------
let pending = [];        // rows waiting to be written
let lockedWarned = false;
let rowsWritten = 0;

function flush() {
    if (!pending.length) return;
    // Group rows by day so a run across midnight starts a new file.
    const byFile = new Map();
    for (const row of pending) {
        if (!byFile.has(row.file)) byFile.set(row.file, []);
        byFile.get(row.file).push(row.line);
    }
    const stillPending = [];
    for (const [file, lines] of byFile) {
        try {
            const isNew = !fs.existsSync(file) || fs.statSync(file).size === 0;
            fs.appendFileSync(file, (isNew ? HEADER + "\r\n" : "") + lines.join("\r\n") + "\r\n");
            if (isNew) console.log(`Logger: saving readings to ${file}`);
            rowsWritten += lines.length;
            if (lockedWarned) { console.log("Logger: file is writable again; saved the buffered rows."); lockedWarned = false; }
        } catch (error) {
            // A logging problem must never stop the server, so rows are kept and retried.
            if (!lockedWarned) {
                console.warn(["EBUSY", "EPERM", "EACCES"].includes(error.code)
                    ? `Logger: ${path.basename(file)} is open in another program (probably Excel). ` +
                      "Readings are kept in memory and will be saved when you close it."
                    : `Logger: could not save to ${file} (${error.message}); will keep retrying.`);
                lockedWarned = true;
            }
            for (const line of lines) stillPending.push({ file, line });
        }
    }
    pending = stillPending;
}

// voltage/current = solar (GPIO35/34); voltage32/current33 = battery (GPIO32/33)
function logReading(reading) {
    const sv = reading.voltage, si = reading.current, bv = reading.voltage32, bi = reading.current33;
    const when = new Date(reading.timestamp);
    pending.push({
        file: logFileFor(when),
        line: [
            localStamp(when), reading.timestamp,
            num(sv, 3), num(si, 4), num(power(sv, si), 3),
            num(bv, 3), num(bi, 4), num(power(bv, bi), 3)
        ].join(",")
    });
    flush();
}

// Retry rows held back while the file was open in Excel, and print a
// summary every 5 minutes.
setInterval(flush, 5000).unref();
setInterval(() => { if (rowsWritten) console.log(`Logger: ${rowsWritten} rows saved so far in ${LOG_DIR}`); }, 5 * 60 * 1000).unref();
process.on("exit", flush);

console.log(`Logger: every reading is saved to ${LOG_DIR}`);
module.exports = { logReading };
