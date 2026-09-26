// ============================================================================
//  PHYSICS — buoyant rigid bodies (per-sample Archimedes + drag + added mass),
//  compound-sphere contacts, bubbles, spray droplets, ripple impulses
// ============================================================================
const RHO_W = 1000, GRAV = 9.81;
const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const quat = {
  mul: (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
                  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]],
  norm: (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; },
  mat: (q) => { // row-major local->world
    const [x, y, z, w] = q;
    return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  },
  random: (r) => { const u1 = r(), u2 = r() * 2 * Math.PI, u3 = r() * 2 * Math.PI, a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)]; },
};
const mv = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
const mtv = (M, v) => [M[0] * v[0] + M[3] * v[1] + M[6] * v[2], M[1] * v[0] + M[4] * v[1] + M[7] * v[2], M[2] * v[0] + M[5] * v[1] + M[8] * v[2]];

// material classes (match shader): 0 metal 1 dielectric 2 wood 3 glass 4 stone 5 beach ball 6 life ring
const CATALOG = [
  { name: 'Chrome sphere', label: 'Chrome ball', kind: 'sphere', r: 0.15, rho: 2100, mat: 0, alb: [0.96, 0.95, 0.93], rough: 0.03, sink: true },
  { name: 'Brass weight', label: 'Weight', kind: 'cyl', R: 0.105, H: 0.085, rr: 0.018, rho: 3200, mat: 0, alb: [0.98, 0.74, 0.36], rough: 0.2, sink: true },
  { name: 'Copper capsule', label: 'Capsule', kind: 'capsule', L: 0.13, r: 0.065, rho: 2400, mat: 0, alb: [0.97, 0.60, 0.45], rough: 0.14, sink: true },
  { name: 'Glass orb', kind: 'sphere', r: 0.12, rho: 2500, mat: 3, alb: [0.93, 0.99, 0.97], rough: 0.0, sink: true },
  { name: 'Ceramic block', label: 'Ceramic', kind: 'box', h: [0.15, 0.075, 0.11], rr: 0.02, rho: 2300, mat: 1, alb: [0.88, 0.87, 0.84], rough: 0.18, sink: true },
  { name: 'Gold ring', kind: 'torus', R: 0.12, r: 0.035, rho: 4000, mat: 0, alb: [1.0, 0.80, 0.42], rough: 0.1, sink: true },
  { name: 'Wooden crate', label: 'Crate', kind: 'box', h: [0.19, 0.19, 0.19], rr: 0.012, rho: 520, mat: 2, alb: [0.66, 0.45, 0.26], rough: 0.62, sink: false },
  { name: 'Beach ball', kind: 'sphere', r: 0.21, rho: 70, mat: 5, alb: [1, 1, 1], rough: 0.32, sink: false },
  { name: 'Life ring', kind: 'torus', R: 0.24, r: 0.07, rho: 170, mat: 6, alb: [1, 1, 1], rough: 0.45, sink: false },
  { name: 'Red buoy', label: 'Buoy', kind: 'capsule', L: 0.11, r: 0.10, rho: 300, mat: 1, alb: [0.80, 0.05, 0.03], rough: 0.28, sink: false },
  { name: 'Driftwood plank', label: 'Driftwood', kind: 'box', h: [0.34, 0.035, 0.09], rr: 0.012, rho: 480, mat: 2, alb: [0.55, 0.43, 0.31], rough: 0.7, sink: false },
  { name: 'Hover sphere', label: 'Hover ball', kind: 'sphere', r: 0.09, rho: 1015, mat: 1, alb: [0.95, 0.62, 0.05], rough: 0.25, sink: true },
  // table-built models (mat 8): collision (cols) and ripple (disp) spheres are in model units
  { name: 'Rubber duck', kind: 'model', model: 'duck', scale: 0.13, rho: 110, mat: 8, sink: false, upright: true,
    cols: [[0, 0.3, 0, 0.3], [0.25, 0.8, 0, 0.25], [-0.35, 0.35, 0, 0.18]], disp: [[0, 0.28, 0, 0.36]] },
  { name: 'Pirate ship', kind: 'model', model: 'pirate', scale: 0.46, rho: 300, mat: 8, sink: false, upright: true,
    flood: { frac: 0.55, pts: [[0.4, 0.12, 0], [-0.44, 0.12, 0], [0, 0.12, 0.155], [0, 0.12, -0.155], [0.22, 0.12, 0.12], [0.22, 0.12, -0.12]] },
    cols: [[0.32, 0.03, 0, 0.1], [0.12, 0.02, 0, 0.14], [-0.1, 0.02, 0, 0.14], [-0.32, 0.08, 0, 0.12], [0.0, 0.55, 0, 0.12], [0.1, 0.85, 0, 0.1]],
    disp: [[0.22, 0.02, 0, 0.13], [-0.18, 0.02, 0, 0.15]] },
  { name: 'Toy battleship', label: 'Battleship', kind: 'model', model: 'battleship', scale: 0.55, rho: 330, mat: 8, sink: false, upright: true,
    flood: { frac: 0.5, pts: [[0.46, 0.105, 0], [-0.46, 0.105, 0], [0, 0.105, 0.085], [0, 0.105, -0.085], [0.25, 0.105, 0.065], [-0.25, 0.105, -0.075]] },
    cols: [[0.36, 0.045, 0, 0.06], [0.18, 0.045, 0, 0.08], [0.0, 0.045, 0, 0.085], [-0.18, 0.045, 0, 0.085], [-0.36, 0.045, 0, 0.07], [0.05, 0.185, 0, 0.07]],
    disp: [[0.2, 0.045, 0, 0.09], [-0.2, 0.045, 0, 0.1]] },
  { name: 'Message bottle', label: 'Bottle', kind: 'model', model: 'bottle', scale: 1, rho: 520, mat: 8, sink: false, upright: true,
    cols: [[-0.04, 0, 0, 0.038], [0.03, 0, 0, 0.036], [0.09, 0, 0, 0.024], [0.14, 0, 0, 0.015]], disp: [[0, 0, 0, 0.05]] },
  { name: 'Treasure chest', label: 'Chest', kind: 'model', model: 'chest', scale: 1, rho: 1900, mat: 8, sink: true,
    cols: [[0, -0.01, 0, 0.075], ...[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x * 0.105, y * 0.055 - 0.005, z * 0.055, 0.045])))] },
  { name: 'Anchor', kind: 'model', model: 'anchor', scale: 1, rho: 7000, mat: 8, sink: true,
    cols: [[0, 0.1, 0, 0.015], [0, 0, 0, 0.015], [0, -0.1, 0, 0.015], [0, 0.19, 0, 0.04], [0.09, -0.12, 0, 0.025], [-0.09, -0.12, 0, 0.025],
      [0.14, -0.06, 0, 0.025], [-0.14, -0.06, 0, 0.025], [0, 0.11, 0.09, 0.012], [0, 0.11, -0.09, 0.012], [0, -0.15, 0, 0.02]] },
  { name: 'Amphora', kind: 'model', model: 'amphora', scale: 1, rho: 1900, mat: 8, sink: true,
    cols: [[0, 0.02, 0, 0.1], [0, -0.1, 0, 0.07], [0, -0.19, 0, 0.03], [0, 0.15, 0, 0.06], [0, 0.25, 0, 0.034], [0.076, 0.2, 0, 0.018], [-0.076, 0.2, 0, 0.018]] },
  { name: "Diver's helmet", label: 'Dive helmet', kind: 'model', model: 'helmet', scale: 1, rho: 2600, mat: 8, sink: true,
    cols: [[0, 0.07, 0, 0.13], [0, -0.07, 0, 0.05], [0.14, -0.075, 0, 0.045], [-0.14, -0.075, 0, 0.045], [0, -0.075, 0.115, 0.045], [0, -0.075, -0.115, 0.045],
      [0.1, -0.075, 0.08, 0.045], [-0.1, -0.075, 0.08, 0.045], [0.1, -0.075, -0.08, 0.045], [-0.1, -0.075, -0.08, 0.045]] },
  { name: 'Cannonball', kind: 'sphere', r: 0.065, rho: 7800, mat: 0, alb: [0.07, 0.068, 0.066], rough: 0.55, sink: true },
];
const TYPE_ID = { sphere: 0, box: 1, capsule: 2, cyl: 3, torus: 4, ellipsoid: 5, model: 6 };

