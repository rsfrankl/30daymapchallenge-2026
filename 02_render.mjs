// Step 2: aggregate places to H3 cells and render a square Dymaxion (Airocean) glow map.
//
// Input : data/places.csv   (from 01_geocode.py)
// Output: data/cells.csv    (h3 cell, n activities, places merged into it)
//         output/day10_prompting_strava_dymaxion.png  (3000 x 3000)
//
// Run: node 02_render.mjs

import fs from "fs";
import {geoAirocean} from "d3-geo-polygon";
import {geoPath, geoRotation, geoInterpolate} from "d3-geo";
import {feature} from "topojson-client";
import {latLngToCell, cellToLatLng} from "h3-js";
import {createCanvas, registerFont} from "canvas";

// ---------- parameters ----------
const H3_RES = 4;            // ~1,770 km² cells, ~22 km edge: merges a metro area, keeps towns apart
const S = 3000;              // square canvas, px
const MARGIN = 110;
const PAL = {                // Northumberland v1.0, inverted onto black; contrast checked (see README)
  bg: "#0B0908",
  water: "#132733",          // deep slate blue (from Northumberland blue), 1.25:1 vs page
  land: "#3A332F",           // warm grey-brown; mustard points 4.6:1 on it, hue split from water
  net: "#C49820",            // Dymaxion net in the activity mustard
  low: "#C49820",            // Northumberland mustard — fewest activities (7.4:1 on bg)
  mid: "#E8B830",            // bright gold (10.7:1)
  high: "#FFF8E6",           // cream-white core — most activities (18.8:1)
  title: "#F4EEE6",
  text: "#C9BDB6",
  muted: "#9C8E88",
};

registerFont("fonts/Jost-800.ttf", {family: "Jost", weight: "800"});
registerFont("fonts/Jost-400.ttf", {family: "Jost", weight: "400"});

// ---------- data ----------
function parseCSV(txt) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [h, ...rest] = rows;
  return rest.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

const places = parseCSV(fs.readFileSync("data/places.csv", "utf8"));
const cells = new Map();
for (const p of places) {
  const id = latLngToCell(+p.lat, +p.lon, H3_RES);
  const c = cells.get(id) ?? {id, n: 0, places: []};
  c.n += +p.n; c.places.push(p.location_summary); cells.set(id, c);
}
const list = [...cells.values()].sort((a, b) => a.n - b.n);   // draw dim first, bright on top
const total = list.reduce((s, c) => s + c.n, 0);
const maxN = list[list.length - 1].n;

fs.writeFileSync("data/cells.csv",
  "h3_cell,n,lat,lon,places\n" + [...list].reverse().map(c => {
    const [la, lo] = cellToLatLng(c.id);
    return `${c.id},${c.n},${la.toFixed(4)},${lo.toFixed(4)},"${c.places.join("; ")}"`;
  }).join("\n") + "\n");

// ---------- scales ----------
const t = n => Math.log(n) / Math.log(maxN);                  // 0 (1 activity) .. 1 (max)
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, u) => a.map((v, i) => Math.round(v + (b[i] - v) * u));
const color = u => u < 0.5 ? mix(hex(PAL.low), hex(PAL.mid), u / 0.5) : mix(hex(PAL.mid), hex(PAL.high), (u - 0.5) / 0.5);
const coreR = u => 7 + 8 * u;          // px; a single activity still gets a 7 px core
const haloR = u => 20 + 36 * u;        // px; minimum glow so lone places read; capped so clusters stay separable

// ---------- canvas ----------
const cv = createCanvas(S, S), ctx = cv.getContext("2d");
ctx.fillStyle = PAL.bg; ctx.fillRect(0, 0, S, S);

const mapTop = 520, mapBottom = 1850;   // map band; title above, legend + notes below
const proj = geoAirocean().fitExtent([[MARGIN, mapTop], [S - MARGIN, mapBottom]], {type: "Sphere"});
const path = geoPath(proj, ctx);

const land = feature(JSON.parse(fs.readFileSync("node_modules/world-atlas/land-50m.json")), "land");
ctx.beginPath(); path({type: "Sphere"}); ctx.fillStyle = PAL.water; ctx.fill();
ctx.beginPath(); path(land); ctx.fillStyle = PAL.land; ctx.fill();

