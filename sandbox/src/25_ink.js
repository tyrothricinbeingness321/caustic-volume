// ============================================================================
//  INK — 3D incompressible fluid on "flat 3D" atlases (y-slices tiled in 2D).
//  Velocity grid V, dye grid D (2x finer), light/occupancy grid L (V res).
//  Dye texel = (absorbance r,g,b * concentration, concentration).
// ============================================================================
const GLSL_ATLAS = `
uniform ivec3 uVDim, uDDim;
uniform int   uVTx, uDTx;
uniform vec3  uGMin, uVCell, uDCell;
ivec2 atlasPx(ivec3 c, ivec3 dim, int tx){ return ivec2((c.y % tx) * dim.x + c.x, (c.y / tx) * dim.z + c.z); }
ivec3 cellOf(ivec2 px, ivec3 dim, int tx){ int ti = px.x / dim.x, tj = px.y / dim.z; return ivec3(px.x - ti*dim.x, tj*tx + ti, px.y - tj*dim.z); }
vec4 fetchC(sampler2D t, ivec3 c, ivec3 dim, int tx){ c = clamp(c, ivec3(0), dim - 1); return texelFetch(t, atlasPx(c, dim, tx), 0); }
bool outside(ivec3 c, ivec3 dim){ return any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, dim)); }
// trilinear sample at continuous cell-centred grid coordinates (hardware bilinear inside a slice)
vec4 sampleG(sampler2D t, vec3 g, ivec3 dim, int tx){
  g = clamp(g, vec3(0.0), vec3(dim) - 1.0);
  float y0 = floor(g.y); float fy = g.y - y0;
  int j0 = int(y0); int j1 = min(j0 + 1, dim.y - 1);
  vec2 inT = g.xz + 0.5;
  vec2 asz = vec2(textureSize(t, 0));
  vec2 a0 = (vec2(float((j0 % tx) * dim.x), float((j0 / tx) * dim.z)) + inT) / asz;
  vec2 a1 = (vec2(float((j1 % tx) * dim.x), float((j1 / tx) * dim.z)) + inT) / asz;
  return mix(textureLod(t, a0, 0.0), textureLod(t, a1, 0.0), fy);
}
vec3 gV(vec3 w){ return (w - uGMin) / uVCell - 0.5; }
vec3 gD(vec3 w){ return (w - uGMin) / uDCell - 0.5; }
vec3 wallBC(vec3 u, ivec3 c, ivec3 dim){
  if (c.x == 0 || c.x == dim.x - 1) u.x = 0.0;
  if (c.y == 0 || c.y == dim.y - 1) u.y = 0.0;
  if (c.z == 0 || c.z == dim.z - 1) u.z = 0.0;
  return u;
}
`;

