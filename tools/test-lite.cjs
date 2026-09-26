// Headless check for CAUSTIC//LITE: renders a set of views on software WebGL (or the CPU fallback),
// saves screenshots, and reports the renderer, frame rate and any console errors.
//   node tools/test-lite.cjs [file] [--cpu] [--nogl] [--mobile] [--perf] [--out=dir] [--w=960] [--h=540] [--three=dir]
//   --cpu     force the CPU fallback          --nogl   launch with WebGL disabled (automatic fallback)
//   --mobile  phone-sized touch viewport      --perf   let the resolution adapt and print fps for 16 s
//   --three   serve three.js from a local copy (e.g. node_modules/three) instead of the CDN
//   --only=a,b  just these views
const path = require('path'); const fs = require('fs'); const { chromium } = require('playwright');
const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const file = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..', 'lite', 'index.html'));
const cpu = process.argv.includes('--cpu'), perf = process.argv.includes('--perf');
const W = +arg('w', 960), H = +arg('h', 540), OUT = arg('out', 'shots/lite'), THREE_DIR = arg('three', ''), ONLY = arg('only', '');
fs.mkdirSync(OUT, { recursive: true });
const VIEWS = [
  { n: 'hero' }, { n: 'low', pitch: 0.07, yaw: 0.2, dist: 5.2 }, { n: 'top', pitch: 1.3, dist: 5.5 },
  { n: 'close', pitch: 0.55, dist: 3.8, yaw: 1.2 }, { n: 'sunset', elev: 9, az: 200 }, { n: 'calm', waves: 0.3, turb: 0 },
  { n: 'storm', waves: 2, turb: 1 }, { n: 'lamp', lamp: true }, { n: 'lamp-low', lamp: true, pitch: 0.1, yaw: 0.3, dist: 5.4 },
  { n: 'ripples', ripples: true, turb: 0.1 }, { n: 'duck', pitch: 0.5, dist: 3.8, yaw: 0.5, duck: [0.1, 0.1] },
  { n: 'duck-calm', pitch: 0.75, dist: 4.2, yaw: 0.3, waves: 0, turb: 0.6, duck: [0, 0], wait: 4000 },
  { n: 'duck-top', pitch: 1.25, dist: 3.4, yaw: 0.3, duck: [0, 0], wait: 3000 }, { n: 'no-duck', duck: false },
];
(async () => {
  const nogl = process.argv.includes('--nogl'), mobile = process.argv.includes('--mobile');
  const b = await chromium.launch({ headless: true, args: nogl ? ['--disable-3d-apis'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: W, height: H } });
  if (THREE_DIR) await p.route(/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/, (route) => {
    const rel = route.request().url().replace(/^.*\/npm\/three@[^/]+\//, '');
    route.fulfill({ path: path.join(path.resolve(THREE_DIR), rel), contentType: 'text/javascript' });
  });
  const logs = []; p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
  p.on('pageerror', (e) => logs.push('pageerror: ' + e));
  await p.goto('file://' + file + (cpu ? '?cpu' : ''));
  await p.waitForFunction(() => window.lite && window.lite.R, null, { timeout: 120000 });
  await p.waitForTimeout(1500);
  console.log('renderer:', await p.evaluate(() => window.lite.R.name));
  if (perf) {
    for (let i = 0; i < 8; i++) { await p.waitForTimeout(2000); console.log(await p.evaluate(() => document.getElementById('stats').textContent)); }
  } else {
    // fixed resolution for comparable shots
    await p.evaluate((c) => { const L = window.lite; L.R.minScale = L.R.maxScale = L.state.scale = c ? 0.5 : 1; }, cpu);
    for (const v of VIEWS.filter((v) => !ONLY || ONLY.split(',').includes(v.n))) {
      await p.evaluate((v) => {
        const L = window.lite, set = (id, x) => { const el = document.getElementById(id); el.value = x; el.dispatchEvent(new Event('input')); };
        L.R.setView(v.yaw ?? 0.62, v.pitch ?? 0.34, v.dist ?? 6.4);
        set('elev', v.elev ?? 50); set('az', v.az ?? 225); set('waves', v.waves ?? 1); set('turb', v.turb ?? 0.5);
        L.setLamp(!!v.lamp);
        if (L.DUCK) {
          L.DUCK.on = v.duck !== false; document.getElementById('duck').checked = L.DUCK.on;
          if (Array.isArray(v.duck)) Object.assign(L.DUCK, { x: v.duck[0], z: v.duck[1] });
        }
        if (v.ripples) { L.addRipple(-0.6, 0.1, 8); L.addRipple(0.7, -0.3, 8); }
      }, v);
      await p.waitForTimeout(v.wait ?? (v.ripples ? 1600 : 1200));
      await p.screenshot({ path: `${OUT}/${v.n}.png`, timeout: 180000 });
      console.log('shot', v.n);
    }
  }
  console.log(logs.length ? logs.slice(0, 8).join('\n') : 'no console errors');
  await b.close();
})();
