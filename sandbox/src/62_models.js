// ============================================================================
//  MODELS — shapes built from a table of primitives. The GPU evaluates the same
//  table (tPrim, sdfModel); the JS mirror below is used for buoyancy sampling.
//  Primitive: type, position, rotation (quaternion), params k, combine op, zone
//  (material region), blend radius / shell thickness s, bound radius.
// ============================================================================
const PT = { SPH: 0, ELL: 1, BOX: 2, CONE: 3, CYL: 4, TOR: 5, ARC: 6, FIN: 7, CAP: 8, SAIL: 9, TUBE: 10, BEZ: 11, STR: 12 };
const OP = { U: 0, SU: 1, SUB: 2, SSUB: 3, INT: 4, SHELL: 5 };
const Q = {
  id: [0, 0, 0, 1],
  axis(ax, ang) { const l = Math.hypot(ax[0], ax[1], ax[2]) || 1, s = Math.sin(ang / 2); return [ax[0] / l * s, ax[1] / l * s, ax[2] / l * s, Math.cos(ang / 2)]; },
  x(a) { return Q.axis([1, 0, 0], a); }, y(a) { return Q.axis([0, 1, 0], a); }, z(a) { return Q.axis([0, 0, 1], a); },
  mul(a, b) { return quat.mul(a, b); },
  // shortest rotation taking unit vector a onto unit vector b
  fromTo(a, b) {
    const d = v3.dot(a, b);
    if (d < -0.999999) { let ax = v3.cross([1, 0, 0], a); if (v3.len(ax) < 1e-6) ax = v3.cross([0, 0, 1], a); return Q.axis(ax, Math.PI); }
    const c = v3.cross(a, b);
    return quat.norm([c[0], c[1], c[2], 1 + d]);
  },
  rot(q, v) { const u = [q[0], q[1], q[2]], t = v3.add(v3.cross(u, v), v3.mul(v, q[3])); return v3.add(v, v3.mul(v3.cross(u, t), 2)); },
};
function primBound(ty, k) {
  switch (ty) {
    case PT.SPH: return k[0];
    case PT.ELL: return Math.max(k[0], k[1], k[2]);
    case PT.BOX: return Math.hypot(k[0], k[1], k[2]);
    case PT.CONE: return k[2] + Math.max(k[0], k[1]);
    case PT.CYL: return Math.hypot(k[0], k[1]);
    case PT.TOR: return k[0] + k[1];
    case PT.ARC: return k[0] + k[1];
    case PT.FIN: case PT.SAIL: return Math.max(k[0], k[1]) + Math.abs(k[3]) + k[2];
    case PT.TUBE: return Math.hypot(k[0] + k[1], k[2]);
    default: return k[0] + k[1];
  }
}
// prim(type, position, params, { q, op, z, s, hollow })
function prim(ty, p, k, o) {
  o = o || {};
  const kk = [k[0] || 0, k[1] || 0, k[2] || 0, k[3] || 0];
  return { ty, p: p.slice(), q: o.q || Q.id, k: kk, op: o.op || 0, z: o.z || 0, s: o.s || 0, hollow: !!o.hollow, b: primBound(ty, kk) };
}
// round cone from a (radius ra) to b (radius rb)
function seg(a, b, ra, rb, o) {
  const d = v3.sub(b, a), h = Math.max(v3.len(d), 1e-5);
  return prim(PT.CONE, a, [ra, rb, h], Object.assign({}, o, { q: Q.fromTo([0, 1, 0], v3.mul(d, 1 / h)) }));
}
// quadratic Bezier tube a -> (control b) -> c, radius ra at a and rc at c; stored relative to a:
// q = (b - a, ra), k = (c - a, rc). A control point exactly on the chord is nudged off it.
function bez(a, b, c, ra, rc, o) {
  let B = v3.sub(b, a); const C = v3.sub(c, a);
  const bb = v3.sub(C, v3.mul(B, 2));
  if (v3.dot(bb, bb) < 1e-7) { const pr = v3.cross(C, Math.abs(C[1]) < 0.9 * v3.len(C) ? [0, 1, 0] : [1, 0, 0]); B = v3.add(B, v3.mul(v3.norm(pr), 0.0004)); }
  o = o || {};
  return { ty: PT.BEZ, p: a.slice(), q: [B[0], B[1], B[2], ra], k: [C[0], C[1], C[2], rc], op: o.op || 0, z: o.z || 0, s: o.s || 0, hollow: false,
    b: Math.max(v3.len(B), v3.len(C)) + Math.max(ra, rc) };
}
// a smooth tube through a polyline (even number of intervals): one quadratic Bezier per pair of intervals,
// passing through every other point, radius from r(fraction along)
function bezChain(pts, r, o, zoneAt) {
  const out = [], n = pts.length - 1;
  for (let i = 0; i + 2 <= n; i += 2) {
    const a = pts[i], m = pts[i + 1], c = pts[i + 2];
    const ctl = v3.sub(v3.mul(m, 2), v3.mul(v3.add(a, c), 0.5));   // the curve passes through m at t = 0.5
    const oo = zoneAt ? Object.assign({}, o, { z: zoneAt(i / n) }) : o;
    out.push(bez(a, ctl, c, r(i / n), r((i + 2) / n), oo));
  }
  return out;
}
// a smooth (C1) tube along a clamped quadratic B-spline: control points pts[0..n] give n - 1 Bezier
// pieces. fr[i] is the fraction along the tube at control point i, rad(f) the radius there, zoneAt(f)
// the zone of the piece ending at f, uAt(f) a coordinate along the tube (sucker spacings) for shading.
// o.s0 is the blend of the first piece into what it grows from, o.s the blend of the others.
function bsplineTube(pts, fr, rad, o, zoneAt, uAt) {
  const n = pts.length - 1, out = [], mid = (a, b) => v3.mul(v3.add(a, b), 0.5);
  for (let j = 0; j < n - 1; j++) {
    const a = j === 0 ? pts[0] : mid(pts[j], pts[j + 1]), e = j === n - 2 ? pts[n] : mid(pts[j + 1], pts[j + 2]);
    const fa = j === 0 ? fr[0] : (fr[j] + fr[j + 1]) / 2, fe = j === n - 2 ? fr[n] : (fr[j + 1] + fr[j + 2]) / 2;
    const pr = bez(a, pts[j + 1], e, rad(fa), rad(fe), { op: o.op, s: j === 0 && o.s0 !== undefined ? o.s0 : o.s, z: zoneAt ? zoneAt(fe) : o.z });
    if (uAt) { pr.u0 = uAt(fa); pr.u1 = uAt(fe); }
    out.push(pr);
  }
  return out;
}
// type 12: a ring of N tentacles hanging from a ring of radius R that lies 0.65 L above p; lengths
// 0.7-1.3 L, root radius r0 tapering to a quarter, tips trailing by tr = [x, z], swaying with amplitude
// A at phase ph (see sdStrands in the GLSL). Never used for buoyancy: the JS mirror is a rough stand-in.
function strands(p, N, seed, R, L, r0, tr, A, ph, o) {
  o = o || {};
  const reach = Math.hypot(tr[0], tr[1]) * 1.69;
  return { ty: PT.STR, p: p.slice(), q: [tr[0], tr[1], A, ph], k: [N + (Math.abs(seed) % 1) * 0.98, R, L, r0], op: o.op || 0, z: o.z || 0, s: o.s || 0,
    hollow: false, b: Math.hypot(0.65 * L, R + 0.12 + 1.6 * A + reach) + r0 };
}
function shellOp(t) { return { ty: 0, p: [0, 0, 0], q: Q.id, k: [0, 0, 0, 0], op: OP.SHELL, z: 0, s: t, hollow: true, b: 0 }; }

