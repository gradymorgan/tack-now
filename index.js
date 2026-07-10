/*
 * tack-now — Signal K server plugin
 *
 * Buffers true-wind and position history, resolves the next mark (Signal K
 * course destination, or a manual mark set from the webapp), and serves both
 * to the webapp at /plugins/tack-now/*. All model parameters live
 * in the plugin settings (server admin UI → Plugin Config).
 */
const fs = require("fs");
const path = require("path");

const SAMPLE_MS = 2000;          // wind/track sampling cadence
const BUFFER_MS = 3 * 3600e3;    // keep up to 3 h of history
const RAD = 180 / Math.PI;
const MS_TO_KN = 1.94384;

const DEFAULTS = {
  fitWindowMinutes: 30,
  boat: { twa: 43, tackCostSeconds: 6, upwindSpeedKnots: 6, useLiveSpeed: true },
  tactics: { headerThresholdDeg: 6, commitSeconds: 60, laylineMarginDeg: 2, laylineJudgmentSigmaDeg: 3 },
  simulation: { simulations: 600, pathsDrawn: 120 },
  windOverride: { enabled: false, oscAmplitudeDeg: 8, oscPeriodMinutes: 6, trendDegPerMinute: 0, noiseSigma: 4, persistenceTauSeconds: 120 },
};

