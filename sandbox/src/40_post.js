// ============================================================================
//  POST — temporal accumulation, bloom pyramid, AgX tonemap, film response
// ============================================================================
SH.taa = GLSL_HEAD + `
uniform sampler2D tCur, tHist, tPos;
uniform mat4 uPrevVP;
uniform float uFeedback;
uniform int uReset;
out vec4 o;
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 cmp(vec3 c){ return c / (1.0 + lum(c)); }
vec3 unc(vec3 c){ return c / max(1.0 - lum(c), 1e-4); }
vec3 toYC(vec3 c){ return vec3(0.25*c.r + 0.5*c.g + 0.25*c.b, 0.5*c.r - 0.5*c.b, -0.25*c.r + 0.5*c.g - 0.25*c.b); }
vec3 fromYC(vec3 y){ return vec3(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z); }
vec4 sampleCR(sampler2D t, vec2 uv, vec2 sz){
  vec2 sp = uv * sz, tc = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tc, f2 = f*f, f3 = f2*f;
  vec2 w0 = -0.5*f3 + f2 - 0.5*f, w1 = 1.5*f3 - 2.5*f2 + 1.0, w2 = -1.5*f3 + 2.0*f2 + 0.5*f, w3 = 0.5*f3 - 0.5*f2;
  vec2 w12 = w1 + w2, tc12 = (tc + w2 / w12) / sz, tc0 = (tc - 1.0) / sz, tc3 = (tc + 2.0) / sz;
  vec4 r = texture(t, vec2(tc12.x, tc0.y)) * (w12.x * w0.y)
         + texture(t, vec2(tc0.x, tc12.y)) * (w0.x * w12.y)
         + texture(t, tc12) * (w12.x * w12.y)
         + texture(t, vec2(tc3.x, tc12.y)) * (w3.x * w12.y)
         + texture(t, vec2(tc12.x, tc3.y)) * (w12.x * w3.y);
  float ws = w12.x*w0.y + w0.x*w12.y + w12.x*w12.y + w3.x*w12.y + w12.x*w3.y;
  return max(r / ws, 0.0);
}
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(tCur, 0);
  vec3 c = texelFetch(tCur, px, 0).rgb;
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 s = toYC(cmp(texelFetch(tCur, clamp(px + ivec2(x, y), ivec2(0), sz - 1), 0).rgb));
    m1 += s; m2 += s*s;
  }
  m1 /= 9.0; m2 /= 9.0;
  vec3 sig = sqrt(max(m2 - m1*m1, 0.0));
  vec4 P = texelFetch(tPos, px, 0);
  vec4 cl = uPrevVP * vec4(P.xyz, P.w > 0.5 ? 1.0 : 0.0);
  vec2 puv = (cl.xy / cl.w) * 0.5 + 0.5;
  if (uReset == 1 || cl.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))){ o = vec4(c, 1.0); return; }
  vec3 hst = sampleCR(tHist, puv, vec2(sz)).rgb;
  if (any(equal(floatBitsToUint(hst) & 0x7F800000u, uvec3(0x7F800000u)))) { o = vec4(c, 1.0); return; }
  hst = min(hst, vec3(4000.0));
  vec3 hy = toYC(cmp(hst));
  vec3 lo = m1 - 1.25*sig, hi = m1 + 1.25*sig;
  vec3 cen = 0.5*(lo + hi), ext = max(0.5*(hi - lo), vec3(1e-5));
  vec3 dv = hy - cen;
  vec3 a = abs(dv / ext);
  float ma = max(a.x, max(a.y, a.z));
  if (ma > 1.0) hy = cen + dv / ma;
  vec3 cc = cmp(c);
  vec3 outc = max(mix(cc, fromYC(hy), uFeedback), 0.0);
  // the variance box can hold colours brighter than any neighbour: keep the result inside the
  // compressed range so the expansion stays bounded
  float lo2 = lum(outc);
  if (lo2 > 0.9997) outc *= 0.9997 / lo2;
  o = vec4(min(unc(outc), vec3(4000.0)), 1.0);
}`;

SH.bloomDown = GLSL_HEAD + `
uniform sampler2D tIn;
uniform vec2 uTexel;
uniform int uFirst;
in vec2 vUv;
out vec4 o;
vec3 s(vec2 d){ return texture(tIn, vUv + d * uTexel).rgb; }
float kw(vec3 c){ return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
void main(){
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 r;
  if (uFirst == 1){
    vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25, g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
    float w0 = kw(g0)*0.5, w1 = kw(g1)*0.125, w2 = kw(g2)*0.125, w3 = kw(g3)*0.125, w4 = kw(g4)*0.125;
    r = (g0*w0 + g1*w1 + g2*w2 + g3*w3 + g4*w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    r = e*0.125 + (a + c + g + i)*0.03125 + (b + d + f + h)*0.0625 + (j + k + l + m)*0.125;
  }
  o = vec4(max(r, 0.0), 1.0);
}`;