// advect velocity + all forces
SH.inkVel = GLSL_HEAD + GLSL_NOISE + GLSL_ATLAS + GLSL_SANDH + `
uniform sampler2D tVel, tDye, tSph, tSandS;
uniform float uSandBuoy;
uniform float uDt, uBuoy, uTurb, uTime, uLevel;
uniform int uNumB;
uniform vec4 uBPos[48];
uniform vec4 uBVel[48];
uniform int uNumInj;
uniform vec4 uInjP[8];
uniform vec4 uInjV[8];
uniform int uNumStir;
uniform vec4 uStirP[4];
uniform vec4 uStirV[4];
uniform int uNumBub;
uniform vec3 uBubMin, uBubMax;
uniform float uDamp;
out vec4 o;
// curl of a smooth vector potential -> divergence-free field (unit-ish amplitude)
vec3 curlNoise(vec3 q, float e){
  float ax = vnoise3(q + vec3(0.0, e, 0.0)) - vnoise3(q - vec3(0.0, e, 0.0));
  float ay = vnoise3(q + vec3(0.0, 0.0, e)) - vnoise3(q - vec3(0.0, 0.0, e));
  float bx = vnoise3(q + vec3(31.4, 0.0, e)) - vnoise3(q + vec3(31.4, 0.0, -e));
  float by = vnoise3(q + vec3(31.4 + e, 0.0, 0.0)) - vnoise3(q + vec3(31.4 - e, 0.0, 0.0));
  float cx = vnoise3(q + vec3(e, 17.9, 0.0)) - vnoise3(q + vec3(-e, 17.9, 0.0));
  float cy = vnoise3(q + vec3(0.0, 17.9 + e, 0.0)) - vnoise3(q + vec3(0.0, 17.9 - e, 0.0));
  // psi = (A, B, C): curl = (dC/dy - dB/dz, dA/dz - dC/dx, dB/dx - dA/dy)
  return vec3(cy - bx, ay - cx, by - ax) / (2.0 * e);
}
void main(){
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy), uVDim, uVTx);
  if (c.y >= uVDim.y){ o = vec4(0.0); return; }
  vec3 pw = uGMin + (vec3(c) + 0.5) * uVCell;
  vec3 u = fetchC(tVel, c, uVDim, uVTx).xyz;
  vec3 ua = sampleG(tVel, gV(pw - u * uDt), uVDim, uVTx).xyz;
  // ink is denser than water: negative buoyancy drives plumes
  float ink = sampleG(tDye, gD(pw), uDDim, uDTx).a;
  // small density perturbations seed the Rayleigh-Taylor lobes of a sinking ink head
  float pert = 1.0 + 0.45 * (vnoise3(pw * 14.0 + vec3(0.0, uTime * 0.6, 0.0)) - 0.5);
  ua.y -= uBuoy * ink * pert * uDt;
  vec3 lat = vec3(vnoise3(pw * 9.0 + 3.7) - 0.5, 0.0, vnoise3(pw * 9.0 + 11.3) - 0.5);
  ua += lat * uBuoy * ink * 0.35 * uDt;
  // suspended sand makes the water heavier: the plume sinks as a density current
  if (uSandBuoy > 0.0) ua.y -= uSandBuoy * min(sampleG(tSandS, gD(pw), uDDim, uDTx).a, 6.0) * uDt;
  // ambient turbulence: divergence-free curl-noise stirring (bounded by the damping below)
  if (uTurb > 0.0){
    vec3 ct = curlNoise(pw * 2.4 + vec3(0.0, uTime * 0.09, uTime * 0.06), 0.18)
            + 0.5 * curlNoise(pw * 6.1 - vec3(uTime * 0.2, 0.0, uTime * 0.15), 0.18);
    float nearTop = 0.45 + 0.55 * smoothstep(uLevel - 0.6, uLevel, pw.y);
    ua += ct * uTurb * nearTop * uDt;
  }
  // moving bodies carry the water with them
  for (int i = 0; i < 48; i++){
    if (i >= uNumB) break;
    vec4 b = uBPos[i];
    float d = length(pw - b.xyz);
    if (d < b.w * 1.35){
      float w = 1.0 - smoothstep(b.w * 0.7, b.w * 1.35, d);
      ua = mix(ua, uBVel[i].xyz, w * 0.9);
    }
  }
  // rising bubbles entrain water upward
  if (uNumBub > 0 && all(greaterThan(pw, uBubMin - 0.07)) && all(lessThan(pw, uBubMax + 0.07))){
    for (int i = 0; i < 64; i++){
      if (i >= uNumBub) break;
      vec4 s = texelFetch(tSph, ivec2(i, 0), 0);
      float d = length(pw - s.xyz), R = 0.035 + s.w * 6.0;
      if (d < R){ float w = 1.0 - d / R; ua.y += (0.3 - ua.y) * w * w * 0.3; }
    }
  }
  for (int i = 0; i < 8; i++){
    if (i >= uNumInj) break;
    vec4 P = uInjP[i];
    float rv = max(P.w, 1.1 * min(uVCell.x, uVCell.y));
    float d = length(pw - P.xyz);
    float w = exp(-d * d / (rv * rv)) * uInjV[i].w;
    ua = mix(ua, uInjV[i].xyz, clamp(w, 0.0, 1.0));
  }
  for (int i = 0; i < 4; i++){
    if (i >= uNumStir) break;
    // stirring: a paddle reaching down 30 cm from the stir point drags the water along with it
    vec4 P = uStirP[i];
    vec3 q = pw - P.xyz;
    q.y = q.y > 0.0 ? q.y : min(q.y + 0.3, 0.0);
    float w = exp(-dot(q, q) / (P.w * P.w)) * uStirV[i].w;
    ua = mix(ua, uStirV[i].xyz, clamp(w, 0.0, 1.0));
  }
  ua *= exp(-uDt * uDamp);
  ua = clamp(ua, vec3(-2.5), vec3(2.5));
  if (pw.y < uGMin.y + sandTop(pw.xz)) ua = vec3(0.0);   // inside the sand bed
  o = vec4(wallBC(ua, c, uVDim), 0.0);
}`;

