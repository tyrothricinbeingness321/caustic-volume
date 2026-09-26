// ============================================================================
//  SIMULATION SHADERS — FFT ocean, iWave ripple layer, surface composition
// ============================================================================
const GLSL_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
`;

const SH = {};

// Full-screen triangle; vUv in [0,1]
SH.fsVS = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  vUv = p;
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// Spectrum time evolution:  h(k,t) = h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}
// Output packs two complex fields:  A = h + i*Dx ,  B = Dz
// ---------------------------------------------------------------------------
SH.spectrum = GLSL_HEAD + `
uniform sampler2D tH0;
uniform float uTime, uL, uDepth, uHScale;
uniform int uN;
out vec4 o;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  int mx = c.x < uN/2 ? c.x : c.x - uN;
  int mz = c.y < uN/2 ? c.y : c.y - uN;
  if (mx == -uN/2 || mz == -uN/2 || (mx == 0 && mz == 0)) { o = vec4(0.0); return; }
  vec4 h0 = texelFetch(tH0, c, 0) * uHScale;
  vec2 k = 6.28318530718 * vec2(float(mx), float(mz)) / uL;
  float kl = max(length(k), 1e-6);
  float w = sqrt(9.81 * kl * tanh(min(kl * uDepth, 20.0)));
  float cw = cos(w * uTime), sw = sin(w * uTime);
  vec2 a = h0.xy, b = h0.zw;
  vec2 h = vec2(a.x*cw - a.y*sw, a.x*sw + a.y*cw) + vec2(b.x*cw + b.y*sw, b.y*cw - b.x*sw);
  vec2 mih = vec2(h.y, -h.x);            // -i * h
  vec2 dx = mih * (k.x / kl);
  vec2 dz = mih * (k.y / kl);
  vec2 A = h + vec2(-dx.y, dx.x);        // h + i*dx
  o = vec4(A, dz);
}`;

// ---------------------------------------------------------------------------
// Stockham radix-2 inverse FFT pass (natural order in / out)
// ---------------------------------------------------------------------------
SH.fft = GLSL_HEAD + `
uniform sampler2D tIn;
uniform int uN, uNs, uHoriz;
out vec4 o;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  int j  = uHoriz == 1 ? c.x : c.y;
  int hs = uNs / 2;
  int e  = (j / uNs) * hs + (j % hs);
  int od = e + uN / 2;
  ivec2 ce = uHoriz == 1 ? ivec2(e, c.y)  : ivec2(c.x, e);
  ivec2 co = uHoriz == 1 ? ivec2(od, c.y) : ivec2(c.x, od);
  vec4 E = texelFetch(tIn, ce, 0);
  vec4 O = texelFetch(tIn, co, 0);
  float ang = 6.28318530718 * float(j % uNs) / float(uNs);
  vec2 w = vec2(cos(ang), sin(ang));
  o = vec4(E.xy + cmul(w, O.xy), E.zw + cmul(w, O.zw));
}`;

// ---------------------------------------------------------------------------
// Displacement finalize: (h, chop*Dx, chop*Dz, Jacobian)
// ---------------------------------------------------------------------------
SH.dispFinal = GLSL_HEAD + `
uniform sampler2D tIn;
uniform float uChop, uL;
uniform int uN;
out vec4 o;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  int N = uN;
  vec4 C = texelFetch(tIn, c, 0);
  vec4 R = texelFetch(tIn, ivec2((c.x + 1) % N, c.y), 0);
  vec4 L = texelFetch(tIn, ivec2((c.x - 1 + N) % N, c.y), 0);
  vec4 U = texelFetch(tIn, ivec2(c.x, (c.y + 1) % N), 0);
  vec4 D = texelFetch(tIn, ivec2(c.x, (c.y - 1 + N) % N), 0);
  float ih = float(N) / (2.0 * uL);
  float dxx = (R.y - L.y) * ih, dzz = (U.z - D.z) * ih;
  float dxz = (U.y - D.y) * ih, dzx = (R.z - L.z) * ih;
  float J = (1.0 + uChop*dxx) * (1.0 + uChop*dzz) - uChop*uChop*dxz*dzx;
  o = vec4(C.x, C.y * uChop, C.z * uChop, J);
}`;

// ---------------------------------------------------------------------------
// iWave ripple layer (Tessendorf) + foam transport.  State: (h, hPrev, foam, -)
// Grid covers the tank's inner footprint.  Neumann (reflecting) walls.
// ---------------------------------------------------------------------------
SH.ripple = GLSL_HEAD + `
uniform sampler2D tState, tDisp;
uniform float uKern[49];
uniform float uDt, uAlpha, uGrav, uCell, uLevel, uFFTL, uCouple, uFoamLife, uWhitecap, uJth, uSrc, uVisc;
uniform vec4 uTank;             // (TX, TZ, BOT, TOP)
uniform int uNumSph;
uniform vec4 uSphOld[48];
uniform vec4 uSphNew[48];
uniform int uNumImp;
uniform vec4 uImp[16];          // x, z, radius, depth (m)
in vec2 vUv;
out vec4 o;

