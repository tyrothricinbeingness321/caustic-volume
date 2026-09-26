// Builds sandbox/index.html from sandbox/src: the page shell (00_head.html), every JavaScript module
// joined in file-name order into one script, and a small module script that loads three.js from
// jsDelivr (through an import map) and starts the app. No dependencies; needs Node 18 or newer.
//   node tools/build-sandbox.cjs
const fs = require('fs');
const path = require('path');

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
const dir = path.join(__dirname, '..', 'sandbox');
const src = path.join(dir, 'src');
const shell = fs.readFileSync(path.join(src, '00_head.html'), 'utf8');
const split = shell.indexOf('<canvas');   // everything before the canvas goes in <head>
const modules = fs.readdirSync(src).filter((f) => f.endsWith('.js')).sort();
const js = modules.map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');
const importmap = '<script type="importmap">{ "imports": { "three": "' + THREE_URL + '" } }</script>\n';

const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
  + shell.slice(0, split) + importmap + '</head>\n<body>\n' + shell.slice(split)
  + '<script>\n"use strict";\n' + js + '\n</script>\n'
  + '<script type="module">\n'
  + '// three.js through the import map, or straight from its URL where an import map can\'t apply\n'
  + 'try { window.THREE = await import(\'three\'); }\n'
  + 'catch (e) { try { window.THREE = await import(\'' + THREE_URL + '\'); } catch (e2) { console.error(e2); } }\n'
  + 'start();\n'
  + '</script>\n</body>\n</html>\n';

fs.writeFileSync(path.join(dir, 'index.html'), html);
console.log(`built sandbox/index.html (${Math.round(html.length / 1024)} KB) from ${modules.length} modules`);