function shapeSDF(b, p) {
  const k = b.prm;
  switch (b.kind) {
    case 'box': { const q = [Math.abs(p[0]) - k[0] + k[3], Math.abs(p[1]) - k[1] + k[3], Math.abs(p[2]) - k[2] + k[3]];
      return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0) - k[3]; }
    case 'cyl': { const d = [Math.hypot(p[0], p[2]) - k[0] + k[2], Math.abs(p[1]) - k[1] + k[2]];
      return Math.min(Math.max(d[0], d[1]), 0) + Math.hypot(Math.max(d[0], 0), Math.max(d[1], 0)) - k[2]; }
    case 'torus': return Math.hypot(Math.hypot(p[0], p[2]) - k[0], p[1]) - k[1];
    case 'capsule': { const y = Math.max(-k[0], Math.min(k[0], p[1])); return Math.hypot(p[0], p[1] - y, p[2]) - k[1]; }
    case 'ellipsoid': { const q = [p[0] / k[0], p[1] / k[1], p[2] / k[2]]; return (Math.hypot(q[0], q[1], q[2]) - 1) * Math.min(k[0], k[1], k[2]); }
    case 'model': return sdfModelJS(b.model.prims, [p[0] / k[0], p[1] / k[0], p[2] / k[0]], true) * k[0];
    default: return Math.hypot(p[0], p[1], p[2]) - k[0];
  }
}

