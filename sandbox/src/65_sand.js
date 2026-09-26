// ============================================================================
//  SAND RUNTIME — hopper, pouring, colour modes, GPU passes, readback for physics
// ============================================================================
const NOZZLE_Y = TANK.TOP + 0.35;
const SAND = {
  pour: false, tool: false, sweep: false,
  mode: 'cycle', color: 0, flow: 6, grain: 0.6, cycle: 8,
  pos: [0.2, 0.62], target: [0.2, 0.62], prevPos: null, sweepT: 0, pourClock: 0,
  head: 0, acc: 0, vp: 0, ws: 0.08, life: 20,
  hist: [], lastSpawnT: -1e9, lastActiveT: -1e9, showT: -1e9, lastKickT: -1e9, kick: null, kickAcc: 0,
  frame: 0, maxH: 0, hasProbe: false, total: 0, bubAcc: 0, dropAcc: 0,
};
const srgbLin = (css) => { const v = parseInt(css.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }); };
const SAND_LIN = SAND_COLORS.map(c => srgbLin(c.css));
const SAND_PAL = new Float32Array(SAND_LIN.flat());
const SAND_AVG = [0, 1, 2].map(k => SAND_LIN.reduce((s, c) => s + c[k], 0) / SAND_LIN.length);

function sandGrainRadius() { return SAND.grain * 0.5e-3; }
// settling velocity of a quartz grain of diameter d in water (Ferguson & Church 2004)
function settlingSpeed(dmm) {
  const d = dmm * 1e-3, Rr = 1.65, nu = 1.0e-6;
  return Rr * GRAV * d * d / (18 * nu + Math.sqrt(0.75 * Rr * GRAV * d * d * d));
}
function sandPouring() { return SAND.pour || SAND.tool; }
function sandColorAt(clock) {
  if (SAND.mode === 'mixed') return { rgb: SAND_AVG, m: 1, idx: -1 };
  const idx = SAND.mode === 'cycle' ? (SAND.color + Math.floor(clock / Math.max(0.2, SAND.cycle))) % SAND_COLORS.length : SAND.color;
  return { rgb: SAND_LIN[idx], m: 0, idx };
}
function sandNozzleR() { return 0.008 + 0.006 * Math.sqrt(SAND.flow / 6); }
function sandHopperVisible() { return sandPouring() || STATE.tool === 'sand' || SIM_T - SAND.lastSpawnT < 0.8; }

// ------------------------------------------------------------ CPU view of the bed (async readback)
function sandHeightAt(x, z) {
  const S = R.sand;
  if (!S || !SAND.hasProbe || SAND.maxH < 1e-4) return 0;
  const u = (x + TANK.TX) / (2 * TANK.TX) * S.pw - 0.5, v = (z + TANK.TZ) / (2 * TANK.TZ) * S.ph - 0.5;
  const i = Math.max(0, Math.min(S.pw - 2, Math.floor(u))), j = Math.max(0, Math.min(S.ph - 2, Math.floor(v)));
  const fx = Math.max(0, Math.min(1, u - i)), fz = Math.max(0, Math.min(1, v - j));
  const d = S.probeData, W = S.pw, at = (a, b) => d[(b * W + a) * 4];
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fz) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fz;
}
function sandNormalAt(x, z) {
  const e = 0.05;
  const gx = (sandHeightAt(x + e, z) - sandHeightAt(x - e, z)) / (2 * e), gz = (sandHeightAt(x, z + e) - sandHeightAt(x, z - e)) / (2 * e);
  return v3.norm([-gx, 1, -gz]);
}
function sandReadback() {
  const gl = GLX.gl, S = R.sand;
  if (S.fence) {
    const st = gl.clientWaitSync(S.fence, 0, 0);
    if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) return;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, S.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, S.probeData);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteSync(S.fence); S.fence = null;
    let mx = 0, sum = 0;
    for (let i = 0; i < S.probeData.length; i += 4) { mx = Math.max(mx, S.probeData[i + 1]); sum += S.probeData[i]; }
    SAND.maxH = mx; SAND.hasProbe = true;
    SAND.total = sum / (S.pw * S.ph) * (2 * TANK.TX) * (2 * TANK.TZ);
    return;
  }
  if (++SAND.frame % 6) return;
  bindTarget(S.probeF);
  P.sandProbe.use().setAll({ tH: S.hc.h, uDim: [S.gw, S.gh] });
  drawFS();
  readTexAsync(S.probe, 0, 0, S.pw, S.ph, S.pbo);
  S.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
}
function sandDomain() { return [-TANK.TX, -TANK.TZ, 1 / (2 * TANK.TX), 1 / (2 * TANK.TZ)]; }
// visual extinction per parcel and per D-grid cell, and the plume's negative buoyancy per parcel
function sandOptics() {
  const dc = R.ink.dCell, vcell = dc[0] * dc[1] * dc[2];
  const vf = SAND.vp * 0.6 / vcell;
  return { sig: Math.min(250, 0.45 * vf / sandGrainRadius() * 0.012), buoy: Math.min(4, GRAV * 1.65 * vf * 0.25) };
}

