/*
 * liquid.js —— 首页与管理页共用的「入口语义 + 液体封面」模块。
 * 干什么：类型 / 意象 / 系列的推断，液体 shader（PC 实时大图、登录页背景），静态封面（手机环、缩略带、管理页列表与预览）。
 * 怎么用：<script src="liquid.js"></script> 后用 window.HP.*；封面关联方式改本文件的 COVER_MODE。
 * 需要什么：浏览器 WebGL；没有 WebGL 时 HP.liquid() 返回 null、HP.covers() 返回空串，调用方照常工作。
 */
(function () {
    /* 封面怎么和入口挂钩（设计稿 docs/lab/portal-ice.html 第二轮）：意象 {true,'none'} · 字入液 {false,'name'} · 意象+字（现用）· 首字为核 {true,'initial'} */
    const COVER_MODE = { motif: true, text: 'name' };
    const LEGACY_DEFAULT_COLOR = '#c8ff00';   // 管理页早期的默认色，等于「没选过」，走类型色

    /* ---- 入口的语义：类型、意象、系列 ---- */
    const kindOf = u => /\/app\//.test(u) ? { cls: 'k-app', label: '应用' } : /\/r\//.test(u) ? { cls: 'k-res', label: '资源库' } : { cls: 'k-site', label: '站点' };
    const MOTIFS = {
      flow: { id: 0, word: '流动', why: '没有可读的内容线索' },
      exchange: { id: 1, word: '对冲', why: '两股液流上下对冲、在中线卷起漩涡' },
      strata: { id: 2, word: '层流', why: '被拉成一行行平行流动的层' },
      ripple: { id: 3, word: '波纹', why: '一圈圈从中心荡开，像敲门' },
      steps: { id: 4, word: '台阶', why: '一层层堆起来的平台' },
    };
    function motifOf(s) {
      if (s.motif && MOTIFS[s.motif]) return MOTIFS[s.motif];          // 管理页手选优先
      const t = `${s.name} ${s.description || ''} ${s.url}`;
      if (/交换|同步|exchange|sync/i.test(t)) return MOTIFS.exchange;
      if (/日志|log|记录|周报|journal/i.test(t)) return MOTIFS.strata;
      if (/叩|敲|knock|消息|聊天|通知/i.test(t)) return MOTIFS.ripple;
      if (/资源|文件|下载|镜像|字体|\/r\//i.test(t)) return MOTIFS.steps;
      return MOTIFS.flow;
    }
    const baseName = n => n.replace(/(企业|专业|社区|旗舰)版$|\s*(Pro|Lite|Plus|Enterprise)$/i, '').trim();
    function hash(str) { let h = 2166136261; for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
    const KIND_TINT = { 'k-app': [0.59, 0.80, 1.0], 'k-res': [0.59, 0.92, 0.78], 'k-site': [0.72, 0.70, 1.0] };
    function tintOf(s) {
      const c = String(s.color || '').toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(c) && c !== LEGACY_DEFAULT_COLOR) return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
      return KIND_TINT[kindOf(s.url).cls];
    }

    /* ---- 缓动与弹簧 ---- */
    function bezier(x1, y1, x2, y2) {
      const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
      return p => { if (p <= 0) return 0; if (p >= 1) return 1; let t = p;
        for (let i = 0; i < 8; i++) { const e = ((ax * t + bx) * t + cx) * t - p, d = (3 * ax * t + 2 * bx) * t + cx; if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break; t -= e / d; }
        return ((ay * t + by) * t + cy) * t; };
    }
    const EASE_IN_OUT = bezier(0.77, 0, 0.175, 1);
    const spring = (p, to, k, z, dt) => { p.v += (-k * (p.x - to) - 2 * z * Math.sqrt(k) * p.v) * dt; p.x += p.v * dt; };
    function loop(tick) {
      let on = true, last = performance.now();
      const f = t => { if (!on) return; const dt = Math.min(1 / 30, (t - last) / 1000); last = t; tick(dt, t); requestAnimationFrame(f); };
      requestAnimationFrame(f);
      return () => { on = false; };
    }

    /* ---- 液体 shader：域扭曲噪声 → 铬面色带；意象改形、字形让液面安静 ---- */
    const VERT = 'attribute vec2 a; varying vec2 v; void main(){ v = a * .5 + .5; gl_Position = vec4(a, 0., 1.); }';
    const FRAG = `precision highp float;
#ifndef OCT
#define OCT 5
#endif
varying vec2 v;
uniform vec2 uRes; uniform float uTime, uMix;
uniform vec4 uA, uB; uniform vec3 uTA, uTB; uniform sampler2D uXA, uXB;
float h(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(h(i), h(i + vec2(1., 0.)), u.x), mix(h(i + vec2(0., 1.)), h(i + vec2(1., 1.)), u.x), u.y); }
float fbm(vec2 p) { float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < OCT; i++) { s += a * n(p); p = m * p; a *= .5; } return s; }
vec3 shade(vec2 uv, vec4 P, vec3 tint, sampler2D X) {
  float seed = P.x, motif = P.y, tAmt = P.z, ph = P.w, asp = uRes.x / uRes.y, t = uTime * .025;
  vec2 p = (uv - .5) * vec2(asp, 1.) * 1.7 + seed;
  if (motif > 1.5 && motif < 2.5) p.x *= .3;
  if (motif > .5 && motif < 1.5) p.x += (smoothstep(.3, .7, uv.y) * 2. - 1.) * 1.6 * sin(uTime * .042);
  float tx = texture2D(X, uv).r, calm = clamp(tx * tAmt * .55, 0., .8);
  vec2 q = vec2(fbm(p + vec2(0., t)), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3. * q + vec2(1.7, 9.2) + .4 * t), fbm(p + 3. * q + vec2(8.3, 2.8) - .3 * t));
  float val = fbm(p + 3.4 * (1. - calm) * r);
  if (motif > 2.5 && motif < 3.5) { float d = length((uv - vec2(.55, .5)) * vec2(asp, 1.)); val += .2 * sin(d * 30. - uTime * .7) * exp(-d * 2.2); }
  if (motif > 3.5) { float k = val * 7., f = fract(k); val = mix(val, (floor(k) + smoothstep(.3, .7, f)) / 7., .75); }
  val += tx * tAmt * .09;
  float band = .5 + .5 * cos(6.2832 * (val * 1.7 + ph));
  float L = pow(band, 1.7), sp = pow(band, 12.);
  vec3 col = mix(vec3(.043, .043, .05), vec3(.913, .894, .855), L);
  return mix(col, tint, sp * .55 * clamp(r.x * 1.4, 0., 1.));
}
void main() {
  vec3 a = shade(v, uA, uTA, uXA);
  vec3 b = uMix > .001 ? shade(v, uB, uTB, uXB) : a;
  gl_FragColor = vec4(mix(a, b, uMix), 1.);
}`;
    /* 标题字形 → 全分辨率模糊高度图（低分辨率纹理的梯度会被扭曲放大成横纹） */
    function textField(s, how, w, h) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      if (how === 'none') return c;
      const str = how === 'initial' ? [...s.name][0] : s.name;
      const fs = how === 'initial' ? h * 0.8 : Math.min(h * 0.26, (w * 0.62) / Math.max(2, [...str].length) * 1.15);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `700 ${fs}px -apple-system, "PingFang SC", system-ui, sans-serif`;
      g.filter = `blur(${Math.round(fs * 0.09)}px)`;
      g.fillText(str, w * 0.56, h * 0.52);
      return c;
    }
    /* lite：手机用，噪声少一层（4 档），GPU 每像素少 20% 运算；液体本身柔，看不出差别 */
    function liquid(canvas, preserve = false, lite = false) {
      const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: preserve });
      if (!gl) return null;
      const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, (lite ? '#define OCT 4\n' : '') + FRAG)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const al = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(al); gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0);
      const U = k => gl.getUniformLocation(pr, k);
      const u = { res: U('uRes'), time: U('uTime'), mix: U('uMix'), A: U('uA'), B: U('uB'), TA: U('uTA'), TB: U('uTB'), XA: U('uXA'), XB: U('uXB') };
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      const texCache = new Map();
      function tex(key, cv) {
        if (texCache.has(key)) return texCache.get(key);
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
        for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
        texCache.set(key, t); return t;
      }
      function params(s) {
        const base = baseName(s.name), hb = hash(base), how = COVER_MODE.text;
        return {
          P: [(hb % 977) / 31, COVER_MODE.motif ? motifOf(s).id : 0, how === 'none' ? 0 : how === 'initial' ? 1.5 : 1.1, ((hb >>> 12) % 100) / 100 + (base !== s.name ? 0.33 : 0)],
          T: tintOf(s),
          X: tex(`${s.name}|${how}|${canvas.width}x${canvas.height}`, textField(s, how, canvas.width, canvas.height)),
        };
      }
      function draw(time, A, B, mixv) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(u.res, canvas.width, canvas.height); gl.uniform1f(u.time, time); gl.uniform1f(u.mix, mixv);
        gl.uniform4fv(u.A, A.P); gl.uniform4fv(u.B, B.P); gl.uniform3fv(u.TA, A.T); gl.uniform3fv(u.TB, B.T);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, A.X); gl.uniform1i(u.XA, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, B.X); gl.uniform1i(u.XB, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      return { params, draw, dispose: () => gl.getExtension('WEBGL_lose_context')?.loseContext() };
    }
    /* 静态封面（手机环、PC 缩略带）：同一个 shader 在固定时刻各拍一帧，与 PC 大图同源同形 */
    const coverCache = new Map();
    function covers(list) {
      const cv = document.createElement('canvas'); cv.width = 480; cv.height = 320;
      const L = liquid(cv, true);
      if (!L) return list.map(() => '');
      const out = list.map(s => {
        const key = JSON.stringify([s.name, s.description, s.url, s.motif, s.color]);
        if (!coverCache.has(key)) { const p = L.params(s); L.draw(12, p, p, 0); coverCache.set(key, cv.toDataURL('image/jpeg', 0.86)); }
        return coverCache.get(key);
      });
      L.dispose();
      return out;
    }


    // 只导出两页真用到的：首页（单幅）与管理页（列表封面、预览、登录背景）
    window.HP = { kindOf, MOTIFS, motifOf, EASE_IN_OUT, spring, loop, liquid, covers };
})();
