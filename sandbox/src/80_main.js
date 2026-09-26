// ============================================================================
//  UI, INPUT, MAIN LOOP
// ============================================================================
const $ = (id) => document.getElementById(id);
const URLP = new URLSearchParams(location.search);
const TEST = URLP.has('test');
const VIEWS = {
  1: { target: [0, 0.72, 0], yaw: 0.62, pitch: 0.2, dist: 6.4, name: 'Hero' },
  2: { target: [0, 0.74, 0], yaw: 0.06, pitch: 0.015, dist: 4.4, name: 'Through the glass' },
  3: { target: [-0.35, 1.0, -0.3], yaw: 0.73, pitch: -0.72, dist: 1.0, name: 'Below the surface' },
  4: { target: [-0.2, 1.17, 0.0], yaw: 0.42, pitch: 0.012, dist: 2.35, name: 'At the waterline' },
  5: { target: [0, 0.6, 0], yaw: 0.35, pitch: 1.12, dist: 5.4, name: 'Top down' },
  6: { target: [0.1, 1.2, 0.0], yaw: 0.5, pitch: 0.78, dist: 2.5, name: 'Close on the surface' },
};
const VIEW_ANIM = { t: 1, from: null, to: null };
function setView(n, instant) {
  const v = VIEWS[n];
  if (!v) return;
  document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.v == n));
  VIEW_ANIM.from = { target: CAM.target.slice(), yaw: CAM.yaw, pitch: CAM.pitch, dist: CAM.dist };
  VIEW_ANIM.to = v; VIEW_ANIM.t = instant ? 1 : 0;
  if (instant) Object.assign(CAM, { target: v.target.slice(), yaw: v.yaw, pitch: v.pitch, dist: v.dist });
  $('caption').textContent = v.name.toUpperCase();
}
function animView(dt) {
  if (VIEW_ANIM.t >= 1 || !VIEW_ANIM.to) return;
  VIEW_ANIM.t = Math.min(1, VIEW_ANIM.t + dt / 1.1);
  const e = VIEW_ANIM.t < 0.5 ? 4 * VIEW_ANIM.t ** 3 : 1 - Math.pow(-2 * VIEW_ANIM.t + 2, 3) / 2;
  const a = VIEW_ANIM.from, b = VIEW_ANIM.to;
  let dy = b.yaw - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  CAM.yaw = a.yaw + dy * e; CAM.pitch = a.pitch + (b.pitch - a.pitch) * e;
  CAM.dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * e);
  CAM.target = a.target.map((x, i) => x + (b.target[i] - x) * e);
  RT.reset = true;
}

function bindUI() {
  const rng = (id, key, fmt, cb) => {
    const el = $('r' + id), out = $('o' + id);
    el.value = STATE[key];
    const show = () => { out.textContent = fmt(STATE[key]); };
    el.addEventListener('input', () => { STATE[key] = parseFloat(el.value); show(); if (cb) cb(); });
    show();
  };
  const f2 = (v) => v.toFixed(2), deg = (v) => Math.round(v) + '°';
  rng('Sea', 'sea', f2); rng('Chop', 'chop', f2); rng('Wind', 'windDir', (v) => Math.round(v * 57.3) + '°'); rng('Peak', 'peak', (v) => v.toFixed(1) + 'm');
  rng('Clar', 'clarity', f2); rng('Foam', 'foam', f2); rng('Part', 'particles', f2);
  rng('El', 'sunElev', deg, () => { R.envDirty = true; }); rng('Az', 'sunAz', deg, () => { R.envDirty = true; });
  rng('God', 'godRays', f2); rng('Caus', 'causGain', f2); rng('Exp', 'exposure', f2); rng('Bloom', 'bloom', (v) => v.toFixed(3));
  rng('Scale', 'scale', (v) => v.toFixed(2) + '×');
  rng('Aper', 'aperture', f2);
  const sw = $('sWater');
  Object.keys(WATER_TYPES).forEach(k => { const o = document.createElement('option'); o.value = o.textContent = k; sw.appendChild(o); });
  sw.value = STATE.waterType;
  sw.addEventListener('change', () => { STATE.waterType = sw.value; });
  const sq = $('sQ');
  Object.keys(PRESETS).forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = k.charAt(0) + k.slice(1).toLowerCase(); sq.appendChild(o); });
  sq.value = STATE.preset;
  sq.addEventListener('change', () => { applyPreset(sq.value, true); });
  $('sBottom').value = String(STATE.bottom);
  $('sBottom').addEventListener('change', (e) => { STATE.bottom = +e.target.value; });
  const chk = (id, key) => { const el = $(id); el.checked = !!STATE[key]; el.addEventListener('change', () => { STATE[key] = el.checked; RT.reset = true; }); };
  chk('cOrbit', 'autoOrbit'); chk('cPause', 'paused'); chk('cAuto', 'autoDrop'); chk('cDisp', 'dispersion'); chk('cGlass', 'glass'); chk('cTaa', 'taa');
  document.querySelectorAll('#views button').forEach(b => b.addEventListener('click', () => setView(+b.dataset.v)));
  $('bDrop').addEventListener('click', () => dropObject());
  $('bSink').addEventListener('click', () => dropObject('sink'));
  $('bFloat').addEventListener('click', () => dropObject('float'));
  $('bSplash').addEventListener('click', bigSplash);
  $('bClear').addEventListener('click', clearObjects);
  $('toggle').addEventListener('click', () => $('panel').classList.remove('hidden'));
  // after a mouse / touch interaction, give the keyboard back to the scene: a focused slider would
  // also take arrow / Page / Home / End keys, and a focused button or checkbox would re-fire on Space
  document.addEventListener('pointerup', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('input[type=range], input[type=checkbox], button') : null;
    if (el) setTimeout(() => el.blur(), 0);
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '6') setView(+k);
    else if (k === 'd') dropObject();
    else if (k === 's') bigSplash();
    else if (k === 'h') $('panel').classList.toggle('hidden');
    else if (k === 'o') { STATE.autoOrbit = !STATE.autoOrbit; $('cOrbit').checked = STATE.autoOrbit; }
    else if (k === 'g') { STATE.glass = !STATE.glass; $('cGlass').checked = STATE.glass; }
    else if (k === ' ') { STATE.paused = !STATE.paused; $('cPause').checked = STATE.paused; e.preventDefault(); }
    else if (k === 'f') { const d = document.documentElement; if (!document.fullscreenElement && d.requestFullscreen) d.requestFullscreen().catch(() => {}); else if (document.exitFullscreen) document.exitFullscreen().catch(() => {}); }
    else if (k === 'c') STATE.debug = (STATE.debug + 1) % 3;
  });
}
function bigSplash() {
  const x = (Math.random() * 2 - 1) * TANK.TX * 0.6, z = (Math.random() * 2 - 1) * TANK.TZ * 0.6;
  const fake = { pos: [x, TANK.LEVEL, z], bound: 0.22, mat: 2, trail: 0 };
  splash(fake, 5.5);
  addImpulse(x, z, 0.35, 0.06);
}
function applyPreset(name, rebuild) {
  STATE.preset = name;
  const q = PRESETS[name];
  STATE.scale = q.scale;
  $('rScale').value = q.scale; $('oScale').textContent = q.scale.toFixed(2) + '×';
  $('sQ').value = name;
  if (rebuild) { buildSimResources(q); SPEC.key = ''; RT.w = RT.w; RT.reset = true; }
}