module.exports = function (app) {
  const plugin = {
    id: "tack-now",
    name: "Tack Now",
    description: "Monte Carlo tack-now-vs-hold advisor for the upwind leg",
  };

  let options = {};
  let unsubscribes = [];
  let timers = [];
  let manualMark = null;
  const latest = { twd: null, twdGround: null, tws: null, twsGround: null, pos: null, hdg: null, cog: null, sog: null, stamp: {} };
  const windBuf = [];   // [tMs, twdDeg]
  const trackBuf = [];  // [tMs, lat, lon]

  const markFile = () => path.join(app.getDataDirPath(), "manual-mark.json");
  const merged = () => deepMerge(DEFAULTS, options || {});

  plugin.schema = {
    type: "object",
    properties: {
      fitWindowMinutes: {
        type: "number", title: "Wind fit window (minutes)", default: 30,
        description: "How much recorded wind history the model is fitted to",
      },
      boat: {
        type: "object", title: "Boat",
        properties: {
          twa: { type: "number", title: "Upwind tacking angle TWA (°)", default: 43 },
          tackCostSeconds: { type: "number", title: "Tack cost (seconds of lost way)", default: 6 },
          upwindSpeedKnots: { type: "number", title: "Upwind boat speed (knots)", default: 6 },
          useLiveSpeed: { type: "boolean", title: "Use live SOG as boat speed when available", default: true },
        },
      },
      tactics: {
        type: "object", title: "Racing model (applies to both simulated boats)",
        properties: {
          headerThresholdDeg: { type: "number", title: "Header threshold (°) — tack when headed beyond this", default: 6 },
          commitSeconds: { type: "number", title: "Commitment after a tack (seconds)", default: 60 },
          laylineMarginDeg: { type: "number", title: "Layline margin (°, + = overstand insurance)", default: 2 },
          laylineJudgmentSigmaDeg: { type: "number", title: "Layline judgment error σ (°)", default: 3 },
        },
      },
      simulation: {
        type: "object", title: "Simulation",
        properties: {
          simulations: { type: "number", title: "Simulations per run", default: 600 },
          pathsDrawn: { type: "number", title: "Paths drawn on the chart", default: 120 },
        },
      },
      windOverride: {
        type: "object", title: "Wind model override (otherwise fitted from history)",
        properties: {
          enabled: { type: "boolean", title: "Override the fitted wind model", default: false },
          oscAmplitudeDeg: { type: "number", title: "Oscillation amplitude (±°)", default: 8 },
          oscPeriodMinutes: { type: "number", title: "Oscillation period (minutes)", default: 6 },
          trendDegPerMinute: { type: "number", title: "Persistent trend (°/minute)", default: 0 },
          noiseSigma: { type: "number", title: "Random noise σ (°/√min)", default: 4 },
          persistenceTauSeconds: { type: "number", title: "Shift persistence τ (seconds)", default: 120 },
        },
      },
    },
  };

  function listen(skPath, fn) {
    const stream = app.streambundle.getSelfStream(skPath);
    unsubscribes.push(stream.onValue((v) => { if (v != null) fn(v); }));
  }

  function pickTwd() {
    const fresh = (k, ms) => latest.stamp[k] != null && Date.now() - latest.stamp[k] < ms;
    // Preference order: a published direction (ground wind on installs running
    // derived-data's Ground Wind calc), then TWD computed from heading + true
    // wind angle (ground- then water-referenced).
    if (fresh("twd", 10e3)) return latest.twd;
    if (fresh("twdGround", 10e3)) return latest.twdGround;
    if (fresh("hdg", 10e3)) {
      if (fresh("atg", 10e3)) return latest.hdg + latest.atg;
      if (fresh("atw", 10e3)) return latest.hdg + latest.atw;
    }
    return null;
  }
  function pickTws() {
    const fresh = (k, ms) => latest.stamp[k] != null && Date.now() - latest.stamp[k] < ms;
    if (fresh("tws", 10e3)) return latest.tws;
    if (fresh("twsGround", 10e3)) return latest.twsGround;
    return null;
  }

  function sample() {
    const now = Date.now();
    const twd = pickTwd();
    if (twd != null) windBuf.push([now, norm360(twd * RAD)]);
    if (latest.pos && latest.pos.latitude != null) trackBuf.push([now, latest.pos.latitude, latest.pos.longitude]);
    const cutoff = now - BUFFER_MS;
    while (windBuf.length && windBuf[0][0] < cutoff) windBuf.shift();
    while (trackBuf.length && trackBuf[0][0] < cutoff) trackBuf.shift();
  }

  function courseMark() {
    for (const p of ["navigation.courseGreatCircle.nextPoint.position", "navigation.courseRhumbline.nextPoint.position"]) {
      let v = app.getSelfPath(p);
      if (v && v.value !== undefined) v = v.value;
      if (v && v.latitude != null) return { latitude: v.latitude, longitude: v.longitude, source: "course" };
    }
    return null;
  }
  function resolveMark() {
    if (manualMark) return { ...manualMark, source: "manual" };
    return courseMark();
  }

  plugin.start = function (opts) {
    options = opts || {};
    try { manualMark = JSON.parse(fs.readFileSync(markFile(), "utf8")); } catch (e) { manualMark = null; }
    listen("environment.wind.directionTrue", (v) => { latest.twd = v; latest.stamp.twd = Date.now(); });
    listen("environment.wind.directionGround", (v) => { latest.twdGround = v; latest.stamp.twdGround = Date.now(); });
    listen("environment.wind.angleTrueGround", (v) => { latest.atg = v; latest.stamp.atg = Date.now(); });
    listen("environment.wind.angleTrueWater", (v) => { latest.atw = v; latest.stamp.atw = Date.now(); });
    listen("environment.wind.speedTrue", (v) => { latest.tws = v; latest.stamp.tws = Date.now(); });
    listen("environment.wind.speedOverGround", (v) => { latest.twsGround = v; latest.stamp.twsGround = Date.now(); });
    listen("navigation.position", (v) => { latest.pos = v; latest.stamp.pos = Date.now(); });
    listen("navigation.headingTrue", (v) => { latest.hdg = v; latest.stamp.hdg = Date.now(); });
    listen("navigation.courseOverGroundTrue", (v) => { latest.cog = v; latest.stamp.cog = Date.now(); });
    listen("navigation.speedOverGround", (v) => { latest.sog = v; latest.stamp.sog = Date.now(); });
    timers.push(setInterval(sample, SAMPLE_MS));
    app.setPluginStatus("Buffering wind & track");
  };

  plugin.stop = function () {
    unsubscribes.forEach((f) => { try { f(); } catch (e) { /* bacon unsubscribe */ } });
    unsubscribes = [];
    timers.forEach(clearInterval);
    timers = [];
  };

  plugin.registerWithRouter = function (router) {
    router.get("/state", (req, res) => {
      const fresh = (k) => latest.stamp[k] != null && Date.now() - latest.stamp[k] < 10e3;
      res.json({
        t: Date.now(),
        position: fresh("pos") ? latest.pos : null,
        headingDeg: fresh("hdg") ? norm360(latest.hdg * RAD) : (fresh("cog") ? norm360(latest.cog * RAD) : null),
        sogKn: fresh("sog") ? latest.sog * MS_TO_KN : null,
        twdDeg: pickTwd() != null ? norm360(pickTwd() * RAD) : null,
        twsKn: pickTws() != null ? pickTws() * MS_TO_KN : null,
        mark: resolveMark(),
        settings: merged(),
      });
    });

    router.get("/history", (req, res) => {
      res.json({ wind: windBuf, track: decimate(trackBuf, 800) });
    });

    router.put("/mark", (req, res) => {
      readJsonBody(req, (err, body) => {
        if (err || !body || body.latitude == null || body.longitude == null) {
          return res.status(400).json({ error: "expected {latitude, longitude}" });
        }
        manualMark = { latitude: body.latitude, longitude: body.longitude };
        try { fs.writeFileSync(markFile(), JSON.stringify(manualMark)); } catch (e) { app.error("mark persist failed: " + e.message); }
        res.json({ ...manualMark, source: "manual" });
      });
    });

    router.delete("/mark", (req, res) => {
      manualMark = null;
      try { fs.unlinkSync(markFile()); } catch (e) { /* not persisted */ }
      res.json({ mark: courseMark() });
    });
  };

  return plugin;
};

function norm360(d) { return ((d % 360) + 360) % 360; }

function decimate(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]);
  out.push(arr[arr.length - 1]);
  return out;
}

function readJsonBody(req, cb) {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) return cb(null, req.body);
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on("end", () => {
    try { cb(null, JSON.parse(raw)); } catch (e) { cb(e); }
  });
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], over[k]);
    } else if (over[k] !== undefined) out[k] = over[k];
  }
  return out;
}
