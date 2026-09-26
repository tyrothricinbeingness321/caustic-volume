// ============================================================================
//  SHARED SCENE GLSL + CAUSTIC PHOTON VOLUME + SKY
// ============================================================================
const GLSL_SCENE = `
#define PI 3.14159265359
uniform vec4  uTank;      // inner half-size x, half-size z, bottom y, top y
uniform float uLevel;     // mean water level
uniform float uAmp;       // wave slab half height (bound)
uniform vec3  uSunDir;    // toward the sun
uniform vec3  uSunCol;    // sun irradiance
uniform vec3  uLw;        // flat-water refracted sun direction (propagation)
uniform float uCausK;     // flat water irradiance transfer
uniform vec3  uSigA, uSigS;
uniform sampler2D tSurf;  // h, dh/dx, dh/dz, foam  over inner footprint
uniform sampler2D tObj;   // 8 texels / object (see packObjects)
uniform sampler2D tPrim;  // shape primitives: 4 texels each (pos + code, rotation, params, blend/bound)
uniform int   uNumObj;
uniform int   uZero;       // always 0: loops start from it so shader compilers can't unroll (and inline) them
uniform float uTime;
uniform int   uLampMode;     // 0 = sun, 1 = lamps
uniform int   uNumLamps;     // 1..3 hanging lamps
uniform int   uLampSel;      // lamp traced by the current photon pass
uniform vec3  uLampPos[3];   // emitting points (just in front of each lens)
uniform vec3  uLampAim[3];   // beam axes
uniform vec2  uLampCone[3];  // cos(outer), cos(inner)
uniform vec3  uLampCol[3];   // radiant intensity (colour * power)
float lampSpot(int i, vec3 dirFromLamp){ return smoothstep(uLampCone[i].x, uLampCone[i].y, dot(dirFromLamp, uLampAim[i])); }

vec2 footUV(vec2 xz){ return (xz + uTank.xy) / (2.0 * uTank.xy); }
vec4 surfAt(vec2 xz){ return textureLod(tSurf, footUV(xz), 0.0); }
float waterH(vec2 xz){ return textureLod(tSurf, footUV(xz), 0.0).x; }
bool inFoot(vec2 xz){ return abs(xz.x) < uTank.x && abs(xz.y) < uTank.y; }

float fresnelDielectric(float cosi, float etai, float etat){
  cosi = clamp(cosi, 0.0, 1.0);
  float sint = etai / etat * sqrt(max(0.0, 1.0 - cosi*cosi));
  if (sint >= 1.0) return 1.0;
  float cost = sqrt(max(0.0, 1.0 - sint*sint));
  float rs = (etat*cosi - etai*cost) / (etat*cosi + etai*cost);
  float rp = (etai*cosi - etat*cost) / (etai*cosi + etat*cost);
  return 0.5 * (rs*rs + rp*rp);
}

// ---------------- primitive-table models ----------------
vec3 qrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float smax(float a, float b, float k){ return -smin(-a, -b, k); }
float sdEllipsoid(vec3 p, vec3 r){ float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-6); }
float primSDF(int ty, vec3 p, vec4 k){
  if (ty == 0) return length(p) - k.x;
  if (ty == 1) return sdEllipsoid(p, k.xyz);
  if (ty == 2){ vec3 q = abs(p) - k.xyz + k.w; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - k.w; }
  if (ty == 3){   // round cone along +y: radius k.x at 0, k.y at height k.z
    vec2 q = vec2(length(p.xz), p.y);
    float b = (k.x - k.y) / k.z, a = sqrt(max(1.0 - b * b, 0.0));
    float kk = dot(q, vec2(-b, a));
    if (kk < 0.0) return length(q) - k.x;
    if (kk > a * k.z) return length(q - vec2(0.0, k.z)) - k.y;
    return dot(q, vec2(a, b)) - k.x;
  }
  if (ty == 4){ vec2 d = vec2(length(p.xz), abs(p.y)) - vec2(k.x, k.y) + k.z; return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - k.z; }
  if (ty == 5) return length(vec2(length(p.xz) - k.x, p.y)) - k.y;
  if (ty == 6){   // arc in the xy plane (symmetric about +y), half-aperture k.z
    vec2 sc = vec2(sin(k.z), cos(k.z));
    p.x = abs(p.x);
    float kk = (sc.y * p.x > sc.x * p.y) ? dot(p.xy, sc) : length(p.xy);
    return sqrt(max(dot(p, p) + k.x * k.x - 2.0 * k.x * kk, 0.0)) - k.y;
  }
  if (ty == 7 || ty == 9){   // membrane in the xy plane (7 ellipse, 9 near-rectangle), thickness k.z, billow k.w
    vec2 e = p.xy / k.xy;
    vec2 e2 = e * e;
    vec2 e4 = e2 * e2;
    float r = ty == 7 ? sqrt(e2.x + e2.y) : sqrt(sqrt(sqrt(e4.x * e4.x + e4.y * e4.y)));
    p.z -= k.w * (ty == 7 ? max(1.0 - r * r, 0.0) : max(1.0 - e2.x, 0.0) * max(1.0 - e2.y, 0.0));
    return max((r - 1.0) * min(k.x, k.y), abs(p.z) - k.z);
  }
  if (ty == 10) return max(abs(length(p.xz) - k.x) - k.y, abs(p.y) - k.z);   // open tube
  p.y -= clamp(p.y, -k.x, k.x);
  return length(p) - k.y;   // 8: capsule along y
}
// Quadratic Bezier tube (type 11): from the prim's origin (radius ra) toward control point B, ending
// at C (radius rc). Exact curve distance (Inigo Quilez's cubic solve). For shading, the dominant tube
// reports a coordinate along it (interpolated between the prim's e.z and e.w: sucker spacings on an
// octopus arm), its radius, tangent, and the direction toward its centre of curvature (inside a curl).
float gBezU = 0.0, gBezR = 0.0;
vec3 gBezIn = vec3(0.0), gBezT = vec3(1.0, 0.0, 0.0);
float sdBezTube(vec3 p, vec3 B, vec3 C, float ra, float rc, out float tt, out vec3 inner, out vec3 tang){
  vec3 a = B, b = C - 2.0 * B, c = 2.0 * B, d = -p;
  if (dot(b, b) < 1e-7){   // (nearly) straight: a tapered segment
    tt = clamp(dot(p, C) / max(dot(C, C), 1e-12), 0.0, 1.0); inner = vec3(0.0); tang = normalize(C + vec3(1e-9, 0.0, 0.0));
    return length(p - C * tt) - mix(ra, rc, tt);
  }
  float kk = 1.0 / dot(b, b);
  float kx = kk * dot(a, b), ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0, kz = kk * dot(d, a);
  float pp = ky - kx * kx, q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  float h = q * q + 4.0 * pp * pp * pp;
  if (h >= 0.0){
    h = sqrt(h);
    vec2 x = (vec2(h, -h) - q) * 0.5;
    vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
    tt = clamp(uv.x + uv.y - kx, 0.0, 1.0);
  } else {
    float z = sqrt(-pp), v = acos(clamp(q / (pp * z * 2.0), -1.0, 1.0)) / 3.0;
    float m = cos(v), n = sin(v) * 1.732050808;
    vec2 t2 = clamp(vec2(m + m, -n - m) * z - kx, 0.0, 1.0);
    vec3 q1 = d + (c + b * t2.x) * t2.x, q2 = d + (c + b * t2.y) * t2.y;
    tt = dot(q1, q1) < dot(q2, q2) ? t2.x : t2.y;
  }
  vec3 tg = normalize(c + 2.0 * b * tt);
  inner = b - tg * dot(b, tg); tang = tg;
  return length(d + (c + b * tt) * tt) - mix(ra, rc, tt);
}
// Type 12: a ring of hanging tentacles. Roots on a ring of radius k.y in the plane 0.65 k.z above the
// prim's origin; lengths 0.7-1.3 k.z; root radius k.w tapering to a quarter; N = floor(k.x) strands,
// seed = fract(k.x). The tips trail by q.xy (the water streaming past the animal) and each strand
// sways in two travelling waves of amplitude q.z at phase q.w. Distance: to the nearest of the three
// strands around the point's bearing, measured across the strand at the point's depth - exact for a
// straight strand, close for gently curved ones (the caller marches it with a shortened step).
float sdStrands(vec3 p, vec4 q, vec4 k){
  float N = floor(k.x), sd = fract(k.x) * 71.0, L = k.z, iL2 = 1.0 / (L * L);
  float s = 0.65 * L - p.y;
  float sc = clamp(s, 0.0, 1.3 * L);
  vec2 pp = p.xz - q.xy * (sc * sc * iL2);
  float j0 = floor(atan(pp.y, pp.x + 1e-7) / 6.2831853 * N);
  float kw = 6.2831853 / (0.55 * L), best = 1e5;
  for (int m = -1; m <= 1; m++){
    float j = j0 + float(m), ii = mod(j, N);
    uint hu = uint(ii) * 747796405u + uint(sd * 1000.0) * 2891336453u + 12345u;   // three 10-bit hashes
    hu = ((hu >> ((hu >> 28u) + 4u)) ^ hu) * 277803737u; hu ^= hu >> 22u;
    float h1 = float(hu & 1023u) / 1024.0, h2 = float((hu >> 10u) & 1023u) / 1024.0, h3 = float((hu >> 20u) & 1023u) / 1024.0;
    float th = (j + 0.5 + 0.4 * (h1 - 0.5)) * 6.2831853 / N;
    float Li = L * (0.7 + 0.6 * h2);
    float sl = clamp(s, 0.0, Li), f = sl / Li;
    vec2 rh = vec2(cos(th), sin(th));
    float be = 6.2831853 * h3;
    vec2 e1 = rh * cos(be) + vec2(-rh.y, rh.x) * sin(be), e2 = vec2(-e1.y, e1.x);
    float fl = exp(-sl * 5.0);
    float p1 = kw * sl - q.w + 6.2831853 * h3, p2 = 1.37 * kw * sl - 0.75 * q.w + 6.2831853 * h1;
    float s1 = sin(p1), s2 = sin(p2);
    // centreline across the depth: flare off the rim, common trail, two sway waves; g = its slope
    vec2 c = rh * (k.y + 0.1 * (1.0 - fl)) + q.xy * (sl * sl * iL2) + e1 * (q.z * f * s1) + e2 * (0.6 * q.z * f * s2);
    vec2 g = rh * (0.5 * fl) + q.xy * (2.0 * sl * iL2) + e1 * (q.z * (s1 / Li + f * kw * cos(p1))) + e2 * (0.6 * q.z * (s2 / Li + f * 1.37 * kw * cos(p2)));
    vec2 dl = p.xz - c;
    float dy = s - sl, dg = dot(dl, g);
    float dd = abs(dy) > 0.0 ? sqrt(dot(dl, dl) + dy * dy) : sqrt(max(dot(dl, dl) - dg * dg / (1.0 + dot(g, g)), 0.0));
    best = min(best, dd - k.w * (1.0 - 0.75 * f));
  }
  return best;
}
// Model = a run of primitives combined in order: 0 union, 1 smooth union, 2 subtract, 3 smooth subtract,
// 4 intersect, 5 shell everything so far. The zone (material region) of the dominant primitive is reported.
float sdfModel(vec3 p, int start, int count, out int zone){
  float d = 1e5;
  zone = 0;
  for (int i = uZero; i < count; i++){
    int row = start + i;
    vec4 a = texelFetch(tPrim, ivec2(0, row), 0);
    vec4 e = texelFetch(tPrim, ivec2(3, row), 0);
    int code = int(a.w + 0.5);
    int ty = code & 15, op = (code >> 4) & 15, zn = code >> 8;
    if (op == 5){ d = abs(d) - e.x; continue; }
    float db = length(p - a.xyz) - e.y;
    if (op <= 1 && db > d + e.x) continue;
    if ((op == 2 || op == 3) && db >= e.x - d) continue;
    vec4 q = texelFetch(tPrim, ivec2(1, row), 0);
    vec4 k = texelFetch(tPrim, ivec2(2, row), 0);
    float pd;
    if (ty == 11){
      float bt; vec3 bi, bg;
      pd = sdBezTube(p - a.xyz, q.xyz, k.xyz, q.w, k.w, bt, bi, bg);
      if (pd < d){ gBezU = mix(e.z, e.w, bt); gBezR = mix(q.w, k.w, bt); gBezIn = bi; gBezT = bg; }
    } else if (ty == 12){
      // strands fill an annulus about the axis (once the common trail is taken out): a cheap bound first
      vec3 pl = p - a.xyz;
      float sdep = clamp(0.65 * k.z - pl.y, 0.0, 1.3 * k.z), iL2 = 1.0 / (k.z * k.z);
      float rr = length(pl.xz - q.xy * (sdep * sdep * iL2));
      float sw = 1.6 * q.z + 0.02 + length(q.xy) * max(sdep * sdep * iL2 - 0.49, 0.0);
      float lb = max(max(k.y - sw - rr, rr - k.y - 0.1 - sw), abs(pl.y) - 0.65 * k.z) - k.w;
      if (lb > d + e.x) continue;
      pd = sdStrands(pl, q, k);
    }
    else pd = primSDF(ty, qrot(vec4(-q.xyz, q.w), p - a.xyz), k);
    if (op == 0){ if (pd < d){ d = pd; zone = zn; } }
    else if (op == 1){ if (pd < d) zone = zn; d = smin(d, pd, e.x); }
    else if (op == 2){ if (-pd > d){ d = -pd; zone = zn; } }
    else if (op == 3){ if (-pd > d) zone = zn; d = smax(d, -pd, e.x); }
    else d = max(d, pd);
  }
  return d;
}
// body-wave warp for swimming fish (model units, head toward +x): m7 = (amplitude, phase, wavenumber, turn bend)
vec3 modelWarp(vec3 p, vec4 m6, vec4 m7){
  if (m6.z < 0.5) return p;
  float env = smoothstep(0.2, -0.55, p.x);
  p.z -= m7.x * env * env * sin(m7.z * p.x - m7.y) + m7.w * p.x * p.x;
  return p;
}
// model object SDF in its local frame: uniform scale k.x, primitive run m6.xy, warp m6.z / m7
float sdfModelObj(vec3 lp, vec4 k, vec4 m6, vec4 m7, out int zone){
  return sdfModel(modelWarp(lp / k.x, m6, m7), int(m6.x + 0.5), int(m6.y + 0.5), zone) * k.x;
}

// ---------------- objects ----------------
float sdfObj(int type, vec3 p, vec4 k){
  if (type == 1){ vec3 q = abs(p) - k.xyz + k.w; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - k.w; }
  if (type == 3){ vec2 d = vec2(length(p.xz), abs(p.y)) - vec2(k.x, k.y) + k.z; return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - k.z; }
  if (type == 4){ vec2 q = vec2(length(p.xz) - k.x, p.y); return length(q) - k.y; }
  return length(p) - k.x;
}
vec3 sdfNormal(int type, vec3 p, vec4 k){
  const vec2 e = vec2(0.0007, -0.0007);
  return normalize(e.xyy*sdfObj(type, p + e.xyy, k) + e.yyx*sdfObj(type, p + e.yyx, k)
                 + e.yxy*sdfObj(type, p + e.yxy, k) + e.xxx*sdfObj(type, p + e.xxx, k));
}
float capIsect(vec3 ro, vec3 rd, float L, float r){
  vec3 pa = vec3(0.0, -L, 0.0), pb = vec3(0.0, L, 0.0);
  vec3 ba = pb - pa, oa = ro - pa;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa), rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  float a = baba - bard*bard, b = baba*rdoa - baoa*bard, c = baba*oaoa - baoa*baoa - r*r*baba;
  float h = b*b - a*c;
  if (h >= 0.0){
    float t = (-b - sqrt(h)) / a;
    float y = baoa + t*bard;
    if (y > 0.0 && y < baba) return t;
    vec3 oc = (y <= 0.0) ? oa : ro - pb;
    b = dot(rd, oc); c = dot(oc, oc) - r*r; h = b*b - c;
    if (h > 0.0) return -b - sqrt(h);
  }
  return -1.0;
}
float eliIsect(vec3 ro, vec3 rd, vec3 ra){
  vec3 o = ro / ra, d = rd / ra;
  float a = dot(d, d), b = dot(o, d), c = dot(o, o);
  float h = b*b - a*(c - 1.0);
  if (h < 0.0) return -1.0;
  return (-b - sqrt(h)) / a;
}

// gOpaqueOnly: shadow / photon / laser queries skip see-through things (jellyfish) and model normals
bool gOpaqueOnly = false;
int gZoneTmp = 0, gHitZone = 0;   // material zone at the last model hit / at the nearest one
vec4 gHitBez = vec4(0.0); vec3 gHitBezT = vec3(1.0, 0.0, 0.0), gHitBezIn = vec3(0.0);   // Bezier tube shading data there
// Ray vs object i.  nW = world normal, lp = local hit point
bool hitObject(int i, vec3 ro, vec3 rd, float tmax, out float tHit, out vec3 nW, out vec3 lp){
  vec4 t0 = texelFetch(tObj, ivec2(0, i), 0);
  vec3 oc = ro - t0.xyz;
  float b = dot(oc, rd), c = dot(oc, oc) - t0.w*t0.w, h = b*b - c;
  if (h < 0.0) return false;
  h = sqrt(h);
  float tn = -b - h, tf = -b + h;
  if (tf < 0.0 || tn > tmax) return false;
  vec4 r0 = texelFetch(tObj, ivec2(1, i), 0);
  vec4 r1 = texelFetch(tObj, ivec2(2, i), 0);
  vec4 r2 = texelFetch(tObj, ivec2(3, i), 0);
  vec4 k  = texelFetch(tObj, ivec2(4, i), 0);
  vec3 lo = vec3(dot(r0.xyz, oc), dot(r1.xyz, oc), dot(r2.xyz, oc));
  vec3 ld = vec3(dot(r0.xyz, rd), dot(r1.xyz, rd), dot(r2.xyz, rd));
  int type = int(r0.w + 0.5);
  float t = -1.0;
  vec3 nl = vec3(0.0, 1.0, 0.0);
  if (type == 6){
    // sphere-trace the primitive table; after the hit the same loop takes the four tetrahedral
    // samples of the gradient (skipped for shadow / photon queries) - a single call site for the SDF
    vec4 m6 = texelFetch(tObj, ivec2(6, i), 0), m7 = texelFetch(tObj, ivec2(7, i), 0);
    float tt = max(tn, 0.0), te = min(tf, tmax);
    float sc = m6.z > 0.5 ? 0.75 : abs(m6.w - 13.0) < 0.5 ? 0.8 : 0.95;   // fish bend, jellyfish strands: shorter steps
    int stage = 0, zz;
    vec3 hp = vec3(0.0), ng = vec3(0.0);
    for (int s = uZero; s < 100; s++){
      vec3 e = vec3(float(((stage + 2) >> 1) & 1), float(((stage - 1) >> 1) & 1), float((stage - 1) & 1)) * 2.0 - 1.0;
      vec3 q = stage == 0 ? lo + ld * tt : hp + e * (0.0004 * k.x);
      float d = sdfModelObj(q, k, m6, m7, zz);
      if (stage == 0){
        if (d < 0.0003 + tt * 0.00015){
          t = tt; hp = q; gZoneTmp = zz;
          if (gOpaqueOnly) break;
          stage = 1;
        } else {
          tt += d * sc;
          if (tt > te || s >= 95) break;
        }
      } else {
        ng += e * d;
        if (++stage > 4) break;
      }
    }
    if (t > 0.0 && !gOpaqueOnly) nl = normalize(ng + vec3(0.0, 1e-9, 0.0));
  } else if (type == 0){
    t = tn > 1e-4 ? tn : -1.0;
    if (t > 0.0) nl = normalize(lo + ld*t);
  } else if (type == 2){
    t = capIsect(lo, ld, k.x, k.y);
    if (t > 0.0){ vec3 p = lo + ld*t; nl = normalize(p - vec3(0.0, clamp(p.y, -k.x, k.x), 0.0)); }
  } else if (type == 5){
    t = eliIsect(lo, ld, k.xyz);
    if (t > 0.0){ vec3 p = lo + ld*t; nl = normalize(p / (k.xyz*k.xyz)); }
  } else {
    float tt = max(tn, 0.0), te = min(tf, tmax);
    for (int s = uZero; s < 64; s++){
      float d = sdfObj(type, lo + ld*tt, k);
      if (d < 0.0004){ t = tt; break; }
      tt += d;
      if (tt > te) break;
    }
    if (t > 0.0) nl = sdfNormal(type, lo + ld*t, k);
  }
  if (t <= 0.0 || t > tmax) return false;
  lp = lo + ld*t;
  nW = normalize(r0.xyz*nl.x + r1.xyz*nl.y + r2.xyz*nl.z);
  tHit = t;
  return true;
}
// nearest object along ray; returns index or -1
int nearestObject(vec3 ro, vec3 rd, inout float tmax, out vec3 nW, out vec3 lp){
  int id = -1;
  nW = vec3(0.0, 1.0, 0.0); lp = vec3(0.0);
  for (int i = uZero; i < uNumObj; i++){
    if (gOpaqueOnly && texelFetch(tObj, ivec2(2, i), 0).w > 9.5) continue;
    float t; vec3 n; vec3 l;
    gZoneTmp = 0;
    if (hitObject(i, ro, rd, tmax, t, n, l)){ tmax = t; id = i; nW = n; lp = l; gHitZone = gZoneTmp; gHitBez = vec4(gBezU, gBezR, 0.0, 0.0); gHitBezT = gBezT; gHitBezIn = gBezIn; }
  }
  return id;
}
`;

