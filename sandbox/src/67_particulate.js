// ============================================================================
//  PARTICULATE — the specks suspended in the water. Real particles: they drift on a slow current,
//  follow the water's flow while the fluid runs (stirring, ink, moving bodies), and each frame are
//  binned into a coarse grid (one particle per cell) that the tracer walks cell by cell.
//  Particle texel: (x, y, z, seed)   seed in (0, 1] picks size and brightness; 0 = not seeded yet
// ============================================================================
SH.partStep = GLSL_HEAD + GLSL_NOISE + GLSL_ATLAS + GLSL_SANDH + `
uniform sampler2D tPS, tVel;
uniform vec4 uTank;   // half-width x, half-depth z, floor y, top of the water
uniform float uDt, uTime, uFluid;
uniform int uPN, uInit;
out vec4 o;
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  float idx = float(px.y * uPN + px.x);
  vec4 P = texelFetch(tPS, px, 0);
  if (uInit == 1 || P.w <= 0.0){   // seed evenly through the water
    vec3 h = hash33(vec3(idx * 0.731, 17.3, 5.1));
    vec3 p = vec3((h.x * 2.0 - 1.0) * (uTank.x - 0.01), mix(uTank.z + 0.02, uTank.w - 0.03, h.y), (h.z * 2.0 - 1.0) * (uTank.y - 0.01));
    o = vec4(p, 0.02 + 0.98 * hash13(vec3(idx, 3.1, 9.7)));
    return;
  }
  vec3 p = P.xyz;
  // the water's own flow when the fluid runs, a slow wandering current, and a little Brownian jitter
  vec3 u = uFluid > 0.5 ? sampleG(tVel, gV(p), uVDim, uVTx).xyz : vec3(0.0);
  vec3 q = p * 1.3 + vec3(0.0, uTime * 0.02, uTime * 0.015);
  vec3 cur = (vec3(vnoise3(q), vnoise3(q + 31.7), vnoise3(q + 57.3)) - 0.5) * vec3(0.03, 0.012, 0.03) + vec3(0.004, -0.0015, 0.003);
  vec3 j = hash33(vec3(idx * 0.37, uTime * 60.0, 2.9)) - 0.5;
  p += (u + cur) * uDt + j * 0.0004;
  // out through a wall: back in at the other side; into the bed or up to the surface: the other end
  if (p.x > uTank.x) p.x -= 2.0 * uTank.x; else if (p.x < -uTank.x) p.x += 2.0 * uTank.x;
  if (p.z > uTank.y) p.z -= 2.0 * uTank.y; else if (p.z < -uTank.y) p.z += 2.0 * uTank.y;
  float bed = uTank.z + sandTop(p.xz) + 0.004;
  if (p.y < bed) p.y = uTank.w - 0.03 - 0.05 * fract(P.w * 13.1);
  else if (p.y > uTank.w - 0.015) p.y = bed + 0.01 + 0.05 * fract(P.w * 17.3);
  o = vec4(p, P.w);
}`;
// one particle per grid cell (the last one written wins); the tracer reads its exact position
SH.partBinVS = GLSL_HEAD + `
uniform sampler2D tPS;
uniform int uPN, uCount, uPTx;
uniform ivec3 uPDim;
uniform vec3 uPMin;
uniform float uPCell;
uniform vec2 uAtlas;
out vec4 vP;
void main(){
  ivec2 c = ivec2(gl_VertexID % uPN, gl_VertexID / uPN);
  vec4 P = texelFetch(tPS, c, 0);
  ivec3 g = ivec3(floor((P.xyz - uPMin) / uPCell));
  gl_PointSize = 1.0;
  vP = P;
  if (gl_VertexID >= uCount || P.w <= 0.0 || any(lessThan(g, ivec3(0))) || any(greaterThanEqual(g, uPDim))){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 a = vec2(float((g.y % uPTx) * uPDim.x + g.x), float((g.y / uPTx) * uPDim.z + g.z)) + 0.5;
  gl_Position = vec4(a / uAtlas * 2.0 - 1.0, 0.0, 1.0);
}`;
SH.partBinFS = GLSL_HEAD + `
in vec4 vP;
out vec4 o;
void main(){ o = vP; }`;

const PART_CELL = 0.055;
function buildPartResources() {
  const T = TANK, cs = PART_CELL;
  const dim = [Math.ceil(2 * T.TX / cs), Math.ceil((T.LEVEL + 0.02 - T.BOT) / cs), Math.ceil(2 * T.TZ / cs)];
  const L = atlasLayout(dim);
  const pn = Math.ceil(Math.sqrt(dim[0] * dim[1] * dim[2] * 0.4));   // enough for the densest setting
  R.part = { pn, dim, L, min: [-T.TX, T.BOT, -T.TZ], fresh: true,
    st: makePair(pn, pn, FMT.RGBA32F, { filter: 'nearest' }),
    grid: makeTex(L.w, L.h, FMT.RGBA32F, { filter: 'nearest' }) };
  R.part.gridF = makeFBO(R.part.grid);
}
function freePartResources() {
  if (!R.part) return;
  R.part.st.free(); freeTex(R.part.grid); freeFBO(R.part.gridF);
  R.part = null;
}
function partCount() {
  const d = R.part.dim;
  return Math.min(R.part.pn * R.part.pn, Math.round(STATE.particles * 0.34 * d[0] * d[1] * d[2]));
}
function simulateParticulate(dt) {
  const S = R.part, T = TANK;
  if (!S || (dt <= 0 && !S.fresh)) return;
  GLX.blend(false);
  bindTarget(S.st.fb);
  P.partStep.use().setAll({ tPS: S.st.a, tVel: R.ink.vel.a, uTank: [T.TX, T.TZ, T.BOT, T.LEVEL], uDt: Math.min(dt, 1 / 20), uTime: SIM_T,
    uFluid: INK.active ? 1 : 0, uPN: S.pn, uInit: S.fresh ? 1 : 0, tSandH: R.sand.hc.h, uSandDom: sandDomain() });
  inkGridUniforms(P.partStep);
  drawFS(); S.st.swap();
  S.fresh = false;
  bindTarget(S.gridF);
  GLX.clear();
  P.partBin.use().setAll({ tPS: S.st.a, uPN: S.pn, uCount: partCount(), uPTx: S.L.tx, uPDim: S.dim, uPMin: S.min, uPCell: PART_CELL, uAtlas: [S.L.w, S.L.h] });
  drawPoints(S.pn * S.pn);
}
function partUniforms() {
  const S = R.part;
  return { tPartG: S.grid, uPDim: S.dim, uPTx: S.L.tx, uPMin: S.min };
}
