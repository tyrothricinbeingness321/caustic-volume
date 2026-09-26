// ============================================================================
//  FRAME ORCHESTRATION — sim → surface → photons → caustic volume → trace → post
// ============================================================================
const STATE = {
  preset: 'MEDIUM', scale: 0.75,
  sea: 0.5, chop: 0.85, windDir: 0.65, peak: 1.25, swell: 0.4, spread: 0.35,
  waterType: 'Caribbean', clarity: 1.6,
  sunElev: 38, sunAz: 228,
  godRays: 1.7, causGain: 1.0, exposure: 1.2, bloom: 0.045, dispersion: true, foam: 1.0,
  glass: true, bottom: 0, particles: 0.4, current: 1.0,
  autoDrop: false, dropEvery: 4.5, maxObjects: 13, item: 12,
  taa: true, autoOrbit: false, paused: false, debug: 0, aperture: 0.35,
  tool: 'orbit', lightMode: 'sun',
  lampCount: 1, lampSel: 0,
  lamps: [
    { x: 0.45, y: 2.35, z: 0.25, power: 1.4, beam: 36, color: '#ffffff' },
    { x: -1.0, y: 2.2, z: -0.3, power: 1.4, beam: 36, color: '#ffffff' },
    { x: 1.3, y: 2.1, z: -0.5, power: 1.4, beam: 36, color: '#ffffff' },
  ],
  get lamp() { return this.lamps[this.lampSel]; },
  ink: { color: 0, size: 1.0, pigment: 0.45, sink: 0.8, turb: 0.35, fade: 150, auto: false, every: 6.5 },
};
const P = {}; // programs
const CAM = { target: [0, 0.72, 0], yaw: 0.62, pitch: 0.2, dist: 6.4, fov: 42, pos: [0, 0, 0], rot: null, vp: null, prevVP: null };
let SIM_T = 0, FRAME = 0;

function compilePrograms() {
  const fs = SH.fsVS;
  // the biggest programs go first so their (parallel) compiles overlap everything else
  const list = [
    ['trace', fs, SH.trace], ['photon', fs, SH.photon], ['laser', fs, SH.laser],
    ['spectrum', fs, SH.spectrum], ['fft', fs, SH.fft], ['dispFinal', fs, SH.dispFinal], ['ripple', fs, SH.ripple],
    ['compose', fs, SH.compose], ['slopes', fs, SH.slopes], ['probe', fs, SH.probe], ['sky', fs, SH.sky],
    ['caus', SH.causVS, SH.causFS],
    ['inkVel', fs, SH.inkVel], ['inkCurl', fs, SH.inkCurl], ['inkConfine', fs, SH.inkConfine], ['inkDiv', fs, SH.inkDiv],
    ['inkJacobi', fs, SH.inkJacobi], ['inkProject', fs, SH.inkProject], ['inkDyeA', fs, SH.inkDyeA], ['inkDyeB', fs, SH.inkDyeB], ['inkLight', fs, SH.inkLight], ['inkSum', fs, SH.inkSum],
    ['sandStep', fs, SH.sandStep], ['sandDep', SH.sandDepVS, SH.sandDepFS], ['sandSus', SH.sandSusVS, SH.sandSusFS], ['sandDeposit', fs, SH.sandDeposit],
    ['sandSlide', fs, SH.sandSlide], ['sandRender', fs, SH.sandRender], ['sandPaint', fs, SH.sandPaint], ['sandProbe', fs, SH.sandProbe],
    ['partStep', fs, SH.partStep], ['partBin', SH.partBinVS, SH.partBinFS],
    ['taa', fs, SH.taa], ['dof', fs, SH.dof], ['bloomDown', fs, SH.bloomDown], ['bloomUp', fs, SH.bloomUp], ['final', fs, SH.final], ['debug', fs, SH.debug],
  ];
  for (const [n, v, f] of list) P[n] = new Prog(v, f, n);
}
function programsReady() { return Object.values(P).every(p => p.isDone()); }
function programsFailed() { return Object.values(P).some(p => p.failed); }

// ------------------------------------------------------------ derived lighting
const LAMP_OFF = { pos: new Float32Array([0, 10, 0, 0, 10, 0, 0, 10, 0]), aim: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]),
  cone: new Float32Array([0.5, 0.6, 0.5, 0.6, 0.5, 0.6]), col: new Float32Array(9), lum: new Float32Array(3) };
