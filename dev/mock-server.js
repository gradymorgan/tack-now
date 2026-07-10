/*
 * Dev harness: serves the webapp plus a synthetic Signal K-plugin API so the
 * LIVE code path can be exercised without a Signal K server or a boat.
 *
 *   node dev/mock-server.js   →  http://localhost:3300/
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3300;
const PUB = path.join(__dirname, "..", "public");
const API = "/plugins/signalk-tack-advisor";

const DEG = Math.PI / 180;
const KTS = 0.514444;
const LAT0 = 41.377, LON0 = -71.505;
const M_LAT = 111320, M_LON = 111320 * Math.cos(LAT0 * DEG);
const toLL = (x, y) => ({ latitude: LAT0 + y / M_LAT, longitude: LON0 + x / M_LON });
const norm360 = d => ((d % 360) + 360) % 360;
const normAng = a => ((a + 180) % 360 + 360) % 360 - 180;

const SETTINGS = {
  fitWindowMinutes: 30,
  boat: { twa: 43, tackCostSeconds: 6, upwindSpeedKnots: 6, useLiveSpeed: true },
  tactics: { headerThresholdDeg: 6, commitSeconds: 60, laylineMarginDeg: 2, laylineJudgmentSigmaDeg: 3 },
  simulation: { simulations: 600, pathsDrawn: 120 },
  windOverride: { enabled: false, oscAmplitudeDeg: 8, oscPeriodMinutes: 6, trendDegPerMinute: 0, noiseSigma: 4, persistenceTauSeconds: 120 },
};

/* ---- synthetic world: oscillating breeze + a boat beating to a mark ---- */
let rngState = 42;
function rng() { rngState |= 0; rngState = rngState + 0x6D2B79F5 | 0; let t = Math.imul(rngState ^ rngState >>> 15, 1 | rngState); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
function gauss() { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const t0 = Date.now() - 35 * 60e3;
const world = {
  wt: t0, twd: 18, dev: 0, wind: [],
  bt: Date.now() - 14 * 60e3, boat: { x: -150, y: -1500, tack: "port", lastTack: 0, hdg: 61 }, track: [],
  mark: { x: 180, y: 1500 }, manualMark: null,
};

function stepWind(toMs) {
  while (world.wt < toMs) {
    world.wt += 2000;
    const t = (world.wt - t0) / 1000;
    const target = 18 + 0.25 * (t / 60) + 7 * Math.sin(2 * Math.PI * t / 300);
    world.dev += -world.dev * (2 / 120) + 3.5 * Math.sqrt(2 / 60) * gauss();
    world.twd = target + world.dev;
    world.wind.push([world.wt, norm360(world.twd)]);
    if (world.wind.length > 5400) world.wind.shift();
  }
}
function stepBoat(toMs) {
  const b = world.boat;
  while (world.bt < toMs) {
    world.bt += 2000;
    const mk = world.mark;
    const bear = Math.atan2(mk.x - b.x, mk.y - b.y) / DEG;
    if (Math.hypot(mk.x - b.x, mk.y - b.y) < 60) { b.x = 250; b.y = -1450; b.tack = "port"; }
    const shift = normAng(world.twd - 18);
    const otherHdg = b.tack === "port" ? 18 - 43 : 18 + 43;
    const d = normAng(bear - otherHdg);
    const layline = (b.tack === "port" && d <= -2) || (b.tack === "stbd" && d >= 2);
    const header = (b.tack === "port" && shift > 7) || (b.tack === "stbd" && shift < -7);
    if ((layline || header) && world.bt - b.lastTack > 45e3) { b.tack = b.tack === "port" ? "stbd" : "port"; b.lastTack = world.bt; }
    b.hdg = b.tack === "port" ? world.twd + 43 : world.twd - 43;
    const spd = 6 * KTS;
    b.x += spd * Math.sin(b.hdg * DEG) * 2; b.y += spd * Math.cos(b.hdg * DEG) * 2;
    const ll = toLL(b.x, b.y);
    world.track.push([world.bt, ll.latitude, ll.longitude]);
    if (world.track.length > 5400) world.track.shift();
  }
}
stepWind(Date.now()); stepBoat(Date.now());

/* ---- http ---- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

http.createServer((req, res) => {
  const now = Date.now();
  stepWind(now); stepBoat(now);
  const url = req.url.split("?")[0];

  if (url === API + "/state") {
    const ll = toLL(world.boat.x, world.boat.y);
    return json(res, {
      t: now, position: ll,
      headingDeg: norm360(world.boat.hdg), sogKn: 6 + 0.4 * Math.sin(now / 9000),
      twdDeg: norm360(world.twd), twsKn: 12.5 + 1.5 * Math.sin(now / 20000),
      mark: world.manualMark ? { ...world.manualMark, source: "manual" } : { ...toLL(world.mark.x, world.mark.y), source: "course" },
      settings: SETTINGS,
    });
  }
  if (url === API + "/history") return json(res, { wind: world.wind, track: world.track });
  if (url === API + "/mark" && req.method === "PUT") {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => {
      try { const b = JSON.parse(raw); world.manualMark = { latitude: b.latitude, longitude: b.longitude }; json(res, { ...world.manualMark, source: "manual" }); }
      catch (e) { res.writeHead(400); res.end("bad json"); }
    });
    return;
  }
  if (url === API + "/mark" && req.method === "DELETE") { world.manualMark = null; return json(res, { ok: true }); }

  // static webapp
  const file = path.join(PUB, url === "/" ? "index.html" : url);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log("tack-advisor dev server → http://localhost:" + PORT + "/"));

function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