// ------------------------------------------------------------ pointer input
function pickWater(cx, cy) {
  const c = GLX.gl.canvas, rect = c.getBoundingClientRect();
  const nx = ((cx - rect.left) / rect.width) * 2 - 1, ny = 1 - ((cy - rect.top) / rect.height) * 2;
  const r = CAM.rot, t = CAM.tan;
  const d = v3.norm([r[0] * nx * t[0] + r[3] * ny * t[1] - r[6], r[1] * nx * t[0] + r[4] * ny * t[1] - r[7], r[2] * nx * t[0] + r[5] * ny * t[1] - r[8]]);
  if (Math.abs(d[1]) < 1e-4) return null;
  const tt = (TANK.LEVEL - CAM.pos[1]) / d[1];
  if (tt <= 0) return null;
  const p = v3.add(CAM.pos, v3.mul(d, tt));
  return WATER.inside(p[0], p[2]) ? p : null;
}
function camRay(cx, cy) {
  const c = GLX.gl.canvas, rect = c.getBoundingClientRect();
  const nx = ((cx - rect.left) / rect.width) * 2 - 1, ny = 1 - ((cy - rect.top) / rect.height) * 2;
  const r = CAM.rot, t = CAM.tan;
  return { o: CAM.pos.slice(), d: v3.norm([r[0] * nx * t[0] + r[3] * ny * t[1] - r[6], r[1] * nx * t[0] + r[4] * ny * t[1] - r[7], r[2] * nx * t[0] + r[5] * ny * t[1] - r[8]]) };
}
// first point inside the water under the cursor (through the surface, the glass, or from underwater)
function pickWaterPoint(cx, cy) {
  const { o, d } = camRay(cx, cy), T = TANK;
  if (WATER.inside(o[0], o[2]) && o[1] < WATER.heightAt(o[0], o[2]) && o[1] > T.BOT) return v3.add(o, v3.mul(d, 0.55));
  let best = null, bt = 1e9;
  if (d[1] < -1e-4) {
    const t = (T.LEVEL - o[1]) / d[1];
    if (t > 0) { const p = v3.add(o, v3.mul(d, t)); if (WATER.inside(p[0], p[2])) { bt = t; best = v3.add(p, v3.mul(d, 0.05 / Math.max(0.35, -d[1]))); } }
  }
  for (const [ax, s] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
    const lim = ax === 0 ? T.TX : T.TZ;
    if (Math.abs(d[ax]) < 1e-5) continue;
    const t = (s * lim - o[ax]) / d[ax];
    if (t <= 0 || t >= bt) continue;
    const p = v3.add(o, v3.mul(d, t)), ob = ax === 0 ? 2 : 0, olim = ax === 0 ? T.TZ : T.TX;
    if (Math.abs(p[ob]) <= olim && p[1] > T.BOT && p[1] < T.LEVEL - 0.02) { bt = t; best = v3.add(p, v3.mul(d, 0.14)); }
  }
  return best;
}
function pickLampXZ(cx, cy) {
  // the selected lamp hangs above whatever point of the water / floor is under the cursor
  const { o, d } = camRay(cx, cy);
  let t = -1;
  if (o[1] > STATE.lamp.y + 0.05 && d[1] < -1e-4) t = (STATE.lamp.y - o[1]) / d[1];
  else if (d[1] < -1e-4) t = (Math.min(TANK.LEVEL, o[1] - 0.05) - o[1]) / d[1];
  if (!(t > 0)) return null;
  const p = v3.add(o, v3.mul(d, Math.min(t, 40)));
  return [Math.max(-TANK.TX - 2.5, Math.min(TANK.TX + 2.5, p[0])), Math.max(-TANK.TZ - 2.5, Math.min(TANK.TZ + 2.5, p[2]))];
}
const TOOL_HINTS = {
  orbit: 'Drag to orbit, right-drag to pan, click the water for ripples.',
  ink: () => 'Click the water to drop <b>' + INK_COLORS[STATE.ink.color].name + '</b>; hold and drag to pour. Right-drag orbits.',
  stir: 'Drag through the water to stir it: ink, sand and the floating specks follow the flow. Stir near the bottom to lift sand. Right-drag orbits.',
  drop: () => 'Click the water to drop <b>' + CATALOG[STATE.item].name + '</b> there. Pick the item under Objects. Right-drag orbits.',
  laser: 'Click or drag to aim the laser at a point in the tank. Mount, color and haze are under Laser. Right-drag orbits.',
  sand: 'Hold on the water to pour sand there; drag to steer the stream. Colors and modes are under Sand. Right-drag orbits.',
  lamp: () => 'Drag a lamp head to move it (or drag anywhere to move <b>lamp ' + (STATE.lampSel + 1) + '</b>). Color, power, height and beam are under Light. Right-drag orbits.',
};
function setTool(t) {
  STATE.tool = t;
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const h = TOOL_HINTS[t];
  $('toolHint').innerHTML = typeof h === 'function' ? h() : h;
  $('gl').classList.toggle('tool', t !== 'orbit');
  if (t === 'lamp' && STATE.lightMode !== 'lamp') setLightMode('lamp');
}
function setLightMode(mode) {
  STATE.lightMode = mode;
  document.querySelectorAll('#lightMode button').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
  $('sunCtl').hidden = mode !== 'sun';
  $('lampCtl').hidden = mode !== 'lamp';
  R.envDirty = true; RT.reset = true;
  syncLampUI();
}
// ------------------------------------------------------------ lamps (1-3, each with its own colour)
const LAMP_SLIDERS = [['LampPow', 'power', (v) => v.toFixed(2)], ['LampH', 'y', (v) => v.toFixed(2) + 'm'], ['LampBeam', 'beam', (v) => Math.round(v) + '°']];
function syncLampUI() {
  if (!$('lampList')) return;
  LAMP_SLIDERS.forEach(([id, key, fmt]) => { $('r' + id).value = STATE.lamp[key]; $('o' + id).textContent = fmt(STATE.lamp[key]); });
  document.querySelectorAll('#lampList .lrow').forEach((r, i) => {
    r.hidden = i >= STATE.lampCount;
    r.querySelector('button').classList.toggle('on', i === STATE.lampSel);
    const c = r.querySelector('input'); if (c.value.toLowerCase() !== STATE.lamps[i].color.toLowerCase()) c.value = STATE.lamps[i].color;
    r.querySelector('output').textContent = STATE.lamps[i].color.toUpperCase();
  });
  document.querySelectorAll('#lampCount button').forEach(b => b.classList.toggle('on', +b.dataset.n === STATE.lampCount));
  $('bPlaceLamp').textContent = 'Move lamp ' + (STATE.lampSel + 1);
  if (STATE.tool === 'lamp') $('toolHint').innerHTML = TOOL_HINTS.lamp();
}
function selectLamp(i) {
  STATE.lampSel = Math.max(0, Math.min(STATE.lampCount - 1, i | 0));
  syncLampUI();
}
function setLampCount(n) {
  STATE.lampCount = Math.max(1, Math.min(3, n | 0));
  if (STATE.lampSel >= STATE.lampCount) STATE.lampSel = STATE.lampCount - 1;
  if (STATE.lightMode !== 'lamp') setLightMode('lamp');
  syncLampUI();
  RT.reset = true;
}
function setLampColor(i, hex) {
  STATE.lamps[i].color = hex;
  syncLampUI();
  RT.reset = true;
}
// screen position of a lamp head (for grabbing it with the lamp tool)
function lampScreen(i) {
  if (!CAM.vp) return null;
  const p = lampGeom(i).head, m = CAM.vp;
  const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (cw <= 0.01) return null;
  const rect = GLX.gl.canvas.getBoundingClientRect();
  return [(cx / cw * 0.5 + 0.5) * rect.width + rect.left, (0.5 - cy / cw * 0.5) * rect.height + rect.top];
}
// pointer state for continuous tools (ink pour, stirring)
const TOOLP = { down: false, x: 0, y: 0, t0: 0, prev: null, lampOff: [0, 0] };
function applyToolFrame(dt) {
  if (!TOOLP.down || dt <= 0) return;
  if (STATE.tool === 'lamp' || STATE.tool === 'drop') return;
  if (STATE.tool === 'laser') {
    const a = pickAimPoint(TOOLP.x, TOOLP.y);
    if (a) LASER.aim = a;
    return;
  }
  if (STATE.tool === 'sand') {
    const w = pickWater(TOOLP.x, TOOLP.y);
    if (w) SAND.target = [w[0], w[2]];
    return;
  }
  const p = pickWaterPoint(TOOLP.x, TOOLP.y);
  if (!p) { TOOLP.prev = null; return; }
  let v = [0, 0, 0];
  if (TOOLP.prev) {
    v = v3.mul(v3.sub(p, TOOLP.prev), 1 / dt);
    const l = v3.len(v); if (l > 2.5) v = v3.mul(v, 2.5 / l);
  }
  if (STATE.tool === 'ink' && SIM_T - TOOLP.t0 > 0.12) {
    const s = STATE.ink.size;
    injectInk(p, STATE.ink.color, (0.07 + 0.05 * s) * dt * 60, 0.016 + 0.007 * s, v3.add([0, -0.2, 0], v3.mul(v, 0.35)), 0.55);
  } else if (STATE.tool === 'stir' && TOOLP.prev) {
    stirWater(p, v, 0.18, Math.min(1, dt * 50));
    const sp = v3.len(v);
    // a wake where the paddle cuts the surface
    if (sp > 0.05 && p[1] > TANK.LEVEL - 0.3) addImpulse(p[0], p[2], 0.06, Math.min(0.006, 0.003 * sp));
    // stirring near the bottom lifts sand off the bed
    sandKick(p, v, dt);
  }
  TOOLP.prev = p;
}
function bindInput() {
  const cv = $('gl');
  const ptrs = new Map();
  let moved = 0, pinch0 = 0;
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const toolBtn = STATE.tool !== 'orbit' && e.button === 0 && !e.shiftKey;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey, tool: toolBtn });
    moved = 0; cv.classList.add('drag');
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); }
    VIEW_ANIM.t = 1;
    if (toolBtn) {
      Object.assign(TOOLP, { down: true, x: e.clientX, y: e.clientY, t0: SIM_T, prev: null });
      if (STATE.tool === 'ink') {
        const p = pickWaterPoint(e.clientX, e.clientY);
        if (p) dropInk(0, 0, STATE.ink.color, p);
      } else if (STATE.tool === 'drop') {
        const w = pickWater(e.clientX, e.clientY);
        if (w) dropObject(STATE.item, w);
      } else if (STATE.tool === 'laser') {
        const a = pickAimPoint(e.clientX, e.clientY);
        if (a) { LASER.aim = a; if (!LASER.on) { LASER.on = true; syncLaserUI(); } }
      } else if (STATE.tool === 'sand') {
        const w = pickWater(e.clientX, e.clientY);
        if (w) { if (!sandPouring()) sandTeleport(w[0], w[2]); else SAND.target = [w[0], w[2]]; }
        SAND.tool = true;
        syncSandUI();
      } else if (STATE.tool === 'lamp') {
        // grab the lamp head nearest the cursor; otherwise the selected lamp jumps to the cursor
        let best = -1, bd = 80;
        for (let i = 0; i < STATE.lampCount; i++) {
          const sp = lampScreen(i);
          if (sp) { const dd = Math.hypot(sp[0] - e.clientX, sp[1] - e.clientY); if (dd < bd) { bd = dd; best = i; } }
        }
        if (best >= 0) selectLamp(best);
        const xz = pickLampXZ(e.clientX, e.clientY);
        TOOLP.lampOff = best >= 0 && xz ? [STATE.lamp.x - xz[0], STATE.lamp.z - xz[1]] : [0, 0];
        if (xz) { STATE.lamp.x = xz[0] + TOOLP.lampOff[0]; STATE.lamp.z = xz[1] + TOOLP.lampOff[1]; RT.reset = true; }
      }
    }
  });
  cv.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    moved += Math.abs(dx) + Math.abs(dy);
    p.x = e.clientX; p.y = e.clientY;
    if (p.tool) {
      TOOLP.x = e.clientX; TOOLP.y = e.clientY;
      if (STATE.tool === 'lamp') {
        const xz = pickLampXZ(e.clientX, e.clientY);
        if (xz) {
          STATE.lamp.x = Math.max(-TANK.TX - 2.5, Math.min(TANK.TX + 2.5, xz[0] + TOOLP.lampOff[0]));
          STATE.lamp.z = Math.max(-TANK.TZ - 2.5, Math.min(TANK.TZ + 2.5, xz[1] + TOOLP.lampOff[1]));
        }
      }
      return;
    }
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0 > 0) CAM.dist = Math.max(0.35, Math.min(22, CAM.dist * pinch0 / d));
      pinch0 = d;
    } else if ((STATE.tool === 'orbit' && p.b === 2) || (p.b === 2 && p.shift) || (STATE.tool === 'orbit' && p.shift)) {
      const r = CAM.rot, s = CAM.dist * 0.0014;
      CAM.target = [CAM.target[0] - (r[0] * dx - r[3] * dy) * s, Math.max(0.05, CAM.target[1] - (r[1] * dx - r[4] * dy) * s), CAM.target[2] - (r[2] * dx - r[5] * dy) * s];
    } else {
      CAM.yaw -= dx * 0.0055;
      CAM.pitch = Math.max(-1.45, Math.min(1.45, CAM.pitch + dy * 0.0045));
    }
  });
  const up = (e) => {
    const p = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (!ptrs.size) cv.classList.remove('drag');
    if (p && p.tool) { TOOLP.down = false; TOOLP.prev = null; if (SAND.tool) { SAND.tool = false; syncSandUI(); } return; }
    if (p && moved < 6 && p.b === 0 && STATE.tool === 'orbit') {
      const w = pickWater(e.clientX, e.clientY);
      if (w) {
        addImpulse(w[0], w[2], 0.07, 0.035);
        kickFloaters(w[0], w[2], 0.35, null);
        for (let i = 0; i < 10; i++) { const a = Math.random() * 6.28; spawnDrop([w[0], TANK.LEVEL + 0.01, w[2]], [Math.cos(a) * 0.4, 1 + Math.random() * 1.2, Math.sin(a) * 0.4], 0.002 + Math.random() * 0.003); }
      }
    }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); VIEW_ANIM.t = 1; CAM.dist = Math.max(0.35, Math.min(22, CAM.dist * Math.exp(e.deltaY * 0.0011))); }, { passive: false });
}
function bindUI2() {
  const sw = $('swatches');
  INK_COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'sw' + (i === STATE.ink.color ? ' on' : '');
    b.style.background = c.css;
    b.title = c.name; b.setAttribute('aria-label', c.name);
    b.innerHTML = '<span>' + c.name + '</span>';
    b.addEventListener('click', () => {
      STATE.ink.color = i;
      sw.querySelectorAll('.sw').forEach((x, j) => x.classList.toggle('on', j === i));
      if (STATE.tool === 'ink') setTool('ink');
    });
    sw.appendChild(b);
  });
  const rngO = (id, obj, key, fmt, cb) => {
    const el = $('r' + id), out = $('o' + id);
    el.value = obj[key];
    const show = () => { out.textContent = fmt(obj[key]); };
    el.addEventListener('input', () => { obj[key] = parseFloat(el.value); show(); if (cb) cb(); });
    show();
  };
  const f2 = (v) => v.toFixed(2);
  rngO('InkSize', STATE.ink, 'size', f2); rngO('InkPig', STATE.ink, 'pigment', f2); rngO('InkSink', STATE.ink, 'sink', f2);
  rngO('InkTurb', STATE.ink, 'turb', f2); rngO('InkFade', STATE.ink, 'fade', (v) => Math.round(v) + 's');
  // lamps: count, one row per lamp (select + its own colour picker), sliders act on the selected lamp
  const lampList = $('lampList');
  STATE.lamps.forEach((Lm, i) => {
    const row = document.createElement('div');
    row.className = 'lrow';
    const b = document.createElement('button');
    b.textContent = 'Lamp ' + (i + 1);
    b.title = 'Select lamp ' + (i + 1) + ' (power, height, beam and the lamp tool act on it)';
    const c = document.createElement('input');
    c.type = 'color'; c.value = Lm.color; c.setAttribute('aria-label', 'Lamp ' + (i + 1) + ' color');
    const o = document.createElement('output');
    b.addEventListener('click', () => selectLamp(i));
    c.addEventListener('input', () => { setLampColor(i, c.value); });
    c.addEventListener('click', () => selectLamp(i));
    row.append(b, c, o);
    lampList.appendChild(row);
  });
  LAMP_SLIDERS.forEach(([id, key, fmt]) => {
    const el = $('r' + id), out = $('o' + id);
    el.addEventListener('input', () => { STATE.lamp[key] = parseFloat(el.value); out.textContent = fmt(STATE.lamp[key]); RT.reset = true; });
  });
  document.querySelectorAll('#lampCount button').forEach(b => b.addEventListener('click', () => setLampCount(+b.dataset.n)));
  $('cInkAuto').checked = STATE.ink.auto;
  $('cInkAuto').addEventListener('change', (e) => { STATE.ink.auto = e.target.checked; });
  $('bInk').addEventListener('click', () => dropInk((Math.random() * 2 - 1) * TANK.TX * 0.6, (Math.random() * 2 - 1) * TANK.TZ * 0.55));
  $('bRain').addEventListener('click', () => inkRain(8));
  $('bInkClear').addEventListener('click', clearInk);
  $('bPlaceLamp').addEventListener('click', () => setTool('lamp'));
  document.querySelectorAll('#tools button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.t)));
  bindSandUI();
  bindThingsUI();
  document.querySelectorAll('#lightMode button').forEach(b => b.addEventListener('click', () => setLightMode(b.dataset.m)));
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    const k = e.key.toLowerCase();
    if (k === 'i') setTool('ink');
    else if (k === 't') setTool('stir');
    else if (k === 'l') setTool('lamp');
    else if (k === 'escape') setTool('orbit');
    else if (k === 'm') setLightMode(STATE.lightMode === 'sun' ? 'lamp' : 'sun');
    else if (k === 'n') $('bInk').click();
    else if (k === 'x') clearInk();
    else if (k === 'a') setTool('sand');
    else if (k === 'b') setTool('drop');
    else if (k === 'j') setTool('laser');
    else if (k === 'k') { LASER.on = !LASER.on; syncLaserUI(); }
    else if (k === 'p') { SAND.pour = !SAND.pour; syncSandUI(); }
    else if (k === 'v') { SAND.sweep = !SAND.sweep; if (SAND.sweep) SAND.pour = true; syncSandUI(); }
    else if (k === 'z') clearSand();
  });
  setTool(STATE.tool);
  setLightMode(STATE.lightMode);
}