// ---------------------------------------------------------------- JS evaluator (mirror of the GLSL)
function ellipsoidSDF(p, r) {
  const k0 = Math.hypot(p[0] / r[0], p[1] / r[1], p[2] / r[2]), k1 = Math.hypot(p[0] / (r[0] * r[0]), p[1] / (r[1] * r[1]), p[2] / (r[2] * r[2]));
  return k0 * (k0 - 1) / Math.max(k1, 1e-6);
}
function primSDFjs(ty, p, k) {
  const [x, y, z] = p;
  switch (ty) {
    case PT.SPH: return Math.hypot(x, y, z) - k[0];
    case PT.ELL: return ellipsoidSDF(p, k);
    case PT.BOX: { const q = [Math.abs(x) - k[0] + k[3], Math.abs(y) - k[1] + k[3], Math.abs(z) - k[2] + k[3]];
      return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0) - k[3]; }
    case PT.CONE: { const qx = Math.hypot(x, z), qy = y, b = (k[0] - k[1]) / k[2], a = Math.sqrt(Math.max(1 - b * b, 0));
      const kk = -b * qx + a * qy;
      if (kk < 0) return Math.hypot(qx, qy) - k[0];
      if (kk > a * k[2]) return Math.hypot(qx, qy - k[2]) - k[1];
      return a * qx + b * qy - k[0]; }
    case PT.CYL: { const dx = Math.hypot(x, z) - k[0] + k[2], dy = Math.abs(y) - k[1] + k[2];
      return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - k[2]; }
    case PT.TOR: return Math.hypot(Math.hypot(x, z) - k[0], y) - k[1];
    case PT.ARC: { const sx = Math.sin(k[2]), cy = Math.cos(k[2]), ax = Math.abs(x);
      const kk = (cy * ax > sx * y) ? ax * sx + y * cy : Math.hypot(ax, y);
      return Math.sqrt(Math.max(ax * ax + y * y + z * z + k[0] * k[0] - 2 * k[0] * kk, 0)) - k[1]; }
    case PT.FIN: case PT.SAIL: { const ex = x / k[0], ey = y / k[1];
      const r = ty === PT.FIN ? Math.hypot(ex, ey) : Math.pow(ex ** 8 + ey ** 8, 0.125);
      const zz = z - k[3] * (ty === PT.FIN ? Math.max(1 - r * r, 0) : Math.max(1 - ex * ex, 0) * Math.max(1 - ey * ey, 0));
      return Math.max((r - 1) * Math.min(k[0], k[1]), Math.abs(zz) - k[2]); }
    case PT.TUBE: return Math.max(Math.abs(Math.hypot(x, z) - k[0]) - k[1], Math.abs(y) - k[2]);
    default: { const yy = y - Math.max(-k[0], Math.min(k[0], y)); return Math.hypot(x, yy, z) - k[1]; }
  }
}
// Bezier tube distance by sampling (JS only needs it for bounds / buoyancy, never per pixel)
function bezSDFjs(p, q, k) {
  let best = 1e9;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, u = 1 - t;
    const x = 2 * u * t * q[0] + t * t * k[0], y = 2 * u * t * q[1] + t * t * k[1], z = 2 * u * t * q[2] + t * t * k[2];
    best = Math.min(best, Math.hypot(p[0] - x, p[1] - y, p[2] - z) - (q[3] + (k[3] - q[3]) * t));
  }
  return best;
}
const sminJ = (a, b, k) => { const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k)); return b + (a - b) * h - k * h * (1 - h); };
// solid = true ignores hollows (cavities, shells): what a sealed body displaces
function sdfModelJS(prims, p, solid) {
  let d = 1e5;
  for (const pr of prims) {
    if (solid && pr.hollow) continue;
    if (pr.op === OP.SHELL) { d = Math.abs(d) - pr.s; continue; }
    // same bounding-sphere early-outs as the GLSL
    const db = Math.hypot(p[0] - pr.p[0], p[1] - pr.p[1], p[2] - pr.p[2]) - pr.b;
    if (pr.op <= 1 && db > d + pr.s) continue;
    if ((pr.op === 2 || pr.op === 3) && db >= pr.s - d) continue;
    const pd = pr.ty === PT.BEZ ? bezSDFjs(v3.sub(p, pr.p), pr.q, pr.k)
      : pr.ty === PT.STR ? Math.max(Math.hypot(p[0] - pr.p[0], p[2] - pr.p[2]) - pr.k[1] - pr.k[3], Math.abs(p[1] - pr.p[1]) - 0.65 * pr.k[2])
      : primSDFjs(pr.ty, Q.rot([-pr.q[0], -pr.q[1], -pr.q[2], pr.q[3]], v3.sub(p, pr.p)), pr.k);
    switch (pr.op) {
      case OP.U: d = Math.min(d, pd); break;
      case OP.SU: d = sminJ(d, pd, pr.s); break;
      case OP.SUB: d = Math.max(d, -pd); break;
      case OP.SSUB: d = -sminJ(-d, pd, pr.s); break;
      default: d = Math.max(d, pd);
    }
  }
  return d;
}

