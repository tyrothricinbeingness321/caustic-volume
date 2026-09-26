// ============================================================================
//  WORLD CONSTANTS, QUALITY PRESETS, CPU-SIDE SPECTRUM + iWAVE KERNEL, RESOURCES
// ============================================================================
const TANK = { TX: 1.8, TZ: 1.1, BOT: 0.03, TOP: 1.55, LEVEL: 1.2, GLASS: 0.022 };
const FFT_L = 4.2;

const PRESETS = {
  LOW:    { fft: 256,  rip: 192, surf: 512,  pn: 192,  cv: 160, cl: 20, floor: 512,  scale: 0.5,  vol: 24,  hf: 90,  iter: 6,  part: 40,  disp: false, inkV: 48,  inkSub: 2, jac: 24,
            sandN: 96,  sandG: 128, sandDy: 0.03,  slide: 6,  sandSteps: 56 },
  MEDIUM: { fft: 256,  rip: 256, surf: 768,  pn: 320,  cv: 256, cl: 32, floor: 768,  scale: 0.75, vol: 40,  hf: 120, iter: 8,  part: 64,  disp: true, inkV: 72,  inkSub: 3, jac: 30,
            sandN: 128, sandG: 192, sandDy: 0.02,  slide: 8,  sandSteps: 72 },
  HIGH:   { fft: 512,  rip: 384, surf: 1024, pn: 512,  cv: 384, cl: 48, floor: 1024, scale: 1.0,  vol: 64,  hf: 160, iter: 9,  part: 96,  disp: true, inkV: 96,  inkSub: 3, jac: 36,
            sandN: 192, sandG: 256, sandDy: 0.015, slide: 10, sandSteps: 88 },
  ULTRA:  { fft: 512,  rip: 512, surf: 1024, pn: 768,  cv: 512, cl: 64, floor: 1536, scale: 1.0,  vol: 96,  hf: 200, iter: 10, part: 128, disp: true, inkV: 128, inkSub: 4, jac: 44,
            sandN: 256, sandG: 320, sandDy: 0.012, slide: 12, sandSteps: 112 },
  INSANE: { fft: 1024, rip: 768, surf: 2048, pn: 1024, cv: 640, cl: 96, floor: 2048, scale: 1.5,  vol: 160, hf: 280, iter: 12, part: 160, disp: true, inkV: 176, inkSub: 5, jac: 60,
            sandN: 320, sandG: 448, sandDy: 0.009, slide: 16, sandSteps: 144 },
};

const WATER_TYPES = {
  'Caribbean': { a: [0.56, 0.115, 0.058], s: [0.045, 0.064, 0.085] },
  'Open ocean': { a: [0.85, 0.20, 0.075], s: [0.030, 0.048, 0.085] },
  'Clear pool': { a: [0.36, 0.058, 0.024], s: [0.012, 0.016, 0.020] },
  'Kelp lagoon': { a: [0.75, 0.16, 0.40], s: [0.20, 0.26, 0.20] },
};