let BODY_ID = 1;
// Table-built shapes: adaptive octree sampling of the solid form (cells straddling the surface are split
// down to ~bound/96, so thin parts like an anchor's shank and ring still count). Gives the volume, the
// extents, volume-weighted buoyancy samples (atoms binned 7x7x7 over the extents) and the inertia per
// unit density about the model origin. Cached per model and scale.
const MODEL_SOLID = {};
function modelSolid(t) {
  const key = t.model + '@' + t.scale;
  if (MODEL_SOLID[key]) return MODEL_SOLID[key];
  const M = MODELS[t.model], sc = t.scale, bb = modelBound(M.prims) * sc, isc = 1 / sc;
  const f = (x, y, z) => sdfModelJS(M.prims, [x * isc, y * isc, z * isc], true) * sc;
  const atoms = [], N0 = 12, h0 = bb / N0, lv = Math.max(2, Math.min(3, Math.round(Math.log2(2 * h0 / 0.0045))));
  const rec = (x, y, z, h, l) => {
    const d = f(x, y, z), r = h * 1.7321;
    if (d > r) return;
    if (d < -r || l === 0) { if (d < 0) atoms.push([x, y, z, 8 * h * h * h, h]); return; }
    const hh = h / 2;
    for (let i = 0; i < 8; i++) rec(x + (i & 1 ? hh : -hh), y + (i & 2 ? hh : -hh), z + (i & 4 ? hh : -hh), hh, l - 1);
  };
  for (let i = 0; i < N0; i++) for (let j = 0; j < N0; j++) for (let k = 0; k < N0; k++)
    rec(-bb + (2 * i + 1) * h0, -bb + (2 * j + 1) * h0, -bb + (2 * k + 1) * h0, h0, lv);
  let V = 0; const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], I = [0, 0, 0];
  for (const a of atoms) {
    V += a[3];
    for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], a[c] - a[4]); hi[c] = Math.max(hi[c], a[c] + a[4]); }
    const s = a[4] * a[4] * 2 / 3;   // a cube's own second moment
    I[0] += a[3] * (a[1] * a[1] + a[2] * a[2] + s); I[1] += a[3] * (a[0] * a[0] + a[2] * a[2] + s); I[2] += a[3] * (a[0] * a[0] + a[1] * a[1] + s);
  }
  if (!atoms.length) { V = 1e-6; lo.fill(-0.01); hi.fill(0.01); I.fill(1e-8); }
  // bin the atoms into buoyancy samples at their volume-weighted centroids. Bin edges sit at volume
  // quantiles along each axis, so samples crowd where the volume is (the hull, not the masts); each
  // sample keeps its slab's half-height for the partial-submersion ramp.
  const nb = [5, 6, 5];
  const edges = [0, 1, 2].map(c => {
    const s = atoms.map(a => [a[c], a[3]]).sort((x, y) => x[0] - y[0]);
    const e = [lo[c]]; let acc = 0, k = 1;
    for (const [x, v] of s) { acc += v; while (k < nb[c] && acc >= V * k / nb[c]) { e.push(x); k++; } }
    while (e.length < nb[c]) e.push(hi[c]);
    e.push(hi[c]);
    return e;
  });
  const binOf = (c, x) => { let i = 0; while (i < nb[c] - 1 && x >= edges[c][i + 1]) i++; return i; };
  const bins = new Map();
  for (const a of atoms) {
    const i = binOf(0, a[0]), j = binOf(1, a[1]), k = binOf(2, a[2]), id = (i * 8 + j) * 8 + k;
    let s = bins.get(id);
    if (!s) { s = [0, 0, 0, 0, j]; bins.set(id, s); }
    s[0] += a[0] * a[3]; s[1] += a[1] * a[3]; s[2] += a[2] * a[3]; s[3] += a[3];
  }
  const samples = [];
  for (const s of bins.values()) if (s[3] > V * 2e-4)
    samples.push({ p: [s[0] / s[3], s[1] / s[3], s[2] / s[3]], v: s[3], e: Math.max(0.004, (edges[1][s[4] + 1] - edges[1][s[4]]) * 0.5) });
  const tot = samples.reduce((q, s) => q + s.v, 0);
  for (const s of samples) s.v *= V / tot;
  return (MODEL_SOLID[key] = { V, lo, hi, I, samples, sampE: (hi[1] - lo[1]) / 12 });
}
function makeBody(t, pos, q, isStatic) {
  const b = { name: t.name, kind: t.kind, type: TYPE_ID[t.kind], mat: t.mat, alb: t.alb, rough: t.rough, seed: Math.random() * 20,
    pos: pos.slice(), vel: [0, 0, 0], q: q.slice(), w: [0, 0, 0], static: !!isStatic, id: BODY_ID++, age: 0,
    sub: 0, trail: 0, prevDisp: null };
  let V, I, ext, lo = null, hi = null, MS = null;
  if (t.kind === 'model') {
    // table-built shape: volume, extents and buoyancy samples come from sampling its solid form
    const M = MODELS[t.model], sc = t.scale;
    b.model = M; b.prm = [sc, 0, 0, 0]; b.bound = modelBound(M.prims) * sc;
    MS = modelSolid(t);
    V = MS.V; lo = MS.lo; hi = MS.hi;
    ext = [0, 1, 2].map(a => Math.max((hi[a] - lo[a]) / 2, 0.01));
    b.cols = t.cols.map(c => ({ p: [c[0] * sc, c[1] * sc, c[2] * sc], r: c[3] * sc }));
    b.disp = (t.disp || []).map(c => ({ p: [c[0] * sc, c[1] * sc, c[2] * sc], r: c[3] * sc }));
    if (t.flood) { b.floodPts = t.flood.pts.map(p => [p[0] * sc, p[1] * sc, p[2] * sc]); b.floodFrac = t.flood.frac; b.flood = 0; }
  } else if (t.kind === 'sphere') {
    b.prm = [t.r, 0, 0, 0]; b.bound = t.r; V = 4 / 3 * Math.PI * t.r ** 3; ext = [t.r, t.r, t.r];
    b.cols = [{ p: [0, 0, 0], r: t.r }]; b.disp = [{ p: [0, 0, 0], r: t.r }];
  } else if (t.kind === 'box') {
    const [hx, hy, hz] = t.h; b.prm = [hx, hy, hz, t.rr]; b.bound = Math.hypot(hx, hy, hz); V = 8 * hx * hy * hz; ext = t.h;
    const rho = Math.min(hx, hy, hz) * 0.55; b.cols = [{ p: [0, 0, 0], r: Math.min(hx, hy, hz) }];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) b.cols.push({ p: [sx * (hx - rho), sy * (hy - rho), sz * (hz - rho)], r: rho });
    const dr = Math.cbrt(hx * hy * hz) * 0.95;
    b.disp = hx > 2 * hz ? [{ p: [-hx * 0.5, 0, 0], r: dr * 0.8 }, { p: [hx * 0.5, 0, 0], r: dr * 0.8 }] : [{ p: [0, 0, 0], r: dr * 1.15 }];
  } else if (t.kind === 'capsule') {
    b.prm = [t.L, t.r, 0, 0]; b.bound = t.L + t.r; V = Math.PI * t.r * t.r * 2 * t.L + 4 / 3 * Math.PI * t.r ** 3; ext = [t.r, t.L + t.r, t.r];
    b.cols = [-1, -0.5, 0, 0.5, 1].map(s => ({ p: [0, s * t.L, 0], r: t.r }));
    b.disp = [-0.7, 0, 0.7].map(s => ({ p: [0, s * t.L, 0], r: t.r * 1.05 }));
  } else if (t.kind === 'cyl') {
    b.prm = [t.R, t.H, t.rr, 0]; b.bound = Math.hypot(t.R, t.H); V = Math.PI * t.R * t.R * 2 * t.H; ext = [t.R, t.H, t.R];
    b.cols = [{ p: [0, 0, 0], r: Math.min(t.R, t.H) }];
    for (let i = 0; i < 8; i++) { const a = i / 8 * 2 * Math.PI, rr = Math.min(t.H, t.R * 0.5); b.cols.push({ p: [Math.cos(a) * (t.R - rr), 0, Math.sin(a) * (t.R - rr)], r: rr }); }
    b.disp = [{ p: [0, 0, 0], r: Math.cbrt(t.R * t.R * t.H) * 1.2 }];
  } else if (t.kind === 'torus') {
    b.prm = [t.R, t.r, 0, 0]; b.bound = t.R + t.r; V = 2 * Math.PI * Math.PI * t.R * t.r * t.r; ext = [t.R + t.r, t.r, t.R + t.r];
    b.cols = []; b.disp = [];
    for (let i = 0; i < 10; i++) { const a = i / 10 * 2 * Math.PI; b.cols.push({ p: [Math.cos(a) * t.R, 0, Math.sin(a) * t.R], r: t.r }); }
    for (let i = 0; i < 5; i++) { const a = i / 5 * 2 * Math.PI; b.disp.push({ p: [Math.cos(a) * t.R, 0, Math.sin(a) * t.R], r: t.r * 1.5 }); }
  } else {
    b.prm = [t.a, t.b, t.c, 0]; b.bound = Math.max(t.a, t.b, t.c); V = 4 / 3 * Math.PI * t.a * t.b * t.c; ext = [t.a, t.b, t.c];
    const m = Math.min(t.a, t.b, t.c);
    b.cols = [{ p: [0, 0, 0], r: m }];
    for (const s of [-1, 1]) {
      if (t.a > m * 1.3) b.cols.push({ p: [s * (t.a - m * 0.9), 0, 0], r: m * 0.9 });
      if (t.c > m * 1.3) b.cols.push({ p: [0, 0, s * (t.c - m * 0.9)], r: m * 0.9 });
    }
    b.disp = [];
  }
  b.V = V;
  b.mass = (t.rho || 1000) * V;
  const m = b.mass;
  if (t.kind === 'sphere') I = [0.4 * m * t.r * t.r, 0.4 * m * t.r * t.r, 0.4 * m * t.r * t.r];
  else if (t.kind === 'torus') I = [m * (t.R * t.R / 2 + 5 / 8 * t.r * t.r), m * (t.R * t.R + 0.75 * t.r * t.r), m * (t.R * t.R / 2 + 5 / 8 * t.r * t.r)];
  else if (MS) {
    // from the sampled solid, floored at a fraction of the box estimate so slender shapes don't spin up
    const box = [ext[1] ** 2 + ext[2] ** 2, ext[0] ** 2 + ext[2] ** 2, ext[0] ** 2 + ext[1] ** 2];
    I = MS.I.map((x, a) => Math.max(x * t.rho, m / 3 * box[a] * 0.15));
  }
  else I = [m / 3 * (ext[1] ** 2 + ext[2] ** 2), m / 3 * (ext[0] ** 2 + ext[2] ** 2), m / 3 * (ext[0] ** 2 + ext[1] ** 2)];
  b.I = I;
  b.invM = b.static ? 0 : 1 / m;
  b.invI = b.static ? [0, 0, 0] : [1 / I[0], 1 / I[1], 1 / I[2]];
  // buoyancy samples: from the sampled solid (models), or the SDF over the shape's bounding box
  b.samples = [];
  const n = 5;
  if (MS) {
    b.samples = MS.samples.map(s => ({ p: s.p.slice(), v: s.v, e: s.e }));
    b.sampE = MS.sampE;
  } else {
    if (!lo) { lo = ext.map(e => -e); hi = ext.slice(); }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      const p = [lo[0] + (i + 0.5) / n * (hi[0] - lo[0]), lo[1] + (j + 0.5) / n * (hi[1] - lo[1]), lo[2] + (k + 0.5) / n * (hi[2] - lo[2])];
      if (shapeSDF(b, p) < 0) b.samples.push({ p, v: 0 });
    }
    if (!b.samples.length) b.samples.push({ p: [0, 0, 0], v: 0 });
    for (const s of b.samples) s.v = V / b.samples.length;
    b.sampE = ((hi[1] - lo[1]) / n) * 0.5;
  }
  b.mass0 = b.mass; b.I0 = b.I.slice();
  if (b.floodPts) b.floodV = V * b.floodFrac;
  b.dragA = Math.pow(V / b.samples.length, 2 / 3) * Math.pow(b.samples.length, -1 / 3) * 1.25;
  return b;
}