// ---------------------------------------------------------------- the library (static shapes)
// zones are material regions interpreted by modelMat() in the tracer
const MODEL_ID = { duck: 0, pirate: 1, battleship: 2, bottle: 3, chest: 4, anchor: 5, amphora: 6, helmet: 7,
  clownfish: 10, bluetang: 11, yellowtang: 12, jelly: 13, octopus: 14, crab: 15, laser: 16 };
const MODELS = {};
function defModel(name, prims) { MODELS[name] = { name, id: MODEL_ID[name], prims, start: 0, count: prims.length }; }

// Rubber duck (duck units: body length 1). Origin at the flat base: a low centre of mass keeps it upright.
defModel('duck', [
  prim(PT.ELL, [0, 0.28, 0], [0.5, 0.3, 0.37]),
  prim(PT.ELL, [-0.4, 0.46, 0], [0.2, 0.13, 0.15], { q: Q.z(0.55), op: OP.SU, s: 0.12 }),
  prim(PT.ELL, [0.22, 0.3, 0], [0.3, 0.26, 0.31], { op: OP.SU, s: 0.1 }),
  prim(PT.SPH, [0.25, 0.8, 0], [0.25], { op: OP.SU, s: 0.14 }),
  prim(PT.ELL, [-0.04, 0.37, 0.29], [0.27, 0.12, 0.08], { q: Q.z(0.25), op: OP.SU, s: 0.05 }),
  prim(PT.ELL, [-0.04, 0.37, -0.29], [0.27, 0.12, 0.08], { q: Q.z(0.25), op: OP.SU, s: 0.05 }),
  prim(PT.BOX, [0, 0.6, 0], [1.2, 0.58, 1.2, 0.03], { op: OP.INT }),
  prim(PT.ELL, [0.53, 0.73, 0], [0.18, 0.065, 0.14], { q: Q.z(-0.1), z: 1 }),
  prim(PT.BOX, [0.64, 0.725, 0], [0.12, 0.007, 0.2, 0], { op: OP.SUB, z: 1 }),
  prim(PT.SPH, [0.41, 0.9, 0.15], [0.055], { z: 2 }),
  prim(PT.SPH, [0.41, 0.9, -0.15], [0.055], { z: 2 }),
]);