// ------------------------------------------------------------ RNG / spectrum
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function genSpectrum(N, L, p) {
  const r = mulberry32(p.seed || 1337);
  const re = new Float32Array(N * N), im = new Float32Array(N * N);
  const kp = 2 * Math.PI / p.peak, kp2 = 2 * Math.PI / (p.peak * 1.9);
  const cutoff = (L / N) * 1.6;
  const wd = p.windDir, sd = p.windDir + 1.1;
  const dk = 2 * Math.PI / L;
  const jon = (k, kpk) => {
    const s = k < kpk ? 0.07 : 0.09;
    const g = Math.pow(3.3, Math.exp(-((k - kpk) ** 2) / (2 * s * s * kpk * kpk)));
    return Math.pow(k, -4) * Math.exp(-1.25 * (kpk / k) ** 2) * g;
  };
  const dirF = (th, dir, sharp) => {
    const c = Math.cos((th - dir) * 0.5);
    return Math.pow(Math.abs(c), sharp);
  };
  let variance = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const mx = i < N / 2 ? i : i - N, mz = j < N / 2 ? j : j - N;
    const idx = j * N + i;
    if (mx === 0 && mz === 0) continue;
    const kx = mx * dk, kz = mz * dk, k = Math.hypot(kx, kz);
    const th = Math.atan2(kz, kx);
    const D = (1 - p.spread) * dirF(th, wd, 12) * 1.9 + p.spread * 0.32;
    const D2 = dirF(th, sd, 20) * 2.2;
    let P = jon(k, kp) * D + p.swell * jon(k, kp2) * D2 + 0.06 * Math.pow(k, -3.2) * p.spread;
    P *= Math.exp(-((k * cutoff) ** 2)) * dk * dk;
    const a = Math.sqrt(P * 0.5);
    re[idx] = gauss(r) * a; im[idx] = gauss(r) * a;
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const idx = j * N + i, m = ((N - j) % N) * N + ((N - i) % N);
    variance += re[idx] * re[idx] + im[idx] * im[idx] + re[m] * re[m] + im[m] * im[m];
  }
  const sc = 1 / Math.sqrt(Math.max(variance, 1e-20));
  const out = new Float32Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const idx = j * N + i, m = ((N - j) % N) * N + ((N - i) % N);
    out[idx * 4] = re[idx] * sc; out[idx * 4 + 1] = im[idx] * sc;
    out[idx * 4 + 2] = re[m] * sc; out[idx * 4 + 3] = -im[m] * sc;
  }
  return out;
}

