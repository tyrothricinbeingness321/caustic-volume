// CAUSTIC//VOLUME (sandbox) — headless validation harness
// Setup:  npm install && npx playwright install chromium
// Usage:  node tools/test-sandbox.cjs [sandbox/index.html] [--q=low] [--frames=4] [--views=1,2,3,4,5,6]
//                                     [--w=960 --h=540] [--out=shots/sandbox]
//                                     [--ink] [--lamp[=N]] [--sand[=seconds]] [--things] [--laser[=mount]] [--three=dir]
//   --ink     drops three inks and evolves the fluid before capturing
//   --lamp    switches to the hanging lamps at night (--lamp=3: red, green and blue lamps)
//   --sand    pours sand for a few seconds (sweeping, colour cycle)
//   --things  drops the toy boats, duck, bottle and the sinkables and adds one of each creature
//   --laser   switches the laser on (mount: side | above | front) and reports its beam segments
// Runs the demo in headless Chromium on SwiftShader (software WebGL2): checks every shader compiles and links,
// steps the simulation deterministically (?test=1 → fixed 1/60 s ticks), captures each camera preset to PNG,
// and fails on GL errors or page exceptions. Software rendering is slow; keep --q=low for quick runs.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const file = path.resolve(process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'sandbox', 'index.html'));
const q = args.q || 'low';
const frames = +(args.frames || 8);
const out = path.resolve(args.out || 'shots/sandbox');
const W = +(args.w || 960), H = +(args.h || 540);
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  // --three=dir: serve three.js from a local copy (e.g. node_modules/three) instead of the CDN
  if (args.three) await page.route(/cdn\.jsdelivr\.net\/npm\/three@[^/]+\//, (route) => {
    const rel = route.request().url().replace(/^.*\/npm\/three@[^/]+\//, '').split('?')[0];
    route.fulfill({ path: path.join(path.resolve(args.three), rel), contentType: 'text/javascript' });
  });
  const logs = [], errors = [];
  page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`); });
  page.on('pageerror', e => errors.push(String(e && e.stack || e)));
  const url = 'file://' + file + `?test=1&q=${q}` + (args.view ? `&view=${args.view}` : '');
  const t0 = Date.now();
  await page.goto(url);
  const info = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2');
    if (!c) return { webgl2: false };
    const d = c.getExtension('WEBGL_debug_renderer_info');
    return { webgl2: true, renderer: d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER),
      cbf: !!c.getExtension('EXT_color_buffer_float'), fl: !!c.getExtension('OES_texture_float_linear') };
  });
  console.log('WebGL:', JSON.stringify(info));
  page.setDefaultTimeout(900000);
  try {
    await page.waitForFunction(() => window.__CV && (window.__CV.ready || window.__CV.error), null, { timeout: 600000, polling: 500 });
  } catch (e) { errors.push('Timed out waiting for shader compilation'); }
  const st = await page.evaluate(() => ({ ready: window.__CV.ready, error: window.__CV.error }));
  console.log(`compile: ${((Date.now() - t0) / 1000).toFixed(1)}s ready=${st.ready}`);
  if (st.error) { console.log('ERROR:\n' + st.error); }
  const report = { info, compileSec: (Date.now() - t0) / 1000, views: [] };
  if (st.ready && !st.error) {
    if (args.lamp) {
      const n = Math.max(1, Math.min(3, +args.lamp || 1));
      await page.evaluate((n) => { const C = window.__CV; C.setLightMode('lamp'); C.setLampCount(n);
        if (n > 1) ['#ff5a3c', '#46ff78', '#4a6bff'].forEach((c, i) => C.setLampColor(i, c)); }, n);
      console.log('lamp mode on,', n, 'lamp(s)');
    }
    if (args.sand) {
      const secs = +args.sand > 1 ? +args.sand : 12;
      await page.evaluate(() => { const C = window.__CV; C.hold = true; Object.assign(C.SAND, { pour: true, sweep: true, flow: 12, cycle: 3 }); });
      for (let t = 0; t < secs; t += 0.1) await page.evaluate(() => window.__CV.simAll(6));
      const s = await page.evaluate(() => window.__CV.sandStats());
      console.log('sand after ' + secs + ' s:', JSON.stringify({ volumeL: s.volume, maxH: s.maxH, nan: s.nan, inWater: s.states[2], sleeping: s.sleeping }));
      if (s.nan) errors.push('NaN in sand fields');
    }
    if (args.things) {
      const r = await page.evaluate(() => {
        const C = window.__CV; C.hold = true; C.STATE.autoDrop = false; C.STATE.maxObjects = 30;
        const names = C.CATALOG.map(t => t.name);
        for (const nm of ['Rubber duck', 'Pirate ship', 'Toy battleship', 'Message bottle', 'Treasure chest', 'Anchor', 'Amphora', "Diver's helmet"]) C.dropObject(names.indexOf(nm));
        for (const k of ['clownfish', 'clownfish', 'bluetang', 'yellowtang', 'jelly', 'octopus', 'crab']) C.addCreature(k);
        return { bodies: C.BODIES.filter(b => !b.static).length, creatures: C.CREATURES.length };
      });
      for (let t = 0; t < 3; t += 0.1) await page.evaluate(() => window.__CV.simAll(6));
      const st2 = await page.evaluate(() => ({
        bodies: window.__CV.BODIES.filter(b => !b.static).map(b => [b.name, +b.pos[1].toFixed(2), +b.sub.toFixed(2)]),
        creatures: window.__CV.CREATURES.map(c => [c.kind, ...c.pos.map(x => +x.toFixed(2))]),
        bad: window.__CV.BODIES.concat(window.__CV.CREATURES).filter(b => !b.pos.every(Number.isFinite)).length }));
      console.log('things after 3 s:', JSON.stringify(st2));
      if (st2.bad) errors.push('non-finite object / creature positions');
    }
    if (args.laser) {
      const mount = ['side', 'above', 'front'].includes(args.laser) ? args.laser : 'side';
      await page.evaluate((m) => { const C = window.__CV; C.hold = true; C.laserSetMount(m); C.LASER.on = true; }, mount);
      for (let i = 0; i < 6; i++) await page.evaluate(() => window.__CV.simAll(1));   // yield: the beam tree is read back asynchronously
      const lz = await page.evaluate(() => ({ segs: window.__CV.LASER.nSeg, spots: window.__CV.LASER.nSpot,
        first: window.__CV.LASER.segs.slice(0, 4).map(s => ({ from: s.s.map(x => +x.toFixed(2)), to: s.e.map(x => +x.toFixed(2)), P: +s.P.toFixed(2) })) }));
      console.log('laser (' + mount + '):', JSON.stringify(lz));
      if (!lz.segs) errors.push('laser produced no beam segments');
    }
    if (args.ink) {
      await page.evaluate(() => { const C = window.__CV; C.hold = true; C.dropInk(-0.5, 0.3, 0); C.dropInk(0.1, 0.3, 1); C.dropInk(0.6, 0.3, 5); });
      for (let t = 0; t < 1.5; t += 0.05) await page.evaluate(() => window.__CV.simAll(3));   // yield between frames so async readbacks complete
      const s = await page.evaluate(() => { const r = window.__CV.inkStats(); return { nan: r.dye.nan + r.vel.nan + r.light.nan, mass: r.dye.sumA, expected: +window.__CV.INK.mExp.toFixed(1) }; });
      console.log('ink after 1.5 s:', JSON.stringify(s));
      if (s.nan) errors.push('NaN in ink fields');
    }
    const views = (args.views || '1,2,3,4,5,6').split(',').map(Number);
    for (const v of views) {
      await page.evaluate((v) => { window.__CV.hold = true; window.__CV.setView(v, true); }, v);
      const tv = Date.now();
      await page.evaluate((n) => window.__CV.step(n), frames);
      const dt = (Date.now() - tv) / frames;
      const shot = path.join(out, `view${v}.png`);
      const data = await page.evaluate(() => window.__CV.capture());
      fs.writeFileSync(shot, Buffer.from(data.split(',')[1], 'base64'));
      const glErr = await page.evaluate(() => window.__CV.glErrors.slice());
      console.log(`view ${v}: ${dt.toFixed(0)} ms/frame (software GL), glErrors=${JSON.stringify(glErr)} -> ${shot}`);
      report.views.push({ v, msPerFrame: dt, glErr });
    }
    const phys = await page.evaluate(() => window.__CV.BODIES.filter(b => !b.static).map(b => ({ n: b.name, y: +b.pos[1].toFixed(3), sub: +b.sub.toFixed(2), v: +Math.hypot(...b.vel).toFixed(3) })));
    console.log('bodies:', JSON.stringify(phys));
    report.bodies = phys;
  }
  report.errors = errors; report.logs = logs;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
  if (logs.length) console.log('CONSOLE:\n' + logs.slice(0, 30).join('\n'));
  const ok = st.ready && !st.error && !errors.length && report.views.every(x => !x.glErr.length);
  console.log(ok ? 'PASS' : 'FAIL');
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