// Pirate ship (ship units: length 1, bow +x). Origin below the waterline (ballast).
(() => {
  const P = [];
  P.push(prim(PT.ELL, [0, 0.05, 0], [0.5, 0.21, 0.16]));
  P.push(prim(PT.BOX, [0, -0.14, 0], [0.36, 0.03, 0.012, 0.01], { op: OP.SU, s: 0.03 }));
  P.push(prim(PT.BOX, [0, -0.44, 0], [0.8, 0.56, 0.5, 0], { op: OP.INT }));                // deck line y = 0.12
  P.push(prim(PT.ELL, [0.0, 0.145, 0], [0.455, 0.055, 0.135], { op: OP.SUB, hollow: true, z: 1 })); // deck well
  P.push(prim(PT.BOX, [-0.37, 0.17, 0], [0.11, 0.07, 0.1, 0.012], { z: 0 }));               // stern castle
  P.push(prim(PT.BOX, [0.33, 0.135, 0], [0.09, 0.035, 0.075, 0.01], { z: 0 }));             // forecastle
  P.push(prim(PT.BOX, [-0.37, 0.25, 0], [0.105, 0.012, 0.097, 0.004], { z: 1 }));           // poop deck rail cap
  P.push(seg([0.44, 0.13, 0], [0.72, 0.25, 0], 0.012, 0.006, { z: 4 }));                    // bowsprit
  P.push(prim(PT.CYL, [0.0, 0.56, 0], [0.013, 0.46, 0.004], { z: 4 }));                     // main mast
  P.push(prim(PT.CYL, [0.27, 0.47, 0], [0.011, 0.37, 0.004], { z: 4 }));                    // fore mast
  P.push(prim(PT.CYL, [-0.32, 0.55, 0], [0.009, 0.31, 0.003], { z: 4 }));                   // mizzen
  const yard = (x, y, hl) => P.push(prim(PT.CAP, [x, y, 0], [hl, 0.006], { q: Q.x(Math.PI / 2), z: 4 }));
  yard(0.0, 0.42, 0.21); yard(0.0, 0.8, 0.16); yard(0.27, 0.37, 0.17); yard(0.27, 0.7, 0.13); yard(-0.32, 0.46, 0.1);
  // square sails in the yz plane, billowing forward; the mizzen carries a small one
  const sail = (x, y, w, h) => P.push(prim(PT.SAIL, [x + 0.012, y, 0], [w, h, 0.0035, 0.034], { q: Q.y(Math.PI / 2), z: 5 }));
  sail(0.0, 0.61, 0.2, 0.17); sail(0.0, 0.93, 0.15, 0.12); sail(0.27, 0.53, 0.165, 0.145); sail(0.27, 0.81, 0.12, 0.1); sail(-0.32, 0.6, 0.1, 0.13);
  P.push(prim(PT.SAIL, [-0.045, 1.045, 0], [0.05, 0.032, 0.002, 0.012], { z: 6 }));          // black flag
  defModel('pirate', P);
})();