// sand heightfield lookup shared by several passes (simulation grid over the tank footprint)
const GLSL_SANDH = `
uniform sampler2D tSandH;
uniform vec4 uSandDom;   // -TX, -TZ, 1/(2TX), 1/(2TZ)
vec2 sandUV(vec2 xz){ return (xz - uSandDom.xy) * uSandDom.zw; }
float sandTop(vec2 xz){ return textureLod(tSandH, sandUV(xz), 0.0).r; }
`;
const GLSL_SANDPACK = `
float packSand(vec3 c){ vec3 q = floor(sqrt(clamp(c, 0.0, 1.0)) * 255.0 + 0.5); return q.r * 65536.0 + q.g * 256.0 + q.b; }
vec4 unpackSand(float code){
  float m = code < 0.0 ? 1.0 : 0.0;
  float q = code < 0.0 ? -code - 1.0 : code;
  vec3 s = vec3(floor(q / 65536.0), mod(floor(q / 256.0), 256.0), mod(q, 256.0)) / 255.0;
  return vec4(s * s, m);
}
`;

// ---------------------------------------------------------------------------
// Photon setup: one photon per grid vertex laid on the (virtual) sea surface
// o0 = entry point xyz, transmission;  o1 = slope x, slope z, t_hit, foam
// ---------------------------------------------------------------------------
SH.photon = GLSL_HEAD + GLSL_SCENE + `
uniform sampler2D tDisp;
uniform vec4 uPDom;
uniform float uPN, uFFTL, uFlatT;
uniform vec2 uPCell;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
float fftH(vec2 xz){
  vec2 x0 = xz;
  for (int i = 0; i < 4; i++){ vec4 d = textureLod(tDisp, x0 / uFFTL, 0.0); x0 = xz - d.yz; }
  return uLevel + textureLod(tDisp, x0 / uFFTL, 0.0).x;
}
void main(){
  gOpaqueOnly = true;
  vec2 uv = (gl_FragCoord.xy - 0.5) / (uPN - 1.0);
  vec2 xz = mix(uPDom.xy, uPDom.zw, uv);
  float h; vec2 sl; float foam = 0.0;
  if (inFoot(xz)){
    // band-limit slopes to the photon spacing (prevents caustic aliasing / sparkle noise)
    vec4 s = surfAt(xz); h = s.x; foam = s.w;
    vec2 acc = vec2(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
      vec2 o = vec2(float(i), float(j)) * uPCell * 0.5;
      float w = (i == 0 ? 2.0 : 1.0) * (j == 0 ? 2.0 : 1.0);
      acc += surfAt(xz + o).yz * w;
    }
    sl = acc / 16.0;
  } else {
    float e = 0.012;
    h = fftH(xz);
    sl = vec2(fftH(xz + vec2(e, 0.0)) - fftH(xz - vec2(e, 0.0)), fftH(xz + vec2(0.0, e)) - fftH(xz - vec2(0.0, e))) / (2.0*e);
  }
  vec3 p = vec3(xz.x, h, xz.y);
  vec3 n = normalize(vec3(-sl.x, 1.0, -sl.y));
  // incident propagation direction: parallel sun rays, or diverging rays from the lamp
  vec3 Li = -uSunDir;
  float tA = 60.0;
  float T;
  if (uLampMode == 1){
    vec3 d = p - uLampPos[uLampSel];
    float d2 = dot(d, d);
    Li = d * inversesqrt(d2);
    tA = sqrt(d2) - 0.04;
    float ci = dot(n, -Li);
    // horizontal irradiance per unit lamp intensity: spot * cos / r^2, times Fresnel transmission
    T = ci > 0.0 ? (1.0 - fresnelDielectric(ci, 1.0, 1.333)) * lampSpot(uLampSel, Li) * max(-Li.y, 0.0) / d2 : 0.0;
  } else {
    float ci = dot(n, uSunDir);
    T = ci > 0.0 ? (1.0 - fresnelDielectric(ci, 1.0, 1.333)) / uFlatT : 0.0;
  }
  T *= 1.0 - 0.85 * clamp(foam, 0.0, 1.0);
  // two object queries through one call site: air-side occlusion (floating objects shade the
  // surface), then the first hit underwater along the refracted ray
  vec3 dw = refract(Li, n, 1.0/1.333);
  float tw = 20.0;
  for (int qi = uZero; qi < 2; qi++){
    if (qi == 0 && T <= 0.0) continue;
    vec3 nn; vec3 ll;
    float tq = qi == 0 ? tA : 20.0;
    int hid = nearestObject(qi == 0 ? p + n*0.003 : p - n*0.002, qi == 0 ? -Li : dw, tq, nn, ll);
    if (qi == 0){ if (hid >= 0) T = 0.0; }
    else tw = tq;
  }
  // non-finite test on the bits (compilers may fold NaN comparisons away, and D3D's min() turns NaN into its other operand)
  if ((floatBitsToUint(T) & 0x7F800000u) == 0x7F800000u || T < 0.0) T = 0.0;
  o0 = vec4(p, min(T, 25.0));
  o1 = vec4(sl, tw, foam);
}`;

