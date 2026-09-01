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
const stats = { bufferDatas: [], drawCalls: [], attribPointers: [], uniforms: [], uniVals: {}, eboUploads: [], lastEbo: null };
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
  bindBuffer(target, buf){ if(target === 0x8893 && buf) stats.lastEbo = buf; },
  bufferData(target, data, usage){
    if(target === 0x8893 && stats.lastEbo){
      stats.eboUploads.push({id: stats.lastEbo.id, len: data.length});
    } else {
      stats.bufferDatas.push({bytes: data.byteLength, usage, data});
    }
  },
  bufferSubData(target, offset, data){
    // scan the live dynamic VBO: per-frame speed stats + global max (speed cap check)
    let mx = 0, sum = 0;
    for(let i = 2; i < data.length; i += 3){
      const v = data[i];
      if(v > mx) mx = v;
      sum += v;
    }
    stats.lastSpeedMax = mx;
    stats.lastSpeedMean = sum / (data.length/3);
    if(mx > (stats.maxSpeedSeen || 0)) stats.maxSpeedSeen = mx;
    stats.lastSubData = {bytes: data.byteLength, offset};
  },
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
  drawElements(mode, count, type, offset){ stats.drawCalls.push({mode, count, type, offset, eboId: stats.lastEbo ? stats.lastEbo.id : null}); }
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
  // synthetic clock shared by rAF timestamps AND performance.now() inside the app,
  // so ms-based deadlines (e.g. the 600 ms delayed morph advance) advance
  // deterministically with the harness's frame loop.
  let simNow = performance.now();
  const mockPerf = { now: () => simNow };
  fn(mockWindow, mockDocument, mockFetch, raf, mockPerf, console, setTimeout, clearTimeout);

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
  let now = simNow; // frame clock continues from the synthetic app clock (no real-time gap)
  const frame = async (ms = 16.7) => { now += ms; simNow = now; step(now); await new Promise(r => setImmediate(r)); };
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

  // Phase 4: pointer move + click → shock + spin kick; morph advance is DELAYED
  fire('pointermove', {clientX: 500, clientY: 400});
  for(let f = 0; f < 30; f++){ await frame(); }
  fire('pointerdown', {clientX: 500, clientY: 400, target: {closest: () => null}});
  await frame();
  assert(stats.uniVals['uShockStrength'] > 0, 'click triggered radial shockwave (uShockStrength > 0)');
  let spun = false, notResetEarly = true;
  for(let f = 0; f < 18; f++){
    await frame();
    if(Math.abs(stats.uniVals['uSpin']) > 0.01) spun = true;
    if(stats.uniVals['uT'] < 0.3) notResetEarly = false;  // morph must still be running
  }
  assert(notResetEarly, 'morph NOT restarted instantly — the void lingers before the transition');
  for(let f = 18; f < 60; f++){
    await frame();
    if(Math.abs(stats.uniVals['uSpin']) > 0.01) spun = true;
  }
  assert(spun, 'camera spin kick oscillates uSpin after click');
  assert(stats.uniVals['uT'] <= 0.3, 'delayed advance fired (~600 ms) and restarted the morph');

  // Phase 4b: rapid-click stability — 5 clicks ~120 ms apart (double-tap spam)
  const uTSamples = [];
  for(let c = 0; c < 5; c++){
    fire('pointerdown', {clientX: 640, clientY: 360, target: {closest: () => null}});
    for(let f = 0; f < 7; f++){ await frame(); uTSamples.push(stats.uniVals['uT']); }
  }
  for(let f = 0; f < 45; f++){ await frame(); uTSamples.push(stats.uniVals['uT']); }
  const resets = uTSamples.reduce((n, v, i) => (i > 0 && uTSamples[i-1] > 0.3 && v < 0.1) ? n+1 : n, 0);
  assert(resets <= 1, 'rapid clicks: morph restarts at most once (debounced advance)');
  assert(stats.maxSpeedSeen <= 2200, 'rapid clicks: per-particle speed capped at VMAX (no chaotic orbits)');
  assert(stats.maxSpeedSeen >= 200, 'rapid clicks: impulses still produced visible motion');

  // Phase 4c: void healing — morph completes, then the field settles back
  for(let f = 0; f < 150; f++){ await frame(); }   // complete the morph
  for(let f = 0; f < 90; f++){ await frame(); }    // ~1.5 s settle
  assert(stats.lastSpeedMean < 50, 'void healed: field settled back into formation');

  // Phase 5: keyboard navigation (already in hold after the settle phase)
  for(let f = 0; f < 90; f++){ await frame(); }    // buffer inside the hold window
  assert(stats.uniVals['uT'] >= 1, 'morph completed before keyboard test');
  // The displayed pose at hold = the pose of the last-drawn edge EBO (at te=1
  // only the to-side edge set is drawn). eboUploads are in pose order 0..3.
  const eboPose = id => stats.eboUploads.findIndex(u => u.id === id);
  const displayedPose = () => {
    const lines = stats.drawCalls.filter(d => d.mode === 1);
    return eboPose(lines[lines.length-1].eboId);
  };
  const press = key => fire('keydown', {key, ctrlKey:false, metaKey:false, altKey:false, preventDefault(){}});
  const d0 = displayedPose();
  press('ArrowRight');
  for(let f = 0; f < 10; f++){ await frame(); }
  assert(stats.uniVals['uT'] <= 0.1, 'ArrowRight restarted the morph');
  for(let f = 0; f < 160; f++){ await frame(); }  // complete the morph
  const d1 = displayedPose();
  assert(d1 === (d0+1)%4, 'ArrowRight advanced the displayed pose by one');
  press('ArrowRight');
  for(let f = 0; f < 160; f++){ await frame(); }  // complete the morph
  const d2 = displayedPose();
  assert(d2 === (d1+1)%4, 'second ArrowRight advanced again by one');
  press('ArrowLeft');
  for(let f = 0; f < 160; f++){ await frame(); }  // complete the morph
  const d3 = displayedPose();
  assert(d3 === d1, 'ArrowLeft stepped the displayed pose back by one');
  press('ArrowLeft');
  for(let f = 0; f < 160; f++){ await frame(); }  // complete the morph
  const d4 = displayedPose();
  assert(d4 === d0, 'second ArrowLeft returned to the starting pose');

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

  // orientation: JSON poses inherit image top-left origin; the app must mirror
  // every particle's y about the pose y-range center at load time (pose0: 1.0 - y)
  const staticUpload = stats.bufferDatas.find(b => b.bytes === 20000*22*4 && b.data instanceof Float32Array);
  assert(!!staticUpload, 'static VBO payload captured for orientation check');
  const vboData = staticUpload.data;
  const pose0raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pose0.json'), 'utf8'));
  const yMid0 = (pose0raw.yrange[0] + pose0raw.yrange[1])/2;
  let yMax = -1e9, yMin = 1e9, iMax = -1, iMin = -1;
  for(let k = 0; k < 20000; k++){
    const y = pose0raw.pos[k*2+1];
    if(y > yMax){ yMax = y; iMax = k; }
    if(y < yMin){ yMin = y; iMin = k; }
  }
  assert(Math.abs(vboData[iMax*22+1] - (2*yMid0 - yMax)) < 1e-4,
    'topmost JSON particle (head) mirrored to bottom of VBO y-range');
  assert(Math.abs(vboData[iMin*22+1] - (2*yMid0 - yMin)) < 1e-4,
    'bottommost JSON particle mirrored to top of VBO y-range');
  assert(Math.abs(vboData[iMax*22] - pose0raw.pos[iMax*2]) < 1e-4, 'x coordinates untouched by the flip');

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
