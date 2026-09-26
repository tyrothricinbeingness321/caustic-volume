// ============================================================================
//  CREATURES — schooling tropical fish, a pulsing jellyfish trailing long tentacles,
//  a crawling octopus and a sideways-walking crab. Kinematic: they steer themselves, stay
//  clear of walls, objects and each other, and push the water as they move.
// ============================================================================
const CREATURE_TYPES = {
  clownfish:  { label: 'Clownfish', model: 'clownfish', fish: true, len: 0.11, speed: 0.16 },
  bluetang:   { label: 'Blue tang', model: 'bluetang', fish: true, len: 0.17, speed: 0.2 },
  yellowtang: { label: 'Yellow tang', model: 'yellowtang', fish: true, len: 0.16, speed: 0.18 },
  jelly:      { label: 'Jellyfish', model: 'jelly', size: 0.12 },
  octopus:    { label: 'Octopus', model: 'octopus', size: 1.0 },
  crab:       { label: 'Crab', model: 'crab', size: 1.0 },
};
const CREATURES = [];
const MAX_CREATURES = 18;
const rnd = (a, b) => a + Math.random() * (b - a);
const bedY = (x, z) => TANK.BOT + (typeof sandHeightAt === 'function' ? sandHeightAt(x, z) : 0);

function addCreature(kind, at) {
  const T = CREATURE_TYPES[kind];
  if (!T) return null;
  while (CREATURES.length >= MAX_CREATURES) CREATURES.shift();
  const x = at ? at[0] : rnd(-TANK.TX + 0.4, TANK.TX - 0.4), z = at ? at[2] : rnd(-TANK.TZ + 0.35, TANK.TZ - 0.35);
  const c = { kind, T, t: Math.random() * 100, id: Math.random(), yaw: rnd(0, 6.283), vel: [0, 0, 0], q: [0, 0, 0, 1], phase: 0 };
  if (T.fish) {
    // join a school of the same species if there is one
    const mate = CREATURES.find(o => o.kind === kind);
    c.pos = mate ? v3.add(mate.pos, [rnd(-0.15, 0.15), rnd(-0.08, 0.08), rnd(-0.15, 0.15)]) : [x, rnd(0.35, TANK.LEVEL - 0.3), z];
    c.len = T.len * rnd(0.85, 1.15);
    c.vel = v3.mul([Math.cos(c.yaw), 0, Math.sin(c.yaw)], T.speed);
    c.wander = [Math.cos(c.yaw), 0, Math.sin(c.yaw)];
    c.bend = 0; c.amp = 0.08; c.burst = 0;
  } else if (kind === 'jelly') {
    c.size = T.size * rnd(0.8, 1.2);
    c.pos = [x, rnd(Math.min(TANK.LEVEL - 0.4, bedY(x, z) + 0.6), TANK.LEVEL - 0.3), z];
    c.axis = [0, 1, 0]; c.period = rnd(1.3, 1.9); c.contract = 0; c.tilt = [rnd(-0.2, 0.2), 0, rnd(-0.2, 0.2)];
  } else {
    c.pos = [x, bedY(x, z) + 0.04, z];
    c.mode = 'walk'; c.timer = rnd(2, 5); c.dir = Math.random() < 0.5 ? 1 : -1; c.claw = 0; c.raise = 0;
    c.jet = 0; c.camo = Math.random(); c.gait = 0; c.moveAmt = 0;
    if (kind === 'octopus') { c.mode = 'crawl'; c.vy = 0; }
  }
  CREATURES.push(c);
  return c;
}
function clearCreatures() { CREATURES.length = 0; }

// ------------------------------------------------------------ steering helpers
function avoidWalls(p, margin, k) {
  const f = [0, 0, 0], T = TANK;
  const push = (d, axis, s) => { if (d < margin) f[axis] += s * k * (1 - d / margin) * (1 - d / margin); };
  push(T.TX - p[0], 0, -1); push(p[0] + T.TX, 0, 1); push(T.TZ - p[2], 2, -1); push(p[2] + T.TZ, 2, 1);
  return f;
}
function avoidBodies(p, extra, k) {
  const f = [0, 0, 0];
  for (const b of BODIES) {
    const d = v3.sub(p, b.pos), l = v3.len(d), r = b.bound + extra;
    if (l < r && l > 1e-4) { const s = k * (1 - l / r); f[0] += d[0] / l * s; f[1] += d[1] / l * s; f[2] += d[2] / l * s; }
  }
  return f;
}
// orientation from a forward direction (local +x) and an up hint (local +y), with a roll about forward
function frameQuat(fwd, up, roll) {
  const x = v3.norm(fwd);
  let z = v3.cross(x, up); if (v3.len(z) < 1e-4) z = v3.cross(x, [0, 0, 1]); z = v3.norm(z);
  let y = v3.cross(z, x);
  if (roll) { const c = Math.cos(roll), s = Math.sin(roll); const y2 = v3.add(v3.mul(y, c), v3.mul(z, s)); z = v3.add(v3.mul(z, c), v3.mul(y, -s)); y = y2; }
  // rotation matrix columns x, y, z -> quaternion
  const m00 = x[0], m11 = y[1], m22 = z[2], tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s]; }
  return quat.norm(q);
}