// Toy battleship (ship units: length 1). Grey hull, red below the boot-top, turrets fore and aft.
(() => {
  const P = [];
  P.push(prim(PT.ELL, [0, 0.0, 0], [0.5, 0.2, 0.08]));
  P.push(prim(PT.ELL, [-0.12, 0.0, 0], [0.38, 0.2, 0.088], { op: OP.SU, s: 0.05 }));        // fuller stern, fine bow
  P.push(prim(PT.BOX, [0, -0.02, 0], [0.7, 0.07, 0.3, 0.0], { op: OP.INT }));               // slab: keel -0.09, deck 0.05
  P.push(prim(PT.BOX, [0.03, 0.085, 0], [0.12, 0.036, 0.046, 0.006], { z: 2 }));            // superstructure
  P.push(prim(PT.BOX, [0.07, 0.15, 0], [0.055, 0.032, 0.034, 0.006], { z: 2 }));            // bridge
  P.push(prim(PT.CYL, [0.07, 0.215, 0], [0.013, 0.035, 0.003], { z: 2 }));
  P.push(seg([0.07, 0.24, 0], [0.07, 0.36, 0], 0.006, 0.002, { z: 5 }));                    // mast
  P.push(prim(PT.CAP, [0.07, 0.31, 0], [0.035, 0.0025], { q: Q.x(Math.PI / 2), z: 5 }));    // yardarm
  P.push(prim(PT.CYL, [-0.06, 0.15, 0], [0.027, 0.06, 0.005], { q: Q.z(0.14), z: 3 }));    // funnel
  const turret = (x, y, back) => {
    P.push(prim(PT.CYL, [x, y, 0], [0.043, 0.017, 0.005], { z: 2 }));
    const dir = back ? -1 : 1, q = Q.z(-dir * Math.PI / 2);
    for (const z of [-0.013, 0.013]) P.push(prim(PT.CAP, [x + dir * 0.075, y + 0.004, z], [0.05, 0.0055], { q, z: 4 }));
  };
  P.push(prim(PT.CYL, [0.19, 0.075, 0], [0.034, 0.02, 0.004], { z: 2 }));                  // barbette
  turret(0.31, 0.066, false); turret(0.19, 0.103, false); turret(-0.29, 0.066, true);
  P.push(prim(PT.BOX, [-0.12, 0.068, 0], [0.04, 0.02, 0.03, 0.005], { z: 2 }));            // aft deckhouse
  // origin (= centre of mass) near the keel: a weighted toy, otherwise the tall superstructure capsizes it
  for (const pr of P) pr.p[1] += 0.055;
  defModel('battleship', P);
})();

// Message in a bottle (metres, axis along x). Glass is a 2.5 mm shell; cork and a tied scroll inside.
defModel('bottle', [
  prim(PT.CYL, [-0.03, 0, 0], [0.036, 0.075, 0.012], { q: Q.z(Math.PI / 2) }),
  seg([0.04, 0, 0], [0.105, 0, 0], 0.035, 0.0125, { op: OP.SU, s: 0.018 }),
  prim(PT.CYL, [0.125, 0, 0], [0.0125, 0.026, 0.002], { q: Q.z(Math.PI / 2), op: OP.SU, s: 0.006 }),
  prim(PT.TOR, [0.149, 0, 0], [0.0128, 0.0038], { q: Q.z(Math.PI / 2), op: OP.SU, s: 0.003 }),
  shellOp(0.0025),
  prim(PT.CYL, [0.146, 0, 0], [0.0112, 0.014, 0.002], { q: Q.z(Math.PI / 2), z: 1 }),
  prim(PT.CYL, [-0.025, -0.011, 0.004], [0.012, 0.062, 0.002], { q: Q.z(Math.PI / 2), z: 2, hollow: true }),
  prim(PT.TOR, [-0.02, -0.011, 0.004], [0.0126, 0.0016], { q: Q.z(Math.PI / 2), z: 3, hollow: true }),
]);