// Smooth column occupied by a body proxy below the local water level (flat-top bump, no rim singularity)
float column(vec4 s, vec2 xz, float lvl){
  float t = length(xz - s.xz) / s.w;
  if (t > 1.6) return 0.0;
  float hc = s.w * exp(-pow(t * 1.1, 6.0));
  return clamp(lvl - (s.y - hc), 0.0, 2.0 * hc);
}
// Only bodies near the surface disturb it; deep bodies are hydrodynamically invisible to the free surface
float surfaceWeight(vec4 s, float lvl){ return clamp(1.0 - (lvl - (s.y + s.w)) / 0.18, 0.0, 1.0); }

void main(){
  ivec2 c  = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(tState, 0);
  vec4 st  = texelFetch(tState, c, 0);
  vec2 uv  = (vec2(c) + 0.5) / vec2(sz);
  vec2 xz  = mix(-uTank.xy, uTank.xy, uv);

  float vd = 0.0;
  for (int j = -6; j <= 6; j++){
    int yy = clamp(c.y + j, 0, sz.y - 1);
    for (int i = -6; i <= 6; i++){
      int xx = clamp(c.x + i, 0, sz.x - 1);
      vd += uKern[abs(i)*7 + abs(j)] * texelFetch(tState, ivec2(xx, yy), 0).x;
    }
  }
  vec4 nl = texelFetch(tState, ivec2(max(c.x-1,0), c.y), 0);
  vec4 nr = texelFetch(tState, ivec2(min(c.x+1,sz.x-1), c.y), 0);
  vec4 nd = texelFetch(tState, ivec2(c.x, max(c.y-1,0)), 0);
  vec4 nu = texelFetch(tState, ivec2(c.x, min(c.y+1,sz.y-1)), 0);

  float h = st.x, hp = st.y;
  float a = uAlpha * uDt;
  float hn = h * (2.0 - a) / (1.0 + a) - hp / (1.0 + a) - uGrav * vd / (1.0 + a);
  // viscous damping acts on the vertical velocity: kills grid-scale chop, leaves long waves alone
  float lapV = (nl.x - nl.y) + (nr.x - nr.y) + (nd.x - nd.y) + (nu.x - nu.y) - 4.0 * (h - hp);
  hn += uVisc * lapV;

  vec4 dsp = textureLod(tDisp, xz / uFFTL, 0.0);
  float lvl = uLevel + dsp.x + h;
  float churn = 0.0;
  float damp = 1.0;
  if (uSrc > 0.5){
    float src = 0.0;
    for (int i = 0; i < 48; i++){
      if (i >= uNumSph) break;
      vec4 so = uSphOld[i], sn = uSphNew[i];
      float w = 0.5 * (surfaceWeight(so, lvl) + surfaceWeight(sn, lvl));
      if (w <= 0.0) continue;
      src += (column(so, xz, lvl) - column(sn, xz, lvl)) * w;
    }
    src = clamp(src * uCouple, -0.008, 0.008);
    hn += src;
    churn += abs(src);
    for (int i = 0; i < 16; i++){
      if (i >= uNumImp) break;
      vec4 im = uImp[i];
      float r = length(xz - im.xy) / im.z;
      if (r < 1.0){
        float w = 0.5 + 0.5 * cos(3.14159265 * r);
        hn -= im.w * w;
        churn += im.w * w * 0.5;
      }
    }
  }
  for (int i = 0; i < 48; i++){
    if (i >= uNumSph) break;
    vec4 s = uSphNew[i];
    float t = length(xz - s.xz) / s.w;
    if (t < 1.0 && abs(lvl - s.y) < s.w) damp = min(damp, mix(0.9, 1.0, t * t));
  }
  hn *= damp; h *= damp;
  hn = 0.3 * tanh(hn / 0.3);

  // foam: decay + diffusion + whitecaps (FFT Jacobian) + steep ripples + agitation near moving bodies
  float fAvg = 0.25 * (nl.z + nr.z + nd.z + nu.z);
  float foam = mix(st.z, fAvg, 0.08) * exp(-uDt / uFoamLife);
  foam += uWhitecap * max(0.0, uJth - dsp.w) * uDt * 6.0;
  float grad = length(vec2(nr.x - nl.x, nu.x - nd.x)) / (2.0 * uCell);
  foam += max(0.0, grad - 0.5) * uDt * 3.0;
  foam += max(churn - 0.001, 0.0) * 5.0;
  foam = clamp(foam, 0.0, 1.2);
  o = vec4(hn, h, foam, 0.0);
}`;

// ---------------------------------------------------------------------------
// Height composition: invert the choppy displacement, add ripples.
// Output (height, foam, jacobian, rippleH)
// ---------------------------------------------------------------------------
SH.compose = GLSL_HEAD + `
uniform sampler2D tDisp, tState;
uniform vec4 uTank;
uniform float uLevel, uFFTL, uEdge;
in vec2 vUv;
out vec4 o;
vec4 bw(float f){ float f2 = f*f, f3 = f2*f; return vec4((1.0 - 3.0*f + 3.0*f2 - f3), (4.0 - 6.0*f2 + 3.0*f3), (1.0 + 3.0*f + 3.0*f2 - 3.0*f3), f3) / 6.0; }
vec4 rippleCubic(vec2 uv){
  ivec2 sz = textureSize(tState, 0);
  vec2 p = uv * vec2(sz) - 0.5;
  ivec2 i0 = ivec2(floor(p));
  vec2 f = p - floor(p);
  vec4 wx = bw(f.x), wy = bw(f.y);
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++){
    int yy = clamp(i0.y - 1 + j, 0, sz.y - 1);
    vec4 row = wx.x * texelFetch(tState, ivec2(clamp(i0.x - 1, 0, sz.x - 1), yy), 0)
             + wx.y * texelFetch(tState, ivec2(clamp(i0.x,     0, sz.x - 1), yy), 0)
             + wx.z * texelFetch(tState, ivec2(clamp(i0.x + 1, 0, sz.x - 1), yy), 0)
             + wx.w * texelFetch(tState, ivec2(clamp(i0.x + 2, 0, sz.x - 1), yy), 0);
    acc += row * wy[j];
  }
  return acc;
}
void main(){
  vec2 xz = mix(-uTank.xy, uTank.xy, vUv);
  vec2 x0 = xz;
  for (int i = 0; i < 5; i++){
    vec4 d = textureLod(tDisp, x0 / uFFTL, 0.0);
    x0 = xz - d.yz;
  }
  vec4 d  = textureLod(tDisp, x0 / uFFTL, 0.0);
  vec4 st = rippleCubic(vUv);
  // soften the ocean spectrum right at the glass (boundary layer)
  vec2 e = (uTank.xy - abs(xz));
  float wall = smoothstep(0.0, uEdge, min(e.x, e.y));
  float hf = d.x * mix(0.55, 1.0, wall);
  o = vec4(uLevel + hf + st.x, st.z, d.w, st.x);
}`;

// Slopes by central differences -> tSurf (height, dh/dx, dh/dz, foam)
SH.slopes = GLSL_HEAD + `
uniform sampler2D tHeight;
uniform vec2 uCell;
out vec4 o;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 s = textureSize(tHeight, 0) - 1;
  vec4 C = texelFetch(tHeight, c, 0);
  float l = texelFetch(tHeight, clamp(c - ivec2(1,0), ivec2(0), s), 0).x;
  float r = texelFetch(tHeight, clamp(c + ivec2(1,0), ivec2(0), s), 0).x;
  float d = texelFetch(tHeight, clamp(c - ivec2(0,1), ivec2(0), s), 0).x;
  float u = texelFetch(tHeight, clamp(c + ivec2(0,1), ivec2(0), s), 0).x;
  float fx = (c.x == 0 || c.x == s.x) ? 1.0 : 2.0;
  float fz = (c.y == 0 || c.y == s.y) ? 1.0 : 2.0;
  vec2 sl = vec2((r - l) / (fx * uCell.x), (u - d) / (fz * uCell.y));
  float m = length(sl);
  if (m > 2.5) sl *= 2.5 / m;
  o = vec4(C.x, sl, C.y);
}`;

// Probe grid for CPU buoyancy: (height, Dx, Dz, foam) at coarse cells
SH.probe = GLSL_HEAD + `
uniform sampler2D tHeight, tDisp;
uniform vec4 uTank;
uniform float uFFTL;
in vec2 vUv;
out vec4 o;
void main(){
  vec2 xz = mix(-uTank.xy, uTank.xy, vUv);
  vec4 s = textureLod(tHeight, vUv, 0.0);      // (total height, foam, J, ripple height)
  vec4 d = textureLod(tDisp, xz / uFFTL, 0.0);
  o = vec4(s.x - s.w, d.y, d.z, s.w);  // (incident ocean height, Dx, Dz, ripple height)
}`;
