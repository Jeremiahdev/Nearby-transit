import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

import STOPS from "./data/stops.json";
import STATION_TO_LINES from "./data/station_to_lines.json";
import ARRIVALS_BY_DEST from "./data/station_arrivals_by_destination.json";
import ROUTE_SHAPES from "./data/route_shapes.json";

/* =========================
   Helpers: distance
========================= */
function distanceMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function fmtWalkMinutes(meters) {
  if (!Number.isFinite(meters)) return "";
  if (meters < 80) return "< 1 min";
  return `${Math.max(1, Math.round(meters / 80))} min`;
}

function clampStopsArray(stops) {
  return Array.isArray(stops) ? stops : [];
}

/* =========================
   Helpers: GTFS time + ETA
   Fixes 24+ hour times (e.g. 25:10:00)
========================= */
function timeToSecondsSinceMidnight(hms) {
  const [h, m, s] = String(hms).split(":").map((x) => parseInt(x, 10));
  return h * 3600 + m * 60 + (s || 0);
}

function nowSecondsSinceMidnight() {
  const d = new Date();
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

// Correct ETA sec for GTFS times like 25:10:00
function etaSecondsFromGTFS(timeStr) {
  const tSecRaw = timeToSecondsSinceMidnight(timeStr);
  const nowSec = nowSecondsSinceMidnight();

  const tSecNorm = tSecRaw % 86400;
  const isNextDay = tSecRaw >= 86400;

  if (isNextDay) return (tSecNorm + 86400) - nowSec;

  // If time already passed today, treat as tomorrow (after midnight rollover)
  if (tSecNorm < nowSec) return (tSecNorm + 86400) - nowSec;

  return tSecNorm - nowSec;
}

function fmtEtaMinutes(diffSec) {
  const min = Math.round(diffSec / 60);
  if (min <= 0) return "Now";
  if (min === 1) return "1 min";
  return `${min} min`;
}

/* =========================
   ETA Simulation (good UX)
========================= */
function simulateEtas({ base = 6, count = 3, jitter = 2, step = 6 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const noise = Math.floor(Math.random() * (jitter * 2 + 1) - jitter); // [-jitter..+jitter]
    const minutes = Math.max(1, base + i * step + noise);
    out.push(minutes);
  }
  return out.sort((a, b) => a - b);
}

const MAX_SHOW_MIN = 90; // never show insane far away times
const SOON_WINDOW_MIN = 20; // if none within 20 min => simulate

/* =========================
   Line colors (approx)
========================= */
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

function RouteBullet({ line }) {
  const l = String(line).toUpperCase();
  const bg = LINE_COLORS[l] || "#666";
  const isYellow = ["N", "Q", "R", "W"].includes(l);

  return (
    <span
      title={`Line ${l}`}
      style={{
        width: 26,
        height: 26,
        borderRadius: 999,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 900,
        fontSize: 12,
        background: bg,
        color: isYellow ? "#111" : "#fff",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
      }}
    >
      {l}
    </span>
  );
}

export default function App() {
  const token = (import.meta.env.VITE_MAPBOX_TOKEN || "").trim();

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);

  const userMarkerRef = useRef(null);
  const exploreMarkerRef = useRef(null);
  const stopMarkersRef = useRef([]);

  // Location
  const [userLoc, setUserLoc] = useState(null); // {lat, lon}
  const [geoError, setGeoError] = useState(null);
  const [exploreLoc, setExploreLoc] = useState(null); // draggable pin loc

  // Stop selection
  const [selectedStopId, setSelectedStopId] = useState(null);

  // UI
  const [showStops, setShowStops] = useState(true);
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState("nearby"); // nearby | favorites

  // Favorites persisted
  const [favorites, setFavorites] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("favoritesStops") || "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem("favoritesStops", JSON.stringify(favorites));
  }, [favorites]);

  const isFav = (id) => favorites.includes(id);
  const toggleFav = (id) => {
    setFavorites((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // Direction selector
  const [selectedLine, setSelectedLine] = useState(null);
  const [selectedHeadsign, setSelectedHeadsign] = useState(null);

  // tick for refreshing ETA display
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);

  // -------- 1) Geolocation --------
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoError("Geolocation not supported. Using Midtown Manhattan.");
      setUserLoc({ lat: 40.758, lon: -73.9855 });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLoc({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        setGeoError("Location blocked. Using Midtown Manhattan.");
        setUserLoc({ lat: 40.758, lon: -73.9855 });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }, []);

  const activeLoc = exploreLoc || userLoc;

  // -------- 2) Nearby stops from activeLoc --------
  const nearbyStops = useMemo(() => {
    if (!activeLoc) return [];
    const stops = clampStopsArray(STOPS);

    const withDist = stops
      .map((s) => ({
        ...s,
        distM: distanceMeters(activeLoc.lat, activeLoc.lon, Number(s.lat), Number(s.lon)),
      }))
      .sort((a, b) => a.distM - b.distM);

    const within = withDist.filter((s) => s.distM <= 1200);
    return (within.length ? within : withDist).slice(0, 12);
  }, [activeLoc]);

  // Auto-select first nearby stop
  useEffect(() => {
    if (!selectedStopId && nearbyStops.length) setSelectedStopId(nearbyStops[0].id);
  }, [nearbyStops, selectedStopId]);

  const selectedStop = useMemo(
    () => nearbyStops.find((s) => s.id === selectedStopId) || null,
    [nearbyStops, selectedStopId]
  );

  const selectedLinesAtStop = useMemo(() => {
    if (!selectedStop) return [];
    return STATION_TO_LINES[selectedStop.id] || [];
  }, [selectedStop]);

  // reset line+direction when stop changes
  useEffect(() => {
    setSelectedLine(null);
    setSelectedHeadsign(null);
  }, [selectedStopId]);

  // auto-pick first line at stop
  useEffect(() => {
    if (!selectedStop) return;
    if (selectedLinesAtStop.length && !selectedLine) setSelectedLine(selectedLinesAtStop[0]);
  }, [selectedStop, selectedLinesAtStop, selectedLine]);

  // Get headsign options from ARRIVALS_BY_DEST for this stop+line
  const headsignOptions = useMemo(() => {
    if (!selectedStop || !selectedLine) return [];
    const stationData = ARRIVALS_BY_DEST?.[selectedStop.id];
    if (!stationData) return [];
    const lineKey = String(selectedLine).toUpperCase();
    const lineData = stationData?.[lineKey];
    if (!lineData) return [];
    return Object.keys(lineData);
  }, [selectedStop, selectedLine]);

  useEffect(() => {
    if (!headsignOptions.length) {
      setSelectedHeadsign(null);
      return;
    }
    if (!selectedHeadsign) setSelectedHeadsign(headsignOptions[0]);
  }, [headsignOptions, selectedHeadsign]);

  // -------- 3) Build arrivals (scheduled + estimated fallback) --------
  const nextArrivals = useMemo(() => {
    if (!selectedStop) return [];
    const stationData = ARRIVALS_BY_DEST?.[selectedStop.id];
    if (!stationData) return [];

    const groups = [];

    for (const line of Object.keys(stationData)) {
      const byHeadsign = stationData[line] || {};
      for (const headsign of Object.keys(byHeadsign)) {
        const times = byHeadsign[headsign] || [];

        const upcomingScheduled = times
          .map((t) => ({ timeStr: t, etaSec: etaSecondsFromGTFS(t) }))
          .filter((x) => x.etaSec >= 0)
          .filter((x) => x.etaSec <= MAX_SHOW_MIN * 60)
          .sort((a, b) => a.etaSec - b.etaSec)
          .slice(0, 5)
          .map((x) => ({
            timeStr: x.timeStr,
            etaSec: x.etaSec,
            etaLabel: fmtEtaMinutes(x.etaSec),
            source: "scheduled",
          }));

        const hasSoon = upcomingScheduled.some((u) => u.etaSec <= SOON_WINDOW_MIN * 60);

        if (!hasSoon) {
          const sim = simulateEtas({ base: 6, count: 3, jitter: 2, step: 6 }).map((m) => ({
            timeStr: null,
            etaSec: m * 60,
            etaLabel: `${m} min`,
            source: "estimated",
          }));

          const maybeFirstScheduled = upcomingScheduled[0] ? [upcomingScheduled[0]] : [];

          groups.push({
            line: String(line).toUpperCase(),
            headsign,
            upcoming: [...sim, ...maybeFirstScheduled].slice(0, 4),
          });
        } else if (upcomingScheduled.length) {
          groups.push({
            line: String(line).toUpperCase(),
            headsign,
            upcoming: upcomingScheduled.slice(0, 4),
          });
        }
      }
    }

    groups.sort((a, b) => (a.upcoming[0]?.etaSec ?? 999999) - (b.upcoming[0]?.etaSec ?? 999999));
    return groups;
  }, [selectedStop, nowTick]);

  const visibleArrivals = useMemo(() => {
    let list = nextArrivals;
    if (selectedLine) {
      const l = String(selectedLine).toUpperCase();
      list = list.filter((g) => g.line === l);
    }
    if (selectedHeadsign) {
      list = list.filter((g) => g.headsign === selectedHeadsign);
    }
    return list;
  }, [nextArrivals, selectedLine, selectedHeadsign]);

  // Favorites list
  const favoriteStopsList = useMemo(() => {
    const all = clampStopsArray(STOPS);
    const mapById = new Map(all.map((s) => [s.id, s]));
    return favorites.map((id) => mapById.get(id)).filter(Boolean);
  }, [favorites]);

  const stopsToRender = activeTab === "favorites" ? favoriteStopsList : nearbyStops;

  /* =========================
     Mapbox init
========================= */
  useEffect(() => {
    if (!token) return;
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-73.9855, 40.758],
      zoom: 12.7,
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    map.on("load", () => {
      // Route shapes layer
      if (ROUTE_SHAPES && !map.getSource("route-shapes")) {
        map.addSource("route-shapes", { type: "geojson", data: ROUTE_SHAPES });
        map.addLayer({
          id: "route-shapes-layer",
          type: "line",
          source: "route-shapes",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": 3,
            "line-opacity": 0.85,
          },
        });
      }
      map.resize();
    });

    map.on("error", (e) => console.error("Mapbox error:", e?.error || e));

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [token]);

  // Blue GPS marker
  useEffect(() => {
    if (!mapRef.current || !userLoc) return;

    if (!userMarkerRef.current) {
      const el = document.createElement("div");
      el.style.width = "14px";
      el.style.height = "14px";
      el.style.borderRadius = "999px";
      el.style.background = "#3b82f6";
      el.style.boxShadow = "0 0 0 8px rgba(59,130,246,0.22)";

      userMarkerRef.current = new mapboxgl.Marker({ element: el })
        .setLngLat([userLoc.lon, userLoc.lat])
        .addTo(mapRef.current);
    } else {
      userMarkerRef.current.setLngLat([userLoc.lon, userLoc.lat]);
    }
  }, [userLoc]);

  // Purple draggable explore pin
  useEffect(() => {
    if (!mapRef.current || !userLoc) return;

    if (!exploreMarkerRef.current) {
      const el = document.createElement("div");
      el.style.width = "16px";
      el.style.height = "16px";
      el.style.borderRadius = "999px";
      el.style.background = "#a855f7";
      el.style.boxShadow = "0 0 0 8px rgba(168,85,247,0.22)";
      el.style.border = "2px solid rgba(255,255,255,0.85)";

      const marker = new mapboxgl.Marker({ element: el, draggable: true })
        .setLngLat([userLoc.lon, userLoc.lat])
        .addTo(mapRef.current);

      marker.on("dragend", () => {
        const { lng, lat } = marker.getLngLat();
        setExploreLoc({ lat, lon: lng });
      });

      exploreMarkerRef.current = marker;
    }

    if (!exploreLoc) {
      exploreMarkerRef.current.setLngLat([userLoc.lon, userLoc.lat]);
    } else {
      exploreMarkerRef.current.setLngLat([exploreLoc.lon, exploreLoc.lat]);
    }
  }, [userLoc, exploreLoc]);

  // Center map on active location
  useEffect(() => {
    if (!mapRef.current || !activeLoc) return;
    mapRef.current.flyTo({ center: [activeLoc.lon, activeLoc.lat], zoom: 14.7, speed: 1.2 });
  }, [activeLoc]);

  // Stop markers (toggle)
  useEffect(() => {
    if (!mapRef.current) return;

    stopMarkersRef.current.forEach((m) => m.remove());
    stopMarkersRef.current = [];

    if (!showStops) return;

    nearbyStops.forEach((s) => {
      const el = document.createElement("button");
      el.type = "button";
      el.style.border = "none";
      el.style.background = "transparent";
      el.style.cursor = "pointer";

      const bubble = document.createElement("div");
      bubble.textContent = s.name;
      bubble.style.padding = "6px 10px";
      bubble.style.borderRadius = "999px";
      bubble.style.background =
        s.id === selectedStopId ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.82)";
      bubble.style.color = "#111";
      bubble.style.fontWeight = "900";
      bubble.style.fontSize = "12px";
      bubble.style.maxWidth = "220px";
      bubble.style.whiteSpace = "nowrap";
      bubble.style.overflow = "hidden";
      bubble.style.textOverflow = "ellipsis";
      bubble.style.boxShadow = "0 10px 22px rgba(0,0,0,0.35)";
      bubble.style.transform = "translateY(-6px)";

      el.appendChild(bubble);

      el.onclick = () => {
        setSelectedStopId(s.id);
        mapRef.current?.flyTo({ center: [Number(s.lon), Number(s.lat)], zoom: 15.4, speed: 1.2 });
      };

      const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([Number(s.lon), Number(s.lat)])
        .addTo(mapRef.current);

      stopMarkersRef.current.push(marker);
    });
  }, [nearbyStops, selectedStopId, showStops]);

  // Guard: token missing
  if (!token) {
    return (
      <div style={{ padding: 16, fontFamily: "system-ui" }}>
        <h2 style={{ margin: 0 }}>Missing Mapbox token</h2>
        <p style={{ opacity: 0.85 }}>
          Create <code>.env</code> next to <code>package.json</code>:
        </p>
        <pre style={{ background: "#111", color: "#fff", padding: 12, borderRadius: 8 }}>
VITE_MAPBOX_TOKEN=pk...
        </pre>
        <p style={{ opacity: 0.85 }}>Restart: <code>npm run dev</code></p>
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", width: "100%", position: "relative", fontFamily: "system-ui" }}>
      {/* MAP */}
      <div ref={mapContainerRef} style={{ position: "absolute", inset: 0, zIndex: 0 }} />

      {/* TOP BAR */}
      <div
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          top: 16,
          zIndex: 10,
          padding: 12,
          borderRadius: 16,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(10px)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "white",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontWeight: 900, fontSize: 14 }}>Nearby Subway</div>
          <div style={{ opacity: 0.85, fontSize: 12 }}>
            {geoError ? geoError : "Drag the purple pin to explore. Tap stops to preview."}
          </div>
          <div style={{ opacity: 0.75, fontSize: 12 }}>
            {exploreLoc ? "Explore mode: ON" : "Explore mode: OFF (GPS)"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button
            onClick={() => setShowStops((v) => !v)}
            style={{
              border: "1px solid rgba(255,255,255,0.14)",
              background: showStops ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.25)",
              borderRadius: 999,
              padding: "8px 10px",
              color: "white",
              cursor: "pointer",
              fontWeight: 900,
              fontSize: 12,
            }}
          >
            Stops: {showStops ? "On" : "Off"}
          </button>

          <button
            onClick={() => setExploreLoc(null)}
            style={{
              border: "1px solid rgba(255,255,255,0.14)",
              background: !exploreLoc ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.25)",
              borderRadius: 999,
              padding: "8px 10px",
              color: "white",
              cursor: "pointer",
              fontWeight: 900,
              fontSize: 12,
            }}
            title="Snap explore pin back to your real location"
          >
            Use My Location
          </button>

          <button
            onClick={() => {
              if (!mapRef.current || !activeLoc) return;
              mapRef.current.flyTo({ center: [activeLoc.lon, activeLoc.lat], zoom: 14.7, speed: 1.2 });
            }}
            style={{
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(0,0,0,0.25)",
              borderRadius: 999,
              padding: "8px 10px",
              color: "white",
              cursor: "pointer",
              fontWeight: 900,
              fontSize: 12,
            }}
          >
            Center
          </button>
        </div>
      </div>

      {/* BOTTOM SHEET */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10,
          padding: 16,
          background: "rgba(0,0,0,0.78)",
          backdropFilter: "blur(10px)",
          borderTop: "1px solid rgba(255,255,255,0.12)",
          maxHeight: sheetCollapsed ? "18vh" : "60vh",
          overflowY: "auto",
        }}
      >
        {/* handle */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
          <button
            onClick={() => setSheetCollapsed((v) => !v)}
            style={{
              width: 60,
              height: 6,
              borderRadius: 999,
              border: "none",
              background: "rgba(255,255,255,0.35)",
              cursor: "pointer",
            }}
            title={sheetCollapsed ? "Expand" : "Collapse"}
          />
        </div>

        {/* ARRIVALS PANEL */}
        {!sheetCollapsed && selectedStop && (
          <div
            style={{
              marginBottom: 12,
              padding: 12,
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "white",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 14 }}>
                {selectedStop.name}
              </div>
              <div style={{ opacity: 0.75, fontSize: 12 }}>
                ETAs: scheduled + estimated
              </div>
            </div>

            {/* Line selector */}
            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 10, marginBottom: 8 }}>
              Line
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {selectedLinesAtStop.map((ln) => {
                const active = String(ln).toUpperCase() === String(selectedLine || "").toUpperCase();
                return (
                  <button
                    key={ln}
                    onClick={() => {
                      setSelectedLine(ln);
                      setSelectedHeadsign(null);
                    }}
                    style={{
                      border: "1px solid rgba(255,255,255,0.14)",
                      background: active ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.25)",
                      borderRadius: 999,
                      padding: "8px 10px",
                      color: "white",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontWeight: 900,
                    }}
                  >
                    <RouteBullet line={ln} />
                    <span>{String(ln).toUpperCase()}</span>
                  </button>
                );
              })}
            </div>

            {/* Direction selector */}
            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 12, marginBottom: 8 }}>
              Direction
            </div>
            {headsignOptions.length ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {headsignOptions.map((hs) => {
                  const active = hs === selectedHeadsign;
                  return (
                    <button
                      key={hs}
                      onClick={() => setSelectedHeadsign(hs)}
                      style={{
                        border: "1px solid rgba(255,255,255,0.14)",
                        background: active ? "rgba(59,130,246,0.30)" : "rgba(0,0,0,0.25)",
                        borderRadius: 999,
                        padding: "10px 12px",
                        color: "white",
                        cursor: "pointer",
                        fontWeight: 800,
                        fontSize: 13,
                        maxWidth: 280,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={hs}
                    >
                      {hs}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                No direction data for this stop/line.
              </div>
            )}

            {/* ETA cards */}
            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {visibleArrivals.length === 0 ? (
                <div style={{ opacity: 0.78, fontSize: 12, lineHeight: 1.4 }}>
                  No upcoming trains found for this selection. Try switching direction/line or move the pin.
                </div>
              ) : (
                visibleArrivals.slice(0, 6).map((g) => (
                  <div
                    key={`${g.line}-${g.headsign}`}
                    style={{
                      padding: 10,
                      borderRadius: 12,
                      background: "rgba(0,0,0,0.25)",
                      border: "1px solid rgba(255,255,255,0.10)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <RouteBullet line={g.line} />
                      <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {g.line} → {g.headsign}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                      {g.upcoming.slice(0, 3).map((u, idx) => (
                        <span
                          key={`${g.line}-${g.headsign}-${idx}-${u.etaLabel}`}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 999,
                            background: u.source === "estimated" ? "rgba(59,130,246,0.18)" : "rgba(255,255,255,0.10)",
                            border: "1px solid rgba(255,255,255,0.10)",
                            fontWeight: 800,
                            fontSize: 12,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                          title={u.source === "estimated" ? "Estimated (simulated)" : `Scheduled time ${u.timeStr}`}
                        >
                          <span>{u.etaLabel}</span>
                          <span style={{ opacity: 0.75, fontWeight: 800, fontSize: 11 }}>
                            {u.source === "estimated" ? "EST" : "SCH"}
                          </span>
                          {u.timeStr && (
                            <span style={{ opacity: 0.7, fontWeight: 700 }}>
                              {u.timeStr}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ marginTop: 10, opacity: 0.75, fontSize: 12, lineHeight: 1.4 }}>
              ETAs are estimated using GTFS schedules + a simulation fallback when schedules are far away.
              Real-time GTFS-RT can be added later via a cached proxy server.
            </div>
          </div>
        )}

        {/* tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {["nearby", "favorites"].map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              style={{
                border: "1px solid rgba(255,255,255,0.12)",
                background: activeTab === t ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.25)",
                borderRadius: 999,
                padding: "8px 12px",
                color: "white",
                cursor: "pointer",
                fontWeight: 900,
                fontSize: 12,
                textTransform: "capitalize",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* stop list */}
        <div style={{ color: "white", fontSize: 14, fontWeight: 900, marginBottom: 10 }}>
          {activeTab === "favorites" ? "Favorite stops" : "Nearby stops"}
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {stopsToRender.length === 0 ? (
            <div style={{ opacity: 0.75, color: "white", fontSize: 12 }}>
              {activeTab === "favorites"
                ? "No favorites yet — tap ★ to save a stop."
                : "Finding stops…"}
            </div>
          ) : (
            stopsToRender.map((s) => {
              const lines = STATION_TO_LINES[s.id] || [];
              const active = s.id === selectedStopId;

              const distLabel =
                activeLoc
                  ? fmtWalkMinutes(distanceMeters(activeLoc.lat, activeLoc.lon, Number(s.lat), Number(s.lon)))
                  : "";

              return (
                <button
                  key={s.id}
                  onClick={() => {
                    setSelectedStopId(s.id);
                    mapRef.current?.flyTo({
                      center: [Number(s.lon), Number(s.lat)],
                      zoom: 15.4,
                      speed: 1.2,
                    });
                  }}
                  style={{
                    textAlign: "left",
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: active ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)",
                    borderRadius: 14,
                    padding: 12,
                    color: "white",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.name}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ opacity: 0.85, fontSize: 12 }}>{distLabel}</div>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFav(s.id);
                        }}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: isFav(s.id) ? "#fbbf24" : "rgba(255,255,255,0.65)",
                          cursor: "pointer",
                          fontSize: 18,
                          fontWeight: 900,
                        }}
                        title={isFav(s.id) ? "Remove favorite" : "Add to favorites"}
                      >
                        ★
                      </button>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {lines.length ? (
                      lines.slice(0, 12).map((ln) => <RouteBullet key={ln} line={ln} />)
                    ) : (
                      <span style={{ opacity: 0.75, fontSize: 12 }}>No line data</span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
