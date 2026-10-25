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
    "Battery_Voltage_V", "Battery_Current_A", "Battery_Power_W",
    "Battery_SOC_pct", "Load"
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
// New file each day. A file written with older columns is left as it is
// and the readings go to the next free name (microgrid_log_<date>_2.csv, ...).
const logFiles = new Map();
function logFileFor(d) {
    const date = localDate(d);
    if (logFiles.has(date)) return logFiles.get(date);
    for (let n = 1; ; n++) {
        const file = path.join(LOG_DIR, `microgrid_log_${date}${n > 1 ? `_${n}` : ""}.csv`);
        let firstLine = "";
        try { firstLine = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]; } catch {}
        if (!firstLine || firstLine === HEADER) { logFiles.set(date, file); return file; }
    }
}

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

// voltage/current = solar (GPIO35/34); voltage32/current33 = battery (GPIO32/33).
// loadState is the relay state confirmed by the ESP32: "closed", "open" or null.
function logReading(reading, loadState) {
    const sv = reading.voltage, si = reading.current, bv = reading.voltage32, bi = reading.current33;
    const when = new Date(reading.timestamp);
    pending.push({
        file: logFileFor(when),
        line: [
            localStamp(when), reading.timestamp,
            num(sv, 3), num(si, 4), num(power(sv, si), 3),
            num(bv, 3), num(bi, 4), num(power(bv, bi), 3),
            num(reading.soc, 1), loadState === "closed" ? "Connected" : loadState === "open" ? "Disconnected" : ""
        ].join(",")
    });
    flush();
}

// ---------- reading the logs back (for the dashboard's Data log tab) ----------
const LOG_NAME = /^microgrid_log_\d{4}-\d{2}-\d{2}(_\d+)?\.csv$/;

// The log files on the Desktop, newest first.
function listLogFiles() {
    let names = [];
    try { names = fs.readdirSync(LOG_DIR).filter(name => LOG_NAME.test(name)); } catch {}
    return names.map(name => {
        const stats = fs.statSync(path.join(LOG_DIR, name));
        return { name, size: stats.size, modified: stats.mtimeMs };
    }).sort((a, b) => b.modified - a.modified);
}

// Full path of a log file, or null if the name is not one of ours.
function logFilePath(name) {
    return LOG_NAME.test(name) && fs.existsSync(path.join(LOG_DIR, name)) ? path.join(LOG_DIR, name) : null;
}

// Header and last rows of the file being written now. Only the end of the
// file is read, so this stays quick however large the day's log grows.
function recentRows(count) {
    // Today's file as logReading() would pick it, else the newest file (e.g. just after midnight).
    const today = logFileFor(new Date());
    const latest = listLogFiles()[0];
    const file = fs.existsSync(today) ? today : latest && path.join(LOG_DIR, latest.name);
    if (!file || !fs.existsSync(file)) return { file: null, header: HEADER.split(","), rows: [] };
    const fd = fs.openSync(file, "r");
    try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, 256 * count + 1024);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
        if (length < size) lines.shift();  // first line may be cut in half
        const firstLine = Buffer.alloc(Math.min(size, 512));
        fs.readSync(fd, firstLine, 0, firstLine.length, 0);
        const header = firstLine.toString("utf8").split(/\r?\n/, 1)[0];
        const rows = lines.filter(line => line !== header).slice(-count).reverse().map(line => line.split(","));
        return { file: path.basename(file), header: header.split(","), rows };
    } finally {
        fs.closeSync(fd);
    }
}

// Retry rows held back while the file was open in Excel, and print a
// summary every 5 minutes.
setInterval(flush, 5000).unref();
setInterval(() => { if (rowsWritten) console.log(`Logger: ${rowsWritten} rows saved so far in ${LOG_DIR}`); }, 5 * 60 * 1000).unref();
process.on("exit", flush);

console.log(`Logger: every reading is saved to ${LOG_DIR}`);
module.exports = { logReading, listLogFiles, logFilePath, recentRows };