// ------------------------------------------------------------ per-frame: hopper, spawning, GPU passes
function stepSandHopper(dt) {
  const T = TANK;
  if (SAND.sweep && sandPouring() && !SAND.tool) {
    SAND.sweepT += dt;
    const t = SAND.sweepT;
    SAND.target = [T.TX * 0.82 * Math.sin(0.35 * t), T.TZ * 0.78 * Math.sin(0.13 * t + 0.7)];
  }
  const lim = [T.TX - 0.08, T.TZ - 0.08];
  const tg = [Math.max(-lim[0], Math.min(lim[0], SAND.target[0])), Math.max(-lim[1], Math.min(lim[1], SAND.target[1]))];
  const dx = tg[0] - SAND.pos[0], dz = tg[1] - SAND.pos[1], d = Math.hypot(dx, dz), vmax = 0.9 * dt;
  if (d > vmax) { SAND.pos[0] += dx / d * vmax; SAND.pos[1] += dz / d * vmax; } else SAND.pos = tg;
}
// Stirring close to the bed lifts sand back into the water: the bed is eroded there and the same
// volume is released as parcels, coloured by the bed's surface. The paddle reaches 30 cm down.
function sandKick(p, v, dt) {
  const S = R.sand;
  if (!S || !SAND.hasProbe || !(SAND.vp > 0) || dt <= 0) return;
  const h = sandHeightAt(p[0], p[2]), above = p[1] - (TANK.BOT + h);
  const sp = Math.hypot(v[0], v[2]) + 0.5 * Math.abs(v[1]);
  if (h < 0.002 || sp < 0.12 || above > 0.32) return;
  const r = 0.1, reach = 1 - Math.max(0, above - 0.02) / 0.3;
  const vol = Math.min(h * Math.PI * r * r * 0.15, 0.0006 * sp * reach * dt * 60);   // m^3 this frame
  SAND.kickAcc += vol / SAND.vp;
  const n = Math.min(512, Math.floor(SAND.kickAcc));
  if (n < 1) return;
  SAND.kickAcc -= n;
  const k = SAND.kick || (SAND.kick = { x: p[0], z: p[2], r, n: 0, v: [0, 0, 0] });
  k.n += n; k.x = p[0]; k.z = p[2]; k.v = [v[0] * 0.6, Math.max(0, v[1]) * 0.4, v[2] * 0.6];
}
function simulateSand(dt, fb) {
  const gl = GLX.gl, S = R.sand, T = TANK;
  if (!S) return;
  sandReadback();
  const prev = SAND.prevPos || SAND.pos.slice();
  if (dt > 0) stepSandHopper(dt);
  SAND.prevPos = SAND.pos.slice();
  const pouring = sandPouring() && dt > 0;
  SAND.ws = settlingSpeed(SAND.grain);
  SAND.life = 1.35 * (T.LEVEL - T.BOT) / SAND.ws + 2.5;
  const rate = S.total / SAND.life;
  SAND.vp = SAND.flow * 1e-3 / rate;
  // colour at the start / end of this frame (cycle mode switches on the pour clock)
  const c0 = sandColorAt(SAND.pourClock);
  if (pouring) SAND.pourClock += dt;
  const c1 = sandColorAt(SAND.pourClock);
  let sw = 1;
  if (c0.idx !== c1.idx && dt > 0) { const per = Math.max(0.2, SAND.cycle); sw = Math.max(0, Math.min(1, ((Math.floor(SAND.pourClock / per) * per) - (SAND.pourClock - dt)) / dt)); }
  let nSpawn = 0;
  if (pouring) {
    SAND.acc += rate * dt;
    nSpawn = Math.min(S.total >> 3, Math.floor(SAND.acc));
    SAND.acc -= nSpawn;
    if (nSpawn > 0) SAND.lastSpawnT = SIM_T;
  }
  // sand lifted off the bed by stirring (see sandKick)
  const kick = SAND.kick; SAND.kick = null;
  const nKick = kick && dt > 0 ? Math.max(0, Math.min(kick.n, (S.total >> 3) - nSpawn)) : 0;
  if (nKick > 0) SAND.lastKickT = SIM_T;
  // stream history (drives the rendered air stream: centre, radius and colour by fall time)
  if (dt > 0 || !SAND.hist.length) SAND.hist.unshift({ t: SIM_T, x: SAND.pos[0], z: SAND.pos[1], r: pouring ? sandNozzleR() : 0, c: c1.rgb, m: c1.m });
  while (SAND.hist.length > 2 && SIM_T - SAND.hist[SAND.hist.length - 2].t > 0.6) SAND.hist.pop();
  const inFlight = SIM_T - Math.max(SAND.lastSpawnT, SAND.lastKickT) < SAND.life + 0.5;
  if (inFlight) SAND.lastActiveT = SIM_T;
  if (dt <= 0) return;
  const settling = SIM_T - SAND.lastActiveT < 10;
  if (!inFlight && !settling) return;
  if (inFlight) { INK.active = true; INK.last = Math.max(INK.last, SIM_T); }
  GLX.blend(false);
  const n = S.n, tank = [T.TX, T.TZ, T.BOT, T.TOP];
  // 1. particles
  if (inFlight) {
    bindTarget(S.nxt.f, n, n);
    const y0 = NOZZLE_Y;
    P.sandStep.use().setAll({ tSP: S.cur.p, tSV: S.cur.v, tVel: R.ink.vel.a, tSurf: R.surf, tSandH: S.hc.h, uSandDom: sandDomain(), uTank: tank,
      uSN: n, uTotal: S.total, uSpawnA: SAND.head, uSpawnN: nSpawn, uFrame: FRAME, uPalN: SAND_COLORS.length, uPal: SAND_PAL,
      uNumB: fb.n, uBPos: fb.P, uBVel: fb.V, uSpawnP0: [prev[0], y0, prev[1]], uSpawnP1: [SAND.pos[0], y0, SAND.pos[1]],
      uSpawnC0: [...c0.rgb, c0.m], uSpawnC1: [...c1.rgb, c1.m], uSwitch: sw, uSpawnR: sandNozzleR() * 0.8, uSpawnV: 0.5,
      uDt: dt, uSettle: SAND.ws, uTau: 0.06, uFluid: R.ink && INK.active ? 1 : 0, uMaxAge: SAND.life * 0.95, uDisp: 0.006,
      uKickN: nKick, uKickP: nKick ? [kick.x, kick.z, kick.r, 0] : [0, 0, 0.1, 0], uKickV: nKick ? kick.v : [0, 0, 0], tSandTop: S.hc.t });
    inkGridUniforms(P.sandStep);
    drawFS();
    S.swapP();
    SAND.head = (SAND.head + nSpawn + nKick) % S.total;
    // 2. landed parcels -> deposit accumulators
    bindTarget(S.depF);
    GLX.clear();
    GLX.blend(true);
    const depSig = Math.max(0.6, Math.min(4, Math.sqrt(SAND.vp / (S.cell[0] * S.cell[1] * 0.004 * 2 * Math.PI))));
    P.sandDep.use().setAll({ tSP: S.cur.p, tSV: S.cur.v, uSN: n, uTank: tank, uDepSig: depSig, uGrid: [S.gw, S.gh] });
    drawPoints(S.total);
    // 3. suspended parcels -> density grid for rendering / buoyancy / shadowing
    bindTarget(S.susF);
    GLX.clear();
    P.sandSus.use().setAll({ tSP: S.cur.p, tSV: S.cur.v, uSN: n, uAtlas: [R.ink.dL.w, R.ink.dL.h] });
    inkGridUniforms(P.sandSus);
    drawPoints(S.total);
    GLX.blend(false);
  } else if (!SAND.susClear) {
    for (const f of [S.depF, S.susF]) { bindTarget(f); GLX.clear(); }
  }
  SAND.susClear = !inFlight;
  // 4. bed: deposit, avalanche, render copy, strata
  const uDim = [S.gw, S.gh];
  bindTarget(S.hn.f);
  P.sandDeposit.use().setAll({ tH: S.hc.h, tTop: S.hc.t, tDep0: S.dep0, tDep1: S.dep1, uVpA: SAND.vp / (S.cell[0] * S.cell[1]), uHMax: T.LEVEL - 0.1 - T.BOT,
    uErode: nKick ? [kick.x, kick.z, kick.r * 0.6, nKick * SAND.vp] : [0, 0, 1, 0], uGridW: [-T.TX, -T.TZ, S.cell[0], S.cell[1]] });
  drawFS(); S.swapH();
  P.sandSlide.use().setAll({ uCell: S.cell, uDim, uTanR: 0.62, uK: 0.1, uCreep: 0.0015 });
  for (let i = 0; i < R.q.slide; i++) {
    bindTarget(S.hn.f);
    P.sandSlide.setAll({ tH: S.hc.h, tTop: S.hc.t });
    drawFS(); S.swapH();
  }
  bindTarget(S.rendF);
  P.sandRender.use().setAll({ tH: S.hc.h, uCell: S.cell, uDim });
  drawFS();
  bindTarget(S.atlas.fb);
  P.sandPaint.use().setAll({ tOld: S.atlas.a, tH: S.hc.h, tTop: S.hc.t, uSCDim: S.cDim, uSCTx: S.cL.tx, uDy: S.dy });
  drawFS(); S.atlas.swap();
  // pour effects at the water entry point: ripples, entrained bubbles, a little spray, a downward jet
  if (pouring) {
    const e = sandHistAt(0.36), f = Math.sqrt(SAND.flow / 6);
    const hy = WATER.heightAt(e.x, e.z);
    addImpulse(e.x, e.z, 0.03 + sandNozzleR() * 2, 0.0012 * f);
    SAND.bubAcc += dt * 30 * f;
    while (SAND.bubAcc >= 1) {
      SAND.bubAcc -= 1;
      const a = Math.random() * 6.28, rr = Math.random() * 0.05;
      spawnBubble([e.x + Math.cos(a) * rr, hy - 0.02 - Math.random() * 0.12, e.z + Math.sin(a) * rr], 0.0012 + Math.pow(Math.random(), 3) * 0.004, [Math.cos(a) * 0.1, -0.1, Math.sin(a) * 0.1]);
    }
    SAND.dropAcc += dt * 10 * f;
    while (SAND.dropAcc >= 1) {
      SAND.dropAcc -= 1;
      const a = Math.random() * 6.28;
      spawnDrop([e.x, hy + 0.01, e.z], [Math.cos(a) * 0.35, 0.5 + Math.random() * 0.9, Math.sin(a) * 0.35], 0.0012 + Math.random() * 0.002);
    }
    if (R.ink) INK.inj.push({ p: [e.x, T.LEVEL - 0.04, e.z], r: 0.035, A: [0, 0, 0], amt: 0, v: [0, -0.6 * f, 0], vw: 0.5 });
  }
}
// jump the hopper (no streak of grains along the jump, no stale stream history)
function sandTeleport(x, z) {
  SAND.pos = [x, z]; SAND.target = [x, z]; SAND.prevPos = [x, z];
  for (const e of SAND.hist) { e.x = x; e.z = z; }
}
function sandHistAt(age) {
  const h = SAND.hist;
  if (!h.length) return { x: SAND.pos[0], z: SAND.pos[1], r: 0, c: SAND_AVG, m: 0 };
  const t = SIM_T - age;
  for (let i = 0; i < h.length - 1; i++) {
    if (h[i + 1].t <= t) {
      const a = h[i], b = h[i + 1], f = a.t > b.t ? (a.t - t) / (a.t - b.t) : 0;
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, r: a.r + (b.r - a.r) * f, c: f < 0.5 ? a.c : b.c, m: f < 0.5 ? a.m : b.m };
    }
  }
  const l = h[h.length - 1];
  return { x: l.x, z: l.z, r: 0, c: l.c, m: l.m };   // older than the recorded history: nothing was falling
}
// uniforms for the analytic air stream: 8 samples of the nozzle history at increasing fall times
const STREAM_DT = 0.055;
function sandStreamUniforms() {
  const P8 = new Float32Array(32), C8 = new Float32Array(32);
  let on = 0;
  for (let k = 0; k < 8; k++) {
    const s = sandHistAt(k * STREAM_DT);
    P8.set([s.x, s.z, 0, s.r], k * 4);
    C8.set([s.c[0], s.c[1], s.c[2], s.m], k * 4);
    if (s.r > 0) on = 1;
  }
  const e = sandHistAt(0.36);
  const wy = WATER.inside(e.x, e.z) ? WATER.heightAt(e.x, e.z) : TANK.LEVEL;
  return { uStreamOn: on, uStreamP: P8, uStreamC: C8, uStream: [NOZZLE_Y, wy, 0.9 + 0.5 * Math.sqrt(SAND.flow / 6), 0.5] };
}
function sandBuries() { return sandPouring() || SAND.maxH > 0.003 || SIM_T - SAND.lastSpawnT < SAND.life; }
function sandBuried(b) { return TANK.BOT + sandHeightAt(b.pos[0], b.pos[2]) > b.pos[1] - 0.2 * b.bound; }
function sandResetBed() {
  SAND.acc = 0; SAND.head = 0; SAND.lastSpawnT = -1e9; SAND.lastActiveT = -1e9;
  SAND.maxH = 0; SAND.total = 0; SAND.hasProbe = false; SAND.hist.length = 0; SAND.susClear = false;
  for (const b of BODIES) if (b.sleep) { b.sleep = false; b.rest = 0; }
}
function clearSand() {
  SAND.pour = false; SAND.tool = false;
  sandResetBed();
  clearSandTextures();
  if (typeof syncSandUI === 'function') syncSandUI();
}
// hopper (drawn only while pouring or with the sand tool): a steel canister with a nozzle and a hanging rod
function packHopper(d, n) {
  if (!sandHopperVisible() || n > 61) return n;
  const x = SAND.pos[0], z = SAND.pos[1], rn = sandNozzleR();
  const put = (pos, bound, type, mat, prm, alb) => { putObj(d, n++, { pos, bound, type, mat, k: prm, alb }); };
  put([x, NOZZLE_Y + 0.025, z], Math.hypot(rn + 0.008, 0.025) + 0.004, 3, 0, [rn + 0.008, 0.025, 0.004, 0], [0.62, 0.6, 0.58, 0.3]);
  put([x, NOZZLE_Y + 0.05 + 0.09, z], Math.hypot(0.075, 0.09) + 0.004, 3, 0, [0.075, 0.09, 0.012, 0], [0.74, 0.73, 0.71, 0.22]);
  const L = 2.4;
  put([x, NOZZLE_Y + 0.23 + L, z], L + 0.01, 2, 1, [L, 0.005, 0, 0], [0.02, 0.02, 0.022, 0.45]);
  return n;
}