// Treasure chest (metres, origin at its middle). Dark planks, brass bands, a gold lock.
defModel('chest', [
  prim(PT.CYL, [0, 0.05, 0], [0.1, 0.15, 0.008], { q: Q.z(Math.PI / 2) }),                 // barrel lid...
  prim(PT.BOX, [0, 0.15, 0], [0.2, 0.1, 0.2, 0], { op: OP.INT }),                           // ...upper half only
  prim(PT.BOX, [0, -0.025, 0], [0.15, 0.075, 0.1, 0.008], { op: OP.U }),                    // body
  prim(PT.BOX, [0.09, -0.025, 0], [0.012, 0.078, 0.103, 0.003], { z: 1 }),
  prim(PT.BOX, [-0.09, -0.025, 0], [0.012, 0.078, 0.103, 0.003], { z: 1 }),
  prim(PT.TOR, [0.09, 0.05, 0], [0.1, 0.006], { q: Q.z(Math.PI / 2), z: 1 }),
  prim(PT.TOR, [-0.09, 0.05, 0], [0.1, 0.006], { q: Q.z(Math.PI / 2), z: 1 }),
  prim(PT.BOX, [0, 0.045, 0.101], [0.024, 0.03, 0.006, 0.003], { z: 2 }),
  prim(PT.CYL, [0, 0.04, 0.107], [0.005, 0.006, 0.001], { q: Q.x(Math.PI / 2), op: OP.SUB, z: 3 }),
  prim(PT.TOR, [0.153, 0.0, 0], [0.022, 0.004], { q: Q.z(Math.PI / 2), z: 1 }),
  prim(PT.TOR, [-0.153, 0.0, 0], [0.022, 0.004], { q: Q.z(Math.PI / 2), z: 1 }),
]);

// Admiralty anchor (metres, origin at the centre of mass)
defModel('anchor', [
  prim(PT.CAP, [0, 0.0, 0], [0.15, 0.012]),                                                  // shank
  prim(PT.TOR, [0, 0.19, 0], [0.035, 0.007], { q: Q.x(Math.PI / 2) }),                     // ring
  prim(PT.CAP, [0, 0.11, 0], [0.11, 0.009], { q: Q.x(Math.PI / 2) }),                      // stock
  prim(PT.ARC, [0, 0.0, 0], [0.15, 0.011, 1.13], { q: Q.z(Math.PI) }),                     // crown + arms
  prim(PT.ELL, [0.136, -0.063, 0], [0.036, 0.022, 0.009], { q: Q.z(0.45), op: OP.SU, s: 0.01 }),
  prim(PT.ELL, [-0.136, -0.063, 0], [0.036, 0.022, 0.009], { q: Q.z(-0.45), op: OP.SU, s: 0.01 }),
  prim(PT.SPH, [0, -0.152, 0], [0.016], { op: OP.SU, s: 0.012 }),
]);

// Amphora (metres, origin near the centre of mass): tall ovoid body widest at the shoulder, a pointed
// toe, long neck with a rolled rim, two long handles rising from the shoulder and bending in to the neck
defModel('amphora', [
  prim(PT.ELL, [0, 0.03, 0], [0.1, 0.14, 0.1]),
  seg([0, -0.215, 0], [0, -0.03, 0], 0.018, 0.085, { op: OP.SU, s: 0.05 }),
  prim(PT.SPH, [0, -0.225, 0], [0.02], { op: OP.SU, s: 0.01 }),
  seg([0, 0.13, 0], [0, 0.21, 0], 0.075, 0.032, { op: OP.SU, s: 0.035 }),
  seg([0, 0.21, 0], [0, 0.285, 0], 0.032, 0.029, { op: OP.SU, s: 0.01 }),
  prim(PT.TOR, [0, 0.288, 0], [0.031, 0.0085], { op: OP.SU, s: 0.004 }),
  prim(PT.CYL, [0, 0.3, 0], [0.022, 0.05, 0.002], { op: OP.SUB, hollow: true, z: 1 }),
  ...[1, -1].flatMap(sx => [
    seg([sx * 0.07, 0.14, 0], [sx * 0.078, 0.252, 0], 0.0095, 0.0085, { op: OP.SU, s: 0.015 }),
    seg([sx * 0.078, 0.252, 0], [sx * 0.029, 0.262, 0], 0.0085, 0.008, { op: OP.SU, s: 0.012 }),
  ]),
]);