// ---------------------------------------------------------------- water state (from async GPU readback)
const WATER = {
  valid: false,
  cell(x, z) {
    const u = (x + TANK.TX) / (2 * TANK.TX) * R.probeW - 0.5, v = (z + TANK.TZ) / (2 * TANK.TZ) * R.probeH - 0.5;
    const i = Math.max(0, Math.min(R.probeW - 2, Math.floor(u))), j = Math.max(0, Math.min(R.probeH - 2, Math.floor(v)));
    return { i, j, fx: Math.max(0, Math.min(1, u - i)), fz: Math.max(0, Math.min(1, v - j)) };
  },
  sample(arr, x, z, ch) {
    const c = this.cell(x, z), W = R.probeW;
    const a = arr[((c.j) * W + c.i) * 4 + ch], b = arr[((c.j) * W + c.i + 1) * 4 + ch];
    const d = arr[((c.j + 1) * W + c.i) * 4 + ch], e = arr[((c.j + 1) * W + c.i + 1) * 4 + ch];
    return (a * (1 - c.fx) + b * c.fx) * (1 - c.fz) + (d * (1 - c.fx) + e * c.fx) * c.fz;
  },
  inside(x, z) { return Math.abs(x) < TANK.TX && Math.abs(z) < TANK.TZ; },
  heightAt(x, z) {
    if (!this.inside(x, z)) return -1e9;
    if (!R.probeValid) return TANK.LEVEL;
    return this.sample(R.probeData, x, z, 0) + this.sample(R.probeData, x, z, 3);
  },
  oceanAt(x, z) {
    if (!this.inside(x, z)) return -1e9;
    if (!R.probeValid) return TANK.LEVEL;
    return this.sample(R.probeData, x, z, 0);
  },
  rippleAt(x, z) {
    if (!R.probeValid) return 0;
    const cx = Math.max(-TANK.TX, Math.min(TANK.TX, x)), cz = Math.max(-TANK.TZ, Math.min(TANK.TZ, z));
    return this.sample(R.probeData, cx, cz, 3);
  },
  // incident ripple level around a body (excludes its own displacement dip)
  rippleRing(x, z, r) {
    let s = 0;
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; s += this.rippleAt(x + Math.cos(a) * r, z + Math.sin(a) * r); }
    return s / 8;
  },
  velAt(x, y, z, t) {
    let vx = 0, vy = 0, vz = 0;
    const h = this.oceanAt(x, z);
    if (R.probeValid && R.probePrev && R.probeTime > R.probePrevTime) {
      const dt = R.probeTime - R.probePrevTime;
      vx = (this.sample(R.probeData, x, z, 1) - this.sample(R.probePrev, x, z, 1)) / dt;
      vy = (h - this.sample(R.probePrev, x, z, 0)) / dt;
      vz = (this.sample(R.probeData, x, z, 2) - this.sample(R.probePrev, x, z, 2)) / dt;
      const cl = (a) => Math.max(-3, Math.min(3, a));
      vx = cl(vx); vy = cl(vy); vz = cl(vz);
    }
    const decay = Math.exp(-Math.max(0, h - y) * 4.0);
    // slow circulating current with turbulence
    const c = STATE.current;
    const cx = -z * 0.08 * c + Math.sin(t * 0.37 + z * 2.1) * 0.03 * c;
    const cz = x * 0.08 * c + Math.cos(t * 0.29 + x * 1.7) * 0.03 * c;
    return [vx * decay + cx, vy * decay, vz * decay + cz];
  },
};