// ------------------------------------------------------------ per-species behaviour
function stepFish(c, dt, all) {
  const T = TANK, sp = c.T.speed * (1 + c.burst);
  // wander: slowly rotating preferred heading, mostly level
  const wa = 0.9 * dt;
  c.wander = v3.norm(v3.add(c.wander, [rnd(-wa, wa), rnd(-wa, wa) * 0.35, rnd(-wa, wa)]));
  c.wander[1] *= 0.98;
  let acc = v3.mul(v3.sub(v3.mul(c.wander, sp), c.vel), 0.6);
  // school: cohesion + alignment with the same species, separation from everyone
  let n = 0, cen = [0, 0, 0], ali = [0, 0, 0];
  for (const o of all) {
    if (o === c || !o.T.fish) continue;
    const d = v3.sub(o.pos, c.pos), l = v3.len(d);
    if (l < 0.07 + c.len && l > 1e-4) acc = v3.add(acc, v3.mul(d, -1.2 / (l * l) * 0.01));
    if (o.kind === c.kind && l < 0.7) { n++; cen = v3.add(cen, o.pos); ali = v3.add(ali, o.vel); }
  }
  if (n) {
    acc = v3.add(acc, v3.mul(v3.sub(v3.mul(cen, 1 / n), c.pos), 0.5));
    acc = v3.add(acc, v3.mul(v3.sub(v3.mul(ali, 1 / n), c.vel), 0.8));
  }
  // keep clear of the glass, the surface, the bed / sand, objects, and jellyfish
  acc = v3.add(acc, avoidWalls(c.pos, 0.38, 3.2));
  const bed = bedY(c.pos[0], c.pos[2]);
  if (c.pos[1] > T.LEVEL - 0.2) acc[1] -= 3 * (c.pos[1] - (T.LEVEL - 0.2)) / 0.2;
  if (c.pos[1] < bed + 0.16) acc[1] += 3 * (bed + 0.16 - c.pos[1]) / 0.16;
  acc = v3.add(acc, avoidBodies(c.pos, 0.12, 2.5));
  // jellyfish: keep clear of the bell and the tentacles trailing below it (a capsule)
  for (const o of all) if (o.kind === 'jelly') {
    const dn = v3.norm(v3.sub([0, -1, 0], o.axis)), w = v3.sub(c.pos, o.pos), h = Math.max(0, Math.min(o.size * 3, v3.dot(w, dn)));
    const d = v3.sub(w, v3.mul(dn, h)), l = v3.len(d), r = o.size * 1.5;
    if (l < r && l > 1e-4) acc = v3.add(acc, v3.mul(d, 2 / l * (1 - l / r)));
  }
  // occasional bursts
  c.burst = Math.max(0, c.burst - dt * 0.8);
  if (Math.random() < dt * 0.05) c.burst = rnd(0.6, 1.4);
  const al = v3.len(acc), amax = 1.2 + c.burst * 2;
  if (al > amax) acc = v3.mul(acc, amax / al);
  const prevDir = v3.norm(c.vel);
  c.vel = v3.add(c.vel, v3.mul(acc, dt));
  let s = v3.len(c.vel);
  const smax = sp * 1.6, smin = sp * 0.45;
  if (s > smax) c.vel = v3.mul(c.vel, smax / s); else if (s < smin) c.vel = v3.mul(v3.norm(s > 1e-5 ? c.vel : c.wander), smin);
  c.vel[1] = Math.max(-0.4 * s, Math.min(0.4 * s, c.vel[1]));
  c.pos = v3.add(c.pos, v3.mul(c.vel, dt));
  c.pos[0] = Math.max(-T.TX + 0.06, Math.min(T.TX - 0.06, c.pos[0]));
  c.pos[2] = Math.max(-T.TZ + 0.06, Math.min(T.TZ - 0.06, c.pos[2]));
  c.pos[1] = Math.max(bed + 0.05, Math.min(T.LEVEL - 0.06, c.pos[1]));
  // body: turn rate -> bend and bank, speed -> tail beat
  s = v3.len(c.vel);
  const dir = v3.norm(c.vel);
  const turn = v3.cross(prevDir, dir)[1] / Math.max(dt, 1e-3);
  c.bend += (Math.max(-0.35, Math.min(0.35, turn * 0.18)) - c.bend) * Math.min(1, dt * 6);
  const freq = 2.2 + 1.3 * s / c.len;
  c.phase += 2 * Math.PI * freq * dt;
  c.amp += ((0.055 + 0.05 * Math.min(1, c.burst + v3.len(acc) * 0.15)) - c.amp) * Math.min(1, dt * 4);
  c.q = frameQuat(dir, [0, 1, 0], -c.bend * 1.2);
}
function stepJelly(c, dt) {
  const T = TANK;
  c.t += dt;
  const u = (c.t / c.period) % 1;
  // fast contraction (35% of the cycle), slow relaxation
  const con = u < 0.35 ? Math.sin(u / 0.35 * Math.PI / 2) : Math.cos((u - 0.35) / 0.65 * Math.PI / 2);
  const thrust = u < 0.35 ? 0.9 : 0;
  c.contract = con;
  // the bell axis wanders a little around vertical, and turns away from walls, surface and bed
  c.tilt = v3.add(c.tilt, [rnd(-0.3, 0.3) * dt, 0, rnd(-0.3, 0.3) * dt]);
  const w = avoidWalls(c.pos, 0.4, 1.2);
  c.tilt[0] += w[0] * dt; c.tilt[2] += w[2] * dt;
  const tl = Math.hypot(c.tilt[0], c.tilt[2]);
  if (tl > 0.45) { c.tilt[0] *= 0.45 / tl; c.tilt[2] *= 0.45 / tl; }
  let ax = v3.norm([c.tilt[0], 1, c.tilt[2]]);
  const bed = bedY(c.pos[0], c.pos[2]);
  if (c.pos[1] > T.LEVEL - 0.25) ax = v3.norm(v3.add(ax, [0, -1.5 * (c.pos[1] - T.LEVEL + 0.25) / 0.25, 0]));
  c.axis = ax;
  const cur = WATER.velAt(c.pos[0], c.pos[1], c.pos[2], SIM_T);
  const target = v3.add(v3.mul(cur, 0.6), [0, -0.012, 0]);
  c.vel = v3.add(c.vel, v3.mul(ax, thrust * 0.22 * dt));
  c.vel = v3.add(c.vel, v3.mul(v3.sub(target, c.vel), Math.min(1, dt * 1.6)));
  c.vel = v3.add(c.vel, v3.mul(avoidBodies(c.pos, c.size + 0.05, 0.4), dt));
  if (c.pos[1] < bed + c.size * 3.3 + 0.05) c.vel[1] += 0.3 * dt;   // keep the tentacles off the bed
  c.pos = v3.add(c.pos, v3.mul(c.vel, dt));
  const m = c.size * 1.3;
  c.pos[0] = Math.max(-T.TX + m, Math.min(T.TX - m, c.pos[0]));
  c.pos[2] = Math.max(-T.TZ + m, Math.min(T.TZ - m, c.pos[2]));
  c.pos[1] = Math.max(bed + c.size * 2.6, Math.min(T.LEVEL - c.size * 0.6, c.pos[1]));
  c.q = Q.fromTo([0, 1, 0], ax);
  // tentacles and oral arms hang under their own weight and stream with the water going past the
  // bell: their tip offset in the bell's frame, followed with a little lag
  const hang = v3.norm(v3.add([0, -0.06, 0], v3.sub(cur, c.vel)));
  const hl = Q.rot([-c.q[0], -c.q[1], -c.q[2], c.q[3]], hang), dn = Math.max(-hl[1], 0.35);
  let tx = hl[0] / dn * JELLY_L, tz = hl[2] / dn * JELLY_L;
  const tm = Math.hypot(tx, tz), lim = 0.8 * JELLY_L;
  if (tm > lim) { tx *= lim / tm; tz *= lim / tm; }
  if (!c.trail) c.trail = [tx, tz];
  const g = Math.min(1, dt * 1.2);
  c.trail[0] += (tx - c.trail[0]) * g; c.trail[1] += (tz - c.trail[1]) * g;
}
function stepCrab(c, dt, all) {
  const T = TANK;
  c.t += dt; c.timer -= dt;
  if (c.timer <= 0) {
    if (c.mode === 'walk') { c.mode = 'pause'; c.timer = rnd(1.2, 3.5); }
    else { c.mode = 'walk'; c.timer = rnd(2, 6); if (Math.random() < 0.5) c.dir = -c.dir; c.yaw += rnd(-0.9, 0.9); }
  }
  const moving = c.mode === 'walk';
  c.moveAmt += ((moving ? 1 : 0) - c.moveAmt) * Math.min(1, dt * 5);
  const fwd = [Math.cos(c.yaw), 0, Math.sin(c.yaw)], side = [-Math.sin(c.yaw), 0, Math.cos(c.yaw)];
  let v = v3.mul(side, c.dir * 0.075 * c.moveAmt);
  // walls and objects push it round; turning to face away when it gets close
  const w = v3.add(avoidWalls(c.pos, 0.25, 0.6), avoidBodies(c.pos, 0.12, 0.6));
  for (const o of all) if (o !== c && !o.T.fish && o.kind !== 'jelly') { const d = v3.sub(c.pos, o.pos); d[1] = 0; const l = v3.len(d); if (l < 0.3 && l > 1e-4) { w[0] += d[0] / l * 0.3; w[2] += d[2] / l * 0.3; } }
  if (v3.len(w) > 0.02 && v3.dot(w, v3.mul(side, c.dir)) < 0) c.dir = -c.dir;
  v = v3.add(v, [w[0] * 0.1, 0, w[2] * 0.1]);
  c.pos = v3.add(c.pos, v3.mul(v, dt));
  c.pos[0] = Math.max(-T.TX + 0.12, Math.min(T.TX - 0.12, c.pos[0]));
  c.pos[2] = Math.max(-T.TZ + 0.12, Math.min(T.TZ - 0.12, c.pos[2]));
  const by = bedY(c.pos[0], c.pos[2]);
  c.pos[1] += (by + 0.04 - c.pos[1]) * Math.min(1, dt * 8);
  c.gait += dt * 9 * c.moveAmt;
  // claws: open / close and a slow raise while pausing
  c.claw = 0.5 + 0.5 * Math.sin(c.t * (moving ? 2.5 : 5.5) + c.id * 7);
  c.raise += ((moving ? 0.1 : 0.6 + 0.4 * Math.sin(c.t * 1.7)) - c.raise) * Math.min(1, dt * 3);
  // sit on the local slope of the bed
  const e = 0.06, gx = (bedY(c.pos[0] + e, c.pos[2]) - bedY(c.pos[0] - e, c.pos[2])) / (2 * e), gz = (bedY(c.pos[0], c.pos[2] + e) - bedY(c.pos[0], c.pos[2] - e)) / (2 * e);
  const up = v3.norm([-gx, 1, -gz]);
  c.q = frameQuat(v3.sub(fwd, v3.mul(up, v3.dot(fwd, up))), up, 0);
  c.vel = v;
}
function stepOctopus(c, dt, all) {
  const T = TANK;
  c.t += dt; c.timer -= dt;
  if (c.timer <= 0) {
    if (c.mode === 'crawl') { c.mode = Math.random() < 0.3 ? 'jet' : 'rest'; c.timer = c.mode === 'jet' ? 1.6 : rnd(3, 7); if (c.mode === 'jet') { c.vy = 0.45; c.yaw += rnd(-1, 1); } }
    else { c.mode = 'crawl'; c.timer = rnd(4, 9); c.yaw += rnd(-1.2, 1.2); }
  }
  const fwd = [Math.cos(c.yaw), 0, Math.sin(c.yaw)];
  const jetting = c.mode === 'jet';
  c.jet += ((jetting ? 1 : 0) - c.jet) * Math.min(1, dt * 3);
  c.moveAmt += ((c.mode === 'crawl' ? 1 : 0) - c.moveAmt) * Math.min(1, dt * 2);
  // crawls head-first; jets mantle-first (backwards) with the arms trailing
  let v = v3.mul(fwd, 0.05 * c.moveAmt - 0.5 * c.jet);
  const w = v3.add(avoidWalls(c.pos, 0.45, 1), avoidBodies(c.pos, 0.2, 1));
  if (v3.dot(w, fwd) < -0.05) c.yaw += dt * 1.5;
  v = v3.add(v, [w[0] * 0.12, 0, w[2] * 0.12]);
  c.pos = v3.add(c.pos, v3.mul(v, dt));
  const by = bedY(c.pos[0], c.pos[2]);
  c.vy -= 0.35 * dt;
  c.pos[1] = Math.max(by + 0.035, c.pos[1] + c.vy * dt);
  if (c.pos[1] <= by + 0.036) c.vy = Math.max(0, c.vy);
  c.pos[0] = Math.max(-T.TX + 0.3, Math.min(T.TX - 0.3, c.pos[0]));
  c.pos[2] = Math.max(-T.TZ + 0.3, Math.min(T.TZ - 0.3, c.pos[2]));
  // chromatophores: slow camouflage drift, a dark flush while jetting
  c.camo += (0.5 + 0.5 * Math.sin(c.t * 0.13 + c.id * 9) - c.camo) * Math.min(1, dt * 0.5);
  c.q = frameQuat(fwd, [0, 1, 0], 0);
  c.vel = v;
}