// Diver's helmet (metres): brass bonnet, breastplate, three portholes with grilles
defModel('helmet', [
  prim(PT.SPH, [0, 0.07, 0], [0.13]),
  prim(PT.ELL, [0, -0.07, 0], [0.19, 0.06, 0.16], { op: OP.SU, s: 0.03, z: 1 }),
  prim(PT.BOX, [0, 0.4, 0], [0.5, 0.52, 0.5, 0], { op: OP.INT }),                            // flat base at y = -0.12
  prim(PT.TOR, [0, -0.04, 0], [0.12, 0.013], { z: 1 }),
  prim(PT.CYL, [0, 0.08, 0.118], [0.056, 0.02, 0.005], { q: Q.x(Math.PI / 2) }),
  prim(PT.CYL, [0, 0.08, 0.13], [0.045, 0.012, 0.002], { q: Q.x(Math.PI / 2), z: 2 }),
  prim(PT.CAP, [0, 0.08, 0.142], [0.046, 0.0035]),
  prim(PT.CAP, [0, 0.08, 0.142], [0.046, 0.0035], { q: Q.z(Math.PI / 2) }),
  prim(PT.CYL, [0.118, 0.08, 0], [0.042, 0.018, 0.004], { q: Q.z(Math.PI / 2) }),
  prim(PT.CYL, [0.128, 0.08, 0], [0.033, 0.012, 0.002], { q: Q.z(Math.PI / 2), z: 2 }),
  prim(PT.CYL, [-0.118, 0.08, 0], [0.042, 0.018, 0.004], { q: Q.z(Math.PI / 2) }),
  prim(PT.CYL, [-0.128, 0.08, 0], [0.033, 0.012, 0.002], { q: Q.z(Math.PI / 2), z: 2 }),
  prim(PT.CYL, [0, 0.2, -0.04], [0.013, 0.02, 0.003]),
  ...[[0.14, 0.09], [-0.14, 0.09], [0.14, -0.09], [-0.14, -0.09], [0, 0.155], [0, -0.155]].map(([x, z]) => prim(PT.SPH, [x, -0.035, z], [0.009], { z: 1 })),
]);

// Laser module: black anodised body along +x, polished bezel, emitting aperture (zone 2)
defModel('laser', [
  prim(PT.CYL, [-0.07, 0, 0], [0.022, 0.07, 0.004], { q: Q.z(Math.PI / 2) }),
  prim(PT.CYL, [0.006, 0, 0], [0.025, 0.008, 0.003], { q: Q.z(Math.PI / 2), z: 1 }),
  prim(PT.CYL, [0.012, 0, 0], [0.007, 0.004, 0.001], { q: Q.z(Math.PI / 2), op: OP.SUB, z: 1 }),
  prim(PT.SPH, [0.006, 0, 0], [0.0055], { z: 2 }),
  prim(PT.BOX, [-0.07, -0.028, 0], [0.03, 0.008, 0.018, 0.003], { z: 3 }),
]);

// ---------------------------------------------------------------- fish (unit length, head toward +x)
// zone 0 body, 1 fins (thin, translucent), 2 eyes
function fishModel(o) {
  const P = [];
  P.push(prim(PT.ELL, o.body[0], o.body[1]));
  P.push(prim(PT.ELL, o.head[0], o.head[1], { op: OP.SU, s: 0.06 }));
  if (o.snout) P.push(prim(PT.ELL, o.snout[0], o.snout[1], { op: OP.SU, s: 0.05 }));
  P.push(prim(PT.ELL, o.ped[0], o.ped[1], { op: OP.SU, s: 0.07 }));
  const fin = (c, r, t, q) => P.push(prim(PT.FIN, c, [r[0], r[1], t, 0], { z: 1, q: q || Q.id }));
  fin(o.tail[0], o.tail[1], 0.005);
  if (o.tailCut) P.push(prim(PT.ELL, o.tailCut[0], o.tailCut[1], { op: OP.SUB, z: 1 }));
  for (const f of o.dorsal) fin(f[0], f[1], 0.004);
  for (const f of o.anal) fin(f[0], f[1], 0.004);
  for (const s of [1, -1]) {
    fin([o.pect[0][0], o.pect[0][1], o.pect[0][2] * s], o.pect[1], 0.003, Q.mul(Q.y(-s * 0.6), Q.x(s * 0.35)));
    fin([o.pelv[0][0], o.pelv[0][1], o.pelv[0][2] * s], o.pelv[1], 0.003, Q.x(s * 0.5));
    P.push(prim(PT.SPH, [o.eye[0][0], o.eye[0][1], o.eye[0][2] * s], [o.eye[1]], { z: 2 }));
  }
  return P;
}
defModel('clownfish', fishModel({
  body: [[0.04, 0, 0], [0.36, 0.165, 0.085]], head: [[0.2, -0.01, 0], [0.2, 0.15, 0.08]], ped: [[-0.32, 0, 0], [0.15, 0.065, 0.035]],
  tail: [[-0.52, 0, 0], [0.12, 0.15]], dorsal: [[[-0.02, 0.165, 0], [0.22, 0.07]], [[-0.2, 0.17, 0], [0.13, 0.085]]], anal: [[[-0.18, -0.155, 0], [0.12, 0.07]]],
  pect: [[0.13, -0.04, 0.08], [0.07, 0.045]], pelv: [[0.07, -0.15, 0.03], [0.06, 0.03]], eye: [[0.29, 0.04, 0.062], 0.036],
}));
defModel('bluetang', fishModel({
  body: [[0.02, 0, 0], [0.36, 0.215, 0.066]], head: [[0.22, 0.0, 0], [0.17, 0.165, 0.06]], ped: [[-0.34, 0, 0], [0.13, 0.06, 0.03]],
  tail: [[-0.5, 0, 0], [0.1, 0.17]], tailCut: [[-0.66, 0, 0], [0.085, 0.12, 0.05]],
  dorsal: [[[-0.02, 0.1, 0], [0.34, 0.17]]], anal: [[[-0.1, -0.08, 0], [0.27, 0.19]]],
  pect: [[0.16, -0.03, 0.062], [0.075, 0.045]], pelv: [[0.1, -0.19, 0.025], [0.05, 0.03]], eye: [[0.3, 0.05, 0.05], 0.034],
}));
defModel('yellowtang', fishModel({
  body: [[0.0, 0, 0], [0.32, 0.29, 0.06]], head: [[0.18, 0.04, 0], [0.15, 0.16, 0.055]], snout: [[0.3, 0.06, 0], [0.1, 0.055, 0.032]],
  ped: [[-0.33, 0, 0], [0.12, 0.06, 0.028]], tail: [[-0.48, 0, 0], [0.09, 0.15]], tailCut: [[-0.62, 0, 0], [0.07, 0.1, 0.05]],
  dorsal: [[[-0.06, 0.16, 0], [0.3, 0.24]]], anal: [[[-0.09, -0.14, 0], [0.25, 0.23]]],
  pect: [[0.12, 0.0, 0.058], [0.07, 0.04]], pelv: [[0.08, -0.26, 0.02], [0.05, 0.03]], eye: [[0.2, 0.1, 0.05], 0.032],
}));

