// ============================================================================
//  MAIN RAY TRACER — glass tank, water volume, refraction/reflection tree,
//  caustic lighting, volumetric light shafts, particulate, bubbles, spray
// ============================================================================
SH.trace = GLSL_HEAD + GLSL_NOISE + GLSL_SCENE + GLSL_ATLAS + `
uniform sampler2D tCaus;       // caustic volume: atlas of horizontal slices
uniform vec4  uCausAtlas;      // tile columns, rows, half-texel margins
uniform vec3  uCausBlur;       // mip level of the blurred field, its margins
uniform sampler2D tFloorCaus, tEnv, tSph;
uniform int   uNumBub, uNumDrop;
uniform vec3  uBubMin, uBubMax, uDropMin, uDropMax;
uniform vec3  uCamPos;
uniform mat3  uCamRot;
uniform vec2  uTanFov, uJitter, uRes;
uniform int   uFrame, uVolSteps, uHFSteps, uMaxIter, uPartSteps, uDbg;
uniform float uCausTop, uCausLayers, uGodRays, uCausGain, uGlassOn, uGlassW, uBottomType;
uniform float uPartDensity, uPartCell, uPartBright, uMaxSlope, uSunRadius, uPixAng, uFoamGain, uMicro, uEnvMax;
uniform vec3  uAmbWater, uKdv, uSkyIrr, uGroundIrr, uGlassTint;
uniform sampler2D tPartG;   // particulate: one particle position per grid cell (w = seed, 0 = empty)
uniform ivec3 uPDim;
uniform int   uPTx;
uniform vec3  uPMin;
uniform sampler2D tInkD, tInkL;
uniform int   uInkOn, uInkSub, uNumAO;
uniform float uInkScat, uLampEmit, uLampR;
uniform vec3  uKeyAmb;
uniform sampler2D tSandR, tSandC, tSandS, tSandT;   // bed height (h, dh/dx, dh/dz), strata atlas, suspended sand, surface colour
uniform vec4  uSandDom;
uniform float uSandMax, uSandDy, uSandSig, uSettleV;
uniform int   uSandSteps, uSCTx, uPalN, uStreamOn;
uniform ivec3 uSCDim;
uniform vec3  uPal[8];
uniform vec3  uPalAvg;
uniform vec4  uStreamP[8];   // air stream: centre x, z, -, radius at increasing fall times
uniform vec4  uStreamC[8];   // colour, mixed flag
uniform vec4  uStream;       // nozzle y, water entry y, density, exit speed
uniform sampler2D tLz;       // laser: row 0 segment start + power, row 1 segment end + medium, row 2 spots (pos, power)
uniform int   uLzN, uLzSpotN;
uniform vec3  uLzCol;
uniform float uLzW, uLzSigW, uLzExt, uLzHaze, uLzHalo;
layout(location = 0) out vec4 oCol;
layout(location = 1) out vec4 oPos;

#define K_SKY 0
#define K_FLOOR 1
#define K_BOTTOM 2
#define K_SURF 3
#define K_WALL 4
#define K_RIM 5
#define K_OBJ 6
#define K_BUB 7
#define K_DROP 8
#define K_SAND 9
#define K_STREAM 10

struct Hit { float t; int kind; int id; vec3 n; vec3 lp; int zone; };

float gSeed = 0.0;
vec4 gSurfBez = vec4(0.0); vec3 gSurfBezT = vec3(1.0, 0.0, 0.0), gSurfBezIn = vec3(0.0);   // Bezier tube data at the shaded object hit
vec3 gDbg = vec3(0.0);   // debug mode 2: which shading branch a pixel's light came from
float rnd(){ gSeed += 1.0; return hash13(vec3(gl_FragCoord.xy, gSeed + float(uFrame % 997) * 3.1731)); }
float ign(vec2 p, int f){ p += 5.588238 * float(f % 64); return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float max3(vec3 v){ return max(v.x, max(v.y, v.z)); }
vec3 safeInv(vec3 d){
  vec3 s = vec3(d.x >= 0.0 ? 1.0 : -1.0, d.y >= 0.0 ? 1.0 : -1.0, d.z >= 0.0 ? 1.0 : -1.0);
  return 1.0 / (s * max(abs(d), vec3(1e-8)));
}
vec2 boxRange(vec3 ro, vec3 inv, vec3 bmin, vec3 bmax){
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 a = min(t0, t1), b = max(t0, t1);
  return vec2(max(max(a.x, a.y), a.z), min(min(b.x, b.y), b.z));
}
float hg(float c, float g){ float g2 = g*g; return (1.0 - g2) / (4.0*PI*pow(max(1.0 + g2 - 2.0*g*c, 1e-4), 1.5)); }

// ---------------- environment ----------------
vec2 equi(vec3 d){ return vec2(atan(d.z, d.x) * (0.5/PI) + 0.5, 1.0 - acos(clamp(d.y, -1.0, 1.0)) / PI); }
vec3 envL(vec3 d, float lod){ return textureLod(tEnv, equi(d), clamp(lod, 0.0, uEnvMax)).rgb; }
vec3 skyL(vec3 d, float cone){
  float r = max(uSunRadius, cone);
  float ang = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
  float disk = smoothstep(r * 1.2, r * 0.8, ang) / (PI * r * r);
  return envL(d, cone * 60.0) + uSunCol * disk;
}
vec3 uwEnv(vec3 d, float depth){
  vec3 base = uAmbWater * exp(-uKdv * depth) / PI;
  return base * mix(0.10, 1.9, smoothstep(-0.35, 0.95, d.y));
}
vec3 ambAir(vec3 n){ return mix(uGroundIrr, uSkyIrr, 0.5 + 0.5*n.y); }
vec3 ambWater(vec3 p, vec3 n){
  float depth = max(uLevel - p.y, 0.0);
  return uAmbWater * exp(-uKdv * depth) * (0.35 + 0.65 * (0.5 + 0.5*n.y));
}

// ---------------- caustic light field ----------------
bool gBed = false;   // shading a bed point (tank floor or sand): the bed caustic map is projected onto it
// non-finite test on the bit pattern: immune to compilers folding isnan / isinf away under fast math
bool badF(vec3 v){ return any(equal(floatBitsToUint(v) & 0x7F800000u, uvec3(0x7F800000u))); }
// one slice of the atlas at a mip level; the margin keeps the filter footprint inside the tile
vec3 causSlice(vec2 uv, float l, float lod, vec2 m){
  float row = floor((l + 0.5) / uCausAtlas.x);
  vec2 tile = vec2(l - row * uCausAtlas.x, row);
  return textureLod(tCaus, (tile + clamp(uv, m, 1.0 - m)) / uCausAtlas.xy, lod).rgb;
}
// relative irradiance: even the sharpest caustic cusps stay far below the clamp
vec3 causSafe(vec3 c){ return badF(c) ? vec3(1.0) : clamp(c, 0.0, 150.0); }
vec3 causAt(vec3 p){
  vec2 uv = footUV(p.xz);
  vec3 c;
  if (gBed || p.y < uTank.z + 0.003) c = textureLod(tFloorCaus, uv, 0.0).rgb;
  else {
    float w = clamp((p.y - uTank.z) / (uCausTop - uTank.z), 0.0, 1.0) * (uCausLayers - 1.0);
    float l0 = min(floor(w), uCausLayers - 2.0);
    c = mix(causSlice(uv, l0, 0.0, uCausAtlas.zw), causSlice(uv, l0 + 1.0, 0.0, uCausAtlas.zw), w - l0);
  }
  return causSafe(c);
}
// the volume field at p, and the same field blurred over ~12 cm (its local average)
vec3 causField(vec3 p, out vec3 cb){
  vec2 uv = footUV(p.xz);
  float w = clamp((p.y - uTank.z) / (uCausTop - uTank.z), 0.0, 1.0) * (uCausLayers - 1.0);
  float l0 = min(floor(w), uCausLayers - 2.0), f = w - l0;
  cb = causSafe(mix(causSlice(uv, l0, uCausBlur.x, uCausBlur.yz), causSlice(uv, l0 + 1.0, uCausBlur.x, uCausBlur.yz), f));
  return causSafe(mix(causSlice(uv, l0, 0.0, uCausAtlas.zw), causSlice(uv, l0 + 1.0, 0.0, uCausAtlas.zw), f));
}

// ---------------- ink fields ----------------
vec4 inkLightAt(vec3 p){ if (uInkOn == 0) return vec4(1.0, 1.0, 1.0, 0.0); return sampleG(tInkL, gV(p), uVDim, uVTx); }
vec4 inkAt(vec3 p){ return sampleG(tInkD, gD(p), uDDim, uDTx); }

// ---------------- key lights (the sun, or 1-3 lamps) ----------------
// per-hit light list: irradiance perpendicular to each light, and the direction toward it
vec3 gE[3]; vec3 gL[3]; int gNL = 0;
vec3 gK[3]; vec3 gX[3];   // underwater: gE = gK * caustic field + gX (lamp light straight through the side glass)
vec3 gLampP[3];
// propagation direction in water of lamp li's light reaching p (refraction point on the flat surface, Newton solve)
vec3 lampDirWater(int li, vec3 p){
  vec3 lp = uLampPos[li];
  float H = max(lp.y - uLevel, 0.05), D = max(uLevel - p.y, 0.0);
  vec2 dxz = p.xz - lp.xz;
  float R = length(dxz);
  if (R < 1e-4) return vec3(0.0, -1.0, 0.0);
  vec2 dir = dxz / R;
  float r = R * H / (H + D / 1.333 + 1e-4);
  for (int i = 0; i < 3; i++){
    float a = sqrt(r*r + H*H), b = sqrt((R - r)*(R - r) + D*D + 1e-8);
    float f = r / a - 1.333 * (R - r) / b;
    float df = H*H / (a*a*a) + 1.333 * D*D / (b*b*b) + 1e-5;
    r = clamp(r - f / df, 0.0, R);
  }
  vec3 entry = vec3(lp.x + dir.x * r, uLevel, lp.z + dir.y * r);
  return normalize(p - entry + vec3(0.0, -1e-4, 0.0));
}
// Underwater light list. The caustic field holds the sun's relative irradiance or a single lamp's
// irradiance (RGB = spectral dispersion), or, with several lamps, one lamp per channel so each lamp
// keeps its own colour and direction.
void keyWaterC(vec3 p, vec3 inkT, vec3 c){
  if (uLampMode == 0){ gNL = 1; gL[0] = -uLw; gK[0] = uSunCol * uCausK * inkT; gX[0] = vec3(0.0); gE[0] = gK[0] * c; return; }
  gNL = clamp(uNumLamps, 1, 3);
  for (int i = 0; i < gNL; i++){   // dynamic trip count: keeps D3D compilers from unrolling the light loops
    vec3 Ld = -lampDirWater(i, p);
    vec3 K = uLampCol[i] * inkT, X = vec3(0.0);
    vec3 E = K * (uNumLamps == 1 ? c : vec3(c[i]));
    // lamp beside the tank: straight light through the side glass below the waterline
    vec3 toL = uLampPos[i] - p;
    float dist = length(toL);
    vec3 l = toL / dist;
    vec2 rb = boxRange(p, safeInv(l), vec3(-uTank.x, uTank.z, -uTank.y), vec3(uTank.x, uTank.w, uTank.y));
    vec3 e = p + l * rb.y;
    if (e.y < uLevel - 0.005 && (abs(e.x) > uTank.x - 0.003 || abs(e.z) > uTank.y - 0.003)){
      X = uLampCol[i] * lampSpot(i, -l) / max(dist * dist, 0.02) * exp(-(uSigA + uSigS) * rb.y) * uGlassTint * inkT;
      float ws = max3(X) / (max3(E) + max3(X) + 1e-6);
      Ld = normalize(mix(Ld, l, ws));
    }
    gE[i] = E + X; gL[i] = Ld; gK[i] = K; gX[i] = X;
  }
}
void keyWater(vec3 p, vec3 inkT){ keyWaterC(p, inkT, causAt(p)); }

// ---------------- heightfield march ----------------
float traceHF(vec3 ro, vec3 rd, float t0, float t1, float sgn){
  float lip = abs(rd.y) + uMaxSlope * length(rd.xz);
  float t = t0;
  vec3 p = ro + rd*t;
  float f = sgn * (p.y - waterH(p.xz));
  if (f <= 0.0) return t0 + 1e-5;
  float tp = t, fp = f;
  bool last = false;
  for (int i = uZero; i < uHFSteps; i++){
    t += max(fp / lip, 0.002 + t * 0.0012);
    if (t >= t1){ t = t1; last = true; }
    p = ro + rd*t;
    f = sgn * (p.y - waterH(p.xz));
    if (f < 0.0){
      float a = tp, b = t;
      for (int k = 0; k < 8; k++){
        float m = 0.5*(a + b);
        vec3 q = ro + rd*m;
        if (sgn * (q.y - waterH(q.xz)) > 0.0) a = m; else b = m;
      }
      return 0.5*(a + b);
    }
    if (last) break;
    tp = t; fp = f;
  }
  return -1.0;
}

// ---------------- sand bed ----------------
vec2 sUV(vec2 xz){ return (xz - uSandDom.xy) * uSandDom.zw; }
// sand thinner than ~1.5 mm is drawn as a tint on the floor rather than as a surface
float sandR(vec2 xz){ return max(textureLod(tSandR, sUV(xz), 0.0).r - 0.0015, 0.0); }
float traceSand(vec3 ro, vec3 rd, float t0, float t1){
  float lip = abs(rd.y) + 1.1 * length(rd.xz);
  float t = t0;
  vec3 p = ro + rd * t;
  float f = p.y - uTank.z - sandR(p.xz);
  if (f <= 0.0) return t0 + 1e-5;
  float tp = t;
  for (int i = uZero; i < uSandSteps; i++){
    // Lipschitz step, but never slower than what reaches t1 within the remaining budget
    // (grazing rays over a wide bed would otherwise run out of steps and fall through to the floor)
    t += max(max(f / lip, 0.0012 + t * 0.001), (t1 - t) / float(uSandSteps - i));
    bool last = t >= t1;
    if (last) t = t1;
    p = ro + rd * t;
    f = p.y - uTank.z - sandR(p.xz);
    if (f < 0.0){
      float a = tp, b = t;
      for (int k = 0; k < 7; k++){
        float m = 0.5 * (a + b);
        vec3 q = ro + rd * m;
        if (q.y - uTank.z - sandR(q.xz) > 0.0) a = m; else b = m;
      }
      return 0.5 * (a + b);
    }
    if (last) break;
    tp = t;
  }
  return -1.0;
}
// strata colour at height hy above the tank floor in a column of height hcol (rgb, mixed fraction)
vec4 strataLayer(vec2 g, int k){
  vec2 org = vec2(float((k % uSCTx) * uSCDim.x), float((k / uSCTx) * uSCDim.z));
  vec4 c = textureLod(tSandC, (org + g) / vec2(textureSize(tSandC, 0)), 0.0);
  return vec4(c.rgb * c.rgb, c.a);
}
vec4 strataAt(vec2 xz, float hy, float hcol){
  vec2 g = clamp(sUV(xz) * vec2(uSCDim.xz), vec2(0.5), vec2(uSCDim.xz) - 0.5);
  float f = hy / uSandDy - 0.5;
  int k0 = clamp(int(floor(f)), 0, uSCDim.y - 1), k1 = min(k0 + 1, uSCDim.y - 1);
  float w = smoothstep(0.0, 1.0, fract(f));
  if (f < 0.0) w = 0.0;
  if (float(k1) * uSandDy >= hcol - 0.0005) w = 0.0;   // the layer above is still empty
  vec4 a = strataLayer(g, k0);
  return w > 0.0 ? mix(a, strataLayer(g, k1), w) : a;
}
vec3 grainCol(vec4 s, vec3 p, float dist, out float det){
  det = clamp(1.6 - uPixAng * dist / 0.0011, 0.0, 1.0);
  vec3 gc = floor(p / 0.0008);
  float g = hash13(gc);
  vec3 base = s.rgb;
  if (s.a > 0.01){
    int k = min(int(hash13(gc + 17.3) * float(uPalN)), uPalN - 1);
    base = mix(base, mix(uPalAvg, uPal[k], det), s.a);
  }
  // grains up close; below pixel size a fine speckle and centimetre mottling (faded before they alias)
  float fw = uPixAng * dist;
  float mid = clamp(1.6 - fw / 0.005, 0.0, 1.0);
  base *= mix(1.0, 0.7 + 0.6 * g, det * 0.85)
        * (1.0 + (vnoise(p.xz * 190.0 + p.y * 60.0) - 0.5) * 0.3 * mid * (1.0 - det))
        * (0.89 + 0.22 * vnoise(p.xz * 35.0 + p.y * 7.0));
  return base * 0.8;
}
// cross-section (glass walls): the recorded strata
vec3 sandAlb(vec3 p, float hy, float hcol, float dist, out float det){ return grainCol(strataAt(p.xz, hy, hcol), p, dist, det); }
// surface: the column's latest deposit colour
vec3 sandTopAlb(vec3 p, float dist, out float det){ return grainCol(textureLod(tSandT, sUV(p.xz), 0.0), p, dist, det); }
// analytic air stream of falling grains: centre, radius and colour at height y (grains left the
// nozzle tau(y) ago, from where the nozzle was then)
vec2 streamAt(float y, out vec4 sc, out float r){
  float fall = max(uStream.x - y, 0.0);
  float v0 = uStream.w;
  float tau = (sqrt(v0 * v0 + 19.62 * fall) - v0) / 9.81;
  float k = clamp(tau / 0.055, 0.0, 6.999);
  int i = int(k);
  float f = k - float(i);
  vec4 a = uStreamP[i], b = uStreamP[i + 1];
  sc = f < 0.5 ? uStreamC[i] : uStreamC[i + 1];
  r = mix(a.w, b.w, f) * (1.0 + 1.2 * fall);
  return mix(a.xy, b.xy, f);
}
bool streamHit(vec3 ro, vec3 rd, float tmax, out float tHit, out float chord){
  float yb = uStream.y, yt = uStream.x;
  float t0 = 0.0, t1 = tmax;
  if (abs(rd.y) > 1e-6){
    float ta = (yb - ro.y) / rd.y, tb = (yt - ro.y) / rd.y;
    t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
  } else if (ro.y < yb || ro.y > yt) return false;
  if (t0 >= t1) return false;
  vec4 sc; float r;
  float dxz = dot(rd.xz, rd.xz);
  float t = 0.5 * (t0 + t1);
  vec2 c = streamAt(ro.y + rd.y * t, sc, r);
  for (int it = 0; it < 4; it++){
    if (dxz > 1e-6) t = clamp(dot(c - ro.xz, rd.xz) / dxz, t0, t1);
    c = streamAt(ro.y + rd.y * t, sc, r);
  }
  if (r <= 1e-5) return false;
  vec2 q = ro.xz + rd.xz * t - c;
  float d2 = dot(q, q);
  if (d2 >= r * r) return false;
  float hc = sqrt((r * r - d2) / max(dxz, 1e-6));
  tHit = max(t - hc, t0 + 1e-4);
  chord = min(2.0 * hc, 0.3);
  return tHit < tmax && tHit > 1e-4;
}

// ---------------- scene intersection ----------------
Hit traceScene(vec3 ro, vec3 rd, int med){
  Hit h; h.t = 1e9; h.kind = K_SKY; h.id = -1; h.n = vec3(0.0, 1.0, 0.0); h.lp = vec3(0.0); h.zone = 0;
  vec3 inv = safeInv(rd);
  float TX = uTank.x, TZ = uTank.y, BOT = uTank.z, TOP = uTank.w;
  if (med == 0){
    if (rd.y < -1e-6){ float t = -ro.y * inv.y; if (t > 1e-4){ h.t = t; h.kind = K_FLOOR; } }
    for (int a = 0; a < 2; a++){
      for (int s = 0; s < 2; s++){
        float sg = s == 0 ? -1.0 : 1.0;
        float t = a == 0 ? (sg*TX - ro.x) * inv.x : (sg*TZ - ro.z) * inv.z;
        if (t > 1e-4 && t < h.t){
          vec3 p = ro + rd*t;
          bool inR = a == 0 ? abs(p.z) <= TZ : abs(p.x) <= TX;
          if (inR && p.y >= 0.0 && p.y <= TOP){ h.t = t; h.kind = K_WALL; h.n = a == 0 ? vec3(sg, 0.0, 0.0) : vec3(0.0, 0.0, sg); }
        }
      }
    }
    if (uGlassOn > 0.5 && abs(rd.y) > 1e-6){
      float t = (TOP - ro.y) * inv.y;
      if (t > 1e-4 && t < h.t){
        vec3 p = ro + rd*t;
        if (abs(p.x) < TX + uGlassW && abs(p.z) < TZ + uGlassW && !(abs(p.x) < TX && abs(p.z) < TZ)){
          h.t = t; h.kind = K_RIM; h.n = vec3(0.0, rd.y < 0.0 ? 1.0 : -1.0, 0.0);
        }
      }
    }
  } else {
    if (abs(rd.x) > 1e-7){ float sx = rd.x > 0.0 ? 1.0 : -1.0; float t = (sx*TX - ro.x) / rd.x; if (t > 1e-5 && t < h.t){ h.t = t; h.kind = K_WALL; h.n = vec3(sx, 0.0, 0.0); } }
    if (abs(rd.z) > 1e-7){ float sz = rd.z > 0.0 ? 1.0 : -1.0; float t = (sz*TZ - ro.z) / rd.z; if (t > 1e-5 && t < h.t){ h.t = t; h.kind = K_WALL; h.n = vec3(0.0, 0.0, sz); } }
    if (rd.y < -1e-7){ float t = (BOT - ro.y) / rd.y; if (t > 1e-5 && t < h.t){ h.t = t; h.kind = K_BOTTOM; h.n = vec3(0.0, 1.0, 0.0); } }
    if (uSandMax > 0.002){
      float top = BOT + uSandMax;
      float t0 = 0.0, t1 = h.t;
      if (ro.y > top){ t0 = rd.y < -1e-6 ? (top - ro.y) / rd.y : 1e9; }
      else if (rd.y > 1e-6) t1 = min(t1, (top - ro.y) / rd.y);
      if (t0 < t1){
        float ts = traceSand(ro, rd, t0, t1);
        if (ts > 0.0){ h.t = ts; h.kind = K_SAND; h.n = vec3(0.0, 1.0, 0.0); }
      }
    }
  }
  {
    vec2 r = boxRange(ro, inv, vec3(-TX, uLevel - uAmp, -TZ), vec3(TX, uLevel + uAmp, TZ));
    float tn = max(r.x, 0.0), tf = min(r.y, h.t);
    if (tn < tf){
      float t = traceHF(ro, rd, tn, tf, med == 0 ? 1.0 : -1.0);
      if (t > 0.0){ h.t = t; h.kind = K_SURF; }
    }
  }
  {
    float tm = h.t; vec3 n = vec3(0.0); vec3 lp = vec3(0.0);
    int id = nearestObject(ro, rd, tm, n, lp);
    if (id >= 0){ h.t = tm; h.kind = K_OBJ; h.id = id; h.n = n; h.lp = lp; h.zone = gHitZone; gSurfBez = gHitBez; gSurfBezT = gHitBezT; gSurfBezIn = gHitBezIn; }
  }
  {
    int base = med == 1 ? 0 : 128;
    int cnt = med == 1 ? uNumBub : uNumDrop;
    vec2 r = boxRange(ro, inv, med == 1 ? uBubMin : uDropMin, med == 1 ? uBubMax : uDropMax);
    if (cnt > 0 && r.x < r.y && r.y > 0.0 && r.x < h.t){
      for (int i = uZero; i < cnt; i++){
        vec4 s = texelFetch(tSph, ivec2(base + i, 0), 0);
        vec3 oc = ro - s.xyz;
        float b = dot(oc, rd), c = dot(oc, oc) - s.w*s.w, dd = b*b - c;
        if (dd > 0.0){
          float t = -b - sqrt(dd);
          if (t > 1e-4 && t < h.t){ h.t = t; h.kind = med == 1 ? K_BUB : K_DROP; h.id = base + i; h.n = normalize(oc + rd*t); }
        }
      }
    }
  }
  if (med == 0 && uStreamOn == 1){
    float ts, ch;
    if (streamHit(ro, rd, h.t, ts, ch)){ h.t = ts; h.kind = K_STREAM; h.id = -1; h.n = vec3(0.0, 1.0, 0.0); h.lp = vec3(ch, 0.0, 0.0); }
  }
  return h;
}

// ---------------- materials ----------------
vec3 brdfSun(vec3 n, vec3 v, vec3 l, vec3 alb, float rough, float metal){
  float ndl = dot(n, l);
  if (ndl <= 0.0) return vec3(0.0);
  vec3 hv = normalize(l + v);
  float ndv = max(dot(n, v), 1e-3), ndh = max(dot(n, hv), 0.0), vdh = max(dot(v, hv), 0.0);
  float a = max(rough*rough, 0.0025), a2 = a*a;
  float dn = ndh*ndh*(a2 - 1.0) + 1.0;
  float D = a2 / (PI * dn * dn);
  float k = a * 0.5;
  float G = (ndl / (ndl*(1.0 - k) + k)) * (ndv / (ndv*(1.0 - k) + k));
  vec3 F0 = mix(vec3(0.04), alb, metal);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vdh, 5.0);
  vec3 spec = D * G * F / (4.0 * ndv * ndl);
  vec3 kd = (1.0 - F) * (1.0 - metal);
  return (kd * alb / PI + spec) * ndl;
}
vec3 glossy(vec3 r, vec3 n, float rough){
  if (rough < 0.02) return r;
  vec3 j = vec3(rnd(), rnd(), rnd()) * 2.0 - 1.0;
  vec3 d = normalize(r + j * rough * rough * 1.2);
  if (dot(d, n) < 0.0) d = reflect(d, n);
  return d;
}
vec3 floorAlb(vec2 xz, float dist, out float rough){
  float fw = max(uPixAng * dist * 1.5, 0.002);
  vec2 cell = floor(xz);
  float chk = mod(cell.x + cell.y, 2.0);
  vec2 f = abs(fract(xz) - 0.5);
  float major = 1.0 - smoothstep(0.492 - fw, 0.497, max(f.x, f.y));
  vec2 g = abs(fract(xz * 10.0) - 0.5);
  float minor = 1.0 - smoothstep(0.47 - fw*10.0, 0.49, max(g.x, g.y));
  float fade = clamp(1.0 - fw * 18.0, 0.0, 1.0);
  float base = mix(0.062, 0.078, chk);
  float n = vnoise(xz * 3.1) * 0.5 + vnoise(xz * 17.0) * 0.5;
  base *= 0.92 + 0.16 * n;
  base = mix(base, 0.13, (1.0 - major) * 0.8);
  base = mix(base, base * 1.18, (1.0 - minor) * 0.35 * fade);
  rough = 0.34 + 0.2 * n;
  return vec3(base) * vec3(0.98, 1.0, 1.02);
}
vec3 bottomAlb(vec2 xz, inout vec3 n, float dist){
  if (uBottomType < 0.5){
    float w = vnoise(xz * 1.7) * 2.6;
    float ph = dot(xz, vec2(0.83, 0.55)) * 26.0 + w * 3.0;
    float r = sin(ph) * 0.5 + 0.5;
    float g1 = vnoise(xz * 180.0), g2 = vnoise(xz * 45.0);
    float amp = 0.06 * clamp(1.0 - uPixAng * dist * 40.0, 0.0, 1.0);
    vec2 dir = vec2(0.83, 0.55) * cos(ph) * amp;
    n = normalize(vec3(-dir.x + (g1 - 0.5)*0.05, 1.0, -dir.y + (g2 - 0.5)*0.05));
    vec3 c = mix(vec3(0.44, 0.40, 0.32), vec3(0.64, 0.59, 0.48), r*0.5 + g2*0.35 + g1*0.15);
    float peb = smoothstep(0.78, 0.86, vnoise(xz * 9.0));
    return mix(c, c * vec3(0.55, 0.52, 0.5), peb * 0.6);
  } else if (uBottomType < 1.5){
    float fw = max(uPixAng * dist * 1.5, 0.0015);
    vec2 t = xz / 0.16;
    vec2 f = abs(fract(t) - 0.5) * 0.16;
    float grout = 1.0 - smoothstep(0.0035, 0.0035 + fw, min(0.08 - f.x, 0.08 - f.y));
    float tv = hash12(floor(t)) * 0.06;
    vec3 c = mix(vec3(0.80, 0.87, 0.90) - tv, vec3(0.30, 0.36, 0.40), grout);
    return c;
  }
  float fw = max(uPixAng * dist * 1.5, 0.002);
  vec2 cell = floor(xz * 2.0);
  return vec3(mix(0.16, 0.26, mod(cell.x + cell.y, 2.0)));
}
vec3 woodAlb(vec3 lp, vec3 base, float seed){
  float ring = length(lp.xy + vec2(seed * 3.1, 0.7)) * 38.0 + vnoise3(lp * 7.0) * 6.0;
  float grain = vnoise(vec2(lp.z * 4.0, lp.y * 90.0 + lp.x * 90.0));
  float band = 0.5 + 0.5 * sin(ring);
  vec3 c = base * (0.72 + 0.28 * band) * (0.85 + 0.3 * grain);
  vec3 q = abs(lp);
  float plank = smoothstep(0.004, 0.0, abs(fract(lp.y * 6.0 + 0.5) - 0.5) - 0.47);
  return c * (1.0 - 0.45 * plank);
}
vec3 stoneAlb(vec3 lp, vec3 base, float seed){
  float n = vnoise3(lp * 9.0 + seed) * 0.6 + vnoise3(lp * 31.0) * 0.3 + vnoise3(lp * 90.0) * 0.1;
  return base * (0.65 + 0.6 * n);
}
vec3 ballAlb(vec3 lp){
  float a = atan(lp.z, lp.x);
  float seg = floor((a / (2.0*PI) + 0.5) * 6.0);
  vec3 cols[3] = vec3[3](vec3(0.85, 0.08, 0.06), vec3(0.95, 0.72, 0.05), vec3(0.06, 0.28, 0.80));
  vec3 c = mod(seg, 2.0) < 0.5 ? cols[int(mod(seg * 0.5, 3.0))] : vec3(0.92);
  float cap = smoothstep(0.84, 0.86, abs(normalize(lp).y));
  return mix(c, vec3(0.93), cap);
}
vec3 ringAlb(vec3 lp){
  float a = atan(lp.z, lp.x);
  float seg = floor((a / (2.0*PI) + 0.5) * 8.0);
  return mod(seg, 2.0) < 0.5 ? vec3(0.90, 0.22, 0.06) : vec3(0.92, 0.91, 0.88);
}

// ---------------- table-built models: surface materials ----------------
// kind: 0 opaque, 1 thin translucent membrane, 2 thin glass shell, 3 jelly volume, 4 emissive
float band(float x, float c, float w){ return 1.0 - smoothstep(w, w + 0.004, abs(x - c)); }
float cells(vec3 q, float f, out vec3 cc){ vec3 c = floor(q * f); vec3 h = hash33(c); cc = (c + 0.2 + 0.6 * h) / f; return h.x; }
float seg2d(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
void fishPattern(int mid, int zone, vec3 q, float nz, out vec3 alb, out float alpha){
  float belly = smoothstep(0.02, -0.16, q.y);
  bool paired = abs(q.z) > 0.012;   // pectoral / pelvic fins stand off the midplane
  if (mid == 10){   // clownfish: orange, three white bands edged in black
    vec3 org = vec3(0.95, 0.22, 0.012);
    float y2 = q.y * q.y;
    float c1 = 0.19 + 1.3 * y2, c2 = -0.03 + 0.07 * (1.0 - y2 / 0.029), c3 = -0.3;
    float w1 = band(q.x, c1, 0.027), w2 = band(q.x, c2, 0.034), w3 = band(q.x, c3, 0.02);
    float k1 = band(q.x, c1, 0.035) - w1, k2 = band(q.x, c2, 0.042) - w2, k3 = band(q.x, c3, 0.028) - w3;
    float white = max(w1, max(w2, w3)), black = max(k1, max(k2, k3));
    alb = mix(mix(org, vec3(0.88, 0.87, 0.84), white), vec3(0.012), black);
    alpha = 1.0;
    if (zone == 1){
      // median fins orange with thin black margins (elliptical radius within the fin under the point);
      // paired fins plain orange
      float r = min(min(length((q.xy - vec2(-0.52, 0.0)) / vec2(0.12, 0.15)), length((q.xy - vec2(-0.02, 0.165)) / vec2(0.22, 0.07))),
                    min(length((q.xy - vec2(-0.2, 0.17)) / vec2(0.13, 0.085)), length((q.xy - vec2(-0.18, -0.155)) / vec2(0.12, 0.07))));
      float med = paired ? 0.0 : 1.0;
      alb = mix(org * 0.95, vec3(0.012), smoothstep(0.8, 0.86, r) * med);
      alb = mix(alb, vec3(0.85, 0.84, 0.8), smoothstep(0.965, 0.99, r) * med * 0.6);
      alpha = paired ? 0.7 : 0.88;
    }
  } else if (mid == 11){   // regal blue tang: royal blue, black "palette" loop, yellow tail wedge
    vec3 blu = vec3(0.015, 0.1, 0.64), blk = vec3(0.006, 0.008, 0.028);
    float rO = length((q.xy - vec2(-0.06, 0.05)) / vec2(0.3, 0.155));
    float rI = length((q.xy - vec2(-0.03, 0.088)) / vec2(0.165, 0.066));
    float pal = (1.0 - smoothstep(0.97, 1.0, rO)) * smoothstep(0.97, 1.0, rI);
    pal = max(pal, 1.0 - smoothstep(0.024, 0.03, seg2d(q.xy, vec2(0.3, 0.055), vec2(0.13, 0.1))));    // from the eye
    pal = max(pal, 1.0 - smoothstep(0.02, 0.028, seg2d(q.xy, vec2(-0.3, 0.035), vec2(-0.43, 0.0))));  // to the tail
    alb = mix(blu, blk, pal);
    float tail = smoothstep(-0.4, -0.44, q.x);
    float wedge = 1.0 - smoothstep(-0.005, 0.005, abs(q.y) - (0.025 + 0.8 * max(-q.x - 0.43, 0.0)));
    alb = mix(alb, mix(blk, vec3(0.98, 0.74, 0.02), wedge), tail);
    alpha = 1.0;
    if (zone == 1){
      if (q.x < -0.42) alpha = 0.95;
      else if (paired){ alb = mix(vec3(0.03, 0.14, 0.6), vec3(0.96, 0.72, 0.06), smoothstep(0.13, 0.09, q.x)); alpha = 0.72; }
      else {
        float r = min(length((q.xy - vec2(-0.02, 0.1)) / vec2(0.34, 0.17)), length((q.xy - vec2(-0.1, -0.08)) / vec2(0.27, 0.19)));
        alb = mix(blu * 0.85, blk, smoothstep(0.9, 0.94, r));
        alb = mix(alb, vec3(0.25, 0.55, 1.0), band(r, 0.86, 0.012) * 0.5);
        alpha = 0.92;
      }
    }
  } else {   // yellow tang: lemon yellow all over, the white caudal spine by the tail
    alb = vec3(1.0, 0.64, 0.0);
    alb = mix(alb, vec3(0.92, 0.9, 0.85), 1.0 - smoothstep(0.01, 0.016, length((q.xy - vec2(-0.335, 0.005)) * vec2(0.6, 1.0))));
    alpha = 1.0;
    if (zone == 1){ alb = paired ? vec3(0.98, 0.7, 0.1) : vec3(1.0, 0.66, 0.02); alpha = paired ? 0.6 : 0.88; }
  }
  if (zone == 0){
    alb = mix(alb, alb * 0.55 + vec3(0.35), belly * 0.35);
    // gill cover edge (tangs) and the mouth line at the snout
    if (mid != 10){
      float op = abs(length((q.xy - vec2(0.34, 0.03)) / vec2(0.13, 0.17)) - 1.0);
      alb *= 1.0 - 0.3 * (1.0 - smoothstep(0.015, 0.04, op)) * step(q.x, 0.3) * step(abs(q.y - 0.03), 0.13);
    }
    float tipX = mid == 10 ? 0.4 : mid == 11 ? 0.39 : 0.4, my = mid == 10 ? -0.03 : mid == 11 ? -0.02 : 0.052;
    alb = mix(alb, vec3(0.03, 0.01, 0.01), (1.0 - smoothstep(0.003, 0.006, abs(q.y - my))) * smoothstep(tipX - 0.05, tipX - 0.025, q.x) * 0.85);
  }
}
void modelSurface(int mid, int zone, vec3 q, vec3 nl, vec4 m7, float seed,
                  out vec3 alb, out float rough, out float metal, out int kind, out float alpha, out vec3 bump){
  alb = vec3(0.5); rough = 0.5; metal = 0.0; kind = 0; alpha = 1.0; bump = vec3(0.0);
  float n1 = vnoise3(q * 23.0 + seed), n2 = vnoise3(q * 71.0 + seed * 1.7);
  if (mid == 0){   // rubber duck
    if (zone == 1){ alb = vec3(0.95, 0.2, 0.01); rough = 0.3; }
    else if (zone == 2){
      vec3 c = vec3(0.41, 0.9, sign(q.z) * 0.15);
      float pup = length(q - c - vec3(0.03, 0.006, sign(q.z) * 0.022));
      alb = pup < 0.032 ? vec3(0.006) : vec3(0.82); rough = 0.1;
    } else { alb = vec3(0.92, 0.6, 0.012) * (0.96 + 0.08 * n1); rough = 0.3; }
  } else if (mid == 1){   // pirate ship
    if (zone == 5){ alb = vec3(0.74, 0.62, 0.44) * (0.85 + 0.2 * n1) * (1.0 - 0.22 * band(fract(q.z * 14.0), 0.5, 0.04)); rough = 0.9; kind = 1; alpha = 0.9; }
    else if (zone == 6){
      vec2 f = vec2(q.x + 0.045, q.y - 1.045);
      float skull = 1.0 - smoothstep(0.009, 0.011, length((f - vec2(0.0, 0.006)) / vec2(1.0, 1.15)));
      float bones = max(1.0 - smoothstep(0.0022, 0.0035, abs(f.x - f.y * 1.3)), 1.0 - smoothstep(0.0022, 0.0035, abs(f.x + f.y * 1.3)));
      bones *= step(length(f), 0.024);
      float eyes = 1.0 - smoothstep(0.0022, 0.003, min(length(f - vec2(-0.0035, 0.008)), length(f - vec2(0.0035, 0.008))));
      alb = mix(vec3(0.012), vec3(0.85), clamp(max(skull, bones) - eyes, 0.0, 1.0)); rough = 0.85; kind = 1; alpha = 0.95;
    }
    else if (zone == 4){ alb = vec3(0.16, 0.085, 0.04) * (0.8 + 0.3 * n2); rough = 0.65; }
    else if (zone == 1){ alb = vec3(0.4, 0.26, 0.13) * (0.85 + 0.25 * vnoise(q.xz * vec2(12.0, 60.0))) * (1.0 - 0.3 * band(fract(q.z * 40.0), 0.5, 0.05)); rough = 0.7; }
    else {
      float plank = band(fract(q.y * 38.0), 0.5, 0.06);
      alb = vec3(0.2, 0.1, 0.045) * (0.8 + 0.35 * vnoise(vec2(q.x * 9.0, q.y * 90.0) + seed)) * (1.0 - 0.35 * plank);
      alb = mix(alb, vec3(0.75, 0.5, 0.1), band(q.y, 0.1, 0.009));                            // gilded rail
      alb = mix(alb, vec3(0.07, 0.05, 0.035), smoothstep(-0.015, -0.035, q.y));               // tarred bottom
      vec2 port = vec2(fract(q.x * 12.5) - 0.5, (q.y - 0.045) * 12.5);
      if (abs(q.x) < 0.32 && max(abs(port.x), abs(port.y)) < 0.22) alb = vec3(0.01);          // gun ports
      if (q.x < -0.3 && q.y > 0.13 && q.y < 0.21 && abs(nl.x) > 0.6){                        // stern windows
        vec2 w = vec2(fract(q.z * 20.0) - 0.5, fract((q.y - 0.13) * 25.0) - 0.5);
        if (max(abs(w.x), abs(w.y)) < 0.3) alb = vec3(0.55, 0.42, 0.12);
      }
      rough = 0.6;
    }
  } else if (mid == 2){   // toy battleship
    vec3 grey = vec3(0.32, 0.34, 0.35) * (0.94 + 0.1 * n1);
    if (zone == 4){ alb = vec3(0.09); rough = 0.35; metal = 0.4; }
    else if (zone == 5){ alb = vec3(0.12); rough = 0.5; }
    else if (zone == 3){ alb = q.y > 0.25 ? vec3(0.02) : grey; rough = 0.5; }
    else if (zone == 2){ alb = grey * 1.12; rough = 0.5; }
    else {   // (hull keel at y = -0.035, deck at 0.105)
      if (nl.y > 0.7 && q.y > 0.1){ alb = vec3(0.3, 0.21, 0.13) * (0.85 + 0.25 * vnoise(vec2(q.x * 6.0, q.z * 120.0))); rough = 0.65; }
      else {
        alb = grey;
        alb = mix(alb, vec3(0.012), band(q.y, 0.015, 0.005));
        alb = mix(alb, vec3(0.32, 0.03, 0.02), smoothstep(0.012, 0.008, q.y));
        if (abs(q.y - 0.073) < 0.004 && fract(q.x * 36.0) < 0.3 && abs(q.x) < 0.4) alb = vec3(0.01);
        rough = 0.45;
      }
    }
  } else if (mid == 3){   // message in a bottle
    if (zone == 0){ alb = vec3(0.46, 0.8, 0.52); rough = 0.03; kind = 2; }
    else if (zone == 1){ alb = vec3(0.52, 0.36, 0.19) * (0.7 + 0.5 * n2); rough = 0.95; }
    else if (zone == 2){ alb = vec3(0.82, 0.74, 0.55) * (0.9 + 0.12 * n1) * (1.0 - 0.35 * band(fract(q.y * 700.0), 0.5, 0.05) * step(0.01, abs(q.z))); rough = 0.9; }
    else { alb = vec3(0.55, 0.02, 0.015); rough = 0.6; }
  } else if (mid == 4){   // treasure chest
    if (zone == 1){ alb = mix(vec3(0.8, 0.56, 0.26), vec3(0.3, 0.3, 0.18), smoothstep(0.55, 0.8, n1)); metal = 1.0 - smoothstep(0.55, 0.8, n1); rough = 0.35 + 0.3 * n2; }
    else if (zone == 2){ alb = vec3(1.0, 0.77, 0.34); metal = 1.0; rough = 0.2; }
    else if (zone == 3){ alb = vec3(0.005); rough = 0.8; }
    else { float pl = band(fract(q.y * 26.0 + 0.5), 0.5, 0.05); alb = vec3(0.32, 0.16, 0.07) * (0.72 + 0.45 * vnoise(vec2(q.x * 10.0, q.y * 120.0) + q.z * 30.0)) * (1.0 - 0.45 * pl); rough = 0.75; }
  } else if (mid == 5){   // anchor: wrought iron with rust
    float rust = smoothstep(0.45, 0.75, n1 * 0.7 + n2 * 0.5);
    alb = mix(vec3(0.07, 0.068, 0.066), vec3(0.32, 0.11, 0.035) * (0.7 + 0.5 * n2), rust);
    metal = 0.8 * (1.0 - rust); rough = mix(0.5, 0.95, rust);
    bump = (hash33(floor(q * 400.0)) - 0.5) * 0.25 * rust;
  } else if (mid == 6){   // amphora: terracotta, painted bands, sea growth
    if (zone == 1){ alb = vec3(0.03, 0.015, 0.01); rough = 0.9; }
    else {
      alb = vec3(0.5, 0.2, 0.085) * (0.85 + 0.25 * n1);
      float paint = max(band(q.y, 0.1, 0.008), band(q.y, 0.125, 0.004));
      paint = max(paint, band(q.y, 0.075 + 0.006 * sin(atan(q.z, q.x) * 10.0), 0.0035));
      alb = mix(alb, vec3(0.03, 0.02, 0.015), paint);
      float crust = smoothstep(0.68, 0.76, vnoise3(q * 55.0 + 7.0)) * smoothstep(0.15, -0.1, q.y);
      alb = mix(alb, vec3(0.75, 0.72, 0.62), crust);
      rough = 0.85; bump = (hash33(floor(q * 300.0)) - 0.5) * 0.3 * crust;
    }
  } else if (mid == 7){   // diver's helmet: brass with verdigris, copper breastplate, dark glass
    // verdigris only in patches and toward the lower rim; the rest tarnished brass / copper
    float pat = smoothstep(0.7, 0.92, n1 * 0.55 + n2 * 0.45 + 0.25 * smoothstep(0.0, -0.15, q.y));
    float tarn = smoothstep(0.3, 0.8, vnoise3(q * 9.0 + seed));
    if (zone == 2){ alb = vec3(0.02, 0.025, 0.03); rough = 0.04; }
    else {
      vec3 metalC = zone == 1 ? vec3(0.9, 0.5, 0.32) : vec3(0.92, 0.68, 0.32);
      metalC *= 1.0 - 0.35 * tarn;
      alb = mix(metalC, vec3(0.2, 0.44, 0.35) * (0.8 + 0.3 * n2), pat); metal = 1.0 - pat; rough = mix(0.3 + 0.2 * tarn, 0.85, pat);
    }
  } else if (mid >= 10 && mid <= 12){   // tropical fish
    if (zone == 2){
      int sp = mid;
      vec3 c = sp == 10 ? vec3(0.29, 0.04, sign(q.z) * 0.062) : sp == 11 ? vec3(0.3, 0.05, sign(q.z) * 0.05) : vec3(0.2, 0.1, sign(q.z) * 0.05);
      vec3 o = normalize(q - c);
      float out_ = abs(o.z);
      vec3 iris = sp == 10 ? vec3(0.85, 0.45, 0.04) : sp == 11 ? vec3(0.3, 0.26, 0.08) : vec3(0.65, 0.48, 0.03);
      alb = mix(iris * 0.45, iris, smoothstep(0.55, 0.62, out_));
      alb = mix(alb, vec3(0.003), smoothstep(0.84, 0.87, out_));
      rough = 0.04;
    } else {
      float a; fishPattern(mid, zone, q, nl.z, alb, a);
      alpha = a; rough = zone == 1 ? 0.45 : 0.24;
      if (zone == 1) kind = 1;
      else {   // scales: a faint lattice in the relief and the colour
        vec2 sq = vec2(q.x * 90.0, q.y * 90.0 + 0.5 * floor(q.x * 90.0));
        vec2 f = fract(sq) - 0.5;
        float sc = smoothstep(0.35, 0.5, length(f));
        alb *= 1.0 - 0.07 * sc;
        bump = vec3(f.x, f.y, 0.0) * 0.12;
      }
    }
  } else if (mid == 14){   // octopus: mottled, papillose skin; two rows of suckers under the arms; golden eyes
    vec3 base = mix(vec3(0.56, 0.13, 0.05), vec3(0.68, 0.36, 0.18), m7.x * 0.7);   // m7.x: camouflage state
    base = mix(base, vec3(0.27, 0.04, 0.02), m7.z);                        // m7.z: dark flush while jetting
    float blot = smoothstep(0.35, 0.8, vnoise3(q * 17.0 + seed));
    vec3 cc; float hc = cells(q, 150.0, cc);
    float chrom = (1.0 - smoothstep(0.12, 0.3, length(q - cc) * 150.0)) * step(0.3, hc);   // chromatophores
    vec3 cp; float hp = cells(q, 62.0, cp);
    float pap = 1.0 - smoothstep(0.08, 0.42, length(q - cp) * 62.0);                       // papillae
    alb = base * (0.72 + 0.5 * n1) * (1.0 - 0.38 * blot);
    alb = mix(alb, alb * 0.42, chrom * 0.75);
    alb = mix(alb, vec3(0.8, 0.66, 0.56), pap * step(0.88, hp) * 0.5);
    alb = mix(alb, vec3(0.8, 0.62, 0.52), smoothstep(-0.35, -0.85, nl.y) * 0.45);           // paler underneath
    rough = 0.36;
    bump = (q - cp) * 62.0 * pap * 0.4 + (vec3(vnoise3(q * 210.0), vnoise3(q * 210.0 + 5.0), vnoise3(q * 210.0 + 9.0)) - 0.5) * 0.32;
    if (zone == 1){
      // eye: golden iris with a horizontal bar pupil, looking out and a little up and forward
      float sz = sign(q.z);
      vec3 o = normalize(q - vec3(0.018, 0.052, sz * 0.037));
      vec3 lk = normalize(vec3(0.25, 0.3, sz)), up = normalize(vec3(0.0, 1.0, 0.0) - lk * lk.y), rt = cross(up, lk);
      float fz = dot(o, lk), fy = dot(o, up), fx = dot(o, rt);
      float iris = smoothstep(0.42, 0.52, fz);
      float pupil = (1.0 - smoothstep(0.07, 0.1, abs(fy) - 0.04 * fx * fx)) * (1.0 - smoothstep(0.34, 0.4, abs(fx))) * step(0.5, fz);
      vec3 gold = vec3(0.72, 0.32, 0.05) * (0.7 + 0.45 * vnoise(vec2(atan(fy, fx) * 7.0, fz * 18.0)));
      alb = mix(alb, gold, iris);
      alb = mix(alb, vec3(0.006), pupil);
      rough = mix(rough, 0.05, iris); bump *= 1.0 - iris;
    } else if (zone >= 2){
      // suckers in two alternating rows along the arm's oral side - it faces the bed toward the base
      // and turns to the inside of the curl toward the tip. gSurfBez.x runs along the arm in sucker
      // spacings (2.3 arm radii); the angle around the arm is measured from the oral midline.
      vec3 T = gSurfBezT, sd = vec3(0.0, -1.0, 0.0);
      float il = length(gSurfBezIn);
      if (zone == 3 && il > 1e-6) sd = normalize(mix(sd, gSurfBezIn / il, 0.75));
      sd -= T * dot(sd, T);
      float sl = length(sd);
      if (sl > 1e-3){
        sd /= sl;
        float ang = atan(dot(nl, cross(T, sd)), dot(nl, sd));
        float u = gSurfBez.x;
        vec2 va = vec2((fract(u) - 0.5) * 2.3, ang + 0.44), vb = vec2((fract(u + 0.5) - 0.5) * 2.3, ang - 0.44);
        vec2 vs = dot(va, va) < dot(vb, vb) ? va : vb;
        float ds = length(vs);
        float cup = 1.0 - smoothstep(0.5, 0.58, ds);
        float rim = smoothstep(0.2, 0.38, ds) * cup;
        float oral = smoothstep(1.25, 0.8, abs(ang));
        alb = mix(alb, vec3(0.84, 0.7, 0.62), oral * 0.55);
        alb = mix(alb, mix(vec3(0.6, 0.38, 0.33), vec3(0.95, 0.87, 0.8), rim), cup);
        rough = mix(rough, 0.26, max(cup, oral * 0.5));
        // a cup: the normal leans in toward the centre inside the rim and out on the rim's outer slope
        vec3 radial = (T * vs.x + cross(T, sd) * vs.y) / max(ds, 1e-4);
        float lean = ds < 0.42 ? -0.6 * smoothstep(0.0, 0.42, ds) : 0.8 * smoothstep(0.58, 0.42, ds);
        bump = mix(bump * (1.0 - oral), radial * lean, cup);
      }
    }
  } else if (mid == 15){   // crab: brick-red granular shell, pale underside, dark leg tips, black claw tips
    vec3 cg; float hg = cells(q, 420.0, cg);
    float gr = 1.0 - smoothstep(0.15, 0.45, length(q - cg) * 420.0);   // granules
    float blot = smoothstep(0.4, 0.75, vnoise3(q * 38.0 + seed));
    vec3 shell = mix(vec3(0.78, 0.15, 0.05), vec3(0.42, 0.055, 0.03), blot) * (0.88 + 0.22 * n2);
    rough = 0.3;
    if (zone == 2){ alb = vec3(0.012, 0.01, 0.01); rough = 0.05; }
    else if (zone == 3){ alb = vec3(0.86, 0.74, 0.58) * (0.9 + 0.15 * n1); rough = 0.45; bump = (q - cg) * 420.0 * gr * 0.1; }
    else if (zone == 7){ alb = vec3(0.015, 0.012, 0.012); rough = 0.18; }
    else if (zone == 6){ alb = mix(vec3(0.52, 0.13, 0.05), vec3(0.07, 0.03, 0.02), smoothstep(-0.022, -0.036, q.y)) * (0.9 + 0.2 * n2); rough = 0.28; }
    else {
      alb = mix(shell, vec3(0.9, 0.55, 0.36), gr * step(0.55, hg) * 0.35);
      bump = (q - cg) * 420.0 * gr * 0.25;
      if (zone == 0){
        // the cervical groove across the carapace and the darker front margin
        float cerv = abs(q.x + 0.004 - 4.0 * q.z * q.z);
        alb *= 1.0 - 0.35 * (1.0 - smoothstep(0.001, 0.0028, cerv)) * step(abs(q.z), 0.032) * step(0.004, q.y);
        alb = mix(alb, alb * 0.6, smoothstep(0.028, 0.05, q.x) * 0.6);
      } else alb = mix(alb, vec3(0.85, 0.48, 0.3), smoothstep(-0.1, -0.7, nl.y) * 0.4);   // limbs: paler beneath
      if (zone == 5) alb = mix(alb, vec3(0.8, 0.45, 0.25), 0.2);
    }
  } else if (mid == 16){   // laser module
    if (zone == 2) kind = 4;
    else if (zone == 1){ alb = vec3(0.82, 0.83, 0.85); metal = 1.0; rough = 0.14; }
    else if (zone == 3){ alb = vec3(0.1, 0.1, 0.11); rough = 0.5; metal = 0.3; }
    else { alb = vec3(0.03, 0.03, 0.035) * (0.9 + 0.2 * n2); rough = 0.34; metal = 0.25; }
  } else if (mid == 13){   // jellyfish: drawn as a volume
    kind = 3;
  }
}

// sun visibility for points in air: objects + light transmitted through the tank
float sunVisAir(vec3 p, vec3 L, float maxD, out vec3 tint){
  tint = vec3(1.0);
  float tm = maxD; vec3 nn = vec3(0.0); vec3 ll = vec3(0.0);
  gOpaqueOnly = true;
  int oc = nearestObject(p, L, tm, nn, ll);
  gOpaqueOnly = false;
  if (oc >= 0) return 0.0;
  float G = uGlassW;
  vec2 r = boxRange(p, safeInv(L), vec3(-uTank.x - G, 0.0, -uTank.y - G), vec3(uTank.x + G, uTank.w, uTank.y + G));
  r.y = min(r.y, maxD);
  if (r.x < r.y && r.y > 0.0){
    float tn = max(r.x, 0.0);
    vec3 a = p + L*tn;
    vec3 sigT = uSigA + uSigS;
    if (a.y < uLevel){
      float tl = (uLevel - p.y) / max(L.y, 1e-4);
      if (tl < r.y) { tint = exp(-sigT * (tl - tn)) * vec3(0.10, 0.16, 0.20); }
      else { tint = exp(-sigT * (r.y - tn)) * mix(vec3(1.0), uGlassTint * uGlassTint, uGlassOn) * 0.9; }
    } else {
      tint = mix(vec3(1.0), uGlassTint * uGlassTint, uGlassOn);
    }
  }
  return 1.0;
}
void keyAir(vec3 p, vec3 Lsun){
  gNL = uLampMode == 0 ? 1 : clamp(uNumLamps, 1, 3);
  for (int i = 0; i < gNL; i++){
    vec3 L = Lsun, I = uSunCol;
    float maxD = 80.0;
    if (uLampMode == 1){
      vec3 d = gLampP[i] - p;
      float dist = length(d);
      L = d / max(dist, 1e-4);
      I = uLampCol[i] * lampSpot(i, -L) / max(dist * dist, 0.02);
      maxD = dist - 0.05;
    }
    gL[i] = L; gE[i] = vec3(0.0);
    if (max3(I) <= 0.0) continue;
    vec3 tint;
    float vis = sunVisAir(p, L, maxD, tint);
    gE[i] = I * vis * tint;
  }
}
vec3 directLight(vec3 n, vec3 v, vec3 alb, float rough, float metal){
  vec3 s = vec3(0.0);
  for (int i = 0; i < gNL; i++) s += brdfSun(n, v, gL[i], alb, rough, metal) * gE[i];
  return s;
}
vec3 diffuseLight(vec3 n){
  vec3 s = vec3(0.0);
  for (int i = 0; i < gNL; i++) s += gE[i] * max(dot(n, gL[i]), 0.0);
  return s;
}
vec3 totalLight(){
  vec3 s = vec3(0.0);
  for (int i = 0; i < gNL; i++) s += gE[i];
  return s;
}
float objAO(vec3 p, vec3 n, int self){
  float occ = 0.0;
  for (int i = uZero; i < uNumAO; i++){
    if (i == self) continue;
    vec4 s = texelFetch(tObj, ivec2(0, i), 0);
    vec3 d = s.xyz - p;
    float l2 = dot(d, d), r = s.w * 0.85;
    float l = sqrt(l2);
    occ += max(dot(n, d / l), 0.0) * clamp(r*r / l2, 0.0, 1.0);
  }
  return clamp(1.0 - occ * 0.8, 0.0, 1.0);
}

// ---------------- laser beam: scattered light from thin segments, and the spots it makes ----------------
// radiance picked up by a camera segment [ro, ro + rd*tEnd] crossing a Gaussian beam of width w:
//   sigma_s * phase * P * exp(-d^2 / w^2) / (sqrt(pi) * w * sin(theta))
vec3 laserGlow(vec3 ro, vec3 rd, float tEnd, int med, float path){
  vec3 acc = vec3(0.0);
  for (int i = uZero; i < uLzN; i++){
    vec4 A = texelFetch(tLz, ivec2(i, 0), 0), B = texelFetch(tLz, ivec2(i, 1), 0);
    if (int(B.w + 0.5) != med) continue;
    vec3 u = B.xyz - A.xyz;
    float Lb = length(u);
    if (Lb < 1e-4) continue;
    vec3 bd = u / Lb, w0 = ro - A.xyz;
    float b = dot(rd, bd), d = dot(rd, w0), e = dot(bd, w0);
    float den = max(1.0 - b * b, 1e-4);
    float t = clamp((b * e - d) / den, 0.0, tEnd);
    float q = clamp(dot(ro + rd * t - A.xyz, bd), 0.0, Lb);
    t = clamp(dot(A.xyz + bd * q - ro, rd), 0.0, tEnd);
    vec3 dv = ro + rd * t - A.xyz - bd * q;
    float w = max(uLzW, uPixAng * (path + t) * 1.3), dd = dot(dv, dv), sd = 1.7725 * sqrt(max(den, 0.0025));
    float g = exp(-dd / (w * w)) / (sd * w);
    if (med == 1){
      // light scattered more than once by the haze spreads into a soft glow that widens along the beam
      float wh = max(0.006 + 0.022 * q, 2.0 * w);
      g = mix(g, exp(-dd / (wh * wh)) / (sd * wh), uLzHalo);
    }
    float sig = med == 1 ? uLzSigW : uLzHaze;
    float ph = 0.35 / PI + 0.8 * hg(dot(bd, -rd), 0.7);
    float att = med == 1 ? exp(-uLzExt * (t + q)) : 1.0;
    acc += A.w * sig * ph * g * att;
  }
  return acc * uLzCol;
}
vec3 laserSpots(vec3 p, float path){
  vec3 acc = vec3(0.0);
  float w = max(0.0022, uPixAng * path * 1.3);
  for (int i = uZero; i < uLzSpotN; i++){
    vec4 S = texelFetch(tLz, ivec2(i, 2), 0);
    vec3 d = p - S.xyz;
    acc += S.w * exp(-dot(d, d) / (w * w)) / (PI * w * w);
  }
  return acc * uLzCol;
}

// ---------------- water volume: in-scattering + particulate ----------------
vec3 particles(vec3 ro, vec3 rd, float tmax, float path0){
  if (uPartDensity <= 0.0) return vec3(0.0);
  float cs = uPartCell;
  vec3 o = (ro - uPMin) / cs;
  float tEnd = tmax / cs;
  vec3 cell = floor(o);
  vec3 st = vec3(rd.x >= 0.0 ? 1.0 : -1.0, rd.y >= 0.0 ? 1.0 : -1.0, rd.z >= 0.0 ? 1.0 : -1.0);
  vec3 tD = 1.0 / max(abs(rd), vec3(1e-6));
  vec3 tM = (cell + max(st, 0.0) - o) * st * tD;
  vec3 sigT = uSigA + uSigS;
  vec3 acc = vec3(0.0);
  for (int i = uZero; i < uPartSteps; i++){
    ivec3 ic = ivec3(cell);
    vec4 Pp = any(lessThan(ic, ivec3(0))) || any(greaterThanEqual(ic, uPDim)) ? vec4(0.0) : texelFetch(tPartG, atlasPx(ic, uPDim, uPTx), 0);
    if (Pp.w > 0.0){
      vec3 pc = (Pp.xyz - uPMin) / cs;
      float sz = fract(Pp.w * 7.31), br = fract(Pp.w * 3.17);
      float tc = dot(pc - o, rd);
      if (tc > 0.0 && tc < tEnd){
        float d = length(o + rd*tc - pc) * cs;
        float r = mix(0.0003, 0.0018, sz*sz*sz);
        float fw = max(r, uPixAng * (path0 + tc*cs) * 0.75);
        float k = exp(-d*d / (fw*fw)) * (r*r) / (fw*fw);
        if (k > 2e-4){
          vec3 pw = Pp.xyz;
          keyWater(pw, inkLightAt(pw).rgb);
          vec3 Ls = vec3(0.0);
          for (int l = 0; l < gNL; l++) Ls += gE[l] * hg(dot(gL[l], rd), 0.55);
          vec3 L = Ls * 4.0 * PI * 0.35 + uAmbWater * exp(-uKdv * max(uLevel - pw.y, 0.0)) * 0.25;
          acc += k * L * exp(-sigT * tc*cs) * uPartBright * mix(0.4, 1.0, br);
        }
      }
    }
    float tt;
    if (tM.x < tM.y && tM.x < tM.z){ tt = tM.x; tM.x += tD.x; cell.x += st.x; }
    else if (tM.y < tM.z){ tt = tM.y; tM.y += tD.y; cell.y += st.y; }
    else { tt = tM.z; tM.z += tD.z; cell.z += st.z; }
    if (tt > tEnd) break;
  }
  return acc;
}
vec3 waterVolume(vec3 ro, vec3 rd, float tmax, float path0, out vec3 Tr){
  vec3 sigW = uSigA + uSigS;
  int n = int(clamp(tmax / 0.045, 4.0, float(uVolSteps)));
  float dt = tmax / float(n);
  float j = ign(gl_FragCoord.xy, uFrame);
  vec3 stepT = exp(-sigW * dt);
  vec3 wgt = (1.0 - stepT) / max(sigW, vec3(1e-5));
  vec3 T = vec3(1.0), acc = vec3(0.0);
  float sub = float(uInkSub);
  // Light shafts: the caustic light sheets are exaggerated against their local average (the blurred
  // field) by uGodRays, while the average glow only rises gently and levels off - the control makes
  // the rays stand out; it cannot fog the tank.
  float shaftMean = 1.4 * uGodRays / (uGodRays + 0.7);
  for (int i = uZero; i < n; i++){
    vec3 p = ro + rd * ((float(i) + j) * dt);
    vec4 il = inkLightAt(p);
    vec3 cb, c = causField(p, cb);
    keyWaterC(p, il.rgb, c);
    vec3 cs = max(cb + uGodRays * (c - cb), 0.0) * shaftMean;
    vec3 sW = vec3(0.0), sI = vec3(0.0);
    for (int l = 0; l < gNL; l++){
      float mu = dot(gL[l], rd);
      vec3 Ek = gK[l] * (gNL > 1 ? vec3(cs[l]) : cs) + gX[l] * shaftMean;
      sW += Ek * (0.35 * hg(mu, 0.8) + 0.65 * hg(mu, 0.35));
      sI += gE[l] * hg(mu, 0.3);
    }
    vec3 ambE = uAmbWater * exp(-uKdv * max(uLevel - p.y, 0.0));
    vec3 srcW = (sW + ambE * (0.13 / PI)) * uSigS;
    vec3 srcS = sI * 2.2 + ambE * (1.1 / PI);   // big grains: bright diffuse reflectors, scattering many times inside a plume
    if (il.a > 0.0015){
      // ink nearby: resolve it with finer sub-steps and its own absorption / scattering
      float ds = dt / sub;
      vec3 srcI = sI + ambE * (0.3 / PI) * (0.25 + 0.75 * il.rgb);
      for (int k = uZero; k < uInkSub; k++){
        vec3 q = ro + rd * ((float(i) + (float(k) + j) / sub) * dt);
        vec4 ink = inkAt(q);
        // neutral (carbon-like) absorbers scatter little; chromatic pigments scatter strongly
        float neutral = min(ink.r, min(ink.g, ink.b)) / max(max(ink.r, max(ink.g, ink.b)), 1e-4);
        vec3 sS = vec3(ink.a * uInkScat * (1.0 - 0.92 * neutral));
        // suspended sand: grainy, settling texture; bright, coloured scatterers
        vec4 sd = sampleG(tSandS, gD(q), uDDim, uDTx);
        float sg = 0.0;
        vec3 salb = vec3(0.0);
        if (sd.a > 1e-3){
          vec3 gq = q + vec3(0.0, uTime * uSettleV, 0.0);
          float gn = vnoise3(gq * 520.0);
          sg = sd.a * uSandSig * (0.25 + 3.0 * gn * gn * gn) * (0.7 + 0.6 * vnoise3(gq * 90.0));
          salb = sd.rgb / sd.a * 0.8;
        }
        vec3 sigT = sigW + ink.rgb + sS + vec3(sg);
        vec3 sT = exp(-sigT * ds);
        acc += T * (srcW + srcI * sS + srcS * salb * sg) * (1.0 - sT) / max(sigT, vec3(1e-5));
        T *= sT;
      }
    } else {
      acc += T * srcW * wgt;
      T *= stepT;
    }
    if (max3(T) < 0.002) break;
  }
  Tr = T;
  return acc + particles(ro, rd, tmax, path0) * (0.25 + 0.75 * T);
}

// ---------------- surface detail ----------------
vec4 surfCubic(vec2 xz){
  vec2 sz = vec2(textureSize(tSurf, 0));
  vec2 uv = footUV(xz) * sz - 0.5;
  vec2 i = floor(uv), f = uv - i;
  vec2 f2 = f*f, f3 = f2*f;
  vec2 w0 = (1.0 - 3.0*f + 3.0*f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0*f2 + 3.0*f3) / 6.0;
  vec2 w2 = (1.0 + 3.0*f + 3.0*f2 - 3.0*f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / sz, h1 = (i + 1.5 + w3 / g1) / sz;
  return g0.y * (g0.x * textureLod(tSurf, vec2(h0.x, h0.y), 0.0) + g1.x * textureLod(tSurf, vec2(h1.x, h0.y), 0.0))
       + g1.y * (g0.x * textureLod(tSurf, vec2(h0.x, h1.y), 0.0) + g1.x * textureLod(tSurf, vec2(h1.x, h1.y), 0.0));
}
vec2 microSlope(vec2 xz){
  float t = uTime;
  vec3 q = vec3(xz * 55.0, t * 1.7);
  float e = 0.35;
  float n0 = vnoise3(q), nx = vnoise3(q + vec3(e, 0.0, 0.0)), nz = vnoise3(q + vec3(0.0, e, 0.0));
  vec3 q2 = vec3(xz * 140.0, t * 2.9);
  float m0 = vnoise3(q2), mx = vnoise3(q2 + vec3(e, 0.0, 0.0)), mz = vnoise3(q2 + vec3(0.0, e, 0.0));
  return (vec2(nx - n0, nz - n0) + 0.5 * vec2(mx - m0, mz - m0)) * uMicro;
}
float foamCover(vec2 xz, float foam){
  if (foam < 0.015) return 0.0;
  float n = vnoise(xz * 34.0 + vec2(uTime * 0.04, 0.0)) * 0.55 + vnoise(xz * 97.0 - uTime * 0.03) * 0.3 + vnoise(xz * 260.0) * 0.15;
  float f = clamp(foam, 0.0, 1.4);
  return smoothstep(0.95 - f * 0.55, 1.1 - f * 0.45, n + 0.25) * clamp(f * 1.6, 0.0, 1.0);
}

// =============================================================================
void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 ndc = ((frag + uJitter) / uRes) * 2.0 - 1.0;
  vec3 rd = normalize(uCamRot * normalize(vec3(ndc.x * uTanFov.x, ndc.y * uTanFov.y, -1.0)));
  vec3 ro = uCamPos + rd * 0.02;
  int med = (inFoot(ro.xz) && ro.y < waterH(ro.xz) && ro.y > uTank.z) ? 1 : 0;

  vec3 col = vec3(0.0), thr = vec3(1.0);
  float cone = 0.0, path = 0.02;
  vec3 sRo[3]; vec3 sRd[3]; vec4 sThr[3]; int sMed[3]; float sLen[3];
  sRo[0] = vec3(0.0); sRo[1] = vec3(0.0); sRo[2] = vec3(0.0);
  sRd[0] = vec3(0.0); sRd[1] = vec3(0.0); sRd[2] = vec3(0.0);
  sThr[0] = vec4(0.0); sThr[1] = vec4(0.0); sThr[2] = vec4(0.0);
  sMed[0] = 0; sMed[1] = 0; sMed[2] = 0; sLen[0] = 0.0; sLen[1] = 0.0; sLen[2] = 0.0;
  int sp = 0;
  float dbgK = -1.0, dbgT = -1.0;
  vec4 firstPos = vec4(rd, 0.0);
  bool first = true;
  vec3 L_sun = normalize(uSunDir + (vec3(rnd(), rnd(), rnd()) - 0.5) * uSunRadius * 2.0);
  vec3 lj = (vec3(rnd(), rnd(), rnd()) - 0.5) * uLampR * 2.0;
  for (int l = 0; l < 3; l++) gLampP[l] = uLampPos[l] + lj;

  for (int it = uZero; it < uMaxIter; it++){
    Hit h = traceScene(ro, rd, med);
    dbgK = float(h.kind) + 10.0 * float(med); dbgT = h.t;
    float tEnd = h.kind == K_SKY ? 1e4 : h.t;
    if (first){ firstPos = h.kind == K_SKY ? vec4(rd, 0.0) : vec4(ro + rd*h.t, 1.0); first = false; }
    if (uLzN > 0) col += thr * laserGlow(ro, rd, min(tEnd, 25.0), med, path);
    if (med == 1){
      vec3 Tr;
      col += thr * waterVolume(ro, rd, min(tEnd, 12.0), path, Tr);
      thr *= Tr;
    }
    bool cont = false;
    vec3 nRo = ro, nRd = rd, nThr = thr; int nMed = med; float nCone = cone;
    bool push = false;
    vec3 pRo = ro, pRd = rd, pThr = vec3(0.0); int pMed = med; float pCone = cone;

    if (h.kind == K_SKY){
      col += thr * skyL(rd, cone);
    } else {
      vec3 p = ro + rd*h.t;
      path += h.t;
      vec3 v = -rd;
      if (h.kind == K_WALL && med == 1){
        vec2 xi = clamp(p.xz, -uTank.xy + 0.002, uTank.xy - 0.002);
        if (p.y >= waterH(xi)) h.kind = K_SURF;
      }
      vec3 gN = (h.kind == K_OBJ || h.kind == K_RIM || h.kind == K_WALL) ? h.n : vec3(0.0, 1.0, 0.0);
      gNL = 0;
      // sand pressed against the glass is lit from outside the tank
      bool wallSand = h.kind == K_WALL && med == 0 && uSandMax > 0.002 && p.y < uTank.z + sandR(clamp(p.xz, -uTank.xy + 0.003, uTank.xy - 0.003));
      if (h.kind == K_FLOOR || h.kind == K_RIM || h.kind == K_OBJ || h.kind == K_SURF || h.kind == K_BOTTOM || h.kind == K_BUB || h.kind == K_SAND || h.kind == K_STREAM || wallSand){
        if (med == 0) keyAir(p + gN * (h.kind == K_SURF ? 0.01 : 0.003), L_sun);
        else {
          gBed = h.kind == K_BOTTOM || h.kind == K_SAND;
          keyWater(p, inkLightAt(p).rgb);
          gBed = false;
          for (int l = 0; l < gNL; l++) gE[l] *= uCausGain;
        }
      }
      float aoO = 1.0;
      if (h.kind == K_FLOOR || h.kind == K_BOTTOM || h.kind == K_OBJ || h.kind == K_SAND) aoO = objAO(p, gN, h.kind == K_OBJ ? h.id : -1);

      if (h.kind == K_FLOOR){
        float rough;
        vec3 alb = floorAlb(p.xz, path, rough);
        vec3 n = vec3(0.0, 1.0, 0.0);
        vec2 e = max(abs(p.xz) - uTank.xy, 0.0);
        float dT = length(e);
        float ao = aoO * (1.0 - 0.35 * exp(-dT * 7.0));
        vec3 c = directLight(n, v, alb, rough, 0.0) + alb / PI * (ambAir(n) * ao + (uLzSpotN > 0 ? laserSpots(p, path) : vec3(0.0)));
        float fog = exp(-path * 0.011);
        vec3 haze = envL(normalize(vec3(rd.x, 0.015, rd.z)), 4.0);
        col += thr * mix(haze, c, fog);
        float ndv = max(dot(n, v), 0.0);
        float F = (0.04 + 0.96 * pow(1.0 - ndv, 5.0)) * (1.0 - rough) * 0.8;
        push = fog > 0.2; pRo = p + n*0.002; pRd = glossy(reflect(rd, n), n, rough * 0.6); pThr = thr * F * fog; pMed = 0; pCone = 0.03;
      }
      else if (h.kind == K_BOTTOM){
        vec3 n = vec3(0.0, 1.0, 0.0);
        vec3 alb = bottomAlb(p.xz, n, path);
        if (uSandMax > 0.002){
          float hs = textureLod(tSandR, sUV(p.xz), 0.0).r;
          if (hs > 1e-5){ float det; alb = mix(alb, sandTopAlb(p, path, det), smoothstep(0.0, 0.0015, hs)); gDbg.b += max3(thr); }
        }
        vec3 c = directLight(n, v, alb, uBottomType > 0.5 && uBottomType < 1.5 ? 0.25 : 0.85, 0.0);
        float ao = aoO;
        vec2 e = uTank.xy - abs(p.xz);
        ao *= 1.0 - 0.3 * exp(-max(min(e.x, e.y), 0.0) * 14.0);
        c += alb / PI * (ambWater(p, n) * ao + (uLzSpotN > 0 ? laserSpots(p, path) : vec3(0.0)));
        col += thr * c;
      }
      else if (h.kind == K_SAND){
        vec4 sr = textureLod(tSandR, sUV(p.xz), 0.0);
        float det;
        vec3 alb = sandTopAlb(p, path, det);
        // slope from the heightfield, soft centimetre-scale relief, grain bumps up close
        vec2 q = p.xz * 60.0, q2 = p.xz * 17.0;
        vec2 rel = vec2(vnoise(q + vec2(0.37, 0.0)) - vnoise(q - vec2(0.37, 0.0)), vnoise(q + vec2(0.0, 0.37)) - vnoise(q - vec2(0.0, 0.37))) * 0.45
                 + vec2(vnoise(q2 + vec2(0.37, 0.0)) - vnoise(q2 - vec2(0.37, 0.0)), vnoise(q2 + vec2(0.0, 0.37)) - vnoise(q2 - vec2(0.0, 0.37))) * 0.3;
        vec3 n = normalize(vec3(-sr.y + rel.x, 1.0, -sr.z + rel.y) + (hash33(floor(p / 0.0008)) - 0.5) * 0.5 * det);
        vec3 c = directLight(n, v, alb, 0.92, 0.0);
        gDbg.g += max3(thr);
        vec2 e = uTank.xy - abs(p.xz);
        float ao = aoO * (1.0 - 0.3 * exp(-max(min(e.x, e.y), 0.0) * 14.0));
        c += alb / PI * (ambWater(p, n) * ao + (uLzSpotN > 0 ? laserSpots(p, path) : vec3(0.0)));
        col += thr * c;
      }
      else if (h.kind == K_STREAM){
        vec4 sc; float sr;
        vec2 cc = streamAt(p.y, sc, sr);
        float fall = max(uStream.x - p.y, 0.0);
        vec2 q = p.xz - cc;
        float ang = atan(q.y, q.x);
        float spd = sqrt(uStream.w * uStream.w + 19.62 * fall);
        float yy = p.y + uTime * spd;
        // a fuzzy granular column: dense core, ragged rim, grain streaks moving down with the flow;
        // it thins out as the grains accelerate
        float rxz = length(rd.xz);
        float core = rxz < 0.25 ? 1.0 : clamp(h.lp.x * rxz / (2.0 * max(sr, 1e-4)), 0.0, 1.0);
        float n1 = vnoise(vec2(ang * 6.0 + 11.0, yy * 45.0));
        float sp = hash12(floor(vec2(ang * 24.0 + 40.0, yy * 260.0)));
        float dens = uStream.z / (1.0 + 2.6 * fall);
        float a = clamp(dens * (0.15 + sqrt(core) * (0.35 + 0.9 * n1)) * (0.45 + 1.1 * step(0.5, sp)), 0.0, 0.92);
        vec3 alb = sc.rgb;
        if (sc.w > 0.5){ int k = min(int(hash12(floor(vec2(ang * 9.0, yy * 90.0))) * float(uPalN)), uPalN - 1); alb = uPal[k]; }
        vec3 nr = normalize(vec3(q.x, 0.0, q.y) + vec3(1e-5, 0.0, 0.0));
        vec3 E = diffuseLight(nr) * 0.55 + totalLight() * 0.3 + ambAir(nr);
        col += thr * a * alb * 0.85 / PI * E;
        cont = true; nRo = p + rd * (h.lp.x + 0.002); nRd = rd; nThr = thr * (1.0 - a); nMed = 0; nCone = cone;
      }
      else if (h.kind == K_SURF){
        vec4 s = surfCubic(p.xz);
        vec2 ms = microSlope(p.xz);
        vec3 ns = normalize(vec3(-s.y - ms.x, 1.0, -s.z - ms.y));
        float fc = foamCover(p.xz, s.w * uFoamGain);
        if (med == 0){
          vec3 n = ns;
          float cosi = max(-dot(rd, n), 0.02);
          float F = fresnelDielectric(cosi, 1.0, 1.333);
          vec3 rr = reflect(rd, n);
          if (rr.y < 0.01) rr = normalize(vec3(rr.x, 0.01 + abs(rr.y) * 0.3, rr.z));
          vec3 tt = refract(rd, n, 1.0 / 1.333);
          if (dot(tt, tt) < 0.5) tt = rd;
          if (fc > 0.0){
            vec3 fcol = vec3(0.92, 0.95, 0.97) / PI * (diffuseLight(ns) + uSkyIrr * 0.9) + vec3(0.02, 0.05, 0.06);
            col += thr * fc * fcol;
          }
          vec3 base = thr * (1.0 - fc);
          cont = true; nRo = p - n*0.0015; nRd = tt; nThr = base * (1.0 - F); nMed = 1; nCone = cone;
          push = true; pRo = p + n*0.0015; pRd = rr; pThr = base * F; pMed = 0; pCone = max(cone, 0.006 + uMicro * 0.02);
        } else {
          vec3 n = -ns;
          float cosi = max(-dot(rd, n), 0.0);
          vec3 tt = refract(rd, n, 1.333);
          vec3 rr = reflect(rd, n);
          if (rr.y > -0.01) rr = normalize(vec3(rr.x, -0.01 - abs(rr.y) * 0.3, rr.z));
          float F = dot(tt, tt) < 0.5 ? 1.0 : fresnelDielectric(cosi, 1.333, 1.0);
          if (fc > 0.0){
            vec3 fcol = vec3(0.75, 0.86, 0.9) / PI * (totalLight() * 0.35 + uSkyIrr * 0.35);
            col += thr * fc * fcol;
          }
          vec3 base = thr * (1.0 - fc);
          if (F >= 0.999){
            cont = true; nRo = p - ns*0.0015; nRd = rr; nThr = base; nMed = 1;
          } else {
            cont = true; nRo = p + ns*0.0015; nRd = tt; nThr = base * (1.0 - F); nMed = 0; nCone = cone;
            push = true; pRo = p - ns*0.0015; pRd = rr; pThr = base * F; pMed = 1;
          }
        }
      }
      else if (h.kind == K_WALL){
        vec3 nO = h.n;
        vec2 xi = clamp(p.xz, -uTank.xy + 0.002, uTank.xy - 0.002);
        bool wet = p.y < waterH(xi);
        float edgeD = abs(nO.x) > 0.5 ? (uTank.y - abs(p.z)) : (uTank.x - abs(p.x));
        edgeD = min(min(edgeD, p.y - 0.0), uTank.w - p.y);
        float edge = uGlassOn * (1.0 - smoothstep(0.0, uGlassW * 1.2, edgeD));
        vec3 gT = mix(vec3(1.0), uGlassTint, uGlassOn) * mix(vec3(1.0), vec3(0.30, 0.55, 0.47), edge);
        float gIor = uGlassOn > 0.5 ? 1.5 : 1.333;
        if (med == 0 && p.y < uTank.z){
          // tank base seen edge-on: thick glass slab (or the sand cross-section without glass)
          float cosi = max(dot(rd, -nO), 0.0);
          float F = fresnelDielectric(cosi, 1.0, 1.5);
          vec3 base = uGlassOn > 0.5 ? vec3(0.16, 0.34, 0.29) : vec3(0.42, 0.38, 0.30);
          col += thr * (F * envL(reflect(rd, nO), 2.0) * uGlassOn + (1.0 - F) * base * (uSkyIrr * 0.5 + uKeyAmb * 0.25) / PI);
        } else if (med == 0){
          bool entering = dot(rd, nO) < 0.0;
          vec3 n = entering ? nO : -nO;
          float cosi = max(-dot(rd, n), 0.0);
          if (edge > 0.0) col += thr * edge * 0.25 * uGlassTint * envL(reflect(rd, n), 3.0);
          vec2 xs = clamp(p.xz, -uTank.xy + 0.003, uTank.xy - 0.003);
          float hcol = uSandMax > 0.002 ? sandR(xs) : 0.0;
          if (entering && p.y < uTank.z + hcol){
            // sand packed against the glass: the strata in cross-section
            float F = fresnelDielectric(cosi, 1.0, gIor) + (uGlassOn > 0.5 ? 0.004 : 0.0);
            float det;
            vec3 ps = vec3(xs.x, p.y, xs.y);
            vec3 alb = sandAlb(ps, p.y - uTank.z, hcol, path, det);
            float below = uTank.z + hcol - p.y;
            vec3 E = (diffuseLight(nO) + uSkyIrr * 0.45 + uGroundIrr * 0.35) * gT
                   + ambWater(vec3(xs.x, uTank.z + hcol, xs.y), vec3(0.0, 1.0, 0.0)) * 2.0 * exp(-below * 90.0);
            col += thr * (1.0 - F) * gT * alb / PI * E;
            gDbg.r += max3(thr);
            push = true; pRo = p + n*0.0015; pRd = reflect(rd, n); pThr = thr * F; pMed = 0;
          } else if (wet && entering){
            float F = fresnelDielectric(cosi, 1.0, gIor) + (uGlassOn > 0.5 ? 0.004 : 0.0);
            vec3 tt = refract(rd, n, 1.0 / 1.333);
            cont = true; nRo = p - n*0.0015; nRd = tt; nThr = thr * (1.0 - F) * gT; nMed = 1;
            push = true; pRo = p + n*0.0015; pRd = reflect(rd, n); pThr = thr * F; pMed = 0;
          } else if (uGlassOn > 0.5){
            float F = min(2.0 * fresnelDielectric(cosi, 1.0, 1.5), 1.0);
            cont = true; nRo = p + rd*0.0015; nRd = rd; nThr = thr * (1.0 - F) * gT; nMed = 0;
            push = true; pRo = p + n*0.0015; pRd = reflect(rd, n); pThr = thr * F; pMed = 0;
          } else {
            cont = true; nRo = p + rd*0.0015; nRd = rd; nThr = thr; nMed = 0;
          }
        } else {
          vec3 n = -nO;
          float cosi = max(-dot(rd, n), 0.0);
          vec3 tt = refract(rd, n, 1.333);
          if (dot(tt, tt) < 0.5){
            cont = true; nRo = p + n*0.0015; nRd = reflect(rd, n); nThr = thr * mix(vec3(1.0), gT, 0.5); nMed = 1;
          } else {
            float F = fresnelDielectric(cosi, 1.333, 1.0) + (uGlassOn > 0.5 ? 0.004 : 0.0);
            cont = true; nRo = p - n*0.0015; nRd = tt; nThr = thr * (1.0 - F) * gT; nMed = 0;
            push = true; pRo = p + n*0.0015; pRd = reflect(rd, n); pThr = thr * F; pMed = 1;
          }
        }
      }
      else if (h.kind == K_RIM){
        vec3 n = h.n;
        float cosi = max(-dot(rd, n), 0.0);
        float F = fresnelDielectric(cosi, 1.0, 1.5);
        vec3 edgeC = vec3(0.22, 0.42, 0.36) * (uSkyIrr * 0.5 + diffuseLight(vec3(0.0, 1.0, 0.0)) * 0.6) / PI;
        col += thr * (F * skyL(reflect(rd, n), 0.004) + (1.0 - F) * edgeC);
      }
      else if (h.kind == K_OBJ){
        int id = h.id;
        vec4 m2 = texelFetch(tObj, ivec2(2, id), 0);
        vec4 m3 = texelFetch(tObj, ivec2(3, id), 0);
        vec4 m5 = texelFetch(tObj, ivec2(5, id), 0);
        int mc = int(m2.w + 0.5);
        vec3 alb = m5.rgb; float rough = m5.a; float metal = mc == 0 ? 1.0 : 0.0;
        vec3 n = h.n;
        int route = 0, mid = -1;
        float alpha = 1.0;
        vec4 m6 = vec4(0.0), m7 = vec4(0.0), k4 = vec4(1.0);
        vec3 ax0 = vec3(1.0, 0.0, 0.0), ax1 = vec3(0.0, 1.0, 0.0), ax2 = vec3(0.0, 0.0, 1.0);
        if (mc >= 8){
          // table-built model: zone at the hit point -> material; relief in the model frame
          ax0 = texelFetch(tObj, ivec2(1, id), 0).xyz; ax1 = m2.xyz; ax2 = m3.xyz;
          k4 = texelFetch(tObj, ivec2(4, id), 0); m6 = texelFetch(tObj, ivec2(6, id), 0); m7 = texelFetch(tObj, ivec2(7, id), 0);
          vec3 q = modelWarp(h.lp / k4.x, m6, m7);
          int zone = h.zone;   // found by the intersection march
          mid = int(m6.w + 0.5);
          vec3 nl = vec3(dot(ax0, n), dot(ax1, n), dot(ax2, n));
          vec3 bump;
          modelSurface(mid, zone, q, nl, m7, m3.w, alb, rough, metal, route, alpha, bump);
          if (mid < 10 && m7.x > 0.02) alb *= 1.0 - 0.3 * m7.x;   // swamped hull: soaked, darker
          n = normalize(n + ax0 * bump.x + ax1 * bump.y + ax2 * bump.z);
          if (dot(n, v) < 0.02) n = normalize(n + v * (0.02 - dot(n, v)));
        }
        else if (mc == 2) alb = woodAlb(h.lp, alb, m3.w);
        else if (mc == 4) alb = stoneAlb(h.lp, alb, m3.w);
        else if (mc == 5) alb = ballAlb(h.lp);
        else if (mc == 6) alb = ringAlb(h.lp);
        bool wet = med == 1;
        float depth = max(uLevel - p.y, 0.0);
        // wetted band just above the waterline: darker, glossier (meniscus / film of water)
        if (!wet && mc != 3 && mid < 10 && route == 0 && inFoot(p.xz)){
          float above = p.y - waterH(p.xz);
          float band = 1.0 - smoothstep(0.0, 0.035, above);
          if (above > -0.01 && band > 0.0){
            alb *= mix(1.0, mc == 0 ? 0.92 : 0.62, band);
            rough = mix(rough, rough * 0.35, band);
          }
        }
        vec4 kk = texelFetch(tObj, ivec2(4, id), 0);
        int li = clamp(int(m3.w + 0.5), 0, 2);
        if (mc == 7 && h.lp.y > kk.y - 0.004 && length(h.lp.xz) < kk.x - 0.012){
          col += thr * uLampCol[li] * uLampEmit;
        } else if (route == 4){
          col += thr * uLzCol * 60.0;   // laser aperture
        } else if (route == 1){
          // thin membrane (fins, sails, flags): lit from either side, partly see-through
          vec3 E = wet ? ambWater(p, n) * 0.7 : ambAir(n) * 0.7;
          vec3 L2 = vec3(0.0);
          for (int l = 0; l < gNL; l++) L2 += gE[l] * (max(dot(n, gL[l]), 0.0) + 0.55 * max(-dot(n, gL[l]), 0.0));
          col += thr * alpha * alb / PI * (L2 + E);
          cont = true; nRo = p + rd * 0.003; nRd = rd; nThr = thr * (1.0 - alpha) * mix(vec3(1.0), alb * 1.4, 0.4); nMed = med; nCone = cone;
        } else if (route == 2){
          // thin glass wall (bottle): reflection plus tinted transmission straight through the wall
          float cosi = max(-dot(rd, n), 0.0);
          float F = min(fresnelDielectric(cosi, wet ? 1.333 : 1.0, 1.52) * 1.6, 1.0);
          cont = true; nRo = p + rd * 0.0065; nRd = rd; nThr = thr * (1.0 - F) * alb; nMed = med; nCone = cone;
          push = true; pRo = p + n * 0.0015; pRd = reflect(rd, n); pThr = thr * F; pMed = med;
        } else if (route == 3){
          // jellyfish: bell, gonads, oral arms and tentacles are translucent tissue, integrated along the
          // ray through the object's bounding sphere - sphere-traced across the gaps, short steps inside
          // the tissue (the bell's edge is soft, the thin tentacles' crisp)
          vec4 b0 = texelFetch(tObj, ivec2(0, id), 0);
          vec3 oc = p - b0.xyz;
          float bb = dot(oc, rd), cc = dot(oc, oc) - b0.w * b0.w;
          float tex = max(-bb + sqrt(max(bb * bb - cc, 0.0)), 0.0);
          float jt = ign(gl_FragCoord.xy, uFrame + 7);
          vec3 Lsrc = vec3(0.0);
          for (int l = 0; l < gNL; l++) Lsrc += gE[l] * (0.4 / PI + 1.2 * hg(dot(gL[l], rd), 0.55));
          vec3 amb = ambWater(p, vec3(0.0, 1.0, 0.0)) * (0.5 / PI);
          vec3 Tj = vec3(1.0), acc = vec3(0.0);
          int js = int(m6.x + 0.5), jn = int(m6.y + 0.5);
          float t = 0.0;
          for (int st = uZero; st < 96; st++){
            if (t > tex || max3(Tj) < 0.02) break;
            vec3 pw = p + rd * t - b0.xyz;
            vec3 lq = vec3(dot(ax0, pw), dot(ax1, pw), dot(ax2, pw)) / k4.x;
            int zj;
            float dj = sdfModel(lq, js, jn, zj) * k4.x;
            if (dj > 0.003){ t += max(0.8 * dj - 0.002, 0.0015); continue; }
            float ds = max(0.0007, 0.45 * abs(dj) + 0.0005) * (0.6 + 0.8 * fract(jt + float(st) * 0.618034));
            vec3 lb = lq - vec3(0.0, m7.z, 0.0);   // bell-centred (m7.z: the bell sits that far above the origin)
            float w = smoothstep(0.003, -0.004, dj), dens;
            vec3 sa;
            if (zj == 1){ sa = vec3(0.95, 0.45, 0.8); dens = 90.0; }
            else if (zj == 2){   // oral arms: folds running down them, patchy, faintly pink
              float ruf = smoothstep(0.25, 0.75, vnoise3(vec3(lb.x * 22.0, lb.y * 6.0, lb.z * 22.0) + 1.7));
              sa = vec3(0.97, 0.78, 0.84);
              dens = 62.0 * (0.25 + 0.75 * ruf) * (0.45 + 0.75 * smoothstep(0.3, 0.72, vnoise3(lb * 9.0 + 3.1)));
            }
            else if (zj == 3){ float hair = pow(max(sin(atan(lb.z, lb.x) * 90.0), 0.0), 6.0); sa = vec3(0.95); dens = 60.0 * hair; }
            else if (zj == 5){ w = smoothstep(0.0009, -0.0009, dj); sa = vec3(0.96, 0.86, 0.9); dens = 240.0; }   // tentacles
            else { sa = vec3(0.85, 0.9, 0.97); dens = 16.0 + 30.0 * smoothstep(0.3, 0.55, lb.y); }
            vec3 sig = vec3(dens * w) * (1.12 - sa);
            vec3 sc = vec3(dens * w) * sa;
            vec3 ext = sig + sc;
            vec3 stT = exp(-ext * ds);
            acc += Tj * (1.0 - stT) * sc / max(ext, vec3(1e-4)) * (Lsrc + amb * 3.0);
            Tj *= stT;
            t += ds;
          }
          col += thr * (acc + directLight(n, v, vec3(0.0), 0.22, 0.0) * 0.35);
          cont = true; nRo = p + rd * (tex + 0.002); nRd = rd; nThr = thr * Tj; nMed = med; nCone = cone;
        } else if (mc == 3){
          // solid glass sphere
          vec4 b0 = texelFetch(tObj, ivec2(0, id), 0);
          float n1 = wet ? 1.333 : 1.0;
          float cosi = max(-dot(rd, n), 0.0);
          float F = fresnelDielectric(cosi, n1, 1.5);
          vec3 t1 = refract(rd, n, n1 / 1.5);
          vec3 oc = p - b0.xyz;
          float bb = dot(oc, t1), cc = dot(oc, oc) - b0.w*b0.w;
          float tex = -bb + sqrt(max(bb*bb - cc, 0.0));
          vec3 q = p + t1 * tex;
          vec3 nq = normalize(q - b0.xyz);
          vec3 t2 = refract(t1, -nq, 1.5 / n1);
          if (dot(t2, t2) < 0.5) t2 = reflect(t1, -nq);
          vec3 gt = exp(-vec3(0.9, 0.35, 0.45) * tex) * alb;
          cont = true; nRo = q + t2*0.0015; nRd = t2; nThr = thr * (1.0 - F) * gt; nMed = med;
          push = true; pRo = p + n*0.0015; pRd = reflect(rd, n); pThr = thr * F; pMed = med;
        } else {
          vec3 direct = directLight(n, v, alb, rough, metal);
          float fy = inFoot(p.xz) ? uTank.z : 0.0;
          float ao = aoO * (1.0 - 0.5 * (0.5 - 0.5*n.y) * exp(-(p.y - fy) * 9.0));
          vec3 E = wet ? ambWater(p, n) : ambAir(n);
          if (uLzSpotN > 0) E += laserSpots(p, path) / max(ao, 0.05);
          col += thr * (direct + alb * (1.0 - metal) / PI * E * ao);
          if (mc == 7) col += thr * uLampCol[li] * 0.012 * smoothstep(kk.y - 0.05, kk.y, h.lp.y);
          float ndv = max(dot(n, v), 0.0);
          vec3 F0 = mix(vec3(wet ? 0.012 : 0.04), alb, metal);
          vec3 Fr = F0 + (1.0 - F0) * pow(1.0 - ndv, 5.0) * (1.0 - rough) * (1.0 - rough);
          vec3 r = reflect(rd, n);
          if (metal > 0.5){
            cont = true; nRo = p + n*0.002; nRd = glossy(r, n, rough); nThr = thr * Fr * mix(1.0, ao, rough); nMed = med; nCone = max(cone, rough * 0.08);
          } else if (rough < 0.45){
            push = true; pRo = p + n*0.002; pRd = glossy(r, n, rough); pThr = thr * Fr * ao; pMed = med; pCone = max(cone, rough * 0.1);
          } else {
            col += thr * Fr * ao * (wet ? uwEnv(r, depth) : envL(r, 2.0 + rough * 5.0));
          }
        }
      }
      else if (h.kind == K_BUB){
        vec4 s = texelFetch(tSph, ivec2(h.id, 0), 0);
        vec3 n = h.n;
        float cosi = max(-dot(rd, n), 0.0);
        float R = fresnelDielectric(cosi, 1.333, 1.0);
        float depth = max(uLevel - p.y, 0.0);
        col += thr * R * uwEnv(reflect(rd, n), depth) * 1.6;
        col += thr * pow(1.0 - cosi, 3.0) * totalLight() * 0.08;
        vec3 oc = p - s.xyz;
        float b = dot(oc, rd), c = dot(oc, oc) - s.w*s.w;
        float tex = -b + sqrt(max(b*b - c, 0.0));
        cont = true; nRo = p + rd*(tex + 0.0005); nRd = rd; nThr = thr * (1.0 - R) * 0.9; nMed = 1;
      }
      else if (h.kind == K_DROP){
        vec4 s = texelFetch(tSph, ivec2(h.id, 0), 0);
        vec3 n = h.n;
        float cosi = max(-dot(rd, n), 0.0);
        float R = fresnelDielectric(cosi, 1.0, 1.333);
        col += thr * R * skyL(reflect(rd, n), 0.01);
        col += thr * (1.0 - R) * 0.25 * envL(-reflect(rd, n), 1.0) * vec3(0.8, 0.95, 1.0);
        vec3 oc = p - s.xyz;
        float b = dot(oc, rd), c = dot(oc, oc) - s.w*s.w;
        float tex = -b + sqrt(max(b*b - c, 0.0));
        cont = true; nRo = p + rd*(tex + 0.0005); nRd = rd; nThr = thr * (1.0 - R) * 0.7; nMed = 0;
      }
    }

    if (nMed == 1){ nRo.xz = clamp(nRo.xz, -uTank.xy + 0.0008, uTank.xy - 0.0008); nRo.y = max(nRo.y, uTank.z + 0.0008); }
    if (pMed == 1){ pRo.xz = clamp(pRo.xz, -uTank.xy + 0.0008, uTank.xy - 0.0008); pRo.y = max(pRo.y, uTank.z + 0.0008); }
    if (push && sp < 3 && max3(pThr) > 0.012){
      sRo[sp] = pRo; sRd[sp] = pRd; sThr[sp] = vec4(pThr, pCone); sMed[sp] = pMed; sLen[sp] = path; sp++;
    }
    if (cont && max3(nThr) > 0.004){
      ro = nRo; rd = nRd; thr = nThr; med = nMed; cone = nCone;
    } else {
      thr = vec3(0.0);
      if (sp == 0) break;
      sp--;
      ro = sRo[sp]; rd = sRd[sp]; thr = sThr[sp].rgb; cone = sThr[sp].a; med = sMed[sp]; path = sLen[sp];
    }
  }
  if (!first){
    // budget exhausted: close the active path and any stacked branches with an environment estimate
    for (int k = 0; k < 4; k++){
      if (k > 0){
        if (sp == 0) break;
        sp--; ro = sRo[sp]; rd = sRd[sp]; thr = sThr[sp].rgb; med = sMed[sp];
      }
      if (max3(thr) < 0.004) continue;
      if (med == 1){
        float d = max(uLevel - ro.y, 0.0);
        col += thr * uwEnv(rd, d) * exp(-(uSigA + uSigS) * 0.5);
      } else col += thr * envL(rd, 2.0);
      thr = vec3(0.0);
    }
  }
  if (badF(col)) col = vec3(0.0);
  col = clamp(col, vec3(0.0), vec3(4000.0));
  oCol = vec4(col, 1.0);
  if (uDbg == 1) oCol = vec4(dbgK, dbgT, float(sp), max3(thr));
  if (uDbg == 2) oCol = vec4(gDbg * 0.6 + col * 0.02, 1.0);
  oPos = firstPos;
}`;
