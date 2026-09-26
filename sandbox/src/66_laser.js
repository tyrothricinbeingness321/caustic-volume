// ============================================================================
//  LASER — mounted emitter, beam-tree pass, async readback + compaction,
//  uniforms for the tracer (beam glow and spots)
// ============================================================================
const LASER_COLORS = {
  green:  { label: 'Green', css: '#3dff5c', lin: [0.05, 1.0, 0.09], ext: 0.08 },
  red:    { label: 'Red', css: '#ff3b2e', lin: [1.0, 0.03, 0.015], ext: 0.38 },
  violet: { label: 'Violet', css: '#8a3cff', lin: [0.42, 0.02, 1.0], ext: 0.06 },
};
// where the module sits and what it points at by default
const LASER_MOUNTS = {
  side:  { label: 'Side', pos: () => [TANK.TX + 0.42, 0.5, 0.3], aim: () => [0.1, TANK.LEVEL, 0.2], stand: 'floor' },
  above: { label: 'Above', pos: () => [1.4, TANK.LEVEL + 0.6, 0.35], aim: () => [0.35, TANK.LEVEL, 0.2], stand: 'ceiling' },
  front: { label: 'Front', pos: () => [0.35, 0.34, TANK.TZ + 0.45], aim: () => [0.05, TANK.LEVEL, -0.25], stand: 'floor' },
};
const LASER = { on: false, color: 'green', mount: 'side', aim: null, sweep: false, haze: 0.5, t: 0,
  fence: null, segs: [], spots: [], nSeg: 0, nSpot: 0, dir: [1, 0, 0], pos: [0, 0, 0] };

