// Smoke test: run the nemo-webgl inline script against a mocked WebGL context.
// Usage: node tools/smoke-test.js   (from the repo root)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'nemo-webgl.html'), 'utf8');
const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
if(!m) throw new Error('inline script block not found');
const src = m[1];

// ---------- mock DOM ----------
function makeClassList(el){
  const set = new Set();
  return {
    add: (...cs) => cs.forEach(c => set.add(c)),
    remove: (...cs) => cs.forEach(c => set.delete(c)),
    contains: c => set.has(c),
    toggle: (c, f) => { const on = f === undefined ? !set.has(c) : f; on ? set.add(c) : set.delete(c); return on; },
    _set: set
  };
}
function makeElement(tag){
  const el = {
    tagName: tag, children: [], style: {}, attrs: {}, _ls: {},
    className: '', title: '', textContent: '', innerHTML: '',
    appendChild(c){ this.children.push(c); return c; },
    setAttribute(k,v){ this.attrs[k]=v; },
    addEventListener(type, fn){ (this._ls[type] = this._ls[type]||[]).push(fn); },
    removeEventListener(){},
    fire(type, ev){ (this._ls[type]||[]).forEach(fn => fn(ev||{})); },
    closest(){ return null; }
  };
  el.classList = makeClassList(el);
  return el;
}

const elements = {};
function getEl(id){
  if(!elements[id]){
    elements[id] = makeElement('div');
    elements[id].id = id;
  }
  return elements[id];
}
const canvas = makeElement('canvas');

// ---------- mock GL ----------
const GL_CONST = {
  ARRAY_BUFFER:0x8892, ELEMENT_ARRAY_BUFFER:0x8893, STATIC_DRAW:0x88E4, DYNAMIC_DRAW:0x88E8,
  VERTEX_SHADER:0x8B31, FRAGMENT_SHADER:0x8B30, COMPILE_STATUS:0x8B81, LINK_STATUS:0x8B82,
  POINTS:0, LINES:1, TRIANGLE_STRIP:5, BLEND:0x0BE2, ONE:1, COLOR_BUFFER_BIT:0x4000,
  TEXTURE_2D:0x0DE1, TEXTURE0:0x84C0, TEXTURE_MIN_FILTER:0x2801, TEXTURE_MAG_FILTER:0x2800,
  TEXTURE_WRAP_S:0x2802, TEXTURE_WRAP_T:0x2803, LINEAR:0x2601, CLAMP_TO_EDGE:0x812F,
  RGBA:0x1908, UNSIGNED_BYTE:0x1401, FRAMEBUFFER:0x8D40, COLOR_ATTACHMENT0:0x8CE0,
  UNSIGNED_SHORT:0x1403, FLOAT:0x1406
};
let objId = 0;
const stats = { bufferDatas: [], drawCalls: [], attribPointers: [], uniforms: [], uniVals: {} };
const shaderSrc = new Map();
const programShaders = new Map();