SH.inkCurl = GLSL_HEAD + GLSL_ATLAS + `
uniform sampler2D tVel;
out vec4 o;
void main(){
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy), uVDim, uVTx);
  if (c.y >= uVDim.y){ o = vec4(0.0); return; }
  vec3 L = fetchC(tVel, c - ivec3(1,0,0), uVDim, uVTx).xyz, R = fetchC(tVel, c + ivec3(1,0,0), uVDim, uVTx).xyz;
  vec3 D = fetchC(tVel, c - ivec3(0,1,0), uVDim, uVTx).xyz, U = fetchC(tVel, c + ivec3(0,1,0), uVDim, uVTx).xyz;
  vec3 B = fetchC(tVel, c - ivec3(0,0,1), uVDim, uVTx).xyz, F = fetchC(tVel, c + ivec3(0,0,1), uVDim, uVTx).xyz;
  vec3 h2 = 2.0 * uVCell;
  vec3 w = vec3((U.z - D.z) / h2.y - (F.y - B.y) / h2.z,
                (F.x - B.x) / h2.z - (R.z - L.z) / h2.x,
                (R.y - L.y) / h2.x - (U.x - D.x) / h2.y);
  o = vec4(w, length(w));
}`;

SH.inkConfine = GLSL_HEAD + GLSL_ATLAS + `
uniform sampler2D tVel, tCurl;
uniform float uDt, uVort;
out vec4 o;
void main(){
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy), uVDim, uVTx);
  if (c.y >= uVDim.y){ o = vec4(0.0); return; }
  float L = fetchC(tCurl, c - ivec3(1,0,0), uVDim, uVTx).w, R = fetchC(tCurl, c + ivec3(1,0,0), uVDim, uVTx).w;
  float D = fetchC(tCurl, c - ivec3(0,1,0), uVDim, uVTx).w, U = fetchC(tCurl, c + ivec3(0,1,0), uVDim, uVTx).w;
  float B = fetchC(tCurl, c - ivec3(0,0,1), uVDim, uVTx).w, F = fetchC(tCurl, c + ivec3(0,0,1), uVDim, uVTx).w;
  vec3 eta = vec3(R - L, U - D, F - B) / (2.0 * uVCell);
  vec3 N = eta / (length(eta) + 1e-5);
  vec3 w = fetchC(tCurl, c, uVDim, uVTx).xyz;
  float h = min(uVCell.x, min(uVCell.y, uVCell.z));
  vec3 u = fetchC(tVel, c, uVDim, uVTx).xyz + uVort * h * cross(N, w) * uDt;
  o = vec4(wallBC(u, c, uVDim), 0.0);
}`;