// ------------------------------------------------------------ objects, creatures, laser
function trimObjects() {
  const dyn = BODIES.filter(x => !x.static);
  while (dyn.length > STATE.maxObjects) { const old = dyn.shift(); BODIES.splice(BODIES.indexOf(old), 1); }
}
function syncItemsUI() {
  document.querySelectorAll('.items button[data-i]').forEach(b => b.classList.toggle('on', +b.dataset.i === STATE.item));
  if (STATE.tool === 'drop') $('toolHint').innerHTML = TOOL_HINTS.drop();
}
function syncCritUI() {
  document.querySelectorAll('#critBtns button').forEach(b => {
    const n = CREATURES.filter(c => c.kind === b.dataset.k).length;
    b.textContent = CREATURE_TYPES[b.dataset.k].label + (n ? ' ×' + n : '');
    b.classList.toggle('on', n > 0);
  });
}
function syncLaserUI() {
  if (!$('bLaser')) return;
  $('bLaser').textContent = LASER.on ? 'Laser off' : 'Laser on';
  $('bLaser').classList.toggle('on', LASER.on);
  document.querySelectorAll('#laserColor button').forEach(b => b.classList.toggle('on', b.dataset.c === LASER.color));
  document.querySelectorAll('#laserMount button').forEach(b => b.classList.toggle('on', b.dataset.m === LASER.mount));
  $('cLzSweep').checked = LASER.sweep;
}
function bindThingsUI() {
  CATALOG.forEach((t, i) => {
    const b = document.createElement('button');
    b.textContent = t.label || t.name; b.title = 'Drop a ' + t.name.toLowerCase() + (t.sink ? ' (sinks)' : ' (floats)');
    b.dataset.i = i;
    b.addEventListener('click', () => { STATE.item = i; syncItemsUI(); dropObject(i); });
    $(t.sink ? 'itemsSink' : 'itemsFloat').appendChild(b);
  });
  const mo = $('rMaxObj'), oo = $('oMaxObj');
  mo.value = STATE.maxObjects; oo.textContent = STATE.maxObjects;
  mo.addEventListener('input', () => { STATE.maxObjects = +mo.value; oo.textContent = STATE.maxObjects; trimObjects(); });
  Object.keys(CREATURE_TYPES).forEach(k => {
    const b = document.createElement('button');
    b.dataset.k = k; b.title = 'Add a ' + CREATURE_TYPES[k].label.toLowerCase();
    b.addEventListener('click', () => { addCreature(k); syncCritUI(); });
    $('critBtns').appendChild(b);
  });
  $('bCritClear').addEventListener('click', () => { clearCreatures(); syncCritUI(); });
  $('bLaser').addEventListener('click', () => { LASER.on = !LASER.on; syncLaserUI(); });
  $('bLaserAim').addEventListener('click', () => { if (!LASER.on) LASER.on = true; setTool('laser'); syncLaserUI(); });
  document.querySelectorAll('#laserColor button').forEach(b => b.addEventListener('click', () => { LASER.color = b.dataset.c; syncLaserUI(); }));
  document.querySelectorAll('#laserMount button').forEach(b => b.addEventListener('click', () => { laserSetMount(b.dataset.m); LASER.on = true; syncLaserUI(); }));
  const hz = $('rLzHaze'), ho = $('oLzHaze');
  hz.value = LASER.haze; ho.textContent = LASER.haze.toFixed(2);
  hz.addEventListener('input', () => { LASER.haze = +hz.value; ho.textContent = LASER.haze.toFixed(2); });
  $('cLzSweep').addEventListener('change', (e) => { LASER.sweep = e.target.checked; });
  syncItemsUI(); syncCritUI(); syncLaserUI();
}