function lampCount() { return STATE.lightMode === 'lamp' ? Math.max(1, Math.min(3, STATE.lampCount | 0)) : 0; }
// picker colour (sRGB hex) -> linear RGB, partially luminance-compensated so saturated lamps stay usable
function lampRGB(hex) {
  const v = parseInt(String(hex).replace('#', ''), 16) || 0;
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(x => { x /= 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const k = lum > 1e-5 ? 1 / Math.sqrt(Math.max(lum, 0.05)) : 0;
  return c.map(x => x * k);
}
function lighting() {
  const el = STATE.sunElev * Math.PI / 180, az = STATE.sunAz * Math.PI / 180;
  const sun = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  const ci = sun[1], eta = 1 / 1.333;
  const k = 1 - eta * eta * (1 - ci * ci);
  // refract(-sun, up, eta) = eta*(-sun) + (eta*ci - sqrt(k))*up
  const lwx = -sun[0] * eta, lwz = -sun[2] * eta, lwy = -sun[1] * eta + (eta * ci - Math.sqrt(k));
  const Lw = v3.norm([lwx, lwy, lwz]);
  const fr = (c, n1, n2) => { const s = n1 / n2 * Math.sqrt(Math.max(0, 1 - c * c)); if (s >= 1) return 1; const ct = Math.sqrt(1 - s * s);
    const rs = (n2 * c - n1 * ct) / (n2 * c + n1 * ct), rp = (n1 * c - n2 * ct) / (n1 * c + n2 * ct); return 0.5 * (rs * rs + rp * rp); };
  const Tflat = 1 - fr(Math.max(ci, 0.02), 1, 1.333);
  const causK = Tflat * Math.max(ci, 0.02) / Math.max(-Lw[1], 0.05);
  const h = Math.max(-0.1, sun[1]);
  const warm = Math.max(0, Math.min(1, (h - 0.0) / 0.45));
  const sunTint = [1.0, 0.55 + 0.4 * warm, 0.28 + 0.6 * warm];
  const sunI = 5.0 * Math.max(0, Math.min(1, (h + 0.03) / 0.12));
  const sunCol = sunTint.map(c => c * sunI);
  const day = Math.max(0.08, Math.min(1, (h + 0.05) / 0.4));
  const skyIrr = [0.36 * day, 0.54 * day, 0.86 * day].map(c => c * Math.PI * 0.72);
  const groundIrr = [0.10, 0.10, 0.105].map(c => c * (sunI * Math.max(h, 0) + 0.5 * day));
  const wt = WATER_TYPES[STATE.waterType];
  const sigA = wt.a.slice(), sigS = wt.s.map(s => s * STATE.clarity);
  const tint = sigA.map((a, i) => Math.exp(-(a + sigS[i]) * 0.9));
  const ambBase = skyIrr.map((s, i) => (s * 0.75 + sunCol[i] * Math.max(h, 0) * causK * 0.22) * tint[i] * 1.1);
  const kdv = sigA.map((a, i) => a * 1.25 + sigS[i] * 0.25);
  const out = { sun, Lw, causK, Tflat, sunCol, skyIrr, groundIrr, sigA, sigS, ambBase, kdv, lampMode: 0,
    keyAmb: sunCol.map(c => c * Math.max(sun[1], 0)), nLamps: 1, lamps: [], lampU: LAMP_OFF, lampEmit: 0, lampR: 0 };
  if (STATE.lightMode === 'lamp') {
    const n = lampCount();
    const U = { pos: new Float32Array(9), aim: new Float32Array(9), cone: new Float32Array(6), col: new Float32Array(9), lum: new Float32Array(3) };
    const sky = [0, 0, 0], amb = [0, 0, 0], key = [0, 0, 0], lamps = [];
    let lensR = 0.088;
    for (let i = 0; i < 3; i++) {
      if (i >= n) { U.pos.set([0, 10, 0], i * 3); U.aim.set([0, -1, 0], i * 3); U.cone.set([0.5, 0.6], i * 2); continue; }
      const Lm = STATE.lamps[i], g = lampGeom(i), I = 10 * Lm.power;
      const c = lampRGB(Lm.color).map(v => v * I);
      const outer = Lm.beam * Math.PI / 180, inner = outer * 0.72;
      const H = Math.max(0.3, g.emit[1] - TANK.LEVEL);
      U.pos.set(g.emit, i * 3); U.aim.set(g.aim, i * 3); U.cone.set([Math.cos(outer), Math.cos(inner)], i * 2); U.col.set(c, i * 3);
      U.lum[i] = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      for (let k = 0; k < 3; k++) { sky[k] += c[k] * 0.0035; amb[k] += c[k] / (H * H) * 0.05 * tint[k]; key[k] += c[k] * 0.04; }
      lamps.push({ pos: g.emit, aim: g.aim, col: c });
      lensR = g.lensR;
    }
    out.lampMode = 1;
    out.nLamps = n;
    out.lamps = lamps;
    out.lampU = U;
    out.lampEmit = 1 / (Math.PI * lensR * lensR);
    out.lampR = lensR * 0.8;
    out.sunCol = [0, 0, 0];
    out.skyIrr = [0.02, 0.021, 0.028].map((c, i) => c * Math.PI + sky[i]);
    out.groundIrr = out.skyIrr.map(c => c * 0.6);
    out.ambBase = amb;
    out.keyAmb = key;
  }
  return out;
}

// ------------------------------------------------------------ camera
function updateCamera(aspect) {
  const c = CAM;
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  c.pos = [c.target[0] + c.dist * cp * Math.sin(c.yaw), c.target[1] + c.dist * sp, c.target[2] + c.dist * cp * Math.cos(c.yaw)];
  if (c.pos[1] < 0.06) c.pos[1] = 0.06;
  const fwd = v3.norm(v3.sub(c.target, c.pos));
  const right = v3.norm(v3.cross(fwd, [0, 1, 0]));
  const up = v3.cross(right, fwd);
  c.rot = new Float32Array([right[0], right[1], right[2], up[0], up[1], up[2], -fwd[0], -fwd[1], -fwd[2]]);
  const ty = Math.tan(c.fov * Math.PI / 360), tx = ty * aspect;
  c.tan = [tx, ty];
  // view-projection (column-major) for reprojection
  const n = 0.01, f = 2000;
  const V = [right[0], up[0], -fwd[0], 0, right[1], up[1], -fwd[1], 0, right[2], up[2], -fwd[2], 0,
    -v3.dot(right, c.pos), -v3.dot(up, c.pos), v3.dot(fwd, c.pos), 1];
  const Pm = [1 / tx, 0, 0, 0, 0, 1 / ty, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, -2 * f * n / (f - n), 0];
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0; for (let k = 0; k < 4; k++) s += Pm[k * 4 + j] * V[i * 4 + k];
    out[i * 4 + j] = s;
  }
  c.prevVP = c.vp || out;
  c.vp = out;
}
const HALTON = (() => { const h = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  const a = []; for (let i = 1; i <= 16; i++) a.push([h(i, 2) - 0.5, h(i, 3) - 0.5]); return a; })();

// ------------------------------------------------------------ passes
let KERNEL = null;
const SPEC = { key: '' };
function seaParams() {
  const s = STATE.sea;
  return { rms: 0.003 + s * s * 0.07 + s * 0.012, chop: STATE.chop * (0.3 + 0.5 * s) };
}
function simulate(dt) {
  const T = TANK, sp = seaParams();
  GLX.blend(false);
  // spectrum regeneration if needed
  const key = [R.fftN, STATE.windDir.toFixed(2), STATE.peak.toFixed(2), STATE.swell.toFixed(2), STATE.spread.toFixed(2)].join('|');
  if (key !== SPEC.key) {
    const data = genSpectrum(R.fftN, FFT_L, { windDir: STATE.windDir, peak: STATE.peak, swell: STATE.swell, spread: STATE.spread, seed: 7 });
    uploadTex(R.h0, data);
    SPEC.key = key;
  }
  // spectrum -> IFFT -> displacement
  const N = R.fftN;
  bindTarget(R.fft.fb);
  P.spectrum.use().setAll({ tH0: R.h0, uTime: SIM_T, uL: FFT_L, uDepth: T.LEVEL - T.BOT, uHScale: sp.rms, uN: N });
  drawFS(); R.fft.swap();
  const stages = Math.log2(N);
  P.fft.use().set('uN', N);
  for (let dir = 1; dir >= 0; dir--) {
    P.fft.set('uHoriz', dir);
    for (let s = 1; s <= stages; s++) {
      bindTarget(R.fft.fb);
      P.fft.set('tIn', R.fft.a).set('uNs', 1 << s);
      drawFS(); R.fft.swap();
    }
  }
  bindTarget(R.dispF);
  P.dispFinal.use().setAll({ tIn: R.fft.a, uChop: sp.chop, uL: FFT_L, uN: N });
  drawFS();
  // ripple layer (iWave)
  const cell = 2 * T.TX / R.ripW;
  const gGrid = GRAV / cell;
  const dtMax = 0.75 * 2 / Math.sqrt(gGrid * KERNEL.rmax);
  const steps = Math.max(1, Math.min(8, Math.ceil(dt / dtMax)));
  const h = dt / steps;
  const disp = packDisplacement();
  const imps = new Float32Array(16 * 4);
  IMPULSES.sort((a, b) => b[3] - a[3]);
  const ni = Math.min(16, IMPULSES.length);
  for (let i = 0; i < ni; i++) imps.set(IMPULSES[i], i * 4);
  IMPULSES.length = 0;
  P.ripple.use().setAll({ uKern: KERNEL.K, uAlpha: 0.8, uCell: cell, uLevel: T.LEVEL, uFFTL: FFT_L, uCouple: 0.6,
    uFoamLife: 2.6, uWhitecap: STATE.foam * (0.15 + 0.85 * STATE.sea), uJth: 0.42 + 0.14 * STATE.sea, uTank: [T.TX, T.TZ, T.BOT, T.TOP],
    uNumSph: disp.n, uSphOld: disp.oldA, uSphNew: disp.newA, uNumImp: ni, uImp: imps, tDisp: R.disp });
  for (let i = 0; i < (dt > 0 ? steps : 0); i++) {
    bindTarget(R.rip.fb);
    P.ripple.setAll({ tState: R.rip.a, uDt: h, uGrav: gGrid * h * h, uSrc: i === 0 ? 1 : 0, uVisc: 0.06 });
    drawFS(); R.rip.swap();
  }
  // compose heightfield + slopes
  bindTarget(R.heightF);
  P.compose.use().setAll({ tDisp: R.disp, tState: R.rip.a, uTank: [T.TX, T.TZ, T.BOT, T.TOP], uLevel: T.LEVEL, uFFTL: FFT_L, uEdge: 0.12 });
  drawFS();
  bindTarget(R.surfF);
  P.slopes.use().setAll({ tHeight: R.height, uCell: [2 * T.TX / R.surfW, 2 * T.TZ / R.surfH] });
  drawFS();
}
function probeReadback() {
  const gl = GLX.gl, T = TANK;
  if (R.fence) {
    const st = gl.clientWaitSync(R.fence, 0, 0);
    if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
      if (!R.probePrev) R.probePrev = new Float32Array(R.probeData.length);
      R.probePrev.set(R.probeData); R.probePrevTime = R.probeValid ? R.probeTime : R.fenceTime;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, R.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, R.probeData);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      R.probeTime = R.fenceTime;
      if (!R.probeValid) { R.probePrev.set(R.probeData); R.probePrevTime = R.probeTime - 0.016; }
      R.probeValid = true;
      gl.deleteSync(R.fence); R.fence = null;
    } else return;
  }
  bindTarget(R.probeF);
  P.probe.use().setAll({ tHeight: R.height, tDisp: R.disp, uTank: [T.TX, T.TZ, T.BOT, T.TOP], uFFTL: FFT_L });
  drawFS();
  readTexAsync(R.probe, 0, 0, R.probeW, R.probeH, R.pbo);
  R.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  R.fenceTime = SIM_T;
  gl.flush();
}
let ENV_T = -1, ENV_KEY = '';
function renderSky(L) {
  const key = STATE.sunElev + '|' + STATE.sunAz + '|' + STATE.lightMode;
  if (key === ENV_KEY && SIM_T - ENV_T < 0.5 && !R.envDirty) return;
  ENV_KEY = key; ENV_T = SIM_T; R.envDirty = false;
  bindTarget(R.envF);
  P.sky.use().setAll({ uSunDir: L.sun, uTime: SIM_T, uCloud: 0.5, uSkyGain: L.lampMode ? 1.0 : 0.85, uNight: L.lampMode });
  drawFS();
  genMips(R.env);
}
function sceneUniforms(prog, L, nObj) {
  const T = TANK, sp = seaParams();
  prog.setAll({ uTank: [T.TX, T.TZ, T.BOT, T.TOP], uLevel: T.LEVEL, uAmp: STATE.amp, uSunDir: L.sun, uSunCol: L.sunCol,
    uLw: L.Lw, uCausK: L.causK, uSigA: L.sigA, uSigS: L.sigS, tSurf: R.surf, tObj: R.obj, tPrim: R.prim, uNumObj: nObj, uZero: 0, uTime: SIM_T,
    uLampMode: L.lampMode, uNumLamps: Math.max(1, L.nLamps), uLampSel: 0, uLampPos: L.lampU.pos, uLampAim: L.lampU.aim,
    uLampCone: L.lampU.cone, uLampCol: L.lampU.col });
}
// photon grid meshes (indices only), one per grid size (lamps split the photon budget between them)
function photonMesh(n) {
  if (!R.meshes) R.meshes = {};
  if (R.meshes[n]) return R.meshes[n];
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = c;
  }
  const mesh = makeIndexMesh(idx);
  mesh.count = idx.length;
  return (R.meshes[n] = mesh);
}
function freePhotonMeshes() {
  if (!R.meshes) return;
  for (const k in R.meshes) R.meshes[k].geometry.dispose();
  R.meshes = {};
}
function renderCaustics(L, nObj) {
  const T = TANK;
  const lamp = L.lampMode === 1, nl = lamp ? L.nLamps : 1;
  // several lamps share the photon budget (keeps the frame cost flat); each lamp gets its own channel
  const pn = nl > 1 ? Math.max(64, Math.round(R.pn / Math.sqrt(nl) / 8) * 8) : R.pn;
  const mesh = photonMesh(pn);
  R.pnUsed = pn * pn * nl;
  R.trisUsed = nl * (pn - 1) * (pn - 1) * 2 * (R.cvL + (STATE.dispersion && nl === 1 ? 3 : 1));
  const D = (T.LEVEL + STATE.amp - T.BOT) / Math.max(-L.Lw[1], 0.2);
  const ox = lamp ? 0 : -L.Lw[0] * D, oz = lamp ? 0 : -L.Lw[2] * D, m = lamp ? 0.12 : 0.18;
  const dom = [-T.TX + Math.min(0, ox) - m, -T.TZ + Math.min(0, oz) - m, T.TX + Math.max(0, ox) + m, T.TZ + Math.max(0, oz) + m];
  const sigT = L.sigA.map((a, i) => a + L.sigS[i]);
  const top = T.LEVEL + STATE.amp;
  GLX.blend(false);
  bindTarget(R.causF); GLX.clear();
  bindTarget(R.floorF); GLX.clear();
  for (let li = 0; li < nl; li++) {
    // photon setup for this light
    GLX.blend(false);
    bindTarget(R.pF, pn, pn);
    P.photon.use();
    sceneUniforms(P.photon, L, nObj);
    P.photon.setAll({ tDisp: R.disp, uPDom: dom, uPN: pn, uFFTL: FFT_L, uFlatT: L.Tflat, uLampSel: li,
      uPCell: [(dom[2] - dom[0]) / (pn - 1), (dom[3] - dom[1]) / (pn - 1)] });
    drawFS();
    // splat the refracted photon mesh into every slice (additive)
    const chan = nl > 1 ? [li === 0 ? 1 : 0, li === 1 ? 1 : 0, li === 2 ? 1 : 0] : [1, 1, 1];
    GLX.blend(true);
    P.caus.use().setAll({ tP0: R.p0, tP1: R.p1, uPN: pn, uLevel: T.LEVEL, uSunDir: L.sun, uLwFlat: L.Lw,
      uTank: [T.TX, T.TZ, T.BOT, T.TOP], uSigT: sigT, uLampMode: L.lampMode, uLampPos: lamp ? L.lamps[li].pos : [0, 10, 0] });
    P.caus.set('uIor', 1.333).set('uMask', chan).set('uFloorSand', 0);
    // one atlas tile per slice; the scissor keeps every slice inside its own tile
    for (let l = 0; l < R.cvL; l++) {
      bindTile(R.causF, (l % R.cvCols) * R.cvW, Math.floor(l / R.cvCols) * R.cvH, R.cvW, R.cvH);
      P.caus.set('uSliceY', T.BOT + (top - T.BOT) * l / (R.cvL - 1));
      GLX.draw(mesh);
    }
    bindTarget(R.floorF);
    P.caus.setAll({ uSliceY: T.BOT, uFloorSand: 1, tSandR: R.sand.rend, uSandMax: sandMaxBound(), uSandDom: sandDomain() });
    if (STATE.dispersion && nl === 1) {
      const iors = [1.3310, 1.3340, 1.3380];
      for (let c = 0; c < 3; c++) {
        P.caus.set('uIor', iors[c]).set('uMask', [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0]);
        GLX.draw(mesh);
      }
    } else GLX.draw(mesh);
    GLX.blend(false);
  }
  // blurred copies of every slice (the local average the light shafts are measured against)
  genMips(R.caus);
  return top;
}
function renderFrame(dt) {
  const T = TANK, q = R.q;
  const cw = GLX.gl.canvas.width, ch = GLX.gl.canvas.height;
  const rw = Math.max(16, Math.round(cw * STATE.scale)), rh = Math.max(16, Math.round(ch * STATE.scale));
  buildRenderTargets(rw, rh);
  const L = lighting();
  const sp = seaParams();
  STATE.amp = Math.min(0.32, sp.rms * (3.6 + 1.2 * sp.chop) + 0.07);
  simulate(dt);
  probeReadback();
  renderSky(L);
  // object + sphere data
  const nObj = packObjects();
  uploadTex(R.obj, R.objData);
  const sb = packSpheres();
  uploadTex(R.sph, R.sphData);
  const fb = packFluidBodies();
  simulateSand(dt, fb);
  simulateInk(dt, L, sb, fb);
  simulateParticulate(dt);
  simulateLaser(dt, L, nObj);
  const top = renderCaustics(L, nObj);
  // trace
  updateCamera(rw / rh);
  const jit = STATE.taa ? HALTON[FRAME % 16] : [0, 0];
  bindTarget(RT.traceF);
  const tr = P.trace.use();
  sceneUniforms(tr, L, nObj);
  const cellP = 0.055;
  tr.setAll({ tCaus: R.caus, tFloorCaus: R.floorC, tEnv: R.env, tSph: R.sph,
    uNumBub: sb.nb, uNumDrop: sb.nd, uBubMin: sb.bmin, uBubMax: sb.bmax, uDropMin: sb.dmin, uDropMax: sb.dmax,
    uCamPos: CAM.pos, uCamRot: CAM.rot, uTanFov: CAM.tan, uJitter: jit, uRes: [rw, rh], uFrame: FRAME,
    uVolSteps: q.vol, uHFSteps: q.hf, uMaxIter: STATE.dbgIter || q.iter, uPartSteps: q.part, uDbg: STATE.dbgMode || 0,
    uCausTop: top, uCausLayers: R.cvL, uCausAtlas: [R.cvCols, R.cvRows, 0.5 / R.cvW, 0.5 / R.cvH],
    uCausBlur: [R.cvBlur, 0.5 * (1 << Math.ceil(R.cvBlur)) / R.cvW, 0.5 * (1 << Math.ceil(R.cvBlur)) / R.cvH], uGodRays: STATE.godRays, uCausGain: STATE.causGain, uGlassOn: STATE.glass ? 1 : 0,
    uGlassW: TANK.GLASS, uBottomType: STATE.bottom, uPartDensity: STATE.particles * 0.34, uPartCell: cellP,
    uPartBright: 1.0, uMaxSlope: 1.2 + sp.chop * 0.8, uSunRadius: 0.0105, uPixAng: 2 * CAM.tan[1] / rh,
    uFoamGain: STATE.foam, uMicro: 0.012 + STATE.sea * 0.035, uEnvMax: R.envLevels,
    uAmbWater: L.ambBase, uKdv: L.kdv,
    uSkyIrr: L.skyIrr, uGroundIrr: L.groundIrr, uGlassTint: [0.93, 0.965, 0.95],
    uNumAO: PACK_NAO, uLampEmit: L.lampEmit, uLampR: L.lampR,
    uKeyAmb: L.keyAmb, uInkOn: INK.active ? 1 : 0, uInkSub: q.inkSub, uInkScat: inkScatter(),
    tInkD: R.ink.dye.a, tInkL: R.ink.light });
  tr.setAll(sandTraceUniforms());
  tr.setAll(partUniforms());
  tr.setAll(laserUniforms());
  inkGridUniforms(tr);
  drawFS();
  // temporal
  let src = RT.hdr;
  if (STATE.taa) {
    bindTarget(RT.taa.fb);
    P.taa.use().setAll({ tCur: RT.hdr, tHist: RT.taa.a, tPos: RT.pos, uPrevVP: CAM.prevVP, uFeedback: 0.88, uReset: RT.reset ? 1 : 0 });
    drawFS(); RT.taa.swap();
    src = RT.taa.a;
  }
  RT.reset = false;
  // depth of field (focus on orbit target)
  if (STATE.aperture > 0.001) {
    bindTarget(RT.dofF);
    P.dof.use().setAll({ tIn: src, tPos: RT.pos, uCamPos: CAM.pos, uFocus: CAM.dist,
      uAperture: STATE.aperture * rh * 0.012, uMaxCoc: Math.min(28, STATE.aperture * rh * 0.012) });
    drawFS();
    src = RT.dof;
  }
  // bloom
  let inp = src;
  RT.bloom.forEach((b, i) => {
    bindTarget(b.df);
    P.bloomDown.use().setAll({ tIn: inp, uTexel: [1 / (i === 0 ? rw : RT.bloom[i - 1].w), 1 / (i === 0 ? rh : RT.bloom[i - 1].h)], uFirst: i === 0 ? 1 : 0 });
    drawFS();
    inp = b.d;
  });
  for (let i = RT.bloom.length - 2; i >= 0; i--) {
    const b = RT.bloom[i], lo = RT.bloom[i + 1];
    bindTarget(b.uf);
    P.bloomUp.use().setAll({ tIn: i === RT.bloom.length - 2 ? lo.d : lo.u, tBase: b.d, uTexel: [1 / lo.w, 1 / lo.h], uRadius: 1.0 });
    drawFS();
  }
  // final
  bindTarget(null, cw, ch);
  const under = (WATER.inside(CAM.pos[0], CAM.pos[2]) && CAM.pos[1] < WATER.heightAt(CAM.pos[0], CAM.pos[2])) ? 1 : 0;
  if (STATE.debug > 0) {
    P.debug.use().setAll({ tIn: STATE.debug === 1 ? R.floorC : R.surf, uScale: STATE.debug === 1 ? 0.25 : 1.0 });
  } else {
    P.final.use().setAll({ tHDR: src, tBloom: RT.bloom.length > 1 ? RT.bloom[0].u : RT.bloom[0].d, uExposure: STATE.exposure, uBloom: STATE.bloom,
      uGrain: 0.028, uVignette: 0.35, uCA: 0.0018, uUnder: under, uTime: SIM_T, uFrame: FRAME });
  }
  drawFS();
  FRAME++;
  return { rw, rh, under };
}