// Caustic slice: photon grid mesh projected to a horizontal plane at uSliceY
SH.causVS = GLSL_HEAD + `
uniform sampler2D tP0, tP1, tSandR;
uniform int uPN, uFloorSand;
uniform float uSliceY, uIor, uLevel, uSandMax;
uniform vec3 uSunDir, uLwFlat, uLampPos;
uniform int uLampMode;
uniform vec4 uTank, uSandDom;
float bedAt(vec2 xz){ return uSliceY + textureLod(tSandR, (xz - uSandDom.xy) * uSandDom.zw, 0.0).r; }
out vec2 vOld, vNew;
out float vW, vDist;
void main(){
  ivec2 c = ivec2(gl_VertexID % uPN, gl_VertexID / uPN);
  vec4 a = texelFetch(tP0, c, 0);
  vec4 b = texelFetch(tP1, c, 0);
  vec3 p = a.xyz;
  vec3 n = normalize(vec3(-b.x, 1.0, -b.y));
  vec3 Li = uLampMode == 1 ? normalize(p - uLampPos) : -uSunDir;
  vec3 d = refract(Li, n, 1.0 / uIor);
  if (dot(d, d) < 0.5) d = vec3(0.0, -1.0, 0.0);
  float t = (uSliceY - p.y) / min(d.y, -1e-3);
  t = max(t, 0.0);
  if (uFloorSand == 1 && uSandMax > 0.002){
    // bed pass: land the refracted photon on the sand surface instead of the tank floor
    float ta = max((uSliceY + uSandMax - p.y) / min(d.y, -1e-3), 0.0), tb = t;
    float st = max(tb - ta, 0.0) / 10.0, tt = ta;
    for (int i = 0; i < 10; i++){
      vec3 q = p + d * (tt + st);
      if (q.y < bedAt(q.xz)) break;
      tt += st;
    }
    float a0 = tt, b0 = min(tt + st, tb);
    for (int k = 0; k < 5; k++){
      float m = 0.5 * (a0 + b0);
      vec3 q = p + d * m;
      if (q.y < bedAt(q.xz)) b0 = m; else a0 = m;
    }
    t = 0.5 * (a0 + b0);
  }
  float vis = t < b.z ? 1.0 : 0.0;
  vec3 q = p + d*t;
  float tf = (uSliceY - uLevel) / uLwFlat.y;
  // sun: area ratio relative to the flat-water beam (dimensionless); lamp: relative to the
  // horizontal surface cell, so the value is the absolute horizontal irradiance incl. beam spreading,
  // converted to irradiance perpendicular to this photon's own propagation direction
  vOld = uLampMode == 1 ? p.xz : p.xz + uLwFlat.xz * tf;
  vNew = q.xz;
  float w0 = (floatBitsToUint(a.w) & 0x7F800000u) == 0x7F800000u ? 0.0 : a.w;
  vW = clamp(w0, 0.0, 25.0) * vis * (uLampMode == 1 ? 1.0 / max(-d.y, 0.2) : 1.0);
  vDist = t;
  gl_Position = vec4(q.x / uTank.x, q.z / uTank.y, 0.0, 1.0);
}`;
SH.causFS = GLSL_HEAD + `
uniform vec3 uSigT, uMask;
in vec2 vOld, vNew;
in float vW, vDist;
out vec4 o;
void main(){
  vec2 ox = dFdx(vOld), oy = dFdy(vOld), nx = dFdx(vNew), ny = dFdy(vNew);
  float aO = abs(ox.x*oy.y - ox.y*oy.x);
  float aN = abs(nx.x*ny.y - nx.y*ny.x);
  float I = aO / max(aN, 1e-14);
  if ((floatBitsToUint(I) & 0x7F800000u) == 0x7F800000u) I = 0.0;   // before min(): D3D's min() would turn NaN into 24
  I = min(I, 24.0);
  vec3 v = uMask * (I * vW) * exp(-uSigT * vDist);
  o = vec4(any(equal(floatBitsToUint(v) & 0x7F800000u, uvec3(0x7F800000u))) ? vec3(0.0) : v, 1.0);
}`;