SH.inkDiv = GLSL_HEAD + GLSL_ATLAS + `
uniform sampler2D tVel;
out vec4 o;
vec3 velN(ivec3 c, ivec3 n, vec3 uc){
  ivec3 q = c + n;
  if (outside(q, uVDim)) return uc * (vec3(1.0) - 2.0 * abs(vec3(n)));
  return fetchC(tVel, q, uVDim, uVTx).xyz;
}
void main(){
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy), uVDim, uVTx);
  if (c.y >= uVDim.y){ o = vec4(0.0); return; }
  vec3 uc = fetchC(tVel, c, uVDim, uVTx).xyz;
  float div = (velN(c, ivec3(1,0,0), uc).x - velN(c, ivec3(-1,0,0), uc).x) / (2.0 * uVCell.x)
            + (velN(c, ivec3(0,1,0), uc).y - velN(c, ivec3(0,-1,0), uc).y) / (2.0 * uVCell.y)
            + (velN(c, ivec3(0,0,1), uc).z - velN(c, ivec3(0,0,-1), uc).z) / (2.0 * uVCell.z);
  o = vec4(div, 0.0, 0.0, 0.0);
}`;

SH.inkJacobi = GLSL_HEAD + GLSL_ATLAS + `
// Jacobi on the wide Laplacian (div of the central-difference gradient): makes the projection
// consistent with the central-difference divergence, so projected flow is discretely divergence-free
uniform sampler2D tP, tDiv;
uniform float uKeep;
out vec4 o;
float pN(ivec3 c, ivec3 n, float pc){ ivec3 q = c + n; return outside(q, uVDim) ? pc : fetchC(tP, q, uVDim, uVTx).x; }
void main(){
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy), uVDim, uVTx);
  if (c.y >= uVDim.y){ o = vec4(0.0); return; }
  float pc = fetchC(tP, c, uVDim, uVTx).x * uKeep;
  float div = fetchC(tDiv, c, uVDim, uVTx).x;
  vec3 ih2 = 1.0 / (4.0 * uVCell * uVCell);
  float s = (pN(c, ivec3(2,0,0), pc) + pN(c, ivec3(-2,0,0), pc)) * ih2.x
          + (pN(c, ivec3(0,2,0), pc) + pN(c, ivec3(0,-2,0), pc)) * ih2.y
          + (pN(c, ivec3(0,0,2), pc) + pN(c, ivec3(0,0,-2), pc)) * ih2.z;
  o = vec4((s - div) / (2.0 * (ih2.x + ih2.y + ih2.z)), 0.0, 0.0, 0.0);
}`;

SH.inkProject = GLSL_HEAD + GLSL_ATLAS + GLSL_SANDH + `
uniform sampler2D tVel, tP;
out vec4 o;
float pN(ivec3 c, ivec3 n, float pc){ ivec3 q = c + n; return outside(q, uVDim) ? pc : fetchC(tP, q, uVDim, uVTx).x; }
void main(){
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy), uVDim, uVTx);
  if (c.y >= uVDim.y){ o = vec4(0.0); return; }
  float pc = fetchC(tP, c, uVDim, uVTx).x;
  vec3 g = vec3(pN(c, ivec3(1,0,0), pc) - pN(c, ivec3(-1,0,0), pc),
                pN(c, ivec3(0,1,0), pc) - pN(c, ivec3(0,-1,0), pc),
                pN(c, ivec3(0,0,1), pc) - pN(c, ivec3(0,0,-1), pc)) / (2.0 * uVCell);
  vec3 u = fetchC(tVel, c, uVDim, uVTx).xyz - g;
  vec3 pw = uGMin + (vec3(c) + 0.5) * uVCell;
  if (pw.y < uGMin.y + sandTop(pw.xz)) u = vec3(0.0);
  o = vec4(wallBC(u, c, uVDim), 0.0);
}`;

// MacCormack dye advection, pass A: forward semi-Lagrangian
SH.inkDyeA = GLSL_HEAD + GLSL_ATLAS + `
uniform sampler2D tDye, tVel;
uniform float uDt;
out vec4 o;
void main(){
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy), uDDim, uDTx);
  if (c.y >= uDDim.y){ o = vec4(0.0); return; }
  vec3 pw = uGMin + (vec3(c) + 0.5) * uDCell;
  vec3 u = sampleG(tVel, gV(pw), uVDim, uVTx).xyz;
  o = sampleG(tDye, gD(pw - u * uDt), uDDim, uDTx);
}`;

