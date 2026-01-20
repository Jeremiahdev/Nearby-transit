// scripts/build_gtfs_json.js
// Build compact JSON for a frontend app:
// - stops.json: parent stations only (location_type=1) with lat/lon/name
// - routes.json: route_id -> route_short_name (J, A, 1, etc) + color
// - stop_to_routes.json: stop_id -> array of route_short_name that serve that stop
//
// Usage:
//   node scripts/build_gtfs_json.js
//
// Expects files in ./gtfs:
//   stops.txt, routes.txt, trips.txt, stop_times.txt
//
// Output in ./src/data:
//   stops.json, routes.json, stop_to_routes.json



const fs = require("fs");
const path = require("path");

// ---------- CSV parsing (handles quotes, commas inside quotes) ----------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        // escaped quote
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && (ch === "," || ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") continue;

      if (ch === ",") {
        row.push(cur);
        cur = "";
      } else {
        // newline
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  // last cell
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }

  // remove any empty trailing rows
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function csvToObjects(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows = parseCSV(raw);
  const headers = rows[0];
  const objs = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const o = {};
    for (let j = 0; j < headers.length; j++) {
      o[headers[j]] = r[j] ?? "";
    }
    objs.push(o);
  }
  return objs;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ---------- Paths ----------
const GTFS_DIR = path.join(process.cwd(), "gtfs");
const OUT_DIR = path.join(process.cwd(), "src", "data");

const stopsPath = path.join(GTFS_DIR, "stops.txt");
const routesPath = path.join(GTFS_DIR, "routes.txt");
const tripsPath = path.join(GTFS_DIR, "trips.txt");
const stopTimesPath = path.join(GTFS_DIR, "stop_times.txt");

if (![stopsPath, routesPath, tripsPath, stopTimesPath].every(fs.existsSync)) {
  console.error("❌ Missing GTFS files. Expected in ./gtfs:");
  console.error("   stops.txt, routes.txt, trips.txt, stop_times.txt");
  process.exit(1);
}

console.log("Reading GTFS files...");

// ---------- 1) stops.json (parent stations only) ----------
const stops = csvToObjects(stopsPath);

// keep only parent stations (location_type=1) if present,
// otherwise keep all stops
let stationStops = stops.filter((s) => String(s.location_type || "") === "1");
if (stationStops.length === 0) stationStops = stops;

const stopsJson = stationStops.map((s) => ({
  id: s.stop_id,
  name: s.stop_name,
  lat: Number(s.stop_lat),
  lon: Number(s.stop_lon),
}));

// ---------- 2) routes.json (route_id -> route_short_name) ----------
const routes = csvToObjects(routesPath);

// only subway routes if route_type exists (NYCT subway is typically 1)
// but keep all if not present
let subwayRoutes = routes;
if (routes.some((r) => r.route_type !== undefined)) {
  subwayRoutes = routes.filter((r) => String(r.route_type) === "1");
}

const routeIdToShort = new Map();
const routesJson = subwayRoutes.map((r) => {
  const shortName = (r.route_short_name || "").trim();
  routeIdToShort.set(r.route_id, shortName || r.route_id);
  return {
    route_id: r.route_id,
    short_name: shortName || r.route_id,
    long_name: r.route_long_name || "",
    color: r.route_color || "",
    text_color: r.route_text_color || "",
  };
});

// ---------- 3) trips: trip_id -> route_id ----------
const trips = csvToObjects(tripsPath);
const tripToRoute = new Map();
for (const t of trips) {
  if (t.trip_id && t.route_id) tripToRoute.set(t.trip_id, t.route_id);
}

// ---------- 4) stop_times: stop_id -> set(route_short_name) ----------
// IMPORTANT: stop_times is huge. We stream-ish read and only keep mapping.
// We'll parse CSV, but we will NOT store full rows.

console.log("Building stop -> routes map (this may take a bit) ...");

const stopToRouteShortSet = new Map();

// Read stop_times as text. (If this is too big and crashes memory, tell me and I’ll give a line-by-line stream version.)
const stopTimesRaw = fs.readFileSync(stopTimesPath, "utf8");
const stopTimesRows = parseCSV(stopTimesRaw);
const stHeaders = stopTimesRows[0];

const idxTrip = stHeaders.indexOf("trip_id");
const idxStop = stHeaders.indexOf("stop_id");

if (idxTrip === -1 || idxStop === -1) {
  console.error("❌ stop_times.txt missing trip_id or stop_id columns");
  process.exit(1);
}

for (let i = 1; i < stopTimesRows.length; i++) {
  const row = stopTimesRows[i];
  const tripId = row[idxTrip];
  const stopId = row[idxStop];
  if (!tripId || !stopId) continue;

  const routeId = tripToRoute.get(tripId);
  if (!routeId) continue;

  const short = routeIdToShort.get(routeId);
  if (!short) continue;

  if (!stopToRouteShortSet.has(stopId)) stopToRouteShortSet.set(stopId, new Set());
  stopToRouteShortSet.get(stopId).add(String(short).toUpperCase());
}

// Build compact json object: { [stopId]: ["J","Z",...] }
const stopToRoutesJson = {};
for (const [stopId, set] of stopToRouteShortSet.entries()) {
  stopToRoutesJson[stopId] = Array.from(set).sort();
}

// ---------- Write outputs ----------
ensureDir(OUT_DIR);

fs.writeFileSync(path.join(OUT_DIR, "stops.json"), JSON.stringify(stopsJson, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "routes.json"), JSON.stringify(routesJson, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "stop_to_routes.json"), JSON.stringify(stopToRoutesJson, null, 2));

console.log("✅ Done!");
console.log(`   stops.json: ${stopsJson.length} stops`);
console.log(`   routes.json: ${routesJson.length} routes`);
console.log(`   stop_to_routes.json: ${Object.keys(stopToRoutesJson).length} stops mapped to routes`);