function parseDecls(src, kind){
  const re = new RegExp(kind + '\\s+[\\w\\[\\]]+\\s+(\\w+)\\s*;', 'g');
  const out = []; let m;
  while((m = re.exec(src))) out.push(m[1]);
  return out;
}
const glMock = Object.assign(Object.create(GL_CONST), {
  createShader(type){ const s = {id:++objId, type}; shaderSrc.set(s.id,''); return s; },
  shaderSource(s, src){ shaderSrc.set(s.id, src); },
  compileShader(){},
  getShaderParameter(){ return true; },
  getShaderInfoLog(){ return ''; },
  createProgram(){ const p = {id:++objId}; programShaders.set(p.id, []); return p; },
  attachShader(p, s){ programShaders.get(p.id).push(s.id); },
  linkProgram(){},
  getProgramParameter(){ return true; },
  getProgramInfoLog(){ return ''; },
  getAttribLocation(p, name){
    const shaders = (programShaders.get(p.id)||[]).map(id => shaderSrc.get(id)||'');
    const vs = shaders.find(s => s.includes('gl_Position')) || shaders[0] || '';
    const attrs = parseDecls(vs, 'attribute');
    return attrs.indexOf(name);
  },
  getUniformLocation(p, name){
    const shaders = (programShaders.get(p.id)||[]).map(id => shaderSrc.get(id)||'');
    for(const s of shaders){
      const unis = parseDecls(s, 'uniform');
      const i = unis.indexOf(name);
      if(i >= 0) return {name, i};
    }
    return null;
  },
  createBuffer(){ return {id:++objId}; },
  bindBuffer(){},
  bufferData(target, data, usage){ stats.bufferDatas.push({bytes: data.byteLength, usage}); },
  bufferSubData(target, offset, data){ stats.lastSubData = {bytes: data.byteLength, offset}; },
  enableVertexAttribArray(){},
  vertexAttribPointer(loc, size, type, norm, stride, offset){
    stats.attribPointers.push({loc, size, stride, offset});
  },
  createTexture(){ return {id:++objId}; },
  texImage2D(){}, texParameteri(){},
  createFramebuffer(){ return {id:++objId}; },
  bindFramebuffer(){},
  framebufferTexture2D(){},
  deleteFramebuffer(){}, deleteTexture(){},
  viewport(){}, clearColor(){}, clear(){}, enable(){}, disable(){}, blendFunc(){},
  useProgram(){}, activeTexture(){}, bindTexture(){},
  uniform1f(loc, v){ if(loc){ stats.uniforms.push({name:loc.name, v:1}); stats.uniVals[loc.name] = v; } },
  uniform2f(loc, a, b){ if(loc){ stats.uniforms.push({name:loc.name, v:2}); stats.uniVals[loc.name] = [a, b]; } },
  uniform1i(loc, v){ if(loc){ stats.uniforms.push({name:loc.name, v:3}); stats.uniVals[loc.name] = v; } },
  drawArrays(mode, first, count){ stats.drawCalls.push({mode, first, count}); },
  drawElements(mode, count, type, offset){ stats.drawCalls.push({mode, count, type, offset}); }
});

// ---------- mock browser env ----------
let rafQueue = [];
function raf(cb){ rafQueue.push(cb); return rafQueue.length; }
function step(ms){ const q = rafQueue; rafQueue = []; for(const cb of q) cb(ms); }

const listeners = {};
let mqChangeHandler = null;
const mockWindow = {
  innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1.5,
  matchMedia(){ return {matches:false, addEventListener(type, fn){ if(type === 'change') mqChangeHandler = fn; }}; },
  addEventListener(type, fn){ (listeners[type] = listeners[type]||[]).push(fn); },
  devicePixelRatio: 1.5
};
function fire(type, ev){ (listeners[type]||[]).forEach(fn => fn(ev)); }

const mockDocument = {
  getElementById(id){ return id === 'c' ? canvas : getEl(id); },
  createElement(tag){ return makeElement(tag); }
};
canvas.getContext = () => glMock;
canvas.width = 0; canvas.height = 0;

const mockFetch = (url) => {
  const p = path.join(ROOT, url);
  return Promise.resolve({
    ok: fs.existsSync(p),
    status: fs.existsSync(p) ? 200 : 404,
    json: () => Promise.resolve(JSON.parse(fs.readFileSync(p, 'utf8')))
  });
};