// ------------------------------------------------------------ ink fluid
function inkScatter() { return 4 + STATE.ink.pigment * 46; }
function inkGridUniforms(prog) {
  const I = R.ink;
  prog.setAll({ uVDim: I.vDim, uDDim: I.dDim, uVTx: I.vL.tx, uDTx: I.dL.tx, uGMin: I.gMin, uVCell: I.vCell, uDCell: I.dCell });
}
function sandMaxBound() {
  if (!R.sand) return 0;
  const grow = SIM_T - SAND.lastSpawnT < SAND.life + 2 ? 0.03 : 0.006;
  return SAND.maxH > 0.0005 || SIM_T - SAND.lastSpawnT < SAND.life + 2 ? Math.min(TANK.LEVEL - TANK.BOT, SAND.maxH + grow) : 0;
}
function sandTraceUniforms() {
  const S = R.sand, o = sandOptics();
  return Object.assign({ tSandR: S.rend, tSandC: S.atlas.a, tSandS: S.sus, tSandT: S.hc.t, uSandDom: sandDomain(), uSandMax: sandMaxBound(), uSandDy: S.dy,
    uSandSig: o.sig, uSettleV: SAND.ws, uSandSteps: R.q.sandSteps, uSCDim: S.cDim, uSCTx: S.cL.tx, uPal: SAND_PAL, uPalAvg: SAND_AVG,
    uPalN: SAND_COLORS.length }, sandStreamUniforms());
}
function simulateInk(dt, L, sb, fb) {
  const I = R.ink, q = R.q;
  if (!I) return;
  if (INK.active && SIM_T - INK.last > STATE.ink.fade * 6 && !INK.inj.length) INK.active = false;
  if (!INK.active || dt <= 0) { INK.inj.length = 0; INK.stir.length = 0; return; }
  const h = Math.min(dt, 1 / 30);
  GLX.blend(false);
  // this frame's events
  const inj = INK.inj.splice(0);
  inj.sort((a, b) => b.amt - a.amt);
  const ni = Math.min(8, inj.length);
  const injP = new Float32Array(32), injV = new Float32Array(32), injC = new Float32Array(32);
  for (let i = 0; i < ni; i++) {
    const e = inj[i];
    injP.set([e.p[0], e.p[1], e.p[2], e.r], i * 4);
    injV.set([e.v[0], e.v[1], e.v[2], e.vw], i * 4);
    injC.set([e.A[0], e.A[1], e.A[2], e.amt], i * 4);
  }
  // expected ink mass (for drift correction): fade + analytic Gaussian injection integrals
  const dc = I.dCell, decay = Math.exp(-h / STATE.ink.fade);
  INK.mExp *= decay;
  for (let i = 0; i < ni; i++) {
    const e = inj[i], rd = Math.max(e.r, 0.9 * dc[0]);
    INK.mExp += e.amt * (e.r * e.r) / (rd * rd) * Math.pow(Math.PI, 1.5) * rd * rd * rd / (dc[0] * dc[1] * dc[2]);
  }
  const st = INK.stir.splice(0, 4);
  const stP = new Float32Array(16), stV = new Float32Array(16);
  st.forEach((s, i) => { stP.set([s.p[0], s.p[1], s.p[2], s.r], i * 4); stV.set([s.v[0], s.v[1], s.v[2], s.k], i * 4); });
  INK.stir.length = 0;
  fb = fb || packFluidBodies();
  const so = sandOptics(), sandIn = SIM_T - SAND.lastSpawnT < SAND.life + 0.5;
  const vw = I.vL.w, vh = I.vL.h, dw = I.dL.w, dh = I.dL.h;
  const pass = (prog, fbo, w, hh) => { bindTarget(fbo, w, hh); inkGridUniforms(prog); drawFS(); };
  // 1. advect velocity + forces
  P.inkVel.use().setAll({ tVel: I.vel.a, tDye: I.dye.a, tSph: R.sph, uDt: h, uBuoy: 1.6 * STATE.ink.sink, uTurb: 0.07 * STATE.ink.turb * (0.6 + STATE.sea), uDamp: 0.12 + 0.18 * STATE.ink.turb,
    uTime: SIM_T, uLevel: TANK.LEVEL, uNumB: fb.n, uBPos: fb.P, uBVel: fb.V, uNumInj: ni, uInjP: injP, uInjV: injV,
    uNumStir: st.length, uStirP: stP, uStirV: stV, uNumBub: Math.min(64, sb.nb), uBubMin: sb.bmin, uBubMax: sb.bmax,
    tSandS: R.sand.sus, uSandBuoy: sandIn ? so.buoy : 0, tSandH: R.sand.hc.h, uSandDom: sandDomain() });
  pass(P.inkVel, I.vel.fb, vw, vh); I.vel.swap();
  // 2-3. vorticity confinement keeps the curls alive
  P.inkCurl.use().set('tVel', I.vel.a); pass(P.inkCurl, I.curlF, vw, vh);
  P.inkConfine.use().setAll({ tVel: I.vel.a, tCurl: I.curl, uDt: h, uVort: 3.5 + 9 * STATE.ink.turb });
  pass(P.inkConfine, I.vel.fb, vw, vh); I.vel.swap();
  // 4-6. pressure projection (warm-started Jacobi)
  P.inkDiv.use().set('tVel', I.vel.a); pass(P.inkDiv, I.divF, vw, vh);
  P.inkJacobi.use().set('tDiv', I.div);
  for (let i = 0; i < q.jac; i++) {
    P.inkJacobi.set('tP', I.p.a).set('uKeep', i === 0 ? 0.98 : 1.0);
    pass(P.inkJacobi, I.p.fb, vw, vh); I.p.swap();
  }
  P.inkProject.use().setAll({ tVel: I.vel.a, tP: I.p.a, tSandH: R.sand.hc.h, uSandDom: sandDomain() }); pass(P.inkProject, I.vel.fb, vw, vh); I.vel.swap();
  // 7-8. MacCormack dye advection + injections + slow fading
  P.inkDyeA.use().setAll({ tDye: I.dye.a, tVel: I.vel.a, uDt: h }); pass(P.inkDyeA, I.hatF, dw, dh);
  P.inkDyeB.use().setAll({ tDye: I.dye.a, tHat: I.hat, tVel: I.vel.a, uDt: h, uDecay: decay, uMac: STATE.ink.mac === 0 ? 0 : 1, uMassScale: STATE.ink.massFix === false ? 1 : INK.massScale,
    uNumInj: ni, uInjP: injP, uInjC: injC });
  pass(P.inkDyeB, I.dye.fb, dw, dh); I.dye.swap();
  // 9. colored self-shadowing toward the key light + occupancy for the ray marcher
  P.inkLight.use().setAll({ tDye: I.dye.a, uLampMode: L.lampMode, uNumLamps: Math.max(1, L.nLamps), uLampPos: L.lampU.pos, uLampAim: L.lampU.aim,
    uLampCone: L.lampU.cone, uLampLum: L.lampU.lum, uLw: L.Lw, tSandS: R.sand.sus, uSandSig: so.sig,
    uInkScat: inkScatter(), uLevel: TANK.LEVEL, uTank: [TANK.TX, TANK.TZ, TANK.BOT, TANK.TOP] });
  pass(P.inkLight, I.lightF, vw, vh);
  inkMassReadback();
}
function inkMassReadback() {
  const gl = GLX.gl, I = R.ink;
  if (INK.fence) {
    const st = gl.clientWaitSync(INK.fence, 0, 0);
    if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, I.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, I.sumData);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(INK.fence); INK.fence = null;
      let m = 0;
      for (let i = 0; i < I.sumData.length; i += 4) m += I.sumData[i];
      INK.mAct = m;
      INK.massScale = m > 0.05 && INK.mExpAtRead > 0 ? Math.max(0.985, Math.min(1.015, Math.pow(INK.mExpAtRead / m, 1 / 6))) : 1;
    }
    return;
  }
  if (++INK.frame % 3) return;
  bindTarget(I.sumF, I.sumW, I.sumH);
  P.inkSum.use().set('tDye', I.dye.a);
  drawFS();
  readTexAsync(I.sum, 0, 0, I.sumW, I.sumH, I.pbo);
  INK.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  INK.mExpAtRead = INK.mExp;
  gl.flush();
}