function laserSetMount(m) { LASER.mount = m; LASER.aim = LASER_MOUNTS[m].aim(); }
function laserGeom() {
  const M = LASER_MOUNTS[LASER.mount];
  const pos = M.pos();
  const aim = LASER.aim || M.aim();
  let dir = v3.norm(v3.sub(aim, pos));
  if (LASER.sweep) {
    // sweep the elevation slowly so the refracted / reflected paths swing (and cross the critical angle)
    const side = v3.norm(v3.cross(dir, [0, 1, 0]));
    dir = v3.norm(Q.rot(Q.axis(side, 0.2 * Math.sin(LASER.t * 0.45)), dir));
  }
  return { pos, dir, aperture: v3.add(pos, v3.mul(dir, 0.012)), stand: M.stand };
}
function packLaser(d, n) {
  if (!LASER.on || n > OBJ_ROWS - 3) return n;
  const g = laserGeom(), M = MODELS.laser;
  const up = Math.abs(g.dir[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const z = v3.norm(v3.cross(g.dir, up)), y = v3.cross(z, g.dir);
  const Rm = [g.dir[0], y[0], z[0], g.dir[1], y[1], z[1], g.dir[2], y[2], z[2]];
  putObj(d, n++, { pos: g.pos, bound: M.bound + 0.004, R: Rm, type: 6, mat: 8, k: [1, 0, 0, 0], m6: [M.start, M.count, 0, M.id] });
  // stand: a post down to the floor, or a rod up to the ceiling
  const base = v3.add(g.pos, Q.rot([0, 0, 0, 1], v3.add(v3.mul(g.dir, -0.07), v3.mul(y, -0.036))));
  if (g.stand === 'floor') {
    const L = Math.max(0.02, base[1] / 2);
    putObj(d, n++, { pos: [base[0], L, base[2]], bound: L + 0.01, type: 2, mat: 0, k: [L, 0.008, 0, 0], alb: [0.55, 0.56, 0.58, 0.3] });
    putObj(d, n++, { pos: [base[0], 0.006, base[2]], bound: 0.07, type: 3, mat: 0, k: [0.06, 0.006, 0.003, 0], alb: [0.08, 0.08, 0.09, 0.4] });
  } else {
    const L = 1.4;
    const top = v3.add(g.pos, v3.mul(y, 0.024));
    putObj(d, n++, { pos: [top[0], top[1] + L, top[2]], bound: L + 0.01, type: 2, mat: 1, k: [L, 0.005, 0, 0], alb: [0.03, 0.03, 0.035, 0.4] });
  }
  return n;
}
function laserUniforms() {
  const C = LASER_COLORS[LASER.color];
  const wt = WATER_TYPES[STATE.waterType];
  // how much the beam scatters: the water's own scattering (the laser channel) plus the "haze" (milk / dust)
  const ch = LASER.color === 'red' ? 0 : LASER.color === 'green' ? 1 : 2;
  const sigW = wt.s[ch] * STATE.clarity + 0.02 + LASER.haze * 0.35;
  return { tLz: R.lz, uLzN: LASER.on ? LASER.nSeg : 0, uLzSpotN: LASER.on ? LASER.nSpot : 0, uLzCol: C.lin, uLzW: 0.0022,
    uLzSigW: sigW, uLzExt: C.ext + sigW * 0.3, uLzHaze: 0.002 + LASER.haze * 0.03, uLzHalo: 0.22 + 0.3 * LASER.haze };
}
// GPU tree pass + asynchronous readback of the previous frame's tree
function simulateLaser(dt, L, nObj) {
  const gl = GLX.gl;
  if (!R.lzF) return;
  if (!LASER.on) { LASER.nSeg = 0; LASER.nSpot = 0; return; }
  LASER.t += dt;
  if (LASER.fence) {
    const st = gl.clientWaitSync(LASER.fence, 0, 0);
    if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, R.lzPbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, R.lzRead);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(LASER.fence); LASER.fence = null;
      laserCompact();
    }
  }
  if (LASER.fence) return;
  const g = laserGeom(), T = TANK;
  const inWater = WATER.inside(g.aperture[0], g.aperture[2]) && g.aperture[1] < WATER.heightAt(g.aperture[0], g.aperture[2]) && g.aperture[1] > T.BOT;
  const C = LASER_COLORS[LASER.color];
  GLX.blend(false);
  bindTarget(R.lzF, 63, 1);
  P.laser.use();
  sceneUniforms(P.laser, L, nObj);
  P.laser.setAll({ uLzO: g.aperture, uLzD: g.dir, uLzMed: inWater ? 1 : 0, uLzMaxSlope: 1.2 + seaParams().chop * 0.8,
    uLzSandMax: sandMaxBound(), uLzExtW: C.ext, tSandH: R.sand.hc.h, uSandDom: sandDomain() });
  drawFS();
  // both attachments -> one PBO (row 0: starts, row 1: ends)
  readTexAsync(R.lzA, 0, 0, 63, 1, R.lzPbo, 0);
  readTexAsync(R.lzB, 0, 0, 63, 1, R.lzPbo, 63 * 16);
  LASER.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
}
function laserCompact() {
  const d = R.lzRead, C = LASER_COLORS[LASER.color], segs = [], spots = [];
  for (let i = 0; i < 63; i++) {
    const a = i * 4, b = (63 + i) * 4, P = d[a + 3];
    if (!(P > 0.003) || !Number.isFinite(d[b])) continue;
    const s = [d[a], d[a + 1], d[a + 2]], e = [d[b], d[b + 1], d[b + 2]], code = Math.round(d[b + 3]);
    const med = code % 2, len = v3.len(v3.sub(e, s));
    segs.push({ s, e, P, med });
    if (code >= 2) spots.push({ p: e, P: P * (med === 1 ? Math.exp(-C.ext * len) : 1) });
  }
  segs.sort((x, y) => y.P - x.P); spots.sort((x, y) => y.P - x.P);
  const T = R.lzData;
  T.fill(0);
  const P0 = 2.6, S0 = 0.012;
  LASER.nSeg = Math.min(32, segs.length); LASER.nSpot = Math.min(8, spots.length);
  for (let i = 0; i < LASER.nSeg; i++) {
    const g = segs[i];
    // long escaping segments are clipped to something sensible
    const dir = v3.sub(g.e, g.s), l = v3.len(dir), e = l > 14 ? v3.add(g.s, v3.mul(dir, 14 / l)) : g.e;
    T.set([g.s[0], g.s[1], g.s[2], g.P * P0], i * 4);
    T.set([e[0], e[1], e[2], g.med], (32 + i) * 4);
  }
  for (let i = 0; i < LASER.nSpot; i++) { const s = spots[i]; T.set([s.p[0], s.p[1], s.p[2], s.P * S0], (64 + i) * 4); }
  LASER.segs = segs; LASER.spots = spots;
  uploadTex(R.lz, T);
}
function buildLaserResources() {
  const gl = GLX.gl;
  R.lzA = makeTex(63, 1, FMT.RGBA32F, { filter: 'nearest' });
  R.lzB = makeTex(63, 1, FMT.RGBA32F, { filter: 'nearest' });
  R.lzF = makeFBO([R.lzA, R.lzB]);
  R.lzPbo = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, R.lzPbo);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, 2 * 63 * 16, gl.STREAM_READ);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  R.lzRead = new Float32Array(2 * 63 * 4);
  R.lz = makeTex(32, 3, FMT.RGBA32F, { filter: 'nearest' });
  R.lzData = new Float32Array(32 * 3 * 4);
  LASER.fence = null; LASER.nSeg = 0; LASER.nSpot = 0;
}
function freeLaserResources() {
  if (!R.lzF) return;
  const gl = GLX.gl;
  [R.lzA, R.lzB, R.lz].forEach(freeTex); freeFBO(R.lzF);
  gl.deleteBuffer(R.lzPbo);
  if (LASER.fence) { gl.deleteSync(LASER.fence); LASER.fence = null; }
  R.lzF = null;
}
// aim point under the cursor: first hit on the tank's water box (surface, glass) or the bed
function pickAimPoint(cx, cy) {
  const { o, d } = camRay(cx, cy), T = TANK;
  const inv = d.map(x => 1 / (Math.abs(x) > 1e-8 ? x : 1e-8));
  const lo = [-T.TX, T.BOT, -T.TZ], hi = [T.TX, T.LEVEL, T.TZ];
  let tn = -1e9, tf = 1e9;
  for (let a = 0; a < 3; a++) { const t0 = (lo[a] - o[a]) * inv[a], t1 = (hi[a] - o[a]) * inv[a]; tn = Math.max(tn, Math.min(t0, t1)); tf = Math.min(tf, Math.max(t0, t1)); }
  if (tn > tf || tf < 0) return null;
  const t = tn > 0 ? tn : tf;
  return v3.add(o, v3.mul(d, t));
}
