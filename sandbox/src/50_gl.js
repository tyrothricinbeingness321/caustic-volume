// ============================================================================
//  GL LAYER — three.js underneath. One THREE.WebGLRenderer draws everything: each program
//  is a THREE.RawShaderMaterial, each simulation texture belongs to a THREE.WebGLRenderTarget,
//  and passes are drawn as a full-screen triangle, a point cloud or an index-only mesh (the
//  vertex shaders build their positions from gl_VertexID). The WebGL 2 context that three.js
//  manages is used directly only for GPU timer queries and asynchronous readbacks.
// ============================================================================
const GLX = {
  renderer: null, gl: null, ext: {}, linearFloat: false, errors: [],
  cam: null, fsMesh: null, ptMesh: null, empty: null, color: null, cur: null, blendOn: false,
  init(canvas) {
    if (typeof THREE === 'undefined') throw new Error('three.js could not be loaded (it comes from cdn.jsdelivr.net). Check the connection and reload.');
    let r;
    try {
      r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    } catch (e) { throw new Error('WebGL2 is not available in this browser.'); }
    const gl = r.getContext();
    if (!r.extensions.has('EXT_color_buffer_float')) throw new Error('Missing required WebGL2 extension: EXT_color_buffer_float');
    r.autoClear = false;          // every pass writes exactly what it means to
    r.info.autoReset = false;
    r.setPixelRatio(1);           // the canvas size is managed in device pixels by resize()
    r.debug.onShaderError = (g, program, vs, fs) => {
      const src = g.getShaderSource(fs) || '', m = /#define SHADER_NAME (\S+)/.exec(src), name = m ? m[1] : '?';
      const log = (g.getShaderInfoLog(vs) || '') + '\n' + (g.getShaderInfoLog(fs) || '') + '\n' + (g.getProgramInfoLog(program) || '');
      const msg = 'Shader "' + name + '" failed:\n' + log;
      GLX.errors.push(msg);
      console.error(msg);
      Prog.annotate(/ERROR:\s*\d+:\d+/.test(g.getShaderInfoLog(vs) || '') ? g.getShaderSource(vs) : src, log);
      if (Prog.byName[name]) Prog.byName[name].failed = true;
    };
    this.renderer = r; this.gl = gl;
    for (const n of ['OES_texture_float_linear', 'KHR_parallel_shader_compile', 'EXT_disjoint_timer_query_webgl2',
                     'WEBGL_debug_renderer_info', 'EXT_float_blend']) {
      this.ext[n] = gl.getExtension(n);
    }
    this.linearFloat = !!this.ext.OES_texture_float_linear;
    this.cam = new THREE.Camera();
    const tri = new THREE.BufferGeometry();
    tri.setDrawRange(0, 3);
    this.fsMesh = new THREE.Mesh(tri);
    this.ptMesh = new THREE.Points(new THREE.BufferGeometry());
    this.fsMesh.frustumCulled = this.ptMesh.frustumCulled = false;
    this.empty = new THREE.Scene();
    this.color = new THREE.Color();
    return gl;
  },
  gpuName() {
    const gl = this.gl, d = this.ext.WEBGL_debug_renderer_info;
    try { return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { return 'unknown'; }
  },
  // draw an object with the current program (additive blending if switched on)
  draw(obj) {
    const m = this.cur.mat;
    m.blending = this.blendOn ? THREE.CustomBlending : THREE.NoBlending;
    obj.material = m;
    this.renderer.render(obj, this.cam);
  },
  blend(on) { this.blendOn = on; },   // additive (one, one) for the draws that follow
  clear(r = 0, g = 0, b = 0, a = 0) { this.renderer.setClearColor(this.color.setRGB(r, g, b, THREE.LinearSRGBColorSpace), a); this.renderer.clear(true, false, false); },
};

class Prog {
  constructor(vs, fs, name) {
    const strip = (s) => s.replace(/^\s*#version[^\n]*\n/, '');   // three.js adds the version line
    this.name = name;
    this.mat = new THREE.RawShaderMaterial({ name, glslVersion: THREE.GLSL3, vertexShader: strip(vs), fragmentShader: strip(fs), uniforms: {},
      depthTest: false, depthWrite: false, side: THREE.DoubleSide, blending: THREE.NoBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation });
    this.ready = false;
    this.failed = false;
    Prog.byName[name] = this;
    // compile in the background (in parallel where the driver can); after it links, look up its
    // uniforms once, which is when three.js reports compile errors
    const probe = new THREE.Mesh(GLX.fsMesh.geometry, this.mat);
    probe.frustumCulled = false;
    const linked = () => {
      try { const pr = GLX.renderer.properties.get(this.mat).currentProgram; if (pr) pr.getUniforms(); } catch (e) { this.failed = true; }
      this.ready = true;
    };
    if (GLX.ext.KHR_parallel_shader_compile) GLX.renderer.compileAsync(probe, GLX.cam).then(linked, (e) => { this.failed = true; GLX.errors.push('Shader "' + name + '": ' + e); });
    else { GLX.renderer.compile(probe, GLX.cam); setTimeout(linked, 0); }   // submit now, check the link on the next tick
  }
  static annotate(src, log) {
    const m = /ERROR:\s*\d+:(\d+)/.exec(log);
    if (!m) return;
    const ln = +m[1], lines = src.split('\n');
    const ctx = lines.slice(Math.max(0, ln - 4), ln + 2).map((l, i) => (Math.max(0, ln - 4) + i + 1) + ': ' + l).join('\n');
    console.error('Context:\n' + ctx);
    GLX.errors.push('Context:\n' + ctx);
  }
  isDone() { return this.ready || this.failed; }
  use() { GLX.cur = this; return this; }
  set(name, v) {
    const val = v !== null && typeof v === 'object' && 'tex' in v ? v.tex : v;   // texture records -> their THREE.Texture
    const u = this.mat.uniforms[name];
    if (u) u.value = val; else this.mat.uniforms[name] = { value: val };
    return this;
  }
  setAll(obj) { for (const k in obj) this.set(k, obj[k]); return this; }
}
Prog.byName = {};

// ---------------------------------------------------------------------------
// Texture records: { w, h, fmt, opt, tex (THREE.Texture), rt (its render target) }. A record gets
// its texture when it becomes part of a target (makeFBO) or is first filled from JavaScript (uploadTex).
const FMT = {
  RGBA32F: { format: 'RGBAFormat', type: 'FloatType', bpp: 16 },
  RGBA16F: { format: 'RGBAFormat', type: 'HalfFloatType', bpp: 8 },
  R32F: { format: 'RedFormat', type: 'FloatType', bpp: 4 },
  RGBA8: { format: 'RGBAFormat', type: 'UnsignedByteType', bpp: 4 },
};
let GPU_BYTES = 0;
function texParams(t, fmt, opt) {
  const lin = opt.filter !== 'nearest' && (fmt.type !== 'FloatType' || GLX.linearFloat);
  t.format = THREE[fmt.format]; t.type = THREE[fmt.type];
  t.minFilter = opt.mips ? THREE.LinearMipmapLinearFilter : (lin ? THREE.LinearFilter : THREE.NearestFilter);
  t.magFilter = lin ? THREE.LinearFilter : THREE.NearestFilter;
  const wrap = opt.wrap === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapS = opt.wrapS === 'repeat' ? THREE.RepeatWrapping : wrap;
  t.wrapT = wrap;
  t.generateMipmaps = false;   // mip chains are rebuilt on demand (genMips)
  t.colorSpace = THREE.NoColorSpace;
}
function makeTex(w, h, fmt, opt = {}) {
  GPU_BYTES += w * h * fmt.bpp * (opt.mips ? 1.33 : 1);
  return { w, h, fmt, opt, tex: null, rt: null, bytes: w * h * fmt.bpp };
}
function freeTex(t) {
  if (!t) return;
  GPU_BYTES -= t.bytes || 0; t.bytes = 0;
  if (t.tex && !t.rt) t.tex.dispose();   // render-target textures go with their target (freeFBO)
}
// a render target drawing into one texture, or into several at once (one per fragment output)
function makeFBO(texs) {
  const list = Array.isArray(texs) ? texs : [texs];
  const rt = new THREE.WebGLRenderTarget(list[0].w, list[0].h, { count: list.length, depthBuffer: false, stencilBuffer: false });
  list.forEach((t, i) => { const tx = rt.textures[i]; texParams(tx, t.fmt, t.opt); t.tex = tx; t.rt = rt; });
  return { rt, w: list[0].w, h: list[0].h };
}
function freeFBO(f) { if (f && f.rt) f.rt.dispose(); }
function bindTarget(fbo, w, h) {
  const r = GLX.renderer;
  if (!fbo) { r.setRenderTarget(null); r.setScissorTest(false); r.setViewport(0, 0, w, h); return; }
  fbo.rt.viewport.set(0, 0, w !== undefined ? w : fbo.w, h !== undefined ? h : fbo.h);
  fbo.rt.scissorTest = false;
  r.setRenderTarget(fbo.rt);
}
// draw into one tile of a target: viewport and scissor on that rectangle
function bindTile(fbo, x, y, w, h) {
  const rt = fbo.rt;
  rt.viewport.set(x, y, w, h); rt.scissor.set(x, y, w, h); rt.scissorTest = true;
  GLX.renderer.setRenderTarget(rt);
}
function drawFS() { GLX.draw(GLX.fsMesh); }
function drawPoints(n) { GLX.ptMesh.geometry.setDrawRange(0, n); GLX.draw(GLX.ptMesh); }
// an index-only triangle mesh (the vertex shader fetches its data by gl_VertexID)
function makeIndexMesh(idx) {
  const g = new THREE.BufferGeometry();
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.Mesh(g);
  m.frustumCulled = false;
  return m;
}
// ping-pong pair of 2D textures + targets
function makePair(w, h, fmt, opt) {
  const a = makeTex(w, h, fmt, opt), b = makeTex(w, h, fmt, opt);
  return { a, b, fa: makeFBO(a), fb: makeFBO(b), w, h,
    swap() { [this.a, this.b] = [this.b, this.a]; [this.fa, this.fb] = [this.fb, this.fa]; },
    free() { freeTex(this.a); freeTex(this.b); freeFBO(this.fa); freeFBO(this.fb); } };
}
// replace a texture's contents from JavaScript (a Float32Array covering the whole texture, or a prefix of it)
function uploadTex(t, data) {
  if (!t.tex) {
    const n = t.w * t.h * 4;
    t.tex = new THREE.DataTexture(data.length === n ? data : new Float32Array(n), t.w, t.h);
    texParams(t.tex, t.fmt, t.opt);
    t.tex.unpackAlignment = 1;
  }
  const img = t.tex.image;
  if (img.data !== data) img.data.set(data.length > img.data.length ? data.subarray(0, img.data.length) : data);
  t.tex.needsUpdate = true;
}
// rebuild a render-target texture's mip chain (three.js does it at the end of a render into the target)
function genMips(t) {
  const r = GLX.renderer, prev = r.getRenderTarget();
  t.tex.generateMipmaps = true;
  r.setRenderTarget(t.rt);
  r.render(GLX.empty, GLX.cam);
  t.tex.generateMipmaps = false;
  r.setRenderTarget(prev);
}
// read texels of a render-target texture now (Float32Array for float targets, Uint8Array for RGBA8)
function readTex(t, x, y, w, h, buf) {
  const r = GLX.renderer, gl = GLX.gl, prev = r.getRenderTarget();
  r.setRenderTarget(t.rt);   // bound through three.js, so its state stays in step
  gl.readBuffer(gl.COLOR_ATTACHMENT0 + Math.max(0, t.rt.textures.indexOf(t.tex)));
  gl.readPixels(x, y, w, h, gl.RGBA, buf instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.FLOAT, buf);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  r.setRenderTarget(prev);
  return buf;
}
// start reading texels into a pixel-pack buffer (float RGBA, at a byte offset); poll with a fence
function readTexAsync(t, x, y, w, h, pbo, offset = 0) {
  const r = GLX.renderer, gl = GLX.gl, prev = r.getRenderTarget();
  r.setRenderTarget(t.rt);
  gl.readBuffer(gl.COLOR_ATTACHMENT0 + Math.max(0, t.rt.textures.indexOf(t.tex)));
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, offset);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  r.setRenderTarget(prev);
}