// ---------------------------------------------------------------------------
// Sky: equirect HDR environment with sun glow and drifting cumulus
// ---------------------------------------------------------------------------
const GLSL_NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3){ p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
  return mix(mix(hash12(i), hash12(i + vec2(1,0)), u.x), mix(hash12(i + vec2(0,1)), hash12(i + vec2(1,1)), u.x), u.y);
}
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.0 - 2.0*f);
  float a = mix(mix(hash13(i), hash13(i+vec3(1,0,0)), u.x), mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), u.x), u.y);
  float b = mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), u.x), mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), u.x), u.y);
  return mix(a, b, u.z);
}
float fbm2(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++){ s += a*vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6)*p; a *= 0.5; } return s; }
`;

const GLSL_SKY = `
uniform float uCloud, uSkyGain, uNight;
vec3 skyRadiance(vec3 d, vec3 s, float time){
  if (uNight > 0.5){
    // dark studio: faint cool gradient, no sun
    float yy = max(d.y, 0.0);
    vec3 c = mix(vec3(0.020, 0.021, 0.026), vec3(0.006, 0.007, 0.011), pow(yy, 0.45));
    if (d.y < 0.0) c = mix(vec3(0.020, 0.021, 0.026), vec3(0.008), smoothstep(0.0, 0.1, -d.y));
    return c * uSkyGain;
  }
  float sunH = s.y;
  float y = max(d.y, 0.0);
  float mu = dot(d, s);
  vec3 zen = mix(vec3(0.020, 0.050, 0.140), vec3(0.090, 0.230, 0.620), smoothstep(-0.05, 0.45, sunH));
  vec3 hor = mix(vec3(0.520, 0.300, 0.160), vec3(0.540, 0.680, 0.880), smoothstep(-0.02, 0.35, sunH));
  vec3 col = mix(hor, zen, pow(y, 0.42));
  col *= 0.85 + 0.35 * mu * mu;
  float m = max(mu, 0.0);
  vec3 sunTint = mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.92, 0.80), smoothstep(0.0, 0.4, sunH));
  col += sunTint * (0.10*pow(m, 6.0) + 0.35*pow(m, 48.0) + 1.6*pow(m, 700.0)) * (1.0 - 0.6*y);
  // horizon haze band
  col = mix(col, hor * 1.1, exp(-y * 16.0) * 0.4);
  if (d.y > 0.004){
    vec2 cp = d.xz / (d.y + 0.06) * 1.35 + vec2(time * 0.012, time * 0.004);
    float n = fbm2(cp * 1.3);
    float cov = mix(0.62, 0.40, uCloud);
    float cl = smoothstep(cov, cov + 0.22, n);
    float nl = fbm2(cp * 1.3 + s.xz * 0.12);
    float lit = clamp(0.55 + (n - nl) * 5.0, 0.15, 1.2);
    vec3 cc = mix(vec3(0.46, 0.50, 0.58), vec3(1.05, 1.0, 0.95) * sunTint, lit) * (0.55 + 0.6 * smoothstep(-0.05, 0.5, sunH));
    cc += sunTint * pow(m, 12.0) * 0.8 * (1.0 - cl);
    float fade = smoothstep(0.0, 0.18, d.y);
    col = mix(col, cc, cl * fade * 0.92);
  }
  if (d.y < 0.0){
    vec3 gnd = vec3(0.10, 0.10, 0.105) * (0.3 + 0.7 * max(sunH, 0.0)) + zen * 0.12;
    col = mix(hor * 1.1, gnd, smoothstep(0.0, 0.08, -d.y));
  }
  return col * uSkyGain;
}
`;

SH.sky = GLSL_HEAD + GLSL_NOISE + GLSL_SKY + `
uniform vec3 uSunDir;
uniform float uTime;
in vec2 vUv;
out vec4 o;
void main(){
  float phi = (vUv.x - 0.5) * 2.0 * PI_S;
  float th = (1.0 - vUv.y) * PI_S;
  vec3 d = vec3(sin(th) * cos(phi), cos(th), sin(th) * sin(phi));
  o = vec4(skyRadiance(d, uSunDir, uTime), 1.0);
}`.replace('uniform vec3 uSunDir;', '#define PI_S 3.14159265359\nuniform vec3 uSunDir;');