// ---------- run ----------
(async () => {
  const fn = new Function('window','document','fetch','requestAnimationFrame','performance',
    'console','setTimeout','clearTimeout',
    src);
  fn(mockWindow, mockDocument, mockFetch, raf, performance, console, setTimeout, clearTimeout);

  // wait for async load pipeline
  let ok = false;
  for(let i = 0; i < 200 && !ok; i++){
    await new Promise(r => setImmediate(r));
    ok = elements['loading'] && elements['loading'].classList.contains('done');
    if(elements['loading'] && elements['loading'].classList.contains('error')) throw new Error('load failed');
  }
  if(!ok) throw new Error('loading overlay never completed');

  // ---------- behavioral phases ----------
  const assert = (cond, msg) => { if(!cond){ console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };
  let now = performance.now(); // rAF timestamps share the performance.now() clock
  const frame = async (ms = 16.7) => { now += ms; step(now); await new Promise(r => setImmediate(r)); };
  const lineDrawsPerFrame = [];
  const trackFrame = () => {
    const before = stats.drawCalls.length;
    return () => {
      let n = 0;
      for(let i = before; i < stats.drawCalls.length; i++) if(stats.drawCalls[i].mode === 1) n++;
      lineDrawsPerFrame.push(n);
    };
  };

  // Phase 1: initial hold on pose 0 → only ONE edge draw (toPose side at t=0 is fromPose... at t=0 from side drawn)
  let end = trackFrame(); await frame(); end();
  assert(lineDrawsPerFrame[lineDrawsPerFrame.length-1] === 1, 'hold: exactly one edge draw per frame');
  assert(stats.uniVals['uT'] <= 0.01, 'morph starts at uT≈0');

  // Phase 2: let the morph ramp (2.4 s) — TWO edge draws during crossfade
  lineDrawsPerFrame.length = 0;
  for(let f = 0; f < 150; f++){ end = trackFrame(); await frame(); end(); }  // ~2.5s
  assert(lineDrawsPerFrame.some(n => n === 2), 'morph: two edge draws (crossfade) during transition');
  assert(stats.uniVals['uT'] >= 1, 'uT reaches 1 after 2.4 s morph');
  const lAlpha = stats.uniVals['uLineAlpha'];
  assert(typeof lAlpha === 'number' && lAlpha >= 0 && lAlpha <= 1, 'uLineAlpha bounded [0,1]');
  assert(stats.uniVals['uFromIndex'] === 0, 'uFromIndex=0 for pose0→pose1 morph');

  // Phase 3: continue through hold → auto-cycle advance at 2.4s+5.2s
  for(let f = 0; f < 340; f++){ end = trackFrame(); await frame(); end(); }  // ~5.7s more
  assert(stats.uniVals['uFromIndex'] === 1, 'auto-cycle advanced to uFromIndex=1');

  // Phase 4: pointer move + click → shockwave + spin kick + manual advance
  fire('pointermove', {clientX: 500, clientY: 400});
  for(let f = 0; f < 30; f++){ await frame(); }
  fire('pointerdown', {clientX: 500, clientY: 400, target: {closest: () => null}});
  await frame();
  assert(stats.uniVals['uShockStrength'] > 0, 'click triggered radial shockwave (uShockStrength > 0)');
  assert(stats.uniVals['uT'] <= 0.02, 'click restarted morph (uT reset)');
  let spun = false;
  for(let f = 0; f < 60; f++){
    await frame();
    if(Math.abs(stats.uniVals['uSpin']) > 0.01) spun = true;
  }
  assert(spun, 'camera spin kick oscillates uSpin after click');

  // Phase 5: keyboard navigation (let the click-triggered morph finish first)
  for(let f = 0; f < 160; f++){ await frame(); }  // ~2.7s → hold (uT=1)
  assert(stats.uniVals['uT'] >= 1, 'morph completed before keyboard test');
  const captionPose = () => elements['poseCaption'].textContent;
  const displayIdx = () => Number(captionPose().trim().slice(0,2)) - 1;
  const beforePose = displayIdx();
  fire('keydown', {key:'ArrowRight', ctrlKey:false, metaKey:false, altKey:false, preventDefault(){}});
  for(let f = 0; f < 10; f++){ await frame(); }
  assert(stats.uniVals['uT'] <= 0.1, 'ArrowRight restarted the morph');
  for(let f = 0; f < 160; f++){ await frame(); }  // complete the morph
  const afterRight = displayIdx();
  assert(afterRight !== beforePose, 'ArrowRight advanced the pose');
  fire('keydown', {key:'ArrowLeft', ctrlKey:false, metaKey:false, altKey:false, preventDefault(){}});
  for(let f = 0; f < 160; f++){ await frame(); }  // complete the morph back
  assert(displayIdx() === beforePose, 'ArrowLeft stepped the displayed pose back');

  // Phase 5b: pose indicator dots — built from pose names, clickable to jump
  const dots = elements['poseDots'].children;
  assert(dots.length === 4, 'four pose indicator dots rendered');
  assert(dots.every((d,i) => d.attrs['aria-pressed'] !== undefined), 'dots expose aria-pressed');
  assert(dots.some(d => d.classList.contains('active')), 'active dot highlighted');
  const dotTarget = (displayIdx() + 2) % 4;
  dots[dotTarget].fire('click', {stopPropagation(){}});
  for(let f = 0; f < 160; f++){ await frame(); }  // complete the morph
  assert(displayIdx() === dotTarget, 'clicking a pose dot jumps to that pose');
  assert(dots[dotTarget].classList.contains('active'), 'clicked dot becomes active');

  // Phase 6: prefers-reduced-motion → frozen cycle, uReduced=1
  mqChangeHandler({matches: true});
  await frame();
  assert(stats.uniVals['uReduced'] === 1, 'uReduced=1 when prefers-reduced-motion active');
  const frozenT = stats.uniVals['uT'];
  for(let f = 0; f < 30; f++){ await frame(); }
  assert(stats.uniVals['uT'] === frozenT, 'cycle frozen under reduced motion');
  assert(stats.uniVals['uShockStrength'] === 0 && stats.uniVals['uSpin'] === 0, 'shock/spin zeroed under reduced motion');
  mqChangeHandler({matches: false});

  // ---------- structural assertions ----------
  const bufSizes = stats.bufferDatas.map(b => b.bytes);
  assert(bufSizes.includes(20000*22*4), 'static VBO = 22 floats x 20000 (1.76 MB) uploaded');
  assert(bufSizes.includes(20000*3*4), 'dynamic VBO = 3 floats x 20000 uploaded');
  assert(stats.lastSubData && stats.lastSubData.bytes === 20000*3*4, 'dynamic VBO updated via bufferSubData each frame');

  // attribute offsets for the 22-float stride (filter particle program: stride 88 bytes)
  const ptr = {};
  for(const p of stats.attribPointers){
    if(p.stride === 88 || p.stride === 12) ptr[p.loc] = {size:p.size, stride:p.stride, offset:p.offset};
  }
  assert(ptr[0] && ptr[0].offset===0  && ptr[0].size===4, 'aPoseAB @0, vec4');
  assert(ptr[1] && ptr[1].offset===16 && ptr[1].size===4, 'aPoseCD @16, vec4');
  assert(ptr[2] && ptr[2].offset===32 && ptr[2].size===3, 'aColA @32, vec3');
  assert(ptr[3] && ptr[3].offset===44 && ptr[3].size===3, 'aColB @44, vec3');
  assert(ptr[4] && ptr[4].offset===56 && ptr[4].size===3, 'aColC @56, vec3');
  assert(ptr[5] && ptr[5].offset===68 && ptr[5].size===3, 'aColD @68, vec3');
  assert(ptr[6] && ptr[6].offset===80 && ptr[6].size===2, 'aMeta @80, vec2');
  assert(ptr[7] && ptr[7].offset===0  && ptr[7].size===3 && ptr[7].stride===12, 'aDyn vec3, separate dynamic VBO');

  // edge draws: two LINES drawElements with ~7900 edges each during morph
  const lineDraws = stats.drawCalls.filter(d => d.mode === 1);
  assert(lineDraws.length > 0, 'edge line draws happened');
  const edgeCounts = [...new Set(lineDraws.map(d => d.count))];
  assert(edgeCounts.every(c => c > 10000 && c < 20000 && c % 2 === 0), `per-pose edge index counts sane (${edgeCounts.join(',')})`);
  assert(lineDraws.some(d => d.type === 0x1403), 'edges drawn as UNSIGNED_SHORT');

  // points: 20000 particles
  assert(stats.drawCalls.some(d => d.mode === 0 && d.count === 20000), '20000 particles drawn as points');
  assert(stats.drawCalls.some(d => d.mode === 0 && d.count === 140), 'star field drawn');

  // uniforms seen
  const uniNames = new Set(stats.uniforms.map(u => u.name));
  for(const u of ['uResolution','uOrigin','uScale','uTime','uMouse','uFromIndex','uT','uReduced','uSpin','uShockCenter','uShockRadius','uShockStrength']) {
    assert(uniNames.has(u), `uniform ${u} set`);
  }
  assert(uniNames.has('uLineAlpha'), 'uLineAlpha set for edge crossfade');

  console.log('\nTotal draw calls:', stats.drawCalls.length, '| buffer uploads:', stats.bufferDatas.length);
  console.log('Smoke test complete.');
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