// ------------------------------------------------------------ iWave kernel
function besselJ0(x) {
  const ax = Math.abs(x);
  if (ax < 8) {
    const y = x * x;
    const a = 57568490574.0 + y * (-13362590354.0 + y * (651619640.7 + y * (-11214424.18 + y * (77392.33017 + y * (-184.9052456)))));
    const b = 57568490411.0 + y * (1029532985.0 + y * (9494680.718 + y * (59272.64853 + y * (267.8532712 + y))));
    return a / b;
  }
  const z = 8 / ax, y = z * z, xx = ax - 0.785398164;
  const a = 1 + y * (-0.1098628627e-2 + y * (0.2734510407e-4 + y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
  const b = -0.1562499995e-1 + y * (0.1430488765e-3 + y * (-0.6911147651e-5 + y * (0.7621095161e-6 - y * 0.934935152e-7)));
  return Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * a - z * Math.sin(xx) * b);
}
function iwaveKernel() {
  // Deep-water operator sqrt(-Laplacian): symbol sqrt(4 - 2cos qx - 2cos qz) ~ |q|, >= 0 everywhere.
  // Inverse DFT on a fine frequency grid, windowed to 13x13, then made strictly non-negative.
  const P = 6, M = 96, K = new Float32Array(49);
  const L = (qx, qz) => 4 - 2 * Math.cos(qx) - 2 * Math.cos(qz);
  for (let i = 0; i <= P; i++) for (let j = 0; j <= P; j++) {
    let s = 0;
    for (let a = 0; a < M; a++) for (let b = 0; b < M; b++) {
      const qx = 2 * Math.PI * (a - M / 2) / M, qz = 2 * Math.PI * (b - M / 2) / M;
      s += Math.sqrt(L(qx, qz)) * Math.cos(qx * i + qz * j);
    }
    const r = Math.hypot(i, j), w = r <= 7 ? 0.5 * (1 + Math.cos(Math.PI * r / 7.5)) : 0;
    K[i * 7 + j] = s / (M * M) * w;
  }
  const resp = (qx, qz) => { let s = 0; for (let i = -P; i <= P; i++) for (let j = -P; j <= P; j++) s += K[Math.abs(i) * 7 + Math.abs(j)] * Math.cos(qx * i + qz * j); return s; };
  let sum = 0;
  for (let i = -P; i <= P; i++) for (let j = -P; j <= P; j++) sum += K[Math.abs(i) * 7 + Math.abs(j)];
  K[0] -= sum;
  // add a small Laplacian (capillary-like) term until the response is non-negative
  let c = 0;
  for (let it = 0; it < 40; it++) {
    let worst = 0;
    for (let a = 1; a <= 32; a++) for (let b = 0; b <= a; b++) {
      const qx = a / 32 * Math.PI, qz = b / 32 * Math.PI;
      const r = resp(qx, qz) + c * L(qx, qz);
      worst = Math.min(worst, r / Math.max(L(qx, qz), 1e-6));
    }
    if (worst >= -1e-4) break;
    c += -worst + 0.002;
  }
  if (c > 0) { K[0] += 4 * c; K[1] -= c; K[7] -= c; }
  let rmax = 0, rmin = 1e9;
  for (let a = 0; a <= 32; a++) for (let b = 0; b <= 32; b++) {
    const r = resp(a / 32 * Math.PI, b / 32 * Math.PI);
    rmax = Math.max(rmax, r); if (a + b > 0) rmin = Math.min(rmin, r);
  }
  return { K, rmax, rmin, c };
}

// ------------------------------------------------------------ resources
const R = { built: false };
function buildSimResources(q) {
  const gl = GLX.gl;
  freeSimResources();
  const T = TANK;
  const asp = T.TZ / T.TX;
  R.q = q;
  R.fftN = q.fft;
  R.h0 = makeTex(q.fft, q.fft, FMT.RGBA32F, { filter: 'nearest' });
  R.fft = makePair(q.fft, q.fft, FMT.RGBA32F, { filter: 'nearest' });
  R.disp = makeTex(q.fft, q.fft, FMT.RGBA32F, { wrap: 'repeat' });
  R.dispF = makeFBO(R.disp);
  R.ripW = q.rip; R.ripH = Math.round(q.rip * asp);
  R.rip = makePair(R.ripW, R.ripH, FMT.RGBA32F, { filter: 'nearest' });
  for (const f of [R.rip.fa, R.rip.fb]) { bindTarget(f); GLX.clear(); }
  R.surfW = q.surf; R.surfH = Math.round(q.surf * asp);
  R.height = makeTex(R.surfW, R.surfH, FMT.RGBA32F, { filter: 'nearest' });
  R.heightF = makeFBO(R.height);
  R.surf = makeTex(R.surfW, R.surfH, FMT.RGBA32F);
  R.surfF = makeFBO(R.surf);
  R.probeW = 128; R.probeH = Math.round(128 * asp);
  R.probe = makeTex(R.probeW, R.probeH, FMT.RGBA32F, { filter: 'nearest' });
  R.probeF = makeFBO(R.probe);
  R.pbo = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, R.pbo);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, R.probeW * R.probeH * 16, gl.STREAM_READ);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  R.probeData = new Float32Array(R.probeW * R.probeH * 4);
  R.probePrev = null; R.probeTime = 0; R.probePrevTime = 0; R.fence = null; R.probeValid = false;
  R.env = makeTex(1024, 512, FMT.RGBA16F, { mips: true, wrapS: 'repeat' });
  R.envF = makeFBO(R.env);
  R.envLevels = Math.floor(Math.log2(1024));
  R.pn = q.pn;
  R.p0 = makeTex(q.pn, q.pn, FMT.RGBA32F, { filter: 'nearest' });
  R.p1 = makeTex(q.pn, q.pn, FMT.RGBA32F, { filter: 'nearest' });
  R.pF = makeFBO([R.p0, R.p1]);
  // the caustic volume is a 2D atlas of horizontal slices: rendering into the layers of a 3D texture
  // is unreliable on ANGLE's D3D11 backend (Chrome / Edge on Windows), where it corrupts or accumulates.
  // Tiles are multiples of 16 texels so mip levels 0-4 stay inside their tiles (the blurred field
  // the light shafts are measured against).
  R.cvW = q.cv; R.cvH = Math.max(16, Math.round(q.cv * asp / 16) * 16); R.cvL = q.cl;
  const maxT = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  R.cvCols = Math.max(1, Math.min(Math.floor(maxT / R.cvW), Math.ceil(Math.sqrt(R.cvL * R.cvH / R.cvW))));
  R.cvRows = Math.ceil(R.cvL / R.cvCols);
  R.caus = makeTex(R.cvW * R.cvCols, R.cvH * R.cvRows, FMT.RGBA16F, { mips: 5 });
  R.causF = makeFBO(R.caus);
  // blur level for the shaft baseline: about 12 cm
  R.cvBlur = Math.max(0, Math.min(4, Math.log2(0.12 * R.cvW / (2 * T.TX))));
  R.flW = q.floor; R.flH = Math.round(q.floor * asp);
  R.floorC = makeTex(R.flW, R.flH, FMT.RGBA16F);
  R.floorF = makeFBO(R.floorC);
  // photon meshes (vertex positions come from gl_VertexID), built per grid size on demand
  freePhotonMeshes();
  photonMesh(q.pn);
  R.obj = makeTex(OBJ_TEX, OBJ_ROWS, FMT.RGBA32F, { filter: 'nearest' });
  R.objData = new Float32Array(OBJ_TEX * OBJ_ROWS * 4);
  R.prim = makeTex(4, PRIM_ROWS, FMT.RGBA32F, { filter: 'nearest' });
  R.primData = new Float32Array(PRIM_ROWS * 16);
  uploadModelLibrary();
  R.sph = makeTex(256, 1, FMT.RGBA32F, { filter: 'nearest' });
  R.sphData = new Float32Array(256 * 4);
  buildInkResources(q);
  buildSandResources(q);
  buildPartResources();
  buildLaserResources();
  R.built = true;
  R.envDirty = true;
  R.specDirty = true;
}
function freeSimResources() {
  if (!R.built) return;
  const gl = GLX.gl;
  [R.h0, R.disp, R.height, R.surf, R.probe, R.env, R.p0, R.p1, R.caus, R.floorC, R.obj, R.prim, R.sph].forEach(freeTex);
  [R.dispF, R.heightF, R.surfF, R.probeF, R.envF, R.pF, R.floorF].forEach(freeFBO);
  freeFBO(R.causF);
  R.fft.free(); R.rip.free();
  gl.deleteBuffer(R.pbo); freePhotonMeshes();
  if (R.fence) { gl.deleteSync(R.fence); R.fence = null; }
  freeInkResources();
  freePartResources();
  freeSandResources();
  freeLaserResources();
  R.built = false;
}
const RT = { w: 0, h: 0 };
function buildRenderTargets(w, h) {
  const gl = GLX.gl;
  if (RT.w === w && RT.h === h) return;
  if (RT.w) {
    [RT.hdr, RT.pos, RT.dof].forEach(freeTex); freeFBO(RT.traceF); freeFBO(RT.dofF); RT.taa.free();
    RT.bloom.forEach(b => { freeTex(b.d); freeTex(b.u); freeFBO(b.df); freeFBO(b.uf); });
  }
  RT.w = w; RT.h = h;
  RT.hdr = makeTex(w, h, FMT.RGBA16F, { filter: 'nearest' });
  RT.pos = makeTex(w, h, FMT.RGBA32F, { filter: 'nearest' });
  RT.traceF = makeFBO([RT.hdr, RT.pos]);
  RT.taa = makePair(w, h, FMT.RGBA16F, {});
  RT.dof = makeTex(w, h, FMT.RGBA16F);
  RT.dofF = makeFBO(RT.dof);
  RT.bloom = [];
  let bw = w, bh = h;
  for (let i = 0; i < 7; i++) {
    bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    const d = makeTex(bw, bh, FMT.RGBA16F), u = makeTex(bw, bh, FMT.RGBA16F);
    RT.bloom.push({ d, u, df: makeFBO(d), uf: makeFBO(u), w: bw, h: bh });
    if (bw <= 4 || bh <= 4) break;
  }
  RT.reset = true;
}

