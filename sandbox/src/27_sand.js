// ============================================================================
//  SAND — GPU grain parcels (air -> water -> bed), a heightfield substrate that
//  avalanches to the angle of repose, and a voxel atlas recording colour strata.
//  Particle texel: P = (x, y, z, state + age/1000)   state 0 idle, 1 air, 2 water, 3 landed
//                  V = (vx, vy, vz, colour)            colour = packed sqrt-RGB, negative = mixed grain
// ============================================================================
const SAND_COLORS = [
  { name: 'Quartz white', css: '#e8dfca' },
  { name: 'Ochre', css: '#c98f36' },
  { name: 'Terracotta', css: '#b4522e' },
  { name: 'Coral pink', css: '#e68a86' },
  { name: 'Turquoise', css: '#2bb0a4' },
  { name: 'Violet', css: '#7b4db3' },
  { name: 'Lime', css: '#9dca3b' },
  { name: 'Basalt black', css: '#2c2a29' },
];

// ---------------------------------------------------------------------------
// particle step: spawn from the hopper (ring buffer), ballistic fall, water entry,
// drag toward the fluid velocity + settling, body push-out, landing on the bed
// ---------------------------------------------------------------------------
SH.sandStep = GLSL_HEAD + GLSL_NOISE + GLSL_ATLAS + GLSL_SANDH + GLSL_SANDPACK + `
uniform sampler2D tSP, tSV, tVel, tSurf, tSandTop;
uniform vec4 uTank;
uniform int uSN, uTotal, uSpawnA, uSpawnN, uFrame, uPalN, uNumB, uKickN;
uniform vec4 uKickP;   // sand lifted by stirring: centre x, z, radius
uniform vec3 uKickV;
uniform vec3 uSpawnP0, uSpawnP1;
uniform vec4 uSpawnC0, uSpawnC1;
uniform vec3 uPal[8];
uniform float uSwitch, uSpawnR, uSpawnV, uDt, uSettle, uTau, uFluid, uMaxAge, uDisp;
uniform vec4 uBPos[48];
uniform vec4 uBVel[48];
layout(location = 0) out vec4 oP;
layout(location = 1) out vec4 oV;
float surfY(vec2 xz){ return textureLod(tSurf, (xz + uTank.xy) / (2.0 * uTank.xy), 0.0).x; }
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  int idx = px.y * uSN + px.x;
  vec4 P = texelFetch(tSP, px, 0);
  vec4 V = texelFetch(tSV, px, 0);
  int rel = idx - uSpawnA;
  if (rel < 0) rel += uTotal;
  if (rel < uSpawnN){
    // new parcel, spread along this frame's nozzle path and pre-advanced by its sub-frame age
    float fr = (float(rel) + 0.5) / float(uSpawnN);
    vec3 h = hash33(vec3(float(idx), float(uFrame), 7.13));
    vec3 h2 = hash33(vec3(float(idx) * 1.37, float(uFrame) * 0.71, 3.1));
    float a = h.x * 6.2831853, rr = uSpawnR * sqrt(h.y);
    vec3 p = mix(uSpawnP0, uSpawnP1, fr) + vec3(cos(a) * rr, 0.0, sin(a) * rr);
    vec3 v = vec3((h2.x - 0.5) * 0.10, -uSpawnV * (0.85 + 0.3 * h2.y), (h2.z - 0.5) * 0.10);
    float tau = (1.0 - fr) * uDt;
    p += v * tau + vec3(0.0, -4.905, 0.0) * tau * tau;
    v.y -= 9.81 * tau;
    vec4 C = fr < uSwitch ? uSpawnC0 : uSpawnC1;
    float code;
    if (C.w > 0.5){ int k = min(int(h.z * float(uPalN)), uPalN - 1); code = -(packSand(uPal[k]) + 1.0); }
    else code = packSand(C.rgb);
    oP = vec4(p, 1.0 + tau * 0.001);
    oV = vec4(v, code);
    return;
  }
  if (rel < uSpawnN + uKickN){
    // lifted off the bed by stirring: starts just above the sand, carries the bed's surface colour
    vec3 h = hash33(vec3(float(idx), float(uFrame), 11.9));
    vec3 h2 = hash33(vec3(float(idx) * 0.61, float(uFrame) * 1.3, 5.7));
    float a = h.x * 6.2831853, rr = uKickP.z * sqrt(h.y);
    vec2 xz = clamp(uKickP.xy + vec2(cos(a), sin(a)) * rr, -uTank.xy + 0.01, uTank.xy - 0.01);
    vec3 p = vec3(xz.x, uTank.z + sandTop(xz) + 0.004 + 0.025 * h.z, xz.y);
    vec3 v = uKickV * (0.35 + 0.65 * h2.x) + vec3((h2.y - 0.5) * 0.35, 0.2 + 0.5 * h2.z, (h.z - 0.5) * 0.35);
    vec4 tc = textureLod(tSandTop, (xz + uTank.xy) / (2.0 * uTank.xy), 0.0);
    float code;
    if (tc.a > 0.5){ int k = min(int(h2.x * float(uPalN)), uPalN - 1); code = -(packSand(uPal[k]) + 1.0); }
    else code = packSand(tc.rgb);
    oP = vec4(p, 2.0);
    oV = vec4(v, code);
    return;
  }
  float state = floor(P.w);
  if (state < 0.5){ oP = P; oV = V; return; }
  if (state > 2.5){ oP = vec4(P.xyz, 0.0); oV = V; return; }   // landed last frame: retire
  float age = fract(P.w) * 1000.0 + uDt;
  vec3 p = P.xyz, v = V.xyz;
  float seed = hash13(vec3(float(idx), 3.3, 1.7));
  if (state < 1.5){
    // air: ballistic
    v.y -= 9.81 * uDt;
    v *= exp(-0.03 * uDt);
    p += v * uDt;
    bool inside = abs(p.x) < uTank.x && abs(p.z) < uTank.y;
    if (inside && p.y < surfY(p.xz)) state = 2.0;
    else if (p.y < 0.0){ oP = vec4(p, 0.0); oV = V; return; }
  } else {
    // water: relax toward the local flow plus this grain's settling velocity
    vec3 u = uFluid > 0.5 ? sampleG(tVel, gV(p), uVDim, uVTx).xyz : vec3(0.0);
    float ws = uSettle * (0.6 + 0.8 * seed);
    vec3 vt = u - vec3(0.0, ws, 0.0);
    v = vt + (v - vt) * exp(-uDt / uTau);
    vec3 j = hash33(vec3(float(idx) * 0.37, float(uFrame), 9.1)) - 0.5;
    p += v * uDt + j * uDisp;
    for (int i = 0; i < 48; i++){
      if (i >= uNumB) break;
      vec4 b = uBPos[i];
      vec3 d = p - b.xyz;
      float l = length(d);
      if (l < b.w && l > 1e-5){
        vec3 n = d / l;
        p = b.xyz + n * b.w;
        float vn = dot(v - uBVel[i].xyz, n);
        if (vn < 0.0) v -= vn * n;
      }
    }
    vec2 lim = uTank.xy - 0.004;
    if (abs(p.x) > lim.x){ p.x = clamp(p.x, -lim.x, lim.x); v.x = 0.0; }
    if (abs(p.z) > lim.y){ p.z = clamp(p.z, -lim.y, lim.y); v.z = 0.0; }
    float sy = surfY(p.xz) - 0.01;
    if (p.y > sy){ p.y = sy; v.y = min(v.y, 0.0); }
    float bed = uTank.z + sandTop(p.xz);
    if (p.y <= bed + 0.002 || age > uMaxAge){ p.y = max(min(p.y, bed), uTank.z); state = 3.0; }
  }
  oP = vec4(p, state + clamp(age, 0.0, 999.0) * 0.001);
  oV = vec4(v, V.w);
}`;