// ------------------------------------------------------------ sand controls
function bindSandUI() {
  const sw = $('sandSw');
  SAND_COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'sw';
    b.style.background = c.css;
    b.title = c.name; b.setAttribute('aria-label', c.name);
    b.innerHTML = '<span>' + c.name + '</span>';
    b.addEventListener('click', () => { SAND.color = i; SAND.pourClock = 0; if (SAND.mode === 'mixed') SAND.mode = 'single'; syncSandUI(); });
    sw.appendChild(b);
  });
  document.querySelectorAll('#sandMode button').forEach(b => b.addEventListener('click', () => { SAND.mode = b.dataset.m; SAND.pourClock = 0; syncSandUI(); }));
  $('bPour').addEventListener('click', () => { SAND.pour = !SAND.pour; syncSandUI(); });
  $('bSweep').addEventListener('click', () => { SAND.sweep = !SAND.sweep; if (SAND.sweep) SAND.pour = true; else SAND.target = SAND.pos.slice(); syncSandUI(); });
  $('bSandClear').addEventListener('click', clearSand);
  const rs = (id, key, fmt) => {
    const el = $('r' + id), out = $('o' + id);
    el.value = SAND[key]; out.textContent = fmt(SAND[key]);
    el.addEventListener('input', () => { SAND[key] = parseFloat(el.value); out.textContent = fmt(SAND[key]); });
  };
  rs('SandFlow', 'flow', (v) => v.toFixed(1) + ' L/s');
  rs('SandGrain', 'grain', (v) => v.toFixed(2) + ' mm');
  rs('SandCycle', 'cycle', (v) => v.toFixed(1) + ' s');
  syncSandUI();
}
function syncSandUI() {
  if (!$('sandSw')) return;
  $('sandSw').querySelectorAll('.sw').forEach((x, j) => x.classList.toggle('on', j === SAND.color && SAND.mode !== 'mixed'));
  document.querySelectorAll('#sandMode button').forEach(b => b.classList.toggle('on', b.dataset.m === SAND.mode));
  $('bPour').classList.toggle('on', SAND.pour);
  $('bPour').textContent = SAND.pour ? 'Stop pouring' : 'Pour';
  $('bSweep').classList.toggle('on', SAND.sweep);
}
function sandInfoText() {
  const ws = settlingSpeed(SAND.grain);
  const bed = SAND.maxH > 0.001 ? 'Bed ' + (SAND.maxH * 100).toFixed(1) + ' cm at its peak, ' + Math.round(SAND.total * 1000) + ' L of sand. ' : 'No sand yet. ';
  return bed + 'Grains settle at ' + (ws * 100).toFixed(1) + ' cm/s.';
}