// ------------------------------------------------------------ ink grids (flat-3D atlases)
function atlasLayout(dim) {
  const [nx, ny, nz] = dim;
  let tx = Math.max(1, Math.round(Math.sqrt(ny * nz / nx)));
  tx = Math.min(tx, Math.floor(16384 / nx), ny);
  const ty = Math.ceil(ny / tx);
  return { tx, ty, w: tx * nx, h: ty * nz };
}
function buildInkResources(q) {
  const T = TANK;
  const nx = q.inkV, hx = 2 * T.TX / nx;
  const ny = Math.ceil((T.LEVEL + 0.08 - T.BOT) / hx), nz = Math.round(2 * T.TZ / hx);
  const vDim = [nx, ny, nz], dDim = [nx * 2, ny * 2, nz * 2];
  const vCell = [2 * T.TX / nx, hx, 2 * T.TZ / nz];
  const dCell = vCell.map(c => c / 2);
  const vL = atlasLayout(vDim), dL = atlasLayout(dDim);
  const velFmt = GLX.linearFloat ? FMT.RGBA32F : FMT.RGBA16F;
  const I = { vDim, dDim, vCell, dCell, vL, dL, gMin: [-T.TX, T.BOT, -T.TZ] };
  I.vel = makePair(vL.w, vL.h, velFmt, {});
  I.curl = makeTex(vL.w, vL.h, FMT.RGBA16F, { filter: 'nearest' }); I.curlF = makeFBO(I.curl);
  I.div = makeTex(vL.w, vL.h, FMT.RGBA32F, { filter: 'nearest' }); I.divF = makeFBO(I.div);
  I.p = makePair(vL.w, vL.h, FMT.RGBA32F, { filter: 'nearest' });
  I.dye = makePair(dL.w, dL.h, FMT.RGBA16F, {});
  I.hat = makeTex(dL.w, dL.h, FMT.RGBA16F); I.hatF = makeFBO(I.hat);
  I.light = makeTex(vL.w, vL.h, FMT.RGBA16F); I.lightF = makeFBO(I.light);
  I.sumW = Math.ceil(dL.w / 16); I.sumH = Math.ceil(dL.h / 16);
  I.sum = makeTex(I.sumW, I.sumH, FMT.RGBA32F, { filter: 'nearest' }); I.sumF = makeFBO(I.sum);
  I.pbo = GLX.gl.createBuffer();
  GLX.gl.bindBuffer(GLX.gl.PIXEL_PACK_BUFFER, I.pbo);
  GLX.gl.bufferData(GLX.gl.PIXEL_PACK_BUFFER, I.sumW * I.sumH * 16, GLX.gl.STREAM_READ);
  GLX.gl.bindBuffer(GLX.gl.PIXEL_PACK_BUFFER, null);
  I.sumData = new Float32Array(I.sumW * I.sumH * 4);
  R.ink = I;
  clearInkTextures();
}
function clearInkTextures() {
  const I = R.ink;
  if (!I) return;
  for (const f of [I.vel.fa, I.vel.fb, I.p.fa, I.p.fb, I.dye.fa, I.dye.fb, I.hatF, I.curlF, I.divF]) { bindTarget(f); GLX.clear(); }
  bindTarget(I.lightF); GLX.clear(1, 1, 1, 0);
}
function freeInkResources() {
  const I = R.ink;
  if (!I) return;
  I.vel.free(); I.p.free(); I.dye.free();
  [I.curl, I.div, I.hat, I.light, I.sum].forEach(freeTex);
  [I.curlF, I.divF, I.hatF, I.lightF, I.sumF].forEach(freeFBO);
  GLX.gl.deleteBuffer(I.pbo);
  if (INK.fence) { GLX.gl.deleteSync(INK.fence); INK.fence = null; }
  R.ink = null;
}