// ------------------------------------------------------------ per-frame rigs (primitive lists in the creature's frame)
// ellipsoid spanning a -> b (local x along it), its y radius in the plane of `up`, z radius across
function ellSeg(a, b, ry, rz, up, o) {
  const d = v3.sub(b, a), l = Math.max(v3.len(d), 1e-5);
  return prim(PT.ELL, v3.mul(v3.add(a, b), 0.5), [l * 0.5 + Math.min(ry, rz) * 0.7, ry, rz], Object.assign({}, o, { q: frameQuat(d, up, 0) }));
}
const smooth01 = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
// stable per-creature random numbers in [0, 1)
const crHash = (c, i, a) => { const v = Math.sin((i + 1) * a + c.id * 91.7) * 43758.5453; return v - Math.floor(v); };

// Crab (metres; +x forward, walks along +-z; the bed at y = -0.04). A carapace wider than long,
// broadest across the front third, with five teeth down each front margin; four pairs of jointed,
// laterally flattened walking legs (merus rising to the knee, carpus, propodus and a pointed dactyl
// planted on the bed) in an alternating tetrapod gait; stout chelipeds folded in front of the mouth.
// rounded bar from a to b: cross-section 2 hy (in the plane of `up`) by 2 hz, the ends rounded
function boxSeg(a, b, hy, hz, up, o) {
  const d = v3.sub(b, a), l = Math.max(v3.len(d), 1e-5), r = Math.min(hy, hz) * 0.92;
  return prim(PT.BOX, v3.mul(v3.add(a, b), 0.5), [l * 0.5 + r * 0.6, hy, hz, r], Object.assign({}, o, { q: frameQuat(d, up, 0) }));
}
function crabPrims(c) {
  const P = [], SU = OP.SU, Y = [0, 1, 0];
  P.push(prim(PT.ELL, [0.012, -0.002, 0], [0.036, 0.016, 0.066]));
  P.push(prim(PT.ELL, [-0.02, -0.004, 0], [0.034, 0.015, 0.046], { op: SU, s: 0.014 }));
  P.push(prim(PT.ELL, [0.0, -0.015, 0], [0.036, 0.008, 0.05], { op: SU, s: 0.008, z: 3 }));        // plastron
  P.push(prim(PT.ELL, [0.041, -0.011, 0], [0.008, 0.005, 0.013], { op: SU, s: 0.004, z: 3 }));     // mouthparts
  for (const s of [1, -1]) P.push(seg([0.043, 0.002, s * 0.005], [0.053, 0.001, s * 0.007], 0.0034, 0.0012, { op: SU, s: 0.003 }));
  for (const s of [1, -1]) {
    // five teeth down each front margin, pointing out and a little forward
    for (let j = 0; j < 5; j++) {
      const a = 0.62 + 0.225 * j, e = [0.012 + 0.036 * Math.cos(a) * 0.97, -0.001, s * 0.066 * Math.sin(a) * 0.97];
      const nrm = v3.norm([Math.cos(a) / 0.036 + 5, 0, s * Math.sin(a) / 0.066]);
      P.push(seg(v3.sub(e, v3.mul(nrm, 0.004)), v3.add(e, v3.mul(nrm, 0.0105)), 0.0058, 0.0008, { op: SU, s: 0.003 }));
    }
    // eyes on short stalks in the orbits at the front corners
    P.push(seg([0.04, 0.003, s * 0.016], [0.049, 0.006, s * 0.02], 0.003, 0.0026));
    P.push(prim(PT.SPH, [0.0505, 0.0068, s * 0.0205], [0.0036], { z: 2 }));
    for (let i = 0; i < 4; i++) {
      const be = [0.72, 0.24, -0.3, -0.86][i], Lm = [0.036, 0.042, 0.042, 0.037][i];
      const u = v3.norm([Math.sin(be), 0, s * Math.cos(be)]);
      const ph = c.gait + (i % 2 ? Math.PI : 0) + (s > 0 ? 0 : Math.PI);
      const lift = Math.max(0, Math.sin(ph)) * c.moveAmt, off = -c.dir * Math.cos(ph) * 0.012 * c.moveAmt;
      const A = [[0.022, 0.006, -0.01, -0.025][i], -0.012, s * [0.05, 0.052, 0.047, 0.037][i]];
      const K = v3.add(v3.add(A, v3.mul(u, Lm * 0.93)), [0, Lm * 0.36 + lift * 0.006, off * 0.4]);
      const F = v3.add(v3.add(A, v3.mul(u, Lm * 0.93 + 0.05)), [0, -0.028 + lift * 0.014, off]);
      const KF = v3.sub(F, K);
      const C = v3.add(v3.add(K, v3.mul(KF, 0.2)), [0, 0.006, 0]);
      const D = v3.add(v3.add(K, v3.mul(KF, 0.6)), [0, 0.006, 0]);
      P.push(boxSeg(A, K, 0.0068, 0.0042, Y, { z: 1 }));
      P.push(boxSeg(K, C, 0.0057, 0.004, Y, { z: 1 }));
      P.push(boxSeg(C, D, 0.005, 0.0036, Y, { z: 1 }));
      P.push(seg(D, F, 0.0034, 0.0006, { z: 6 }));
    }
    // cheliped: merus and carpus swing the heavy chela in front of the face, fingers toward the midline;
    // the dactyl (upper finger) opens and closes against the fixed finger; black tips
    const Bc = [0.032, -0.01, s * 0.034], Mc = [0.05, -0.004 + c.raise * 0.006, s * 0.058], Wc = [0.068, 0.002 + c.raise * 0.012, s * 0.05];
    P.push(boxSeg(Bc, Mc, 0.0074, 0.0062, Y, { z: 4 }));
    P.push(ellSeg(Mc, Wc, 0.0082, 0.0074, Y, { z: 4 }));
    const cd = v3.norm([0.72, 0.03 + 0.25 * c.raise, -s * 0.69]), cs = v3.norm(v3.cross(cd, Y)), cu = v3.cross(cs, cd);
    const at = (f, h, l) => v3.add(Wc, v3.add(v3.mul(cd, f), v3.add(v3.mul(cu, h), v3.mul(cs, l))));
    P.push(prim(PT.ELL, at(0.017, 0.001, 0), [0.02, 0.0145, 0.011], { q: frameQuat(cd, cu, 0), z: 4, op: SU, s: 0.006 }));
    const F0 = at(0.031, -0.0055, 0), F1 = at(0.042, -0.006, 0.0006), F2 = at(0.052, -0.002, 0.001);
    P.push(seg(F0, F1, 0.006, 0.0042, { z: 5, op: SU, s: 0.004 })); P.push(seg(F1, F2, 0.0042, 0.001, { z: 7 }));
    const op = 0.08 + 0.45 * c.claw, co = Math.cos(op), so = Math.sin(op), H = at(0.03, 0.0075, 0);
    const rot = (f, h) => v3.add(H, v3.add(v3.mul(cd, f * co - h * so), v3.mul(cu, f * so + h * co)));
    const M1 = rot(0.012, -0.0015), M2 = rot(0.022, -0.0085);
    P.push(seg(H, M1, 0.0054, 0.004, { z: 5 })); P.push(seg(M1, M2, 0.004, 0.001, { z: 7 }));
  }
  return P;
}

