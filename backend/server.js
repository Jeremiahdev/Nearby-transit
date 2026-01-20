import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const app = express();
app.use(cors());

const PORT = Number(process.env.PORT || 3000);
//const API_KEY = process.env.MTA_API_KEY;
const CACHE_SECONDS = Number(process.env.CACHE_SECONDS || 30);

const FEEDS = {
jz: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
ace: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
nqrw: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
bdfm: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
g: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
l: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
sir: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
// "gtfs" is the 1-6/S/7 feed in MTA naming
gtfs: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
};

//if (!API_KEY){ console.warn("Missing MTA_API_KEY in .env");}

// In memory cache: { feedName: { ts, json } }
const cache = new Map();

async function fetchAndParseGTFSRT(url) {
  const res = await fetch(url) //in the original code it added fetch(url, {headers: { "x-api-key": API_KEY } but since im not using a api key im thinking i could leave it out


  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MTA fetch fail ${res.status} ${res.statusText} ${text}`);
  }


  const buf = Buffer.from(await res.arrayBuffer());
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);


  // Convert to plain JSON-ish structure
 // (protobuf objects include Long; we'll stringify those safely)
 return JSON.parse(

   JSON.stringify(feed, (_, v) => (typeof v === "bigint" ? v.toString() : v))
 );
}


async function getCached(feedName) {

  const entry = cache.get(feedName);
  const now = Date.now();


  if (entry && now - entry.ts < CACHE_SECONDS * 1000) return entry.json;


  const url = FEEDS[feedName];
  if (!url) throw new Error(`Unknown feed: ${feedName}`);


  const json = await fetchAndParseGTFSRT(url);
  cache.set(feedName, { ts: now, json });
  return json;
}

app.get("/health", (req, res) => {

  res.json({ ok: true, time: new Date().toISOString() });
});

// Raw GTFS-RT feed as JSON (cached)
app.get("/api/gtfsrt/:feed", async (req, res) => {
  try {

    const feed = req.params.feed;

    const json = await getCached(feed);

    res.json({

      feed,
      cached_seconds: CACHE_SECONDS,
      fetched_at: new Date(cache.get(feed).ts).toISOString(),
      data: json,
    });
  } catch (err) {

    res.status(500).json({ error: String(err.message || err) });
  }
});


// OPTIONAL: a "simple arrivals" endpoint you can build toward later
// For now it returns tripUpdates only (where arrival/departure live)

app.get("/api/trip-updates/:feed", async (req, res) => {

  try {

    const feed = req.params.feed;
    const json = await getCached(feed);
    const entities = json.entity || [];
    const tripUpdates = entities
      .filter((e) => e.tripUpdate)
      .map((e) => e.tripUpdate);

    res.json({
      feed,

      count: tripUpdates.length,

      fetched_at: new Date(cache.get(feed).ts).toISOString(),
      tripUpdates,
    });
  } catch (err) {

    res.status(500).json({ error: String(err.message || err) });

  }
});
 // i left here for tmm 1/18/2026 this is the end point for arrivals not finished


// attempting to make an end point that shows arrivals depending on stop id

app.get("/api/arrivals/:feed", async (req, res) => {

  try {

    const feed = req.params.feed;
    const json = await getCached(feed);
    const entities = json.entity || [];
    const route = entities
      .filter((e) => e.route)
      .map((e) => e.route)

    res.json({
      feed,

      count: route.length,

      fetched_at: new Date(cache.get(feed).ts).toISOString(),
      arrival,
    });
  } catch (err) {

    res.status(500).json({ error: String(err.message || err) });

  }
})

app.listen(PORT, "0.0.0.0", () => {

  console.log(` MTA proxy running on http://0.0.0.0:${PORT}`);

  console.log(`Try: http://<pi-ip>:${PORT}/health`);

  console.log(`Try: http://<pi-ip>:${PORT}/api/gtfsrt/jz`);

  console.log(`try: http://<pi-ip>:${PORT}/api/trip-update/jz`); //added this on 1/19/2026
});