// pass B: error compensation + limiter, injections, slow fading
SH.inkDyeB = GLSL_HEAD + GLSL_ATLAS + `
uniform sampler2D tDye, tHat, tVel;
uniform float uDt, uDecay, uMac, uMassScale;
uniform int uNumInj;
uniform vec4 uInjP[8];
uniform vec4 uInjC[8];
out vec4 o;
void main(){
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy), uDDim, uDTx);
  if (c.y >= uDDim.y){ o = vec4(0.0); return; }
  vec3 pw = uGMin + (vec3(c) + 0.5) * uDCell;
  vec3 u = sampleG(tVel, gV(pw), uVDim, uVTx).xyz;
  vec4 hat = fetchC(tHat, c, uDDim, uDTx);
  vec4 til = sampleG(tHat, gD(pw + u * uDt), uDDim, uDTx);
  vec4 phi = fetchC(tDye, c, uDDim, uDTx);
  vec4 r = hat + 0.5 * (phi - til);
  vec3 g = clamp(gD(pw - u * uDt), vec3(0.0), vec3(uDDim) - 1.0);
  ivec3 i0 = ivec3(floor(g));
  vec4 mn = vec4(1e9), mx = vec4(-1e9);
  for (int k = 0; k < 8; k++){
    vec4 s = fetchC(tDye, i0 + ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1), uDDim, uDTx);
    mn = min(mn, s); mx = max(mx, s);
  }
  r = clamp(r, mn, mx);
  if (uMac < 0.5) r = hat;
  r *= uMassScale;
  for (int i = 0; i < 8; i++){
    if (i >= uNumInj) break;
    vec4 P = uInjP[i];
    float rd = max(P.w, 0.9 * uDCell.x);
    float d = length(pw - P.xyz);
    float w = exp(-d * d / (rd * rd)) * (P.w * P.w) / (rd * rd);
    r += vec4(uInjC[i].rgb, 1.0) * uInjC[i].w * w;
  }
  o = max(r * uDecay, 0.0);
}`;