// Dymaxion face triangles: the projection's faces are in its rotated frame, so un-rotate them to lon/lat,
// then draw each edge as a line (great-circle arcs project to straight lines on the net).
const unrot = geoRotation(proj.rotate()).invert;
ctx.globalAlpha = 0.35; ctx.strokeStyle = PAL.net; ctx.lineWidth = 2;
// Vertices are shared by up to five faces, so each endpoint is nudged a hair toward this face's centroid
// before projecting; otherwise it can land on a different piece of the net. An edge is then drawn only if
// its projected midpoint lies on the segment between its endpoints (within 5% of its length; Fuller's
// faces bend edges slightly), i.e. it doesn't cross a cut in the net.
for (const f of proj.faces) {
  const c = unrot(f.site);
  const inward = v => geoInterpolate(unrot(v), c)(1e-4);
  for (let i = 0; i < f.face.length; i++) {
    const a = inward(f.face[i]), b = inward(f.face[(i + 1) % f.face.length]);
    const pa = proj(a), pb = proj(b), pm = proj(geoInterpolate(a, b)(0.5));
    if (!pa || !pb || !pm) continue;
    const off = Math.hypot(pm[0] - (pa[0] + pb[0]) / 2, pm[1] - (pa[1] + pb[1]) / 2);
    if (off > 0.05 * Math.hypot(pb[0] - pa[0], pb[1] - pa[1])) continue;   // cut-crossing edges miss by 100s of px
    ctx.beginPath(); ctx.moveTo(...pa); ctx.lineTo(...pb); ctx.stroke();
  }
}
ctx.globalAlpha = 0.9; ctx.lineWidth = 4;
ctx.beginPath(); path({type: "Sphere"}); ctx.stroke();
ctx.globalAlpha = 1;

function glow(x, y, u, scale = 1) {
  const [r, g, b] = color(u), R = haloR(u) * scale, c = coreR(u) * scale;
  const grd = ctx.createRadialGradient(x, y, 0, x, y, R);
  grd.addColorStop(0, `rgba(${r},${g},${b},0.50)`);
  grd.addColorStop(0.35, `rgba(${r},${g},${b},0.14)`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.beginPath(); ctx.arc(x, y, c, 0, 2 * Math.PI); ctx.fill();
}
for (const c of list) {
  const [la, lo] = cellToLatLng(c.id);
  const xy = proj([lo, la]);
  if (xy) glow(xy[0], xy[1], t(c.n));
}

// ---------- type ----------
ctx.textBaseline = "alphabetic";
ctx.fillStyle = PAL.title; ctx.font = "800 136px Jost";
ctx.fillText("Everywhere Strava thinks I’ve exercised", MARGIN, 300);
ctx.fillStyle = PAL.text; ctx.font = "400 62px Jost";
const fmt = n => n.toLocaleString("en-US");
ctx.fillText(`${fmt(total)} Strava runs, walks, hikes & rides · ${places.length} places · May 2012 – Nov 2026`, MARGIN, 410);

// legend
const ly = 2120;
ctx.fillStyle = PAL.text; ctx.font = "400 50px Jost";
ctx.fillText("Activities per hexagon", MARGIN, ly - 110);
const stops = [1, 10, 100, maxN];
stops.forEach((n, i) => {
  const x = MARGIN + 60 + i * 330;
  glow(x, ly, t(n));
  ctx.fillStyle = PAL.text; ctx.font = "400 50px Jost";
  ctx.fillText(fmt(n), x + 85, ly + 17);
});

// top places (display names for the brightest hexagons, keyed by the cell's largest place)
const NICE = {
  "North Tyneside, United Kingdom": "Tyneside, England",
  "Providence, Rhode Island": "Providence, Rhode Island",
  "Cambridge, Massachusetts": "Cambridge & Boston, Mass.",
  "Hamden, Connecticut": "New Haven & Hamden, Conn.",
  "Bad Schönborn, Germany": "Bad Schönborn, Germany",
  "Brookfield, Vermont": "Brookfield, Vermont",
};
const tx = S / 2 + 160;
ctx.fillStyle = PAL.text; ctx.font = "400 50px Jost";
ctx.fillText("Brightest places", tx, ly - 110);
[...list].reverse().slice(0, 6).forEach((c, i) => {
  const y = ly - 20 + i * 62;
  ctx.fillStyle = PAL.title; ctx.font = "800 44px Jost";
  ctx.textAlign = "right"; ctx.fillText(fmt(c.n), tx + 110, y); ctx.textAlign = "left";
  ctx.fillStyle = PAL.text; ctx.font = "400 44px Jost";
  ctx.fillText(NICE[c.places[0]] ?? c.places[0], tx + 145, y);
});

// notes
ctx.fillStyle = PAL.muted; ctx.font = "400 40px Jost";
const notes = [
  `Each activity placed at its Strava place name, geocoded to town level; ${fmt(2480 - total)} indoor or unlocated activities omitted.`,
  `Aggregated to H3 hexagons (resolution ${H3_RES}, ~22 km edge). Brightness and glow scale with log(count).`,
  "Projection: Buckminster Fuller’s Dymaxion (Airocean) map — no up, no down, continents unbroken.",
];
notes.forEach((s, i) => ctx.fillText(s, MARGIN, 2600 + i * 62));
ctx.fillStyle = PAL.text; ctx.font = "400 44px Jost";
ctx.fillText("#30DayMapChallenge 2026 · Day 10: Prompting only · Rachel Franklin · made 100% by prompting Claude", MARGIN, S - 110);

fs.mkdirSync("output", {recursive: true});
fs.writeFileSync("output/day10_prompting_strava_dymaxion.png", cv.toBuffer("image/png"));
console.log(`cells ${list.length}, total ${total}, max ${maxN}`);
console.log([...list].reverse().slice(0, 8).map(c => `${c.n}  ${c.places.join("; ")}`).join("\n"));
