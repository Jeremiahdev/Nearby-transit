// scripts/build_route_shapes.mjs
// Build GeoJSON route shapes from GTFS (routes.txt, trips.txt, shapes.txt)
//
// Output: src/data/route_shapes.json
//
// Usage (from project root):
//   node scripts/build_route_shapes.mjs ./gtfs
//
// Where ./gtfs contains routes.txt, trips.txt, shapes.txt

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const LINE_COLORS = {
  "1": "#EE352E",
  "2": "#EE352E",
  "3": "#EE352E",
  "4": "#00933C",
  "5": "#00933C",
  "6": "#00933C",
  "7": "#B933AD",
  A: "#0039A6",
  C: "#0039A6",
  E: "#0039A6",
  B: "#FF6319",
  D: "#FF6319",
  F: "#FF6319",
  M: "#FF6319",
  N: "#FCCC0A",
  Q: "#FCCC0A",
  R: "#FCCC0A",
  W: "#FCCC0A",
  J: "#996633",
  Z: "#996633",
  L: "#A7A9AC",
  S: "#808183",
};

// ---- tiny CSV parser (handles quotes) ----
function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      // double quote inside quoted string -> escape
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function mustExist(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }
}

async function readGTFS(filePath, onRow) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = parseCSVLine(line).map((h) => h.trim());
      continue;
    }
    const vals = parseCSVLine(line);
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = vals[i];
    await onRow(row);
  }
}

// ---- main ----
async function main() {
  const gtfsDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!gtfsDir) {
    console.error("Usage: node scripts/build_route_shapes.mjs ./gtfs");
    process.exit(1);
  }

  const routesPath = path.join(gtfsDir, "routes.txt");
  const tripsPath = path.join(gtfsDir, "trips.txt");
  const shapesPath = path.join(gtfsDir, "shapes.txt");

  mustExist(routesPath);
  mustExist(tripsPath);
  mustExist(shapesPath);

  // 1) route_id -> route_short_name
  const routeIdToShort = new Map();
  await readGTFS(routesPath, async (r) => {
    const route_id = r.route_id;
    const short = (r.route_short_name || "").trim();
    if (route_id) routeIdToShort.set(route_id, short || route_id);
  });

  // 2) Determine the most common shape_id per (route_id, direction_id)
  // Key: route_id|direction_id|shape_id -> count
  const counts = new Map();

  await readGTFS(tripsPath, async (t) => {
    const route_id = t.route_id;
    const shape_id = t.shape_id;
    const direction_id = (t.direction_id ?? "").trim(); // often "0" or "1"

    if (!route_id || !shape_id) return;
    const dir = direction_id === "" ? "0" : direction_id; // default
    const key = `${route_id}|${dir}|${shape_id}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  // For each (route_id, dir) pick best shape_id
  const bestShapeByRouteDir = new Map(); // route_id|dir -> {shape_id, count}
  for (const [key, count] of counts.entries()) {
    const [route_id, dir, shape_id] = key.split("|");
    const rd = `${route_id}|${dir}`;
    const existing = bestShapeByRouteDir.get(rd);
    if (!existing || count > existing.count) {
      bestShapeByRouteDir.set(rd, { shape_id, count });
    }
  }

  const chosenShapeIds = new Set(
    [...bestShapeByRouteDir.values()].map((x) => x.shape_id)
  );

  // 3) Read shapes for chosen shape_ids only
  // shape_id -> [{seq, lat, lon}]
  const shapePoints = new Map();

  await readGTFS(shapesPath, async (s) => {
    const shape_id = s.shape_id;
    if (!shape_id || !chosenShapeIds.has(shape_id)) return;

    const lat = Number(s.shape_pt_lat);
    const lon = Number(s.shape_pt_lon);
    const seq = Number(s.shape_pt_sequence);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(seq))
      return;

    if (!shapePoints.has(shape_id)) shapePoints.set(shape_id, []);
    shapePoints.get(shape_id).push({ seq, lat, lon });
  });

  // Sort points by sequence
  for (const [shape_id, pts] of shapePoints.entries()) {
    pts.sort((a, b) => a.seq - b.seq);
    shapePoints.set(shape_id, pts);
  }

  // 4) Build GeoJSON features
  const features = [];

  for (const [rd, best] of bestShapeByRouteDir.entries()) {
    const [route_id, dir] = rd.split("|");
    const shape_id = best.shape_id;
    const pts = shapePoints.get(shape_id) || [];
    if (pts.length < 2) continue;

    const short = String(routeIdToShort.get(route_id) || route_id).trim();
    const color = LINE_COLORS[short.toUpperCase()] || "#999999";

    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: pts.map((p) => [p.lon, p.lat]),
      },
      properties: {
        route_id,
        route_short_name: short,
        direction_id: dir, // "0" or "1"
        shape_id,
        color,
        trips_sampled: best.count,
      },
    });
  }

  // Nice deterministic ordering: by route then direction
  features.sort((a, b) => {
    const ra = a.properties.route_short_name;
    const rb = b.properties.route_short_name;
    if (ra < rb) return -1;
    if (ra > rb) return 1;
    return Number(a.properties.direction_id) - Number(b.properties.direction_id);
  });

  const out = {
    type: "FeatureCollection",
    features,
  };

  const outDir = path.resolve("./src/data");
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, "route_shapes.json");
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`✅ Wrote ${features.length} route shape features -> ${outPath}`);
  console.log(
    `Tip: each feature is a route+direction (so usually 2 per line).`
  );
}

main().catch((err) => {
  console.error("❌ build_route_shapes failed:", err);
  process.exit(1);
});