// transmittance of ink toward the key light(s) (colored self-shadowing) + local occupancy.
// With several lamps the transmittances are blended by each lamp's strength at the cell.
SH.inkLight = GLSL_HEAD + GLSL_ATLAS + `
uniform sampler2D tDye, tSandS;
uniform float uSandSig;
uniform int uLampMode, uNumLamps;
uniform vec3 uLampPos[3], uLampAim[3];
uniform vec2 uLampCone[3];
uniform float uLampLum[3];
uniform vec3 uLw;
uniform float uInkScat, uLevel;
uniform vec4 uTank;
out vec4 o;
void main(){
  ivec3 c = cellOf(ivec2(gl_FragCoord.xy), uVDim, uVTx);
  if (c.y >= uVDim.y){ o = vec4(1.0, 1.0, 1.0, 0.0); return; }
  vec3 pw = uGMin + (vec3(c) + 0.5) * uVCell;
  int nl = uLampMode == 1 ? clamp(uNumLamps, 1, 3) : 1;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int l = 0; l < nl; l++){
    vec3 dir = -uLw;
    float w = 1.0;
    if (uLampMode == 1){
      vec3 d = uLampPos[l] - pw;
      float r2 = max(dot(d, d), 1e-4);
      dir = d * inversesqrt(r2);
      w = uLampLum[l] * (0.03 + smoothstep(uLampCone[l].x, uLampCone[l].y, dot(-dir, uLampAim[l]))) / r2 + 1e-6;
    }
    float tEnd = dir.y > 1e-3 ? (uLevel + 0.03 - pw.y) / dir.y : 4.0;
    vec3 inv = 1.0 / (sign(dir) * max(abs(dir), vec3(1e-5)) + vec3(1e-9));
    vec3 t1 = (vec3(uTank.x, 0.0, uTank.y) * sign(dir) - vec3(pw.x, 0.0, pw.z)) * inv;
    if (abs(dir.x) > 1e-4) tEnd = min(tEnd, t1.x);
    if (abs(dir.z) > 1e-4) tEnd = min(tEnd, t1.z);
    tEnd = clamp(tEnd, 0.0, 4.0);
    const int N = 24;
    float ds = tEnd / float(N);
    vec3 tau = vec3(0.0);
    for (int i = 0; i < N; i++){
      vec4 d = sampleG(tDye, gD(pw + dir * (float(i) + 0.5) * ds), uDDim, uDTx);
      float neutral = min(d.r, min(d.g, d.b)) / max(max(d.r, max(d.g, d.b)), 1e-4);
      float sd = sampleG(tSandS, gD(pw + dir * (float(i) + 0.5) * ds), uDDim, uDTx).a;
      tau += (d.rgb + vec3(d.a * uInkScat * 0.65 * (1.0 - 0.92 * neutral) + sd * uSandSig * 0.35)) * ds;
    }
    acc += w * exp(-tau);
    wsum += w;
  }
  float occ = sampleG(tDye, gD(pw), uDDim, uDTx).a;
  occ = max(occ, sampleG(tDye, gD(pw + vec3(uVCell.x, 0.0, 0.0)), uDDim, uDTx).a);
  occ = max(occ, sampleG(tDye, gD(pw - vec3(uVCell.x, 0.0, 0.0)), uDDim, uDTx).a);
  occ = max(occ, sampleG(tDye, gD(pw + vec3(0.0, uVCell.y, 0.0)), uDDim, uDTx).a);
  occ = max(occ, sampleG(tDye, gD(pw - vec3(0.0, uVCell.y, 0.0)), uDDim, uDTx).a);
  occ = max(occ, sampleG(tDye, gD(pw + vec3(0.0, 0.0, uVCell.z)), uDDim, uDTx).a);
  occ = max(occ, sampleG(tDye, gD(pw - vec3(0.0, 0.0, uVCell.z)), uDDim, uDTx).a);
  // suspended sand also needs the fine volume steps
  float so = sampleG(tSandS, gD(pw), uDDim, uDTx).a;
  so = max(so, sampleG(tSandS, gD(pw + vec3(uVCell.x, 0.0, 0.0)), uDDim, uDTx).a);
  so = max(so, sampleG(tSandS, gD(pw - vec3(uVCell.x, 0.0, 0.0)), uDDim, uDTx).a);
  so = max(so, sampleG(tSandS, gD(pw + vec3(0.0, uVCell.y, 0.0)), uDDim, uDTx).a);
  so = max(so, sampleG(tSandS, gD(pw - vec3(0.0, uVCell.y, 0.0)), uDDim, uDTx).a);
  so = max(so, sampleG(tSandS, gD(pw + vec3(0.0, 0.0, uVCell.z)), uDDim, uDTx).a);
  so = max(so, sampleG(tSandS, gD(pw - vec3(0.0, 0.0, uVCell.z)), uDDim, uDTx).a);
  o = vec4(acc / max(wsum, 1e-9), max(occ, min(so * 0.05, 1.0)));
}`;

// block sums of ink concentration (16x16 atlas texels each) for the mass-conservation readback
SH.inkSum = GLSL_HEAD + `
uniform sampler2D tDye;
out vec4 o;
void main(){
  ivec2 sz = textureSize(tDye, 0);
  ivec2 b = ivec2(gl_FragCoord.xy) * 16;
  float s = 0.0;
  for (int j = 0; j < 16; j++){
    for (int i = 0; i < 16; i++){
      ivec2 q = b + ivec2(i, j);
      if (q.x < sz.x && q.y < sz.y) s += texelFetch(tDye, q, 0).a;
    }
  }
  o = vec4(s, 0.0, 0.0, 0.0);
}`;