// ---------------------------------------------------------------- GPU table
const PRIM_ROWS = 4096;
let PRIM_LIB_ROWS = 0;
function writePrim(data, row, pr) {
  const o = row * 16;
  data.set([pr.p[0], pr.p[1], pr.p[2], pr.ty + pr.op * 16 + pr.z * 256], o);
  data.set(pr.q, o + 4);
  data.set(pr.k, o + 8);
  data.set([pr.s, pr.b, pr.u0 || 0, pr.u1 || 0], o + 12);
}
function modelBound(prims) {
  let b = 0;
  for (const p of prims) if (p.op !== OP.SUB && p.op !== OP.SSUB && p.op !== OP.SHELL && p.op !== OP.INT) b = Math.max(b, v3.len(p.p) + p.b);
  return b;
}
function uploadModelLibrary() {
  const data = R.primData;
  let row = 0;
  for (const k in MODELS) {
    const m = MODELS[k];
    m.start = row; m.count = m.prims.length; m.bound = modelBound(m.prims);
    for (const pr of m.prims) writePrim(data, row++, pr);
  }
  PRIM_LIB_ROWS = row;
  uploadTex(R.prim, data);
}
// per-frame rows for animated creatures, appended after the library
const DYN = { rows: 0 };
function dynBegin() { DYN.rows = PRIM_LIB_ROWS; }
function dynAdd(prims) {
  const start = DYN.rows;
  for (const pr of prims) { if (DYN.rows >= PRIM_ROWS) break; writePrim(R.primData, DYN.rows++, pr); }
  return { start, count: DYN.rows - start };
}
function dynUpload() {
  const n = DYN.rows - PRIM_LIB_ROWS;
  if (n <= 0) return;
  uploadTex(R.prim, R.primData);   // the whole table (a partial upload would need one call per 4-texel row)
}
// object texture: 8 texels per object
//   0 pos, bound | 1-3 local axes (columns of R) + type, material class, seed | 4 params | 5 albedo, rough
//   6 model: prim start, prim count, warp type, model id | 7 animation (warp amplitude, phase, wavenumber, bend)
const OBJ_ROWS = 96, OBJ_TEX = 8;
function putObj(d, n, o) {
  const b = n * OBJ_TEX * 4, Rm = o.R || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  d.set([o.pos[0], o.pos[1], o.pos[2], o.bound], b);
  d.set([Rm[0], Rm[3], Rm[6], o.type], b + 4);
  d.set([Rm[1], Rm[4], Rm[7], o.mat], b + 8);
  d.set([Rm[2], Rm[5], Rm[8], o.seed || 0], b + 12);
  d.set(o.k || [0, 0, 0, 0], b + 16);
  d.set(o.alb || [0.5, 0.5, 0.5, 0.5], b + 20);
  d.set(o.m6 || [0, 0, 0, 0], b + 24);
  d.set(o.m7 || [0, 0, 0, 0], b + 28);
}
