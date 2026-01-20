import fs from "fs";
import path from "path";
import readline from "readline";

// ---------- CONFIG ----------
const GTFS_DIR = path.resolve("gtfs"); // folder containing stops.txt, routes.txt, trips.txt, stop_times.txt
const OUT_FILE = path.resolve("src/data/station_to_lines.json");

// ---------- Helpers ----------
function splitCsvLine(line) {
  // GTFS files rarely use quotes, but sometimes they do.
  // This handles commas inside quotes minimally.
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

async function loadSmallTable(filePath, onRow) {
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

async function streamTable(filePath, onRow) {
  // For huge files like stop_times.txt
  return loadSmallTable(filePath, onRow);
}

// ---------- Main ----------
async function main() {
  const stopsPath = path.join(GTFS_DIR, "stops.txt");
  const routesPath = path.join(GTFS_DIR, "routes.txt");
  const tripsPath = path.join(GTFS_DIR, "trips.txt");
  const stopTimesPath = path.join(GTFS_DIR, "stop_times.txt");

  // 1) stop_id -> parent_station (if exists) else stop_id
  const stopToStation = new Map();
  await loadSmallTable(stopsPath, (r) => {
    const stopId = r.stop_id;
    const parent = r.parent_station;
    // Some feeds use location_type to mark stations.
    // But simplest: if it has parent_station, use that. Otherwise, itself is the station key.
    stopToStation.set(stopId, parent && parent.length ? parent : stopId);
  });

  // 2) route_id -> route_short_name (J/A/1/etc.)
  const routeIdToShort = new Map();
  await loadSmallTable(routesPath, (r) => {
    const routeId = r.route_id;
    const shortName = (r.route_short_name || "").trim();
    if (routeId && shortName) routeIdToShort.set(routeId, shortName.toUpperCase());
  });

  // 3) trip_id -> route_short_name
  const tripToLine = new Map();
  await loadSmallTable(tripsPath, (r) => {
    const tripId = r.trip_id;
    const routeId = r.route_id;
    const line = routeIdToShort.get(routeId);
    if (tripId && line) tripToLine.set(tripId, line);
  });

  // 4) station_id -> Set(lines)
  const stationToLines = new Map();

  console.log("Streaming stop_times.txt (this can take a bit)...");
  let seen = 0;

  await streamTable(stopTimesPath, (r) => {
    const tripId = r.trip_id;
    const stopId = r.stop_id;

    const line = tripToLine.get(tripId);
    if (!line) return;

    const stationId = stopToStation.get(stopId) || stopId;

    let set = stationToLines.get(stationId);
    if (!set) {
      set = new Set();
      stationToLines.set(stationId, set);
    }
    set.add(line);

    seen++;
    if (seen % 500000 === 0) console.log(`...processed ${seen.toLocaleString()} stop_times rows`);
  });

  // 5) Convert to plain JSON (sorted lines)
  const outObj = {};
  for (const [stationId, set] of stationToLines.entries()) {
    outObj[stationId] = Array.from(set).sort();
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(outObj, null, 2), "utf8");

  console.log(`✅ Wrote ${Object.keys(outObj).length.toLocaleString()} stations to: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("❌ build_station_to_lines failed:", err);
  process.exit(1);
});