// Octopus (metres; head toward +x; the bed at y = -0.035). An egg-shaped mantle behind and above the
// head, eye turrets with horn papillae, the funnel on the left, a web between the arm bases, and eight
// long tapering arms: smooth B-spline tubes whose centrelines are integrated from a curvature profile
// (slow S-bends, a travelling wave while crawling, a curl gathered at the tip); some tips are raised.
// Sucker shading runs along each arm (bsplineTube's uAt: spacing proportional to the arm's radius).
const OCTO_FK = [0, 0.206, 0.395, 0.567, 0.72, 0.851, 0.946, 1.0];   // control points, denser toward the tip
function octoPrims(c) {
  const P = [], SU = OP.SU, J = smooth01(0, 1, c.jet), breath = Math.sin(c.t * 2.1), sw = 1 + 0.04 * breath;
  P.push(prim(PT.ELL, [-0.084 - 0.012 * J, 0.056 - 0.018 * J, 0], [0.066 * (1 + 0.15 * J) * sw, 0.045 * sw, 0.05 * sw], { q: Q.z(-0.3 + 0.28 * J) }));
  P.push(prim(PT.ELL, [-0.032, 0.038, 0], [0.036, 0.031, 0.037], { op: SU, s: 0.022 }));
  P.push(prim(PT.ELL, [0.006, 0.026, 0], [0.036, 0.03, 0.04], { op: SU, s: 0.02 }));
  for (const s of [1, -1]) {
    P.push(prim(PT.SPH, [0.013, 0.047, s * 0.028], [0.016], { op: SU, s: 0.012 }));
    P.push(seg([0.011, 0.06, s * 0.03], [0.008, 0.07, s * 0.032], 0.0036, 0.0006, { op: SU, s: 0.003 }));
  }
  P.push(seg([-0.036, 0.016, 0.037], [-0.011, 0.008, 0.047], 0.0072, 0.0052, { op: SU, s: 0.006 }));
  P.push(prim(PT.ELL, [0.01, -0.016, 0], [0.078, 0.009, 0.078], { op: SU, s: 0.02 }));   // web
  const ground = -0.035, crawl = c.moveAmt, NS = 48;
  const R = (f) => 0.0135 * Math.pow(Math.max(1 - f, 0), 0.9) + 0.001;
  for (let i = 0; i < 8; i++) {
    const r1 = crHash(c, i, 12.9898), r2 = crHash(c, i, 39.346), r3 = crHash(c, i, 73.156), r4 = crHash(c, i, 21.73);
    const th = (i + 0.5) * Math.PI / 4 + 0.14 * (r4 - 0.5) + 0.05 * Math.sin(c.t * 0.5 + i * 1.9);
    const La = 0.29 * (0.86 + 0.28 * r3);
    const ph = c.t * (0.6 + 1.8 * crawl) + i * 0.83;
    const curl = (r1 < 0.5 ? -1 : 1) * (1.8 + 2.4 * r2) * (1 - 0.3 * crawl);   // total turn gathered at the tip
    const lift = (r3 > 0.7 ? 0.03 : 0) + 0.025 * Math.max(0, Math.sin(c.t * 0.31 + i * 2.4)) * (1 - crawl);
    // crawl pose on the bed, and the jet pose (arms streaming back past the head), blended by J
    const x0 = 0.01 + 0.034 * Math.cos(th), z0 = 0.034 * Math.sin(th), pos = [], U = [0];
    let x = x0, y = -0.008, z = z0, hd = th;
    for (let k = 0; k <= NS; k++) {
      const f = k / NS;
      const jet = [x0 + 0.92 * La * f, -0.008 + (0.02 * Math.sin(th) - 0.004) * Math.min(1, 3 * f) + 0.006 * f * Math.sin(2 * ph - 9 * f + i),
        z0 * (1 - 0.6 * Math.min(1, 2 * f)) + 0.012 * f * Math.sin(2.3 * ph - 8 * f)];
      pos.push(J > 0 ? lerp3([x, y, z], jet, J) : [x, y, z]);
      if (k === NS) break;
      const ds = La / NS;
      const kap = 4.5 * Math.sin(2.2 * Math.PI * f + r4 * 6.28) + 0.8 * Math.sin(c.t * 0.4 + i * 1.3 - 3 * f)
        + 7 * crawl * Math.sin(ph - 7 * f) * f + 5 * curl / La * f ** 4;
      hd += kap * ds;
      const f2 = (k + 1) / NS;
      const y2 = -0.008 + (ground + R(f2) * 0.9 + 0.008) * smooth01(0, 0.2, f2) + lift * smooth01(0.45, 1, f2);
      const dh = Math.sqrt(Math.max(ds * ds - (y2 - y) * (y2 - y), ds * ds * 0.2));
      x += Math.cos(hd) * dh; z += Math.sin(hd) * dh; y = y2;
      U.push(U[k] + ds / (2.3 * R((k + 0.5) / NS)));
    }
    const at = (arr, f) => { const u = f * NS, k = Math.min(NS - 1, Math.floor(u)), t = u - k; return Array.isArray(arr[0]) ? lerp3(arr[k], arr[k + 1], t) : arr[k] + (arr[k + 1] - arr[k]) * t; };
    P.push(...bsplineTube(OCTO_FK.map(f => at(pos, f)), OCTO_FK, R, { op: SU, s: 0.003, s0: 0.014 }, (f) => f < 0.62 ? 2 : 3, (f) => at(U, f)));
  }
  for (const s of [1, -1]) P.push(prim(PT.SPH, [0.018, 0.052, s * 0.037], [0.0095], { z: 1 }));
  return P;
}