// ---------------------------------------------------------------- particles & events
const BUBBLES = [], DROPS = [], IMPULSES = [];
function addImpulse(x, z, radius, depth) {
  if (!WATER.inside(x, z)) return;
  IMPULSES.push([x, z, radius, depth]);
}
function spawnBubble(p, r, v) {
  if (BUBBLES.length >= 400) BUBBLES.shift();
  BUBBLES.push({ p: p.slice(), v: v ? v.slice() : [0, 0, 0], r, ph: Math.random() * 6.28, life: 0 });
}
function spawnDrop(p, v, r) {
  if (DROPS.length >= 300) DROPS.shift();
  DROPS.push({ p: p.slice(), v: v.slice(), r });
}
function splash(b, speed) {
  const s = Math.min(speed, 7), size = b.bound;
  const nd = Math.round(Math.min(90, 14 + s * size * 110));
  for (let i = 0; i < nd; i++) {
    const a = Math.random() * 2 * Math.PI, rr = size * (0.7 + Math.random() * 0.6);
    const up = (0.9 + Math.random() * 2.4) * (0.45 + s * 0.35), out = 0.3 + Math.random() * 1.3 * (0.5 + s * 0.2);
    spawnDrop([b.pos[0] + Math.cos(a) * rr, WATER.heightAt(b.pos[0], b.pos[2]) + 0.01, b.pos[2] + Math.sin(a) * rr],
      [Math.cos(a) * out, up, Math.sin(a) * out], 0.0025 + Math.random() * Math.random() * 0.009);
  }
  const nb = Math.round(Math.min(70, 10 + s * size * 90));
  for (let i = 0; i < nb; i++) {
    const a = Math.random() * 2 * Math.PI, rr = size * Math.random() * 1.1;
    spawnBubble([b.pos[0] + Math.cos(a) * rr, b.pos[1] - Math.random() * size, b.pos[2] + Math.sin(a) * rr],
      0.0018 + Math.pow(Math.random(), 2.5) * 0.009, [Math.cos(a) * 0.2, -Math.random() * s * 0.2, Math.sin(a) * 0.2]);
  }
  addImpulse(b.pos[0], b.pos[2], size * 1.5, Math.min(0.06, 0.008 + s * size * 0.03));
  kickFloaters(b.pos[0], b.pos[2], Math.min(1, s * size * 1.6), b);
  if (b.mat === 0 || b.mat === 3 || b.mat === 1) b.trail = 1.6;
}
// the splash ring lifts and shoves nearby floating bodies (replaces ripple-driven buoyancy)
function kickFloaters(x, z, strength, self) {
  for (const o of BODIES) {
    if (o.static || o.sleep || o === self || o.sub <= 0.01 || o.sub >= 0.97) continue;
    const dx = o.pos[0] - x, dz = o.pos[2] - z, d = Math.hypot(dx, dz);
    const R0 = 0.35 + strength * 0.9;
    if (d > R0 || d < 1e-4) continue;
    const f = (1 - d / R0) ** 2 * strength;
    o.vel = v3.add(o.vel, [dx / d * 0.55 * f, 0.9 * f, dz / d * 0.55 * f]);
    o.w = v3.add(o.w, [(Math.random() - 0.5) * 2.5 * f, (Math.random() - 0.5) * 2.5 * f, (Math.random() - 0.5) * 2.5 * f]);
  }
}
function stepParticles(dt, t) {
  for (let i = BUBBLES.length - 1; i >= 0; i--) {
    const q = BUBBLES[i];
    q.life += dt;
    const vt = 0.12 + q.r * 32;
    q.v[1] += (vt - q.v[1]) * Math.min(1, dt * 6);
    q.v[0] *= Math.exp(-dt * 3); q.v[2] *= Math.exp(-dt * 3);
    const wv = WATER.velAt(q.p[0], q.p[1], q.p[2], t);
    const wob = Math.min(1, q.r * 300) * 0.06;
    q.p[0] += (q.v[0] + wv[0] * 0.6 + Math.sin(t * 13 + q.ph) * wob) * dt;
    q.p[1] += q.v[1] * dt;
    q.p[2] += (q.v[2] + wv[2] * 0.6 + Math.cos(t * 11 + q.ph) * wob) * dt;
    q.p[0] = Math.max(-TANK.TX + q.r, Math.min(TANK.TX - q.r, q.p[0]));
    q.p[2] = Math.max(-TANK.TZ + q.r, Math.min(TANK.TZ - q.r, q.p[2]));
    q.p[1] = Math.max(TANK.BOT + q.r, q.p[1]);
    if (q.p[1] + q.r > WATER.heightAt(q.p[0], q.p[2])) {
      if (q.r > 0.003) addImpulse(q.p[0], q.p[2], 0.035 + q.r * 4, q.r * 0.25);
      BUBBLES.splice(i, 1);
    }
  }
  for (let i = DROPS.length - 1; i >= 0; i--) {
    const d = DROPS[i];
    const sp = v3.len(d.v), k = 0.9 * sp * 0.0012 / d.r;
    d.v[1] -= GRAV * dt;
    d.v = v3.mul(d.v, Math.exp(-k * dt));
    d.p = v3.add(d.p, v3.mul(d.v, dt));
    const h = WATER.heightAt(d.p[0], d.p[2]);
    if (d.p[1] < h && d.v[1] < 0) {
      addImpulse(d.p[0], d.p[2], 0.02 + d.r * 5, d.r * 0.5);
      if (d.r > 0.004 && Math.random() < 0.5) spawnBubble([d.p[0], h - 0.01, d.p[2]], 0.0015 + Math.random() * 0.002);
      DROPS.splice(i, 1);
    } else if (d.p[1] < 0) DROPS.splice(i, 1);
  }
}