// ------------------------------------------------------------ stats / timing
const STATS = { fps: 0, ms: 0, gpu: 0, last: 0, acc: 0, n: 0, q: [] };
function gpuBegin() {
  const gl = GLX.gl, ext = GLX.ext.EXT_disjoint_timer_query_webgl2;
  if (!ext || STATS.q.length > 4) return null;
  const q = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
  return q;
}
function gpuEnd(q) {
  const gl = GLX.gl, ext = GLX.ext.EXT_disjoint_timer_query_webgl2;
  if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); STATS.q.push(q); }
  while (STATS.q.length) {
    const h = STATS.q[0];
    if (!gl.getQueryParameter(h, gl.QUERY_RESULT_AVAILABLE)) break;
    const dis = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const ns = gl.getQueryParameter(h, gl.QUERY_RESULT);
    if (!dis) STATS.gpu = STATS.gpu ? STATS.gpu * 0.9 + ns / 1e6 * 0.1 : ns / 1e6;
    gl.deleteQuery(h); STATS.q.shift();
  }
}

// ------------------------------------------------------------ main
let LAST = 0, ACC = 0, DROP_T = 0, INK_T = 0, READY = false;
function resize() {
  const c = $('gl');
  const dpr = TEST ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(64, Math.round(c.clientWidth * dpr)), h = Math.max(64, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
}
function seedScene() {
  addStones();
  const put = (i, x, z, y) => { const b = makeBody(CATALOG[i], [x, y, z], quat.random(mulberry32(i * 77 + 3))); b.vel = [0, 0, 0]; BODIES.push(b); return b; };
  put(0, 0.55, 0.25, TANK.BOT + 0.16);         // chrome sphere resting on the bed
  put(1, -0.6, -0.35, TANK.BOT + 0.2);         // brass weight
  put(6, -0.45, 0.4, TANK.LEVEL);              // wooden crate afloat
  put(7, 0.9, -0.3, TANK.LEVEL + 0.1);         // beach ball
  put(8, 0.1, -0.5, TANK.LEVEL);               // life ring
  put(11, -1.2, -0.1, TANK.LEVEL - 0.55);      // near-neutral sphere hovering
  // a rubber duck riding upright, and a few fish so the tank starts out alive
  const duck = makeBody(CATALOG[12], [0.35, TANK.LEVEL + 0.03, 0.2], [0, Math.sin(-0.4), 0, Math.cos(-0.4)]);
  BODIES.push(duck);
  for (const [k, x, y, z] of [['clownfish', 0.4, 0.72, 0.3], ['clownfish', 0.48, 0.76, 0.36], ['clownfish', 0.36, 0.68, 0.4],
    ['bluetang', -0.5, 0.82, -0.2], ['bluetang', -0.58, 0.86, -0.1]]) addCreature(k, [x, y, z]);
  syncCritUI();
}
function start() {
  const c = $('gl');
  resize();
  try { GLX.init(c); } catch (e) { fail(e.message); return; }
  // if the driver resets the GPU (a frame ran too long), every GL object is gone: say so instead of
  // drawing garbage, and start over cleanly once the context comes back
  c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fail('The graphics driver reset the WebGL context. It will reload when the GPU is back; if this repeats, choose a lower Quality preset.'); });
  c.addEventListener('webglcontextrestored', () => location.reload());
  // Medium by default on every GPU (Quality > Preset goes higher); ?q=low|medium|high|ultra|insane overrides
  let preset = 'MEDIUM';
  const qp = (URLP.get('q') || '').toUpperCase();
  if (PRESETS[qp]) preset = qp;
  if (TEST && !PRESETS[qp]) preset = 'LOW';
  KERNEL = iwaveKernel();
  compilePrograms();
  applyPreset(preset, false);
  buildSimResources(PRESETS[preset]);
  bindUI(); bindInput(); bindUI2();
  setView(URLP.get('view') ? +URLP.get('view') : 1, true);
  seedScene();
  window.addEventListener('resize', resize);
  requestAnimationFrame(loop);
}
function fail(msg) {
  const l = $('load');
  l.classList.add('err'); l.style.display = 'flex';
  $('loadMsg').textContent = msg;
  // point people without a capable GPU to the lite version (it has a CPU fallback)
  if (!$('liteNote')) l.insertAdjacentHTML('beforeend', '<p id="liteNote" style="color:var(--dim)">This sandbox needs WebGL 2 and a strong GPU. CAUSTIC//LITE runs almost anywhere.</p>');
  window.__CV.error = msg;
}
function loop(now) {
  requestAnimationFrame(loop);
  const dtr = LAST ? Math.min(0.05, (now - LAST) / 1000) : 1 / 60;
  LAST = now;
  if (!READY) {
    const all = Object.values(P), done = all.filter(p => p.isDone()).length;
    $('loadBar').style.width = (done / all.length * 100).toFixed(0) + '%';
    $('loadMsg').textContent = 'Compiling shaders ' + done + '/' + all.length + (done < all.length ? ' — the ray tracer takes longest' : '');
    if (programsFailed()) { fail(GLX.errors.join('\n\n')); READY = true; window.__CV.ready = false; return; }
    if (done === all.length) { READY = true; $('load').style.display = 'none'; window.__CV.ready = true; }
    return;
  }
  if (window.__CV.error || window.__CV.hold) return;
  tick(dtr);
}
function tick(dtr) {
  resize();
  const dt = STATE.paused ? 0 : (TEST ? 1 / 60 : dtr);
  animView(dtr);
  if (STATE.autoOrbit && VIEW_ANIM.t >= 1) CAM.yaw += dtr * 0.06;
  if (dt > 0) {
    SIM_T += dt;
    ACC += dt;
    const h = 1 / 240;
    let n = 0;
    while (ACC >= h && n < 16) { stepBodies(h, SIM_T); ACC -= h; n++; }
    stepParticles(dt, SIM_T);
    stepCreatures(dt);
    if (STATE.autoDrop) { DROP_T += dt; if (DROP_T > STATE.dropEvery) { DROP_T = 0; dropObject(Math.random() < 0.55 ? 'sink' : 'float'); } }
    applyToolFrame(dt);
    stepInkEvents();
    if (STATE.ink.auto) { INK_T += dt; if (INK_T > STATE.ink.every) { INK_T = 0; dropInk((Math.random() * 2 - 1) * TANK.TX * 0.65, (Math.random() * 2 - 1) * TANK.TZ * 0.6, Math.floor(Math.random() * INK_COLORS.length)); } }
  }
  const t0 = performance.now();
  const q = gpuBegin();
  const info = renderFrame(dt);
  gpuEnd(q);
  const cpu = performance.now() - t0;
  const glErr = GLX.gl.getError();
  if (glErr && window.__CV.glErrors.length < 20) window.__CV.glErrors.push(glErr);
  STATS.n++; STATS.acc += dtr;
  STATS.ms = STATS.ms ? STATS.ms * 0.92 + cpu * 0.08 : cpu;
  if (STATS.acc > 0.5) {
    STATS.fps = STATS.n / STATS.acc; STATS.n = 0; STATS.acc = 0;
    $('sFps').textContent = STATS.fps.toFixed(0);
    $('sGpu').textContent = STATS.gpu ? STATS.gpu.toFixed(1) + 'ms' : 'n/a';
    $('sMs').textContent = STATS.ms.toFixed(1) + 'ms';
    $('sRes').textContent = info.rw + '×' + info.rh;
    $('sPh').textContent = ((R.pnUsed || R.pn * R.pn) / 1e6).toFixed(2) + 'M';
    $('sTri').textContent = ((R.trisUsed || 0) / 1e6).toFixed(0) + 'M';
    $('sObj').textContent = BODIES.filter(b => !b.static).length;
    $('sBub').textContent = BUBBLES.length + DROPS.length;
    $('sandInfo').textContent = sandInfoText();
  }
  window.__CV.frame = FRAME;
}
window.__CV = { ready: false, error: null, frame: 0, glErrors: [], STATE, CAM, setView, dropObject, BODIES, BUBBLES, DROPS, R, hold: false,
  dropInk, inkRain, clearInk, injectInk, stirWater, setLightMode, setTool, INK, setLampCount, selectLamp, setLampColor, SAND, clearSand, sandHeightAt,
  CATALOG, CREATURES, addCreature, clearCreatures, LASER, laserSetMount, MODELS,
  sandStats() {
    const S = R.sand, out = {};
    const scan = (name, t, w, h) => {
      const px = readTex(t, 0, 0, w, h, new Float32Array(w * h * 4));
      let nan = 0, mx = [0, 0, 0, 0], sum = 0;
      for (let i = 0; i < px.length; i += 4) { for (let c = 0; c < 4; c++) { const v = px[i + c]; if (!Number.isFinite(v)) nan++; else mx[c] = Math.max(mx[c], Math.abs(v)); } sum += px[i]; }
      out[name] = { nan, max: mx.map(v => +v.toFixed(4)), sum };
    };
    scan('P', S.cur.p, S.n, S.n); scan('V', S.cur.v, S.n, S.n);
    scan('H', S.hc.h, S.gw, S.gh); scan('Top', S.hc.t, S.gw, S.gh); scan('rend', S.rend, S.gw, S.gh); scan('sus', S.sus, R.ink.dL.w, R.ink.dL.h);
    // particle states
    const px = readTex(S.cur.p, 0, 0, S.n, S.n, new Float32Array(S.n * S.n * 4));
    const st = [0, 0, 0, 0]; for (let i = 3; i < px.length; i += 4) st[Math.max(0, Math.min(3, Math.floor(px[i])))]++;
    // strata atlas coverage
    const cp = readTex(S.atlas.a, 0, 0, S.cL.w, S.cL.h, new Uint8Array(S.cL.w * S.cL.h * 4));
    let painted = 0; for (let i = 0; i < cp.length; i += 4) if (cp[i] + cp[i + 1] + cp[i + 2] > 0) painted++;
    const cellA = S.cell[0] * S.cell[1];
    return { t: +SIM_T.toFixed(2), states: st, volume: +(out.H.sum * cellA * 1000).toFixed(2), maxH: out.H.max[0], nan: out.P.nan + out.V.nan + out.H.nan + out.Top.nan + out.rend.nan + out.sus.nan,
      susMax: out.sus.max[3], painted, maxHprobe: +SAND.maxH.toFixed(4), vp: SAND.vp, ws: +SAND.ws.toFixed(4), sleeping: BODIES.filter(b => b.sleep).length };
  },
  step(n) { for (let i = 0; i < n; i++) tick(1 / 60); GLX.gl.finish(); return FRAME; },
  capture() { tick(1 / 60); return GLX.gl.canvas.toDataURL('image/png'); },
  set(k, v) { STATE[k] = v; R.envDirty = true; RT.reset = true; },
  scanTextures() {
    const out = {};
    const scan = (name, t, w, h, x0, y0) => {
      const px = readTex(t, x0 || 0, y0 || 0, w, h, new Float32Array(w * h * 4));
      let nan = 0, inf = 0, mx = 0, first = null, sum = 0;
      for (let i = 0; i < px.length; i++) { const v = px[i]; if (Number.isNaN(v)) { nan++; if (!first) first = [i >> 2, i & 3]; } else if (!isFinite(v)) inf++; else { mx = Math.max(mx, Math.abs(v)); if ((i & 3) === 1) sum += v; } }
      out[name] = { nan, inf, max: +mx.toFixed(3), mean: +(sum / (w * h)).toFixed(4), first: first ? [first[0] % w, (first[0] / w) | 0, first[1]] : null };
    };
    scan('disp', R.disp, R.fftN, R.fftN); scan('rip', R.rip.a, R.ripW, R.ripH); scan('height', R.height, R.surfW, R.surfH);
    scan('surf', R.surf, R.surfW, R.surfH); scan('p0', R.p0, R.pn, R.pn); scan('p1', R.p1, R.pn, R.pn);
    scan('floorC', R.floorC, R.flW, R.flH);
    const tile = (l) => [(l % R.cvCols) * R.cvW, Math.floor(l / R.cvCols) * R.cvH];
    for (let l = 0; l < R.cvL; l += Math.max(1, (R.cvL / 5) | 0)) scan('caus' + l, R.caus, R.cvW, R.cvH, ...tile(l));
    scan('caus' + (R.cvL - 1), R.caus, R.cvW, R.cvH, ...tile(R.cvL - 1));
    scan('env', R.env, 1024, 512);
    scan('hdr', RT.hdr, RT.w, RT.h); scan('pos', RT.pos, RT.w, RT.h);
    return out;
  },
  pixel(x, y) { return Array.from(readTex(RT.hdr, x, y, 1, 1, new Float32Array(4))); },
  renderOnly() { const d = STATE.paused; STATE.paused = true; const t = STATE.taa; STATE.taa = false; tick(1 / 60); STATE.paused = d; STATE.taa = t; },
  simOnly(n, dropEvery) {
    // run physics + water simulation without the (expensive) ray tracer, for long-horizon stability tests
    for (let f = 0; f < n; f++) {
      const dt = 1 / 60;
      SIM_T += dt; ACC += dt;
      const hh = 1 / 240; let k = 0;
      while (ACC >= hh && k < 16) { stepBodies(hh, SIM_T); ACC -= hh; k++; }
      stepParticles(dt, SIM_T);
      if (dropEvery && f % dropEvery === 0) dropObject(Math.random() < 0.6 ? 'sink' : 'float');
      const sp = seaParams();
      STATE.amp = Math.min(0.32, sp.rms * (3.6 + 1.2 * sp.chop) + 0.07);
      simulate(dt);
      probeReadback();
      if (f % 30 === 29) GLX.gl.finish();
    }
    return this.rippleStats();
  },
  simAll(n) {
    // physics + water + ink, no ray tracing
    for (let f = 0; f < n; f++) {
      const dt = 1 / 60;
      SIM_T += dt; ACC += dt;
      const hh = 1 / 240; let k = 0;
      while (ACC >= hh && k < 16) { stepBodies(hh, SIM_T); ACC -= hh; k++; }
      stepParticles(dt, SIM_T); stepCreatures(dt); stepInkEvents(); applyToolFrame(dt);
      const sp = seaParams();
      STATE.amp = Math.min(0.32, sp.rms * (3.6 + 1.2 * sp.chop) + 0.07);
      simulate(dt); probeReadback();
      const L = lighting();
      const nObj = packObjects();
      uploadTex(R.obj, R.objData);
      const sb = packSpheres();
      uploadTex(R.sph, R.sphData);
      const fb = packFluidBodies();
      simulateSand(dt, fb);
      simulateInk(dt, L, sb, fb);
      simulateParticulate(dt);
      simulateLaser(dt, L, nObj);
      if (f % 30 === 29) GLX.gl.finish();
    }
    return this.inkStats();
  },
  // physics only (bodies against the current water state), and a timing probe for it
  physOnly(n) { for (let i = 0; i < n; i++) { SIM_T += 1 / 240; stepBodies(1 / 240, SIM_T); } },
  physBench(n) { const t0 = performance.now(); for (let i = 0; i < n; i++) stepBodies(1 / 240, SIM_T); return (performance.now() - t0) / n; },
  inkStats() {
    const I = R.ink, out = {};
    const scan = (name, t, w, h) => {
      const px = readTex(t, 0, 0, w, h, new Float32Array(w * h * 4));
      let nan = 0, mx = [0, 0, 0, 0], sum = 0;
      for (let i = 0; i < px.length; i += 4) {
        for (let c = 0; c < 4; c++) { const v = px[i + c]; if (!Number.isFinite(v)) nan++; else mx[c] = Math.max(mx[c], Math.abs(v)); }
        sum += px[i + 3];
      }
      out[name] = { nan, max: mx.map(v => +v.toFixed(3)), sumA: +sum.toFixed(1) };
    };
    scan('vel', I.vel.a, I.vL.w, I.vL.h); scan('dye', I.dye.a, I.dL.w, I.dL.h); scan('light', I.light, I.vL.w, I.vL.h);
    scan('p', I.p.a, I.vL.w, I.vL.h);
    // residual divergence after projection
    P.inkDiv.use().set('tVel', I.vel.a); bindTarget(I.divF, I.vL.w, I.vL.h); inkGridUniforms(P.inkDiv); drawFS();
    scan('div', I.div, I.vL.w, I.vL.h);
    out.t = +SIM_T.toFixed(2); out.active = INK.active;
    return out;
  },
  rippleStats() {
    const w = R.ripW, h = R.ripH, px = readTex(R.rip.a, 0, 0, w, h, new Float32Array(w * h * 4));
    let mx = 0, ss = 0, grad = 0, foam = 0, nan = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const v = px[(j * w + i) * 4];
      if (!Number.isFinite(v)) { nan++; continue; }
      mx = Math.max(mx, Math.abs(v)); ss += v * v; foam += px[(j * w + i) * 4 + 2];
      if (i > 0 && j > 0) grad = Math.max(grad, Math.hypot(v - px[(j * w + i - 1) * 4], v - px[((j - 1) * w + i) * 4]) / (2 * TANK.TX / w));
    }
    const sw = R.surfW, sh = R.surfH, sp = readTex(R.surf, 0, 0, sw, sh, new Float32Array(sw * sh * 4));
    let smax = 0, sjump = 0;
    for (let j = 1; j < sh; j++) for (let i = 1; i < sw; i++) {
      const o = (j * sw + i) * 4;
      smax = Math.max(smax, Math.hypot(sp[o + 1], sp[o + 2]));
      sjump = Math.max(sjump, Math.abs(sp[o] - sp[o - 4]), Math.abs(sp[o] - sp[o - sw * 4]));
    }
    return { t: +SIM_T.toFixed(1), objs: BODIES.filter(b => !b.static).length, maxH: +mx.toFixed(4), rmsH: +Math.sqrt(ss / (w * h)).toFixed(5),
      maxGrad: +grad.toFixed(2), meanFoam: +(foam / (w * h)).toFixed(4), surfMaxSlope: +smax.toFixed(2), surfMaxStep: +sjump.toFixed(4), nan };
  },
  probeHDR() {
    const taa = STATE.taa; STATE.taa = false; tick(1 / 60); STATE.taa = taa;
    const w = RT.w, h = RT.h, px = readTex(RT.hdr, 0, 0, w, h, new Float32Array(w * h * 4));
    let nan = 0, zero = 0, neg = 0, maxv = 0, sum = 0, hot = 0; const bad = [];
    for (let i = 0; i < w * h; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      if (!isFinite(r) || !isFinite(g) || !isFinite(b)) { nan++; if (bad.length < 12) bad.push(['nan', i % w, (i / w) | 0]); }
      else if (r + g + b < 1e-5) { zero++; if (bad.length < 12) bad.push(['zero', i % w, (i / w) | 0]); }
      else { if (r < 0 || g < 0 || b < 0) neg++; maxv = Math.max(maxv, r, g, b); const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; sum += l; if (l > 50) hot++; }
    }
    return { w, h, nan, zero, neg, maxv, bad, mean: sum / (w * h), hot };
  } };