// Jellyfish (bell radii; bell centre at the origin, axis +y). A domed bell hollowed underneath, four
// horseshoe gonads, a short marginal fringe, four long frilly oral arms spiralling down from the mouth,
// and a ring of long thin marginal tentacles (one analytic primitive, see strands()). Tentacles and
// oral arms trail with c.trail (the water streaming past, in the bell's frame) and sway in slow waves
// that quicken with each pulse. Drawn by the tracer as translucent volume (route 3).
const JELLY_L = 2.4;   // mean marginal tentacle length (they range 0.7-1.3 of it)
function jellyPrims(c) {
  const k = c.contract, sr = 1 - 0.14 * k, sh = 1 + 0.1 * k, P = [], tr = c.trail || [0, 0];
  P.push(prim(PT.ELL, [0, 0, 0], [sr, 0.55 * sh, sr]));
  P.push(prim(PT.ELL, [0, -0.12, 0], [0.9 * sr, 0.5 * sh, 0.9 * sr], { op: OP.SUB }));
  P.push(prim(PT.BOX, [0, 0.55, 0], [1.3, 0.6, 1.3, 0], { op: OP.INT }));
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; P.push(prim(PT.TOR, [Math.cos(a) * 0.27 * sr, 0.25 * sh, Math.sin(a) * 0.27 * sr], [0.12 * sr, 0.028], { z: 1 })); }
  P.push(prim(PT.TUBE, [0, -0.1 - 0.03 * k, 0], [0.93 * sr, 0.01, 0.06], { z: 3 }));
  const L = JELLY_L, FR = [0, 0.2, 0.4, 0.6, 0.8, 1];
  for (let j = 0; j < 4; j++) {
    const La = 1.75 * (0.88 + 0.24 * crHash(c, j, 17.13)), a0 = j * Math.PI / 2, pts = [];
    for (const f of FR) {
      const d = f * La, ang = a0 + 1.1 * f + 0.28 * Math.sin(c.t * 0.8 + j * 1.7 - 3 * f);
      const rad = 0.05 + 0.2 * Math.sin(0.5 * Math.PI * Math.min(1, 1.4 * f)) + 0.03 * Math.sin(c.t * 1.1 + j - 4 * f) * f;
      const dr = (d * d) / (L * L);
      pts.push([Math.cos(ang) * rad + tr[0] * dr, 0.28 - d, Math.sin(ang) * rad + tr[1] * dr]);
    }
    P.push(...bsplineTube(pts, FR, (f) => 0.075 * (1 - 0.62 * f) + 0.01, { s: 0.02, s0: 0.05, op: OP.SU, z: 2 }));
  }
  const ph = ((c.t * 2.0 + 1.5 * k) % (8 * Math.PI) + 8 * Math.PI) % (8 * Math.PI);
  P.push(strands([0, -0.07 - 0.65 * L, 0], 24, c.id * 7.31, 0.95 * sr, L, 0.012, tr, 0.07 + 0.05 * k, ph, { z: 5 }));
  return P;
}