// ---------------------------------------------------------------- rigid bodies
const BODIES = [];
function worldInvInertia(b, Rm) {
  // R diag(invI) R^T as a function
  return (v) => { const l = mtv(Rm, v); return mv(Rm, [l[0] * b.invI[0], l[1] * b.invI[1], l[2] * b.invI[2]]); };
}
function contact(A, B, cp, n, pen, e, mu) {
  const RA = quat.mat(A.q), IA = worldInvInertia(A, RA);
  const bDyn = !!B && !B.static && !B.sleep;
  const RB = B ? quat.mat(B.q) : null, IB = B ? worldInvInertia(B, RB) : null;
  const ra = v3.sub(cp, A.pos), rb = B ? v3.sub(cp, B.pos) : [0, 0, 0];
  const invB = bDyn ? B.invM : 0;
  const tot = A.invM + invB;
  if (tot <= 0) return;
  const corr = Math.max(pen - 0.0015, 0) * 0.7 / tot;
  A.pos = v3.add(A.pos, v3.mul(n, corr * A.invM));
  if (bDyn) B.pos = v3.sub(B.pos, v3.mul(n, corr * invB));
  const va = v3.add(A.vel, v3.cross(A.w, ra)), vb = B ? v3.add(B.vel, v3.cross(B.w, rb)) : [0, 0, 0];
  const vr = v3.sub(va, vb), vn = v3.dot(vr, n);
  if (vn >= 0) return;
  const kOf = (dir) => {
    let k = A.invM + v3.dot(dir, v3.cross(IA(v3.cross(ra, dir)), ra));
    if (bDyn) k += invB + v3.dot(dir, v3.cross(IB(v3.cross(rb, dir)), rb));
    return k;
  };
  const j = -(1 + (Math.abs(vn) > 0.4 ? e : 0)) * vn / kOf(n);
  const apply = (imp) => {
    A.vel = v3.add(A.vel, v3.mul(imp, A.invM)); A.w = v3.add(A.w, IA(v3.cross(ra, imp)));
    if (bDyn) { B.vel = v3.sub(B.vel, v3.mul(imp, invB)); B.w = v3.sub(B.w, IB(v3.cross(rb, imp))); }
  };
  apply(v3.mul(n, j));
  const vt = v3.sub(vr, v3.mul(n, vn)), vtl = v3.len(vt);
  if (vtl > 1e-5) {
    const tdir = v3.mul(vt, 1 / vtl);
    let jt = -vtl / kOf(tdir);
    jt = Math.max(-mu * j, Math.min(mu * j, jt));
    apply(v3.mul(tdir, jt));
  }
}
function stepBodies(dt, t) {
  const T = TANK;
  for (const b of BODIES) {
    if (b.static || b.sleep) continue;
    b.age += dt;
    const Rm = quat.mat(b.q);
    // boats swamp once the gunwale goes under (or they heel right over), take on water and sink
    if (b.floodPts && b.flood < 1) {
      let wet = 0;
      for (const fp of b.floodPts) { const w = v3.add(b.pos, mv(Rm, fp)); if (WATER.inside(w[0], w[2]) && w[1] < WATER.heightAt(w[0], w[2]) - 0.004) wet++; }
      if (Rm[4] < 0.3) wet += 2;
      if (wet > 0) {
        b.flood = Math.min(1, b.flood + dt * 0.05 * wet);
        const m2 = b.mass0 + b.flood * b.floodV * RHO_W * 0.97, r = m2 / b.mass;
        b.mass = m2; b.invM = 1 / m2;
        b.I = b.I.map(x => x * r); b.invI = b.I.map(x => 1 / x);
      }
    }
    let F = [0, -b.mass * GRAV, 0], Tq = [0, 0, 0], vsub = 0;
    // Froude-Krylov: buoyancy from the incident ocean field only. The ripple layer is this body's own
    // radiated/diffracted wave; feeding it back into its buoyancy creates a self-exciting loop.
    for (const s of b.samples) {
      const r = mv(Rm, s.p), pw = v3.add(b.pos, r);
      const hw = WATER.oceanAt(pw[0], pw[2]);
      const se = s.e || b.sampE;
      const f = Math.max(0, Math.min(1, (hw - (pw[1] - se)) / (2 * se)));
      const vp = v3.add(b.vel, v3.cross(b.w, r));
      let Fs;
      if (f > 0) {
        const vw = WATER.velAt(pw[0], pw[1], pw[2], t);
        const u = v3.sub(vp, vw), ul = v3.len(u);
        Fs = v3.mul(u, -RHO_W * b.dragA * f * (0.5 * 0.9 * ul + 0.25));
        // wave-radiation damping acts at the waterline (samples partially submerged)
        const wl = 4 * f * (1 - f) * RHO_W * s.v * 26;
        Fs[0] -= wl * u[0] * 0.35; Fs[1] -= wl * u[1]; Fs[2] -= wl * u[2] * 0.35;
        Fs[1] += RHO_W * GRAV * s.v * f;
        vsub += s.v * f;
      } else {
        Fs = v3.mul(vp, -1.2 * b.dragA * 0.5 * v3.len(vp) * 0.6);
      }
      F = v3.add(F, Fs);
      Tq = v3.add(Tq, v3.cross(r, Fs));
    }
    const wasSub = b.sub;
    b.sub = vsub / b.V;
    if (wasSub < 0.02 && b.sub >= 0.02 && b.vel[1] < -0.6) splash(b, -b.vel[1]);
    const meff = b.mass + 0.5 * RHO_W * vsub;
    const iscale = b.mass / (b.mass + 0.35 * RHO_W * vsub);
    b.vel = v3.add(b.vel, v3.mul(F, dt / meff));
    const IW = worldInvInertia(b, Rm);
    b.w = v3.add(b.w, v3.mul(IW(Tq), dt * iscale));
    const wd = Math.exp(-dt * (0.25 + 2.2 * b.sub));
    b.w = v3.mul(b.w, wd);
    const sp = v3.len(b.w);
    if (sp > 25) b.w = v3.mul(b.w, 25 / sp);
    b.pos = v3.add(b.pos, v3.mul(b.vel, dt));
    const wq = [b.w[0] * dt * 0.5, b.w[1] * dt * 0.5, b.w[2] * dt * 0.5, 0];
    const dq = quat.mul(wq, b.q);
    b.q = quat.norm([b.q[0] + dq[0], b.q[1] + dq[1], b.q[2] + dq[2], b.q[3] + dq[3]]);
    // resting on the bed: bleed off contact jitter
    if (b.sub > 0.95 && v3.len(b.vel) < 0.06 && v3.len(b.w) < 0.4) {
      let low = 1e9;
      for (const c of b.cols) low = Math.min(low, b.pos[1] + mv(Rm, c.p)[1] - c.r);
      if (low < TANK.BOT + sandHeightAt(b.pos[0], b.pos[2]) + 0.006) { const k = Math.exp(-dt * 8); b.vel = v3.mul(b.vel, k); b.w = v3.mul(b.w, k); }
    }
    // asleep once slow, submerged and supported for a while: frozen, so a growing substrate can bury it
    const slow = b.sub > 0.95 && v3.len(b.vel) < 0.05 && v3.len(b.w) < 0.3 && t - (b.touchT || -1e9) < 0.15;
    b.rest = slow ? (b.rest || 0) + dt : 0;
    if (b.rest > 1.5 && sandBuries()) { b.sleep = true; b.vel = [0, 0, 0]; b.w = [0, 0, 0]; }
    if (b.trail > 0) {
      b.trail -= dt;
      const vs = v3.len(b.vel);
      if (b.sub > 0.5 && vs > 0.25 && Math.random() < dt * vs * 70) {
        const a = Math.random() * 6.28;
        spawnBubble([b.pos[0] + Math.cos(a) * b.bound * 0.6, b.pos[1] + b.bound * 0.5, b.pos[2] + Math.sin(a) * b.bound * 0.6],
          0.0015 + Math.pow(Math.random(), 3) * 0.006, [0, 0.1, 0]);
      }
    }
  }
  // contacts: tank walls + floor, then pairs
  for (const A of BODIES) {
    if (A.static || A.sleep) continue;
    const Rm = quat.mat(A.q);
    const inX = Math.abs(A.pos[0]) < T.TX + 0.3 && Math.abs(A.pos[2]) < T.TZ + 0.3;
    for (const c of A.cols) {
      const cw = v3.add(A.pos, mv(Rm, c.p));
      if (inX) {
        if (cw[0] + c.r > T.TX) contact(A, null, [T.TX, cw[1], cw[2]], [-1, 0, 0], cw[0] + c.r - T.TX, 0.25, 0.3);
        if (cw[0] - c.r < -T.TX) contact(A, null, [-T.TX, cw[1], cw[2]], [1, 0, 0], -T.TX - (cw[0] - c.r), 0.25, 0.3);
        if (cw[2] + c.r > T.TZ) contact(A, null, [cw[0], cw[1], T.TZ], [0, 0, -1], cw[2] + c.r - T.TZ, 0.25, 0.3);
        if (cw[2] - c.r < -T.TZ) contact(A, null, [cw[0], cw[1], -T.TZ], [0, 0, 1], -T.TZ - (cw[2] - c.r), 0.25, 0.3);
        // bed: bare glass floor or the sand substrate (sloped normal, softer and grippier)
        const sh = sandHeightAt(cw[0], cw[2]), bed = T.BOT + sh;
        if (cw[1] - c.r < bed) {
          if (sh > 0.002) { const nr = sandNormalAt(cw[0], cw[2]); contact(A, null, [cw[0], bed, cw[2]], nr, Math.min(bed - (cw[1] - c.r), 0.012) * nr[1], 0.08, 0.75); }
          else contact(A, null, [cw[0], T.BOT, cw[2]], [0, 1, 0], T.BOT - (cw[1] - c.r), 0.2, 0.55);
          A.touchT = t;
        }
      } else if (cw[1] - c.r < 0) contact(A, null, [cw[0], 0, cw[2]], [0, 1, 0], -(cw[1] - c.r), 0.3, 0.5);
    }
  }
  for (let i = 0; i < BODIES.length; i++) for (let j = i + 1; j < BODIES.length; j++) {
    let A = BODIES[i], B = BODIES[j];
    const aFix = A.static || A.sleep, bFix = B.static || B.sleep;
    if (aFix && bFix) continue;
    if (aFix) { const tmp = A; A = B; B = tmp; }
    if (v3.len(v3.sub(A.pos, B.pos)) > A.bound + B.bound) continue;
    const RA = quat.mat(A.q), RB = quat.mat(B.q);
    for (const ca of A.cols) {
      const pa = v3.add(A.pos, mv(RA, ca.p));
      for (const cb of B.cols) {
        const pb = v3.add(B.pos, mv(RB, cb.p));
        const d = v3.sub(pa, pb), dl = v3.len(d);
        if (dl < ca.r + cb.r && dl > 1e-6) {
          const n = v3.mul(d, 1 / dl);
          // a hard knock wakes a sleeping body unless the sand has already buried it
          if (B.sleep && v3.dot(A.vel, n) < -0.35 && !sandBuried(B)) { B.sleep = false; B.rest = 0; }
          contact(A, B, v3.add(pb, v3.mul(n, cb.r)), n, ca.r + cb.r - dl, 0.2, 0.35);
          A.touchT = t; if (!B.static) B.touchT = t;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- spawning
function dropObject(which, at) {
  const r = Math.random;
  let pool = CATALOG;
  if (which === 'sink') pool = CATALOG.filter(c => c.sink);
  else if (which === 'float') pool = CATALOG.filter(c => !c.sink);
  // favour the least-represented kinds so the tank keeps a varied cast
  const count = (tp) => BODIES.filter(b => b.name === tp.name).length;
  let t;
  if (typeof which === 'number') t = CATALOG[which];
  else {
    const minC = Math.min(...pool.map(count));
    const cand = pool.filter(tp => count(tp) <= minC);
    t = cand[Math.floor(r() * cand.length)];
  }
  const m = 0.45;
  const pos = [(r() * 2 - 1) * (TANK.TX - m), TANK.TOP + 0.5 + r() * 0.9, (r() * 2 - 1) * (TANK.TZ - m)];
  if (at) { pos[0] = Math.max(-TANK.TX + 0.25, Math.min(TANK.TX - 0.25, at[0])); pos[2] = Math.max(-TANK.TZ + 0.25, Math.min(TANK.TZ - 0.25, at[2])); }
  let q0 = quat.random(r);
  if (t.upright) {
    // boats and the duck are launched: set down upright, just above the water
    const yaw = r() * 6.283;
    q0 = quat.norm(quat.mul([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], [(r() - 0.5) * 0.08, 0, (r() - 0.5) * 0.08, 1]));
    pos[1] = TANK.LEVEL + 0.2 + r() * 0.12;
  }
  const b = makeBody(t, pos, q0);
  b.vel = t.upright ? [0, -0.25, 0] : [(r() - 0.5) * 0.6, -r() * 1.2, (r() - 0.5) * 0.6];
  b.w = t.upright ? [0, (r() - 0.5) * 0.6, 0] : [(r() - 0.5) * 4, (r() - 0.5) * 4, (r() - 0.5) * 4];
  BODIES.push(b);
  const dyn = BODIES.filter(x => !x.static);
  while (dyn.length > STATE.maxObjects) {
    const old = dyn.shift();
    BODIES.splice(BODIES.indexOf(old), 1);
  }
  return b;
}
function addStones() {
  const stones = [
    { p: [-1.05, 0.0, 0.35], a: 0.26, b: 0.13, c: 0.19, alb: [0.36, 0.34, 0.32] },
    { p: [0.95, 0.0, -0.55], a: 0.18, b: 0.10, c: 0.14, alb: [0.45, 0.41, 0.36] },
    { p: [1.35, 0.0, 0.62], a: 0.12, b: 0.07, c: 0.10, alb: [0.30, 0.30, 0.31] },
    { p: [-0.35, 0.0, -0.72], a: 0.15, b: 0.06, c: 0.11, alb: [0.50, 0.46, 0.40] },
  ];
  for (const s of stones) {
    const t = { name: 'Stone', kind: 'ellipsoid', a: s.a, b: s.b, c: s.c, rho: 2600, mat: 4, alb: s.alb, rough: 0.85 };
    const yaw = Math.random() * 6.28;
    const b = makeBody(t, [s.p[0], TANK.BOT + s.b * 0.72, s.p[2]], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], true);
    BODIES.push(b);
  }
}
function clearObjects() {
  for (let i = BODIES.length - 1; i >= 0; i--) if (!BODIES[i].static) BODIES.splice(i, 1);
  BUBBLES.length = 0; DROPS.length = 0;
}

// ---------------------------------------------------------------- GPU packing
let PACK_NAO = 0;
function packObjects() {
  const d = R.objData;
  d.fill(0);
  dynBegin();
  let n = 0;
  for (const b of BODIES) {
    if (n >= OBJ_ROWS - 26) break;
    putObj(d, n++, { pos: b.pos, bound: b.bound + 0.002, R: quat.mat(b.q), type: b.type, mat: b.mat, seed: b.seed, k: b.prm,
      alb: [b.alb ? b.alb[0] : 1, b.alb ? b.alb[1] : 1, b.alb ? b.alb[2] : 1, b.rough || 0.4],
      m6: b.model ? [b.model.start, b.model.count, 0, b.model.id] : null, m7: b.flood ? [b.flood, 0, 0, 0] : null });
  }
  PACK_NAO = n;
  n = packCreatures(d, n);
  for (let li = 0; li < lampCount() && n <= OBJ_ROWS - 8; li++) {
    const g = lampGeom(li);
    // shade: rounded cylinder whose local +y is the beam axis; front cap is the emissive lens (seed = lamp index)
    const y = g.aim, up = Math.abs(y[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    const xa = v3.norm(v3.cross(up, y)), za = v3.cross(xa, y);
    putObj(d, n++, { pos: g.head, bound: Math.hypot(g.R, g.H) + 0.004, R: [xa[0], y[0], za[0], xa[1], y[1], za[1], xa[2], y[2], za[2]],
      type: 3, mat: 7, seed: li, k: [g.R, g.H, 0.012, 0], alb: [0.06, 0.062, 0.066, 0.26] });
    // cable: long thin capsule rising from the back of the shade
    const back = v3.sub(g.head, v3.mul(y, g.H * 0.9)), L = 2.4;
    putObj(d, n++, { pos: [back[0], back[1] + L, back[2]], bound: L + 0.01, type: 2, mat: 1, k: [L, 0.0045, 0, 0], alb: [0.02, 0.02, 0.022, 0.45] });
  }
  n = packHopper(d, n);
  n = packLaser(d, n);
  dynUpload();
  return n;
}
// lamp head placement: hangs at (x, y, z), aims into the tank near itself
function lampGeom(i) {
  const Lm = STATE.lamps[i === undefined ? STATE.lampSel : i], T = TANK;
  const head = [Lm.x, Lm.y, Lm.z];
  const tgt = [Math.max(-T.TX * 0.6, Math.min(T.TX * 0.6, Lm.x * 0.7)), T.LEVEL - 0.55, Math.max(-T.TZ * 0.6, Math.min(T.TZ * 0.6, Lm.z * 0.7))];
  const aim = v3.norm(v3.sub(tgt, head));
  const H = 0.13, Rr = 0.1;
  return { head, aim, H, R: Rr, emit: v3.add(head, v3.mul(aim, H + 0.02)), lensR: Rr - 0.012 };
}
function packSpheres() {
  const d = R.sphData;
  d.fill(0);
  const bb = { bmin: [1e9, 1e9, 1e9], bmax: [-1e9, -1e9, -1e9], dmin: [1e9, 1e9, 1e9], dmax: [-1e9, -1e9, -1e9] };
  const nb = Math.min(128, BUBBLES.length), nd = Math.min(128, DROPS.length);
  for (let i = 0; i < nb; i++) {
    const q = BUBBLES[BUBBLES.length - 1 - i];
    d.set([q.p[0], q.p[1], q.p[2], q.r], i * 4);
    for (let k = 0; k < 3; k++) { bb.bmin[k] = Math.min(bb.bmin[k], q.p[k] - q.r); bb.bmax[k] = Math.max(bb.bmax[k], q.p[k] + q.r); }
  }
  for (let i = 0; i < nd; i++) {
    const q = DROPS[DROPS.length - 1 - i];
    d.set([q.p[0], q.p[1], q.p[2], q.r], (128 + i) * 4);
    for (let k = 0; k < 3; k++) { bb.dmin[k] = Math.min(bb.dmin[k], q.p[k] - q.r); bb.dmax[k] = Math.max(bb.dmax[k], q.p[k] + q.r); }
  }
  bb.nb = nb; bb.nd = nd;
  return bb;
}
// displacement spheres (prev / current) for the ripple coupling
function packDisplacement() {
  const oldA = new Float32Array(48 * 4), newA = new Float32Array(48 * 4);
  let n = 0;
  const list = BODIES.filter(b => !b.static).sort((a, b) => Math.abs(a.pos[1] - TANK.LEVEL) - Math.abs(b.pos[1] - TANK.LEVEL));
  for (const b of list) {
    const Rm = quat.mat(b.q);
    const cur = b.disp.map(s => v3.add(b.pos, mv(Rm, s.p)));
    const prev = b.prevDisp || cur;
    for (let i = 0; i < cur.length && n < 48; i++, n++) {
      oldA.set([prev[i][0], prev[i][1], prev[i][2], b.disp[i].r], n * 4);
      newA.set([cur[i][0], cur[i][1], cur[i][2], b.disp[i].r], n * 4);
    }
    b.prevDisp = cur;
  }
  return { n, oldA, newA };
}

// ---------------------------------------------------------------- ink
const INK_COLORS = [
  { name: 'Prussian blue', css: '#1c3aa8', A: [62, 40, 6] },
  { name: 'Vermilion', css: '#e2562b', A: [3, 30, 72] },
  { name: 'Crimson', css: '#ad1438', A: [4, 72, 40] },
  { name: 'Emerald', css: '#10906a', A: [62, 6, 40] },
  { name: 'Violet', css: '#6a2ab0', A: [24, 62, 7] },
  { name: 'India ink', css: '#16191d', A: [56, 58, 62] },
];
const INK = { inj: [], stir: [], active: false, last: -1e9, rain: [], pours: [], mExp: 0, mExpAtRead: 0, massScale: 1, fence: null, frame: 0 };
function injectInk(p, colorIdx, amount, radius, vel, velWeight) {
  const c = INK_COLORS[colorIdx % INK_COLORS.length];
  const q = [Math.max(-TANK.TX + 0.04, Math.min(TANK.TX - 0.04, p[0])), Math.max(TANK.BOT + 0.04, Math.min(TANK.LEVEL - 0.02, p[1])),
             Math.max(-TANK.TZ + 0.04, Math.min(TANK.TZ - 0.04, p[2]))];
  INK.inj.push({ p: q, r: radius, A: c.A, amt: amount, v: vel || [0, -0.4, 0], vw: velWeight === undefined ? 1 : velWeight });
  INK.active = true; INK.last = SIM_T;
}
// a drop is a short squirt: enough ink and momentum to roll into a plume
function dropInk(x, z, colorIdx, at) {
  const s = STATE.ink.size;
  const ci = colorIdx === undefined ? STATE.ink.color : colorIdx;
  const p = at || [x, TANK.LEVEL - 0.05, z];
  INK.pours.push({ p, c: ci, t0: SIM_T, dur: 0.22 + 0.16 * s, amt: 0.5 + 0.3 * s, r: 0.02 + 0.012 * s, v: -(0.32 + 0.18 * s),
    jx: (Math.random() - 0.5) * 0.08, jz: (Math.random() - 0.5) * 0.08 });
  INK.active = true; INK.last = SIM_T;
  if (!at) addImpulse(p[0], p[2], 0.035, 0.004);
}
function inkRain(n) {
  for (let i = 0; i < n; i++) INK.rain.push({ t: SIM_T + i * 0.22 + Math.random() * 0.1,
    x: (Math.random() * 2 - 1) * TANK.TX * 0.7, z: (Math.random() * 2 - 1) * TANK.TZ * 0.65, c: Math.floor(Math.random() * INK_COLORS.length) });
}
function stirWater(p, v, r, k) { INK.stir.push({ p, v, r, k }); INK.active = true; INK.last = Math.max(INK.last, SIM_T - 30); }
function clearInk() { INK.inj.length = 0; INK.stir.length = 0; INK.rain.length = 0; INK.pours.length = 0; INK.active = false; INK.mExp = 0; INK.massScale = 1; clearInkTextures(); }
function stepInkEvents() {
  for (let i = INK.rain.length - 1; i >= 0; i--) if (SIM_T >= INK.rain[i].t) { const r = INK.rain[i]; dropInk(r.x, r.z, r.c); INK.rain.splice(i, 1); }
  for (let i = INK.pours.length - 1; i >= 0; i--) {
    const q = INK.pours[i], age = SIM_T - q.t0;
    if (age > q.dur) { INK.pours.splice(i, 1); continue; }
    const f = 1 - age / q.dur;
    injectInk(q.p, q.c, q.amt * (0.55 + 0.45 * f), q.r, [q.jx, q.v, q.jz], 0.85);
  }
}
// body proxies that push the water (moving bodies drag it, resting ones and stones block it)
function packFluidBodies() {
  const P = new Float32Array(48 * 4), V = new Float32Array(48 * 4);
  let n = 0;
  const wet = BODIES.filter(b => b.pos[1] - b.bound < TANK.LEVEL + 0.05 && WATER.inside(b.pos[0], b.pos[2]));
  wet.sort((a, b) => v3.len(b.vel) + v3.len(b.w) * 0.1 - v3.len(a.vel) - v3.len(a.w) * 0.1);
  for (const b of wet) {
    const Rm = quat.mat(b.q);
    const cols = b.cols.length > 6 ? b.cols.filter((c, i) => i === 0 || i % 2 === 1) : b.cols;
    for (const c of cols) {
      if (n >= 48) break;
      const r = mv(Rm, c.p), pw = v3.add(b.pos, r);
      if (pw[1] - c.r > TANK.LEVEL + 0.02) continue;
      const vw = b.static || b.sleep ? [0, 0, 0] : v3.add(b.vel, v3.cross(b.w, r));
      P.set([pw[0], pw[1], pw[2], c.r], n * 4);
      V.set([vw[0], vw[1], vw[2], 0], n * 4);
      n++;
    }
  }
  for (const c of creatureFluidProxies()) {
    if (n >= 48) break;
    P.set([c.p[0], c.p[1], c.p[2], c.r], n * 4);
    V.set([c.v[0], c.v[1], c.v[2], 0], n * 4);
    n++;
  }
  return { n, P, V };
}
