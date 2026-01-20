import fs from "fs";
import path from "path";
import readline from "readline";

const GTFS_DIR = path.resolve("gtfs");
const OUT_FILE = path.resolve("src/data/station_arrivals_by_destination.json");

// ---- small CSV splitter (handles simple quotes) ----
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function loadTable(filePath, onRow) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = splitCsvLine(line);
      continue;
    }
    const cols = splitCsvLine(line);
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cols[i];
    onRow(row);
  }
}

function pushTime(obj, stationId, line, headsign, t) {
  if (!obj[stationId]) obj[stationId] = {};
  if (!obj[stationId][line]) obj[stationId][line] = {};
  if (!obj[stationId][line][headsign]) obj[stationId][line][headsign] = [];
  obj[stationId][line][headsign].push(t);
}

function normalizeTime(t) {
  // keep HH:MM:SS, ignore blanks
  if (!t) return null;
  const s = t.trim();
  if (!s) return null;
  return s;
}

async function main() {
  const stopsPath = path.join(GTFS_DIR, "stops.txt");
  const routesPath = path.join(GTFS_DIR, "routes.txt");
  const tripsPath = path.join(GTFS_DIR, "trips.txt");
  const stopTimesPath = path.join(GTFS_DIR, "stop_times.txt");

  // 1) stop_id -> parent_station (or itself)
  const stopToStation = new Map();
  await loadTable(stopsPath, (r) => {
    const stopId = r.stop_id;
    const parent = r.parent_station;
    stopToStation.set(stopId, parent && parent.length ? parent : stopId);
  });

  // 2) route_id -> short name (J/A/1)
  const routeIdToLine = new Map();
  await loadTable(routesPath, (r) => {
    const routeId = r.route_id;
    const short = (r.route_short_name || "").trim();
    if (routeId && short) routeIdToLine.set(routeId, short.toUpperCase());
  });

  // 3) trip_id -> { line, headsign }
  const tripInfo = new Map();
  await loadTable(tripsPath, (r) => {
    const tripId = r.trip_id;
    const routeId = r.route_id;
    const line = routeIdToLine.get(routeId);
    const headsign = (r.trip_headsign || "").trim();
    if (tripId && line && headsign) {
      tripInfo.set(tripId, { line, headsign });
    }
  });

  // 4) Stream stop_times and fill station->line->headsign->times
  const out = {};
  let seen = 0;

  console.log("Streaming stop_times.txt…");

  await loadTable(stopTimesPath, (r) => {
    const tripId = r.trip_id;
    const stopId = r.stop_id;
    const time = normalizeTime(r.arrival_time);

    if (!time) return;

    const info = tripInfo.get(tripId);
    if (!info) return;

    const stationId = stopToStation.get(stopId) || stopId;
    pushTime(out, stationId, info.line, info.headsign, time);

    seen++;
    if (seen % 500000 === 0) console.log(`...processed ${seen.toLocaleString()} rows`);
  });

  // 5) Sort & trim times to keep file smaller
  // Keep only the first 120 times per (station,line,headsign) after sorting.
  for (const stationId of Object.keys(out)) {
    for (const line of Object.keys(out[stationId])) {
      for (const headsign of Object.keys(out[stationId][line])) {
        const arr = out[stationId][line][headsign];
        arr.sort(); // HH:MM:SS sorts lexicographically fine
        out[stationId][line][headsign] = arr.slice(0, 120);
      }
    }
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");

  console.log(`✅ Wrote: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("❌ build_station_arrivals_by_destination failed:", e);
  process.exit(1);
});