// landed parcels -> deposit accumulators over the sand grid: each parcel is spread over a small
// mass-normalised Gaussian footprint sized so a single parcel never raises a cell by more than a few mm
SH.sandDepVS = GLSL_HEAD + GLSL_SANDPACK + `
uniform sampler2D tSP, tSV;
uniform int uSN;
uniform vec4 uTank;
uniform float uDepSig;
uniform vec2 uGrid;
out vec4 vC;
out float vNorm;
float Phi(float x){ x = clamp(x, -6.0, 6.0); return 0.5 + 0.5 * tanh(0.7978845608 * (x + 0.044715 * x * x * x)); }   // clamped: tanh overflows to NaN on some GPUs
void main(){
  ivec2 c = ivec2(gl_VertexID % uSN, gl_VertexID / uSN);
  vec4 P = texelFetch(tSP, c, 0);
  gl_PointSize = 2.0 * ceil(3.0 * uDepSig) + 1.0;
  vNorm = 1.0;
  if (floor(P.w) != 3.0){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vC = vec4(0.0); return; }
  vC = unpackSand(texelFetch(tSV, c, 0).w);
  vec2 ndc = vec2(P.x / uTank.x, P.z / uTank.y);
  // against a wall part of the footprint falls off the grid: scale the rest up so no sand is lost
  vec2 cp = (ndc * 0.5 + 0.5) * uGrid;
  float fx = Phi((uGrid.x - cp.x) / uDepSig) - Phi(-cp.x / uDepSig);
  float fz = Phi((uGrid.y - cp.y) / uDepSig) - Phi(-cp.y / uDepSig);
  vNorm = 1.0 / max(fx * fz, 0.05);
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;
SH.sandDepFS = GLSL_HEAD + `
uniform float uDepSig;
in vec4 vC;
in float vNorm;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main(){
  float S = 2.0 * ceil(3.0 * uDepSig) + 1.0;
  vec2 r = (gl_PointCoord - 0.5) * S;
  float w = exp(-dot(r, r) / (2.0 * uDepSig * uDepSig)) / (6.2831853 * uDepSig * uDepSig) * vNorm;
  float m = vC.a;
  o0 = vec4(vC.rgb * (1.0 - m), 1.0 - m) * w;   // uniformly coloured sand: colour sum, count
  o1 = vec4(m * w, 0.0, 0.0, 0.0);              // mixed (speckled) sand count
}`;

// suspended parcels -> density grid on the ink dye atlas (for rendering, buoyancy and shadowing)
SH.sandSusVS = GLSL_HEAD + GLSL_ATLAS + GLSL_SANDPACK + `
uniform sampler2D tSP, tSV;
uniform int uSN;
uniform vec2 uAtlas;
out vec4 vC;
void main(){
  ivec2 c = ivec2(gl_VertexID % uSN, gl_VertexID / uSN);
  vec4 P = texelFetch(tSP, c, 0);
  gl_PointSize = 1.0;
  if (floor(P.w) != 2.0){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vC = vec4(0.0); return; }
  ivec3 g = clamp(ivec3(floor((P.xyz - uGMin) / uDCell)), ivec3(0), uDDim - 1);
  vec2 px = vec2(atlasPx(g, uDDim, uDTx)) + 0.5;
  vec4 col = unpackSand(texelFetch(tSV, c, 0).w);
  vC = vec4(col.rgb, 1.0);
  gl_Position = vec4(px / uAtlas * 2.0 - 1.0, 0.0, 1.0);
}`;
SH.sandSusFS = GLSL_HEAD + `
in vec4 vC;
out vec4 o;
void main(){ o = vC; }`;

// deposit: grow each column by its landed parcels; remember the start height for the strata painter
SH.sandDeposit = GLSL_HEAD + `
uniform sampler2D tH, tTop, tDep0, tDep1;
uniform float uVpA, uHMax;
uniform vec4 uErode;   // stirring: Gaussian bite out of the bed (x, z, sigma, volume)
uniform vec4 uGridW;   // world x, z of the grid's corner, cell size
layout(location = 0) out vec4 oH;
layout(location = 1) out vec4 oT;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 H = texelFetch(tH, c, 0);
  vec4 T = texelFetch(tTop, c, 0);
  vec4 d0 = texelFetch(tDep0, c, 0);
  float dm = texelFetch(tDep1, c, 0).r;
  float n = d0.a + dm;
  float h0 = H.r;
  float h1 = min(h0 + n * uVpA, uHMax);
  float add = h1 - h0;
  if (uErode.w > 0.0){
    vec2 d = uGridW.xy + (vec2(c) + 0.5) * uGridW.zw - uErode.xy;
    h1 = max(h1 - uErode.w / (6.2831853 * uErode.z * uErode.z) * exp(-dot(d, d) / (2.0 * uErode.z * uErode.z)), 0.0);
  }
  if (add > 0.0){
    vec3 cin = d0.a > 1e-4 ? d0.rgb / d0.a : T.rgb;
    T = mix(T, vec4(cin, dm / max(n, 1e-6)), h0 < 1e-4 ? 1.0 : clamp(add / 0.0015, 0.0, 1.0));
  }
  oH = vec4(h1, h0, 0.0, 0.0);
  oT = T;
}`;

// avalanche: pairwise (mass-conserving) flux wherever the slope exceeds the angle of repose,
// plus a very slow creep; moving sand carries its donor's surface colour
SH.sandSlide = GLSL_HEAD + GLSL_NOISE + `
uniform sampler2D tH, tTop;
uniform vec2 uCell;
uniform ivec2 uDim;
uniform float uTanR, uK, uCreep;
layout(location = 0) out vec4 oH;
layout(location = 1) out vec4 oT;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 H = texelFetch(tH, c, 0);
  float h = H.r, dh = 0.0, inA = 0.0;
  vec4 inC = vec4(0.0);
  // the angle of repose varies a little from place to place (grain packing): irregular flanks and
  // avalanche scars instead of a perfect cone; the pair threshold is symmetric so mass is conserved
  float rc = vnoise(vec2(c) * 0.23) + 0.5 * vnoise(vec2(c) * 0.71 + 13.1);
  for (int j = -1; j <= 1; j++){
    for (int i = -1; i <= 1; i++){
      if (i == 0 && j == 0) continue;
      ivec2 q = c + ivec2(i, j);
      if (q.x < 0 || q.y < 0 || q.x >= uDim.x || q.y >= uDim.y) continue;
      float hn = texelFetch(tH, q, 0).r;
      float rn = vnoise(vec2(q) * 0.23) + 0.5 * vnoise(vec2(q) * 0.71 + 13.1);
      float T = uTanR * (0.8 + 0.27 * (rc + rn) * 0.667) * length(vec2(float(i) * uCell.x, float(j) * uCell.y));
      float fin = max(hn - h - T, 0.0) * uK;
      float fout = max(h - hn - T, 0.0) * uK;
      float cr = min(h, hn) > 0.003 ? (hn - h) * uCreep : 0.0;   // creep only inside deposits
      dh += fin - fout + cr;
      float gain = fin + max(cr, 0.0);
      if (gain > 0.0){ inC += texelFetch(tTop, q, 0) * gain; inA += gain; }
    }
  }
  vec4 T = texelFetch(tTop, c, 0);
  if (inA > 1e-8) T = mix(T, inC / inA, h < 1e-4 ? 1.0 : clamp(inA / 0.0015, 0.0, 1.0));
  oH = vec4(max(h + dh, 0.0), H.g, 0.0, 0.0);
  oT = T;
}`;

// render copy: smoothed height and its gradient (Sobel)
SH.sandRender = GLSL_HEAD + `
uniform sampler2D tH;
uniform vec2 uCell;
uniform ivec2 uDim;
out vec4 o;
float hA(ivec2 q){ return texelFetch(tH, clamp(q, ivec2(0), uDim - 1), 0).r; }
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  float a = hA(c + ivec2(-1, -1)), b = hA(c + ivec2(0, -1)), d = hA(c + ivec2(1, -1));
  float e = hA(c + ivec2(-1, 0)), f = hA(c), g = hA(c + ivec2(1, 0));
  float k = hA(c + ivec2(-1, 1)), l = hA(c + ivec2(0, 1)), m = hA(c + ivec2(1, 1));
  float hs = (4.0 * f + 2.0 * (b + e + g + l) + (a + d + k + m)) / 16.0;
  float gx = ((d + 2.0 * g + m) - (a + 2.0 * e + k)) / (8.0 * uCell.x);
  float gz = ((k + 2.0 * l + m) - (a + 2.0 * b + d)) / (8.0 * uCell.y);
  o = vec4(hs, gx, gz, f);
}`;

// strata painter: every voxel between this frame's start and end height takes the column's surface
// colour, blended by how much of the voxel was filled before (sqrt-encoded RGB, alpha = mixed fraction)
SH.sandPaint = GLSL_HEAD + GLSL_ATLAS + `
uniform sampler2D tOld, tH, tTop;
uniform ivec3 uSCDim;
uniform int uSCTx;
uniform float uDy;
out vec4 o;
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 old = texelFetch(tOld, px, 0);
  ivec3 c = cellOf(px, uSCDim, uSCTx);
  if (c.y >= uSCDim.y){ o = old; return; }
  vec4 H = texelFetch(tH, c.xz, 0);
  float y0 = float(c.y) * uDy, y1 = y0 + uDy;
  float add = min(H.r, y1) - max(H.g, y0);
  if (add <= 1e-7){ o = old; return; }
  float f0 = clamp(min(H.g, y1) - y0, 0.0, uDy);
  vec4 T = texelFetch(tTop, c.xz, 0);
  vec4 oc = vec4(old.rgb * old.rgb, old.a);
  vec4 nc = f0 > 1e-6 ? (oc * f0 + T * add) / (f0 + add) : T;
  o = vec4(sqrt(clamp(nc.rgb, 0.0, 1.0)), clamp(nc.a, 0.0, 1.0));
}`;

// 4x4 block average / max of the height, read back for physics and the tracer's march bound
SH.sandProbe = GLSL_HEAD + `
uniform sampler2D tH;
uniform ivec2 uDim;
out vec4 o;
void main(){
  ivec2 b = ivec2(gl_FragCoord.xy) * 4;
  float s = 0.0, mx = 0.0, n = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++){
    ivec2 q = b + ivec2(i, j);
    if (q.x < uDim.x && q.y < uDim.y){ float h = texelFetch(tH, q, 0).r; s += h; mx = max(mx, h); n += 1.0; }
  }
  o = vec4(s / max(n, 1.0), mx, 0.0, 0.0);
}`;
