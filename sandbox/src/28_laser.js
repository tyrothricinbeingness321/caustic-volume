// ============================================================================
//  LASER BEAM TREE — one fragment per node of a binary tree (depth 6, 63 nodes).
//  A node's index spells its path from the emitter: at every interface bit 0
//  takes the reflected branch and bit 1 the transmitted one, each weighted by
//  Fresnel (total internal reflection sends everything down the reflected
//  branch). Output: segment start + power, segment end + medium (+2 if it ends
//  on a diffuse surface, where it makes a spot).
// ============================================================================
SH.laser = GLSL_HEAD + GLSL_SCENE + GLSL_SANDH + `
uniform vec3 uLzO, uLzD;
uniform int uLzMed;
uniform float uLzMaxSlope, uLzSandMax, uLzExtW;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
float lzHF(vec3 ro, vec3 rd, float t0, float t1, float sgn){
  float lip = abs(rd.y) + uLzMaxSlope * length(rd.xz);
  float t = t0;
  vec3 p = ro + rd * t;
  float f = sgn * (p.y - waterH(p.xz));
  if (f <= 0.0) return t0 + 1e-5;
  float tp = t;
  for (int i = uZero; i < 240; i++){
    t += max(max(f / lip, 0.0008), (t1 - t) / float(240 - i));
    bool last = t >= t1;
    if (last) t = t1;
    p = ro + rd * t;
    f = sgn * (p.y - waterH(p.xz));
    if (f < 0.0){
      float a = tp, b = t;
      for (int k = 0; k < 12; k++){ float m = 0.5 * (a + b); vec3 q = ro + rd * m; if (sgn * (q.y - waterH(q.xz)) > 0.0) a = m; else b = m; }
      return 0.5 * (a + b);
    }
    if (last) break;
    tp = t;
  }
  return -1.0;
}
float lzSand(vec3 ro, vec3 rd, float t0, float t1){
  float t = t0;
  vec3 p = ro + rd * t;
  float f = p.y - uTank.z - sandTop(p.xz);
  if (f <= 0.0) return t0 + 1e-5;
  float tp = t, lip = abs(rd.y) + 1.2 * length(rd.xz);
  for (int i = uZero; i < 96; i++){
    t += max(max(f / lip, 0.001), (t1 - t) / float(96 - i));
    bool last = t >= t1;
    if (last) t = t1;
    p = ro + rd * t;
    f = p.y - uTank.z - sandTop(p.xz);
    if (f < 0.0){
      float a = tp, b = t;
      for (int k = 0; k < 8; k++){ float m = 0.5 * (a + b); vec3 q = ro + rd * m; if (q.y - uTank.z - sandTop(q.xz) > 0.0) a = m; else b = m; }
      return 0.5 * (a + b);
    }
    if (last) break;
    tp = t;
  }
  return -1.0;
}
// kind: 0 escapes, 1 water surface, 2 glass wall, 3 bed / floor, 4 object
void lzTrace(vec3 ro, vec3 rd, int med, out float tH, out int kind, out vec3 nH, out int obj){
  tH = 30.0; kind = 0; nH = vec3(0.0, 1.0, 0.0); obj = -1;
  float TX = uTank.x, TZ = uTank.y, BOT = uTank.z, TOP = uTank.w;
  if (med == 1){
    if (abs(rd.x) > 1e-7){ float sx = rd.x > 0.0 ? 1.0 : -1.0; float t = (sx * TX - ro.x) / rd.x; if (t > 1e-5 && t < tH){ tH = t; kind = 2; nH = vec3(sx, 0.0, 0.0); } }
    if (abs(rd.z) > 1e-7){ float sz = rd.z > 0.0 ? 1.0 : -1.0; float t = (sz * TZ - ro.z) / rd.z; if (t > 1e-5 && t < tH){ tH = t; kind = 2; nH = vec3(0.0, 0.0, sz); } }
    if (rd.y < -1e-7){ float t = (BOT - ro.y) / rd.y; if (t > 1e-5 && t < tH){ tH = t; kind = 3; nH = vec3(0.0, 1.0, 0.0); } }
    if (uLzSandMax > 0.002){
      float top = BOT + uLzSandMax, t0 = 0.0, t1 = tH;
      if (ro.y > top) t0 = rd.y < -1e-6 ? (top - ro.y) / rd.y : 1e9;
      else if (rd.y > 1e-6) t1 = min(t1, (top - ro.y) / rd.y);
      if (t0 < t1){ float ts = lzSand(ro, rd, t0, t1); if (ts > 0.0){ tH = ts; kind = 3; } }
    }
  } else {
    for (int a = 0; a < 2; a++){
      for (int s = 0; s < 2; s++){
        float sg = s == 0 ? -1.0 : 1.0;
        float den = a == 0 ? rd.x : rd.z;
        if (abs(den) < 1e-7) continue;
        float t = a == 0 ? (sg * TX - ro.x) / den : (sg * TZ - ro.z) / den;
        if (t > 1e-4 && t < tH){
          vec3 p = ro + rd * t;
          bool inR = a == 0 ? abs(p.z) <= TZ : abs(p.x) <= TX;
          if (inR && p.y >= 0.0 && p.y <= TOP){ tH = t; kind = 2; nH = a == 0 ? vec3(sg, 0.0, 0.0) : vec3(0.0, 0.0, sg); }
        }
      }
    }
    if (rd.y < -1e-6){ float t = -ro.y / rd.y; if (t > 1e-4 && t < tH){ tH = t; kind = 3; nH = vec3(0.0, 1.0, 0.0); } }
  }
  // water surface (from above in air, from below in water)
  {
    vec3 inv = 1.0 / (vec3(rd.x >= 0.0 ? 1.0 : -1.0, rd.y >= 0.0 ? 1.0 : -1.0, rd.z >= 0.0 ? 1.0 : -1.0) * max(abs(rd), vec3(1e-8)));
    vec3 b0 = (vec3(-uTank.x, uLevel - uAmp, -uTank.y) - ro) * inv, b1 = (vec3(uTank.x, uLevel + uAmp, uTank.y) - ro) * inv;
    vec3 lo = min(b0, b1), hi = max(b0, b1);
    float tn = max(max(lo.x, max(lo.y, lo.z)), 0.0), tf = min(min(hi.x, min(hi.y, hi.z)), tH);
    if (tn < tf){ float t = lzHF(ro, rd, tn, tf, med == 0 ? 1.0 : -1.0); if (t > 0.0){ tH = t; kind = 1; } }
  }
  vec3 nn, ll;
  float tm = tH;
  int id = nearestObject(ro, rd, tm, nn, ll);
  if (id >= 0){ tH = tm; kind = 4; nH = nn; obj = id; }
}
void main(){
  gOpaqueOnly = true;
  int node = int(gl_FragCoord.x) + 1;
  int depth = 0;
  for (int b = 1; b < 7; b++) if ((node >> b) > 0) depth = b;
  vec3 ro = uLzO, rd = normalize(uLzD);
  int med = uLzMed;
  float P = 1.0;
  o0 = vec4(0.0); o1 = vec4(0.0);
  for (int L = uZero; L < 7; L++){
    float tH; int kind; vec3 nH; int obj;
    lzTrace(ro, rd, med, tH, kind, nH, obj);
    vec3 pe = ro + rd * tH;
    bool mirror = false, glassBall = false;
    if (kind == 4){
      int mc = int(texelFetch(tObj, ivec2(2, obj), 0).w + 0.5), ty = int(texelFetch(tObj, ivec2(1, obj), 0).w + 0.5);
      mirror = mc == 0; glassBall = mc == 3 && ty == 0;
    }
    if (L == depth){
      bool spot = kind == 3 || (kind == 4 && !mirror && !glassBall);
      o0 = vec4(ro, P);
      o1 = vec4(pe, float(med) + (spot ? 2.0 : 0.0));
      return;
    }
    if (med == 1) P *= exp(-uLzExtW * tH);
    int bit = (node >> (depth - 1 - L)) & 1;   // 0 reflect, 1 transmit
    vec3 nro = pe, nrd = rd;
    int nmed = med;
    float w = 0.0;
    if (kind == 1){
      // the beam crosses the moving surface where it is, but refracts at the mean (level) surface,
      // so waves don't swing it around: a steady, solid beam
      vec3 ns = vec3(0.0, 1.0, 0.0);
      vec3 ni = med == 0 ? ns : -ns;
      float n1 = med == 0 ? 1.0 : 1.333, n2 = med == 0 ? 1.333 : 1.0;
      vec3 tt = refract(rd, ni, n1 / n2);
      float F = dot(tt, tt) < 0.5 ? 1.0 : fresnelDielectric(max(-dot(rd, ni), 0.0), n1, n2);
      if (bit == 0){ w = F; nrd = reflect(rd, ni); nro = pe + ni * 1e-3; }
      else { w = 1.0 - F; nrd = tt; nro = pe - ni * 1e-3; nmed = 1 - med; }
    } else if (kind == 2){
      vec2 xi = clamp(pe.xz, -uTank.xy + 0.002, uTank.xy - 0.002);
      vec3 ni = dot(rd, nH) < 0.0 ? nH : -nH;
      if (pe.y < waterH(xi) && pe.y > uTank.z){
        // thin glass between air and water: refracts as air <-> water, plus the glass's own reflection
        float n1 = med == 0 ? 1.0 : 1.333, n2 = med == 0 ? 1.333 : 1.0;
        vec3 tt = refract(rd, ni, n1 / n2);
        float F = dot(tt, tt) < 0.5 ? 1.0 : min(fresnelDielectric(max(-dot(rd, ni), 0.0), n1, n2) + 0.035, 1.0);
        if (bit == 0){ w = F; nrd = reflect(rd, ni); nro = pe + ni * 1e-3; }
        else { w = 1.0 - F; nrd = tt; nro = pe - ni * 1e-3; nmed = 1 - med; }
      } else {
        float F = 0.08;
        if (bit == 0){ w = F; nrd = reflect(rd, ni); nro = pe + ni * 1e-3; }
        else { w = 1.0 - F; nro = pe - ni * 1e-3; }
      }
    } else if (kind == 4 && mirror){
      if (bit == 0){ w = 0.85; nrd = reflect(rd, nH); nro = pe + nH * 1e-3; }
    } else if (kind == 4 && glassBall){
      vec4 b0 = texelFetch(tObj, ivec2(0, obj), 0);
      float n1 = med == 1 ? 1.333 : 1.0;
      float F = fresnelDielectric(max(-dot(rd, nH), 0.0), n1, 1.5);
      if (bit == 0){ w = F; nrd = reflect(rd, nH); nro = pe + nH * 1e-3; }
      else {
        vec3 t1 = refract(rd, nH, n1 / 1.5);
        vec3 oc = pe - b0.xyz;
        float bb = dot(oc, t1), cc = dot(oc, oc) - b0.w * b0.w;
        float tex = -bb + sqrt(max(bb * bb - cc, 0.0));
        vec3 q = pe + t1 * tex, nq = normalize(q - b0.xyz);
        vec3 t2 = refract(t1, -nq, 1.5 / n1);
        if (dot(t2, t2) > 0.5){ w = (1.0 - F) * (1.0 - fresnelDielectric(max(dot(t1, nq), 0.0), 1.5, n1)); nrd = t2; nro = q + nq * 1e-3; }
      }
    }
    P *= w;
    if (P < 0.002) return;
    ro = nro; rd = normalize(nrd); med = nmed;
  }
}`;