// ------------------------------------------------------------ sand (particles, heightfield, strata atlas)
function buildSandResources(q) {
  const T = TANK, gl = GLX.gl;
  const n = q.sandN, gw = q.sandG, gh = Math.round(q.sandG * T.TZ / T.TX);
  const S = { n, total: n * n, gw, gh, cell: [2 * T.TX / gw, 2 * T.TZ / gh], dy: q.sandDy };
  const part = () => { const p = makeTex(n, n, FMT.RGBA32F, { filter: 'nearest' }), v = makeTex(n, n, FMT.RGBA32F, { filter: 'nearest' }); return { p, v, f: makeFBO([p, v]) }; };
  S.cur = part(); S.nxt = part();
  S.swapP = () => { const t = S.cur; S.cur = S.nxt; S.nxt = t; };
  const hsim = () => { const h = makeTex(gw, gh, FMT.RGBA32F, { filter: 'nearest' }), t = makeTex(gw, gh, FMT.RGBA16F); return { h, t, f: makeFBO([h, t]) }; };
  S.hc = hsim(); S.hn = hsim();
  S.swapH = () => { const t = S.hc; S.hc = S.hn; S.hn = t; };
  S.dep0 = makeTex(gw, gh, FMT.RGBA16F, { filter: 'nearest' }); S.dep1 = makeTex(gw, gh, FMT.RGBA16F, { filter: 'nearest' });
  S.depF = makeFBO([S.dep0, S.dep1]);
  S.rend = makeTex(gw, gh, GLX.linearFloat ? FMT.RGBA32F : FMT.RGBA16F); S.rendF = makeFBO(S.rend);
  S.pw = Math.ceil(gw / 4); S.ph = Math.ceil(gh / 4);
  S.probe = makeTex(S.pw, S.ph, FMT.RGBA32F, { filter: 'nearest' }); S.probeF = makeFBO(S.probe);
  S.pbo = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, S.pbo);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, S.pw * S.ph * 16, gl.STREAM_READ);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  S.probeData = new Float32Array(S.pw * S.ph * 4);
  S.layers = Math.ceil((T.LEVEL - 0.1 - T.BOT) / q.sandDy) + 1;
  S.cDim = [gw, S.layers, gh];
  S.cL = atlasLayout(S.cDim);
  S.atlas = makePair(S.cL.w, S.cL.h, FMT.RGBA8, {});
  const dL = R.ink.dL;
  S.sus = makeTex(dL.w, dL.h, FMT.RGBA16F); S.susF = makeFBO(S.sus);
  R.sand = S;
  clearSandTextures();
  sandResetBed();
}
function clearSandTextures() {
  const gl = GLX.gl, S = R.sand;
  if (!S) return;
  for (const f of [S.cur.f, S.nxt.f, S.hc.f, S.hn.f, S.depF, S.rendF, S.probeF, S.atlas.fa, S.atlas.fb, S.susF]) { bindTarget(f); GLX.clear(); }
  S.probeData.fill(0);
  if (S.fence) { gl.deleteSync(S.fence); S.fence = null; }
}
function freeSandResources() {
  const S = R.sand;
  if (!S) return;
  const gl = GLX.gl;
  [S.cur, S.nxt].forEach(x => { freeTex(x.p); freeTex(x.v); freeFBO(x.f); });
  [S.hc, S.hn].forEach(x => { freeTex(x.h); freeTex(x.t); freeFBO(x.f); });
  [S.dep0, S.dep1, S.rend, S.probe, S.sus].forEach(freeTex);
  [S.depF, S.rendF, S.probeF, S.susF].forEach(freeFBO);
  S.atlas.free();
  gl.deleteBuffer(S.pbo);
  if (S.fence) gl.deleteSync(S.fence);
  R.sand = null;
}