// ------------------------------------------------------------ stepping + packing
function stepCreatures(dt) {
  if (dt <= 0) return;
  for (const c of CREATURES) {
    if (c.T.fish) stepFish(c, dt, CREATURES);
    else if (c.kind === 'jelly') stepJelly(c, dt);
    else if (c.kind === 'crab') stepCrab(c, dt, CREATURES);
    else stepOctopus(c, dt, CREATURES);
  }
}
function packCreatures(d, n) {
  for (const c of CREATURES) {
    if (n >= OBJ_ROWS - 8) break;
    const Rm = quat.mat(c.q);
    let m6, m7, k, bound, mat = 8, pos = c.pos;
    if (c.T.fish) {
      const M = MODELS[c.T.model];
      m6 = [M.start, M.count, 1, M.id]; m7 = [c.amp, c.phase, 7.5, c.bend]; k = [c.len, 0, 0, 0];
      bound = (M.bound + 0.1) * c.len;
    } else {
      const P = c.kind === 'jelly' ? jellyPrims(c) : c.kind === 'crab' ? crabPrims(c) : octoPrims(c);
      const s = c.kind === 'jelly' ? c.size : 1;
      m7 = c.kind === 'jelly' ? [c.contract, c.t, 0, 0] : c.kind === 'octopus' ? [c.camo, c.t, c.jet, 0] : [c.t, c.claw, 0, 0];
      if (c.kind === 'jelly') {
        // centre the object on the whole animal (bell plus trailing tentacles) for a tight bound;
        // the tracer gets the bell's offset in m7.z
        const sh = 1.3;
        for (const pr of P) pr.p = [pr.p[0], pr.p[1] + sh, pr.p[2]];
        pos = v3.sub(c.pos, v3.mul(Q.rot(c.q, [0, 1, 0]), sh * s));
        m7[2] = sh; mat = 10;
      }
      const r = dynAdd(P);
      m6 = [r.start, r.count, 0, MODEL_ID[c.kind]];
      k = [s, 0, 0, 0];
      bound = modelBound(P) * s + 0.005;
    }
    putObj(d, n, { pos, bound, R: Rm, type: 6, mat, seed: c.id * 10, k, m6, m7 });
    n++;
  }
  return n;
}
// creatures push the water (ink wakes) and nudge falling sand
function creatureFluidProxies() {
  const out = [];
  for (const c of CREATURES) {
    const r = c.T.fish ? c.len * 0.3 : c.kind === 'jelly' ? c.size * 0.8 : c.kind === 'octopus' ? 0.08 : 0.07;
    out.push({ p: c.pos, r, v: c.vel });
  }
  return out;
}