SH.bloomUp = GLSL_HEAD + `
uniform sampler2D tIn, tBase;
uniform vec2 uTexel;
uniform float uRadius;
in vec2 vUv;
out vec4 o;
void main(){
  vec2 t = uTexel * uRadius;
  vec3 r = texture(tIn, vUv + vec2(-t.x, t.y)).rgb + texture(tIn, vUv + vec2(0, t.y)).rgb * 2.0 + texture(tIn, vUv + vec2(t.x, t.y)).rgb
         + texture(tIn, vUv + vec2(-t.x, 0)).rgb * 2.0 + texture(tIn, vUv).rgb * 4.0 + texture(tIn, vUv + vec2(t.x, 0)).rgb * 2.0
         + texture(tIn, vUv + vec2(-t.x, -t.y)).rgb + texture(tIn, vUv + vec2(0, -t.y)).rgb * 2.0 + texture(tIn, vUv + vec2(t.x, -t.y)).rgb;
  o = vec4(r / 16.0 + texture(tBase, vUv).rgb, 1.0);
}`;

SH.final = GLSL_HEAD + `
uniform sampler2D tHDR, tBloom;
uniform float uExposure, uBloom, uGrain, uVignette, uCA, uUnder, uTime;
uniform int uFrame;
in vec2 vUv;
out vec4 o;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 agxContrast(vec3 x){
  vec3 x2 = x*x, x4 = x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
}
vec3 agx(vec3 v){
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float mn = -12.47393, mx = 4.026069;
  v = m * v;
  v = clamp(log2(max(v, 1e-10)), mn, mx);
  v = (v - mn) / (mx - mn);
  return agxContrast(v);
}
vec3 agxLook(vec3 v){
  float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
  v = pow(max(v, 0.0), vec3(1.38));
  return l + 1.36 * (v - l);
}
vec3 agxOut(vec3 v){
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  return mi * v;
}
void main(){
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float ca = uCA * (1.0 + uUnder * 2.0);
  vec3 c;
  c.r = texture(tHDR, uv - d * ca).r;
  c.g = texture(tHDR, uv).g;
  c.b = texture(tHDR, uv + d * ca).b;
  c += texture(tBloom, uv).rgb * uBloom;
  c *= uExposure;
  float vg = smoothstep(1.25, 0.25, length(d * vec2(1.0, 0.82)) * 1.35);
  c *= mix(1.0, vg, uVignette + uUnder * 0.25);
  vec3 t = agxOut(agxLook(agx(c)));
  float g = hash12(gl_FragCoord.xy + float(uFrame % 211) * 17.37) - 0.5;
  t += g * uGrain * (0.35 + 0.65 * (1.0 - t));
  o = vec4(clamp(t, 0.0, 1.0), 1.0);
}`;

// Depth of field: golden-angle gather, CoC from primary hit distance
SH.dof = GLSL_HEAD + `
uniform sampler2D tIn, tPos;
uniform vec3 uCamPos;
uniform float uFocus, uAperture, uMaxCoc;
out vec4 o;
float cocAt(ivec2 p, out float d){
  vec4 P = texelFetch(tPos, p, 0);
  d = P.w > 0.5 ? length(P.xyz - uCamPos) : 1e4;
  return min(uAperture * abs(d - uFocus) / max(d, 1e-3), uMaxCoc);
}
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(tIn, 0) - 1;
  float dc; float cc = cocAt(px, dc);
  vec3 c0 = texelFetch(tIn, px, 0).rgb;
  if (uMaxCoc < 0.5){ o = vec4(c0, 1.0); return; }
  vec3 acc = c0; float wsum = 1.0;
  const int N = 48;
  for (int i = 1; i < N; i++){
    float r = sqrt(float(i) / float(N)) * uMaxCoc;
    float a = float(i) * 2.39996323;
    ivec2 q = clamp(px + ivec2(round(vec2(cos(a), sin(a)) * r)), ivec2(0), sz);
    float ds; float cs = cocAt(q, ds);
    if (ds > dc) cs = min(cs, cc * 1.2 + 0.5);
    float w = clamp(cs - r + 1.0, 0.0, 1.0) / max(cs * cs, 1.0);
    acc += texelFetch(tIn, q, 0).rgb * w; wsum += w;
  }
  vec3 blur = acc / wsum;
  o = vec4(mix(c0, blur, smoothstep(0.35, 1.6, cc)), 1.0);
}`;

// Debug: visualize a caustic map / layer
SH.debug = GLSL_HEAD + `
uniform sampler2D tIn;
uniform float uScale;
in vec2 vUv;
out vec4 o;
void main(){ o = vec4(pow(texture(tIn, vUv).rgb * uScale, vec3(1.0/2.2)), 1.0); }`;
