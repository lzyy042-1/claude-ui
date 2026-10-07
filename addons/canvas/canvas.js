/* ────────────────────────────────────────────────────────────────
 * claude-ui 的「画布」附加模块
 *
 * 这里的东西原来长在 index.html 里（约 1300 行），整块搬出来的，
 * **逻辑一行没改**，只是换了位置。
 *
 * 它自己管：无限画布 / 涂鸦 / 工作区（状态机）/ 图片对象 / 蒙版 / 存盘恢复
 *
 * 跟本体的接口只有两个方向，一共三个函数：
 *   本体 → 画布   window.__initView() / window.__inkFit()   切模式时通知重新量尺寸
 *   画布 → 本体   window.CU.flow() / window.CU.raw()        往左栏写一条（没有就静默）
 *
 * ⚠️ 别在这文件里读本体的内部变量 —— 那会让它退回到"捆在一起"。
 * ──────────────────────────────────────────────────────────────── */
(function () {
'use strict';

// 本体现在通过 window.CU 提供这两个；拿不到就静默，画布照样能用
function flow(icon, cls, text){ var c = window.CU; if (c && c.flow) c.flow(icon, cls, text); }
function raw (kind, cls, text){ var c = window.CU; if (c && c.raw)  c.raw (kind, cls, text); }
// esc 本来是共享作用域的，搬出来得自带一份
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// ── 「给 AI 看」────────────────────────────────────────────────
//   AI 能看见画布，靠的是**画布自己暴露的那个接口**，不是本体替它说话。
//   这个按钮把一句话复制到剪贴板，用户贴给模型，模型自己去拉。
//  ⚠️ 用 execCommand 不用 navigator.clipboard：后者要过 WebView2 的权限，
//     而 pywebview 默认不处理权限请求 —— 会静默失败（"点了没反应"）。
function copyText(s){
  var ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

function canvasUrl(){ return location.origin + '/api/canvas'; }

(function mountGiveAi(){
  var bar = document.querySelector('#pCanvas .hdr');
  if (!bar) return;
  var b = document.createElement('span');
  b.className = 'tool';
  b.id = 'tGiveAi';
  b.title = '复制一句话贴给 AI —— 它就知道去哪儿看你的画布';
  b.textContent = '给AI看';
  b.addEventListener('click', function () {
    var msg = '我的画布在 ' + canvasUrl()
            + '（我手写和画的都在那儿：笔迹坐标、认出来的字、图片对象的位置。'
            + '你可以直接取来看。）';
    if (copyText(msg)){
      var old = b.textContent;
      b.textContent = '已复制';
      setTimeout(function () { b.textContent = old; }, 1200);
    } else {
      b.textContent = canvasUrl();      // 复制不了就把它露出来，让人自己抄
    }
  });
  bar.appendChild(b);
})();


  // ── 画布视图（缩放 / 平移）───────────────────────────────────────
  //  屏幕坐标 = 画布坐标 × k + t     ⇒     画布坐标 = (屏幕 − t) / k
  //  k/t 只作用在 .plane 上；视口 #cvs 本身不动。
  //  ⚠️ 只要碰"手在哪儿"，一律先过 toPlane() —— 缩放一开，
  //     原来那些直接拿 clientX 减 rect.left 的地方会全部错掉。
  const V = { k: 1, tx: 0, ty: 0 };
  const VIEW_MIN = 0.25, VIEW_MAX = 5;

  // plane 的尺寸 / 画布原点在 plane 里的位置。
  // 所有「画布坐标 → plane 内的 CSS 坐标」都要加这个偏移。
  // 涂鸦那边不用管 —— 它走 SVG viewBox，负起点的 viewBox 已经把偏移吃掉了。
  const PLANE_W = 8000, PLANE_H = 6000;
  const PLANE_CX = PLANE_W / 2, PLANE_CY = PLANE_H / 2;

  const _planeEl = () => document.getElementById('plane');
  const _cvsEl   = () => document.getElementById('cvs');

  let _viewInited = false;

  // 视图初始化（只做一次）：
  //   · 画布上有东西 → 把**内容的包围盒中心**对到视口中心（打开就能看见自己画的）
  //   · 空画布       → 把**原点**放在视口中心
  // ⚠️ 空画布不能把原点留在左上角：plane 是有限的，一缩小边界就进视口、
  //    角上立刻露出一片空白（实测踩过）。原点居中后四周都有内容可看。
  function _placeView(){
    const r = _cvsEl().getBoundingClientRect();
    if (r.width <= 0) return false;                   // 画布还藏着，量不到
    const st = (window.__inkStrokes && window.__inkStrokes()) || [];
    const ob = (window.__canvasObjs && window.__canvasObjs()) || [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    st.forEach(s => (s.pts || []).forEach(p => {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }));
    ob.forEach(o => {
      if (o.x < x0) x0 = o.x;
      if (o.x + o.w > x1) x1 = o.x + o.w;
      if (o.y < y0) y0 = o.y;
      if (o.y + o.h > y1) y1 = o.y + o.h;
    });
    if (x0 === Infinity){ V.tx = r.width / 2; V.ty = r.height / 2; }
    else { V.tx = r.width / 2 - (x0 + x1) / 2; V.ty = r.height / 2 - (y0 + y1) / 2; }
    _viewInited = true;
    return true;
  }

  function applyView(){
    if (!_viewInited) _placeView();
    const tf = `translate(${V.tx.toFixed(2)}px, ${V.ty.toFixed(2)}px) scale(${V.k.toFixed(4)})`;
    _planeEl().style.transform = tf;
    const p2 = document.getElementById('plane2');       // 批注层跟内容层同一套变换
    if (p2) p2.style.transform = tf;
    updScaleBar();
    if (window.__drawWS) window.__drawWS();   // 工作区蒙版挂在视口层，缩放/平移后要跟着重算
  }

  // 比例尺：挑一个"整"的画布距离（1/2/5/10 × 10ⁿ），让它在屏幕上落在 70~150px 之间。
  // 数字永远好读，线长随缩放变 —— 跟地图、CAD 里那个是同一套做法。
  function updScaleBar(){
    const line = document.getElementById('sbLine'), lab = document.getElementById('sbLabel');
    if (!line || !lab) return;
    const raw  = 100 / V.k;                                   // 先按"100px 该是多少单位"反推
    const pow  = Math.pow(10, Math.floor(Math.log10(raw)));
    let pick = 10 * pow;
    for (const m of [1, 2, 5, 10]){
      const c = m * pow;
      if (c * V.k >= 70){ pick = c; break; }                  // 够长了就它了
    }
    line.style.width = (pick * V.k).toFixed(1) + 'px';
    lab.textContent  = pick >= 1000 ? (pick / 1000) + 'k' : String(pick);
  }

  // 画布模式露出来之后才有尺寸 → 那时候再初始化视图
  window.__initView = () => { _viewInited = false; applyView(); };

  // 屏幕坐标 → 画布坐标
  function toPlane(cx, cy){
    const r = _cvsEl().getBoundingClientRect();
    return [(cx - r.left - V.tx) / V.k, (cy - r.top - V.ty) / V.k];
  }

  // 以屏幕上的某点为锚缩放 —— 那个点下面的画布内容原地不动（不跳）。
  // 推导：同一个屏幕点 px 对应同一个画布点 ⇒ px = c·k + t = c·k' + t' ⇒ t' = px − (px − t)·k'/k
  function zoomAt(cx, cy, factor){
    const r = _cvsEl().getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const k2 = Math.min(VIEW_MAX, Math.max(VIEW_MIN, V.k * factor));
    if (k2 === V.k) return;
    V.tx = px - (px - V.tx) * (k2 / V.k);
    V.ty = py - (py - V.ty) * (k2 / V.k);
    V.k = k2;
    applyView();
  }


  // ── 框选 chip ─────────────────────────────────────────────────
  // 网页自己截不了屏（浏览器安全边界），所以截图在后端做（PIL ImageGrab）。
  // 后端还会在截之前把本窗口 hide 掉，否则框出来的全是软件自己那张脸。
  // 坐标换算靠 getBoundingClientRect —— 图是按比例缩放显示的，不能拿窗口坐标硬算。
  (function(){
    const chip = document.getElementById('modeShot');
    const ov   = document.getElementById('shotOv');
    const img  = document.getElementById('shotImg');
    const sel  = document.getElementById('shotSel');
    const hint = document.getElementById('shotHint');
    let shot = null;                 // {name,w,h}
    let p0 = null, rect = null;      // 拖框起点 / 当前矩形（图内像素坐标）

    function close(){
      ov.hidden = true; sel.hidden = true; img.removeAttribute('src');
      shot = null; p0 = null; rect = null;
    }

    function toImg(ev){
      const b = img.getBoundingClientRect();
      const x = (ev.clientX - b.left) / b.width  * shot.w;
      const y = (ev.clientY - b.top)  / b.height * shot.h;
      return [Math.max(0, Math.min(shot.w, x)), Math.max(0, Math.min(shot.h, y))];
    }

    function draw(){
      if (!rect) return;
      const b = img.getBoundingClientRect();
      const sx = b.width / shot.w, sy = b.height / shot.h;
      sel.style.left   = (b.left + rect[0] * sx) + 'px';
      sel.style.top    = (b.top  + rect[1] * sy) + 'px';
      sel.style.width  = ((rect[2] - rect[0]) * sx) + 'px';
      sel.style.height = ((rect[3] - rect[1]) * sy) + 'px';
      sel.hidden = false;
    }

    async function commit(){
      if (!rect || !shot){ close(); return; }
      const [x0, y0, x1, y1] = rect;
      const body = { name: shot.name, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      close();
      try {
        const r = await fetch('/api/crop', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.err || ('HTTP ' + r.status));
        // 裁出来的图也走"附件卡片"（跟拖拽同一条路）——
        // 宿主给了 __attach 就用它，没给（老宿主/单独跑）就退回老行为：把路径塞进输入框。
        if (window.__attach) {
          window.__attach(d.path);
        } else {
          // 路径可能是中文目录，用空格接上去跟手打的没区别
          inp.value = (inp.value ? inp.value.replace(/\s*$/, ' ') : '') + d.path;
          inp.selectionStart = inp.selectionEnd = inp.value.length;
        }
        inp.focus();
        if (window.__canvasAdd && d.url) window.__canvasAdd(d.url);   // 同一张图落到画布上
        flow('·', 'ok', '框选：' + d.path);
      } catch (e) {
        raw('err', 'er', '裁图失败：' + esc(e.message));
      }
    }

    chip.addEventListener('click', async () => {
      chip.classList.remove('on');
      flow('·', 'd', '框选：正在截屏…');
      try {
        const r = await fetch('/api/capture', { method: 'POST' });
        const d = await r.json();
        if (!d.ok) throw new Error(d.err || ('HTTP ' + r.status));
        shot = d;
        img.src = d.url + '?t=' + Date.now();
        ov.hidden = false;
        sel.hidden = true;
        hint.textContent = `拖一个框 → 回车确认 · Esc 取消 · 原图 ${d.w}×${d.h}`;
        flow('·', 'ok', `框选：已截 ${d.w}×${d.h}`);
      } catch (e) {
        raw('err', 'er', '截屏失败：' + esc(e.message));
      }
    });

    ov.addEventListener('mousedown', ev => {
      if (!shot) return;
      p0 = toImg(ev);
      rect = [p0[0], p0[1], p0[0], p0[1]];
      draw();
    });
    ov.addEventListener('mousemove', ev => {
      if (!p0 || !shot) return;
      const p = toImg(ev);
      rect = [Math.min(p0[0], p[0]), Math.min(p0[1], p[1]),
              Math.max(p0[0], p[0]), Math.max(p0[1], p[1])];
      draw();
    });
    ov.addEventListener('mouseup', () => { p0 = null; });
    ov.addEventListener('dblclick', commit);      // 双击也能确认
    window.addEventListener('keydown', ev => {
      if (ov.hidden) return;
      if (ev.key === 'Escape'){ close(); ev.preventDefault(); }
      else if (ev.key === 'Enter'){ commit(); ev.preventDefault(); }
    });
  })();

  // ── 画布：目前只有一条规矩 —— 框选截的东西落到这儿 ────────────
  //  对象是 DOM（不是位图），所以拖、删、以后连线都便宜；
  //  这正是「WP 走 web」那条理由（DOM 就是对象树，不用截图）。
  (function(){
    const cvs  = document.getElementById('cvs');      // 视口：算坐标的基准
    const plane = document.getElementById('plane');    // 内容层：对象住这儿
    const cnt  = document.getElementById('cvCnt');
    const objs = [];                  // {el, path, url, x, y, w, h}
    let z = 10;

    function refresh(){
      cnt.textContent = objs.length + ' obj';
      // 空提示归涂鸦层统一管（笔迹也算内容），别两边各判一次打起来
      if (window.__inkObjCount) window.__inkObjCount(objs.length);
      if (window.__canvasChanged) window.__canvasChanged();
    }

    // at = 可选的重放位置（存盘恢复时用）；不给就按第几个斜着往下摆
    function add(src, at){
      const img = new Image();
      img.onload = () => {
        const i = objs.length;
        const k = Math.min(1, 320 / img.naturalWidth);
        const el = document.createElement('div');
        el.className = 'cvobj';
        const ox = (at && at.x) != null ? at.x : 24 + (i % 6) * 28;    // 这两个是**画布坐标**
        const oy = (at && at.y) != null ? at.y : 20 + (i % 6) * 24;
        el.style.width = Math.round((at && at.w) || img.naturalWidth * k) + 'px';
        el.style.left = (ox + PLANE_CX) + 'px';    // plane 内 CSS 坐标 = 画布坐标 + 偏移
        el.style.top  = (oy + PLANE_CY) + 'px';
        el.style.zIndex = ++z;
        el.dataset.path = (at && at.path) || src;
        img.style.width = '100%';
        el.appendChild(img);
        // 归属：新加的图算**当前打开的工作区**的；恢复时按存档里的 wsp
        const wsp = at ? (at.wsp || null)
                       : ((window.__wsOpenId && window.__wsOpenId()) || null);
        const rec = { el, path: el.dataset.path, url: (at && at.url) || src,
                      x: ox, y: oy,                 // 存**画布坐标**，不是 style.left
                      wsp,                          // 属于哪个工作区（null = 原画）
                      w: parseFloat(el.style.width), h: 0 };
        const x = document.createElement('div');
        x.className = 'x'; x.textContent = '×'; x.title = '删掉这块';
        x.addEventListener('click', ev => {
          ev.stopPropagation();
          el.remove();
          const j = objs.indexOf(rec);
          if (j >= 0) objs.splice(j, 1);
          refresh();
        });
        el.appendChild(x);
        el.addEventListener('mousedown', ev => {
          if (ev.target === x) return;
          const r = el.getBoundingClientRect();
          const dx = ev.clientX - r.left, dy = ev.clientY - r.top;   // 抓取偏移（屏幕空间）
          el.style.zIndex = ++z;
          const move = e2 => {
            // 屏幕 → 画布；抓取偏移也要除以 k，不然缩放后手感会飘
            const [x, y] = toPlane(e2.clientX, e2.clientY);
            const nx = Math.max(-PLANE_CX + 8, x - dx / V.k);    // 画布坐标
            const ny = Math.max(-PLANE_CY + 8, y - dy / V.k);
            el.style.left = (nx + PLANE_CX) + 'px';
            el.style.top  = (ny + PLANE_CY) + 'px';
            rec.x = nx; rec.y = ny;                              // 拖到一半也是对的
          };
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            if (window.__canvasChanged) window.__canvasChanged();
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
          ev.preventDefault();
        });
        plane.appendChild(el);
        objs.push(rec);
        refresh();
      };
      img.onerror = () => raw('err', 'er', '画布载图失败：' + esc(src));
      img.src = src;
    }

    window.__canvasAdd = add;
    window.__canvasObjs = () => objs.map(o => ({
      path: o.path, url: o.url, x: Math.round(o.x), y: Math.round(o.y),
      w: Math.round(o.w), h: Math.round(o.h), wsp: o.wsp || 0 }));
    // 归属可见性 —— 跟笔迹一套规则：工作区里的图只在**那个工作区开着**时露出来
    //  ⚠️ 传的是**一串** id（可以多个工作区同时开着），不是一个
    window.__canvasFilter = ids => {
      const open = ids || [];
      objs.forEach(o => {
        o.el.style.display = (!o.wsp || open.indexOf(o.wsp) >= 0) ? '' : 'none';
      });
    };
    refresh();
  })();

  // ── 画布手势（2026-10-07 加）────────────────────────────────────
  //   鼠标：滚轮缩放 · 中键或空格+拖 平移
  //   触摸：单指平移 · 双指缩放
  //   笔：**一律不抢** —— 它是拿来画画的
  //   三者物理上分得开，不冲突。
  //
  //   ⚠️ 空格状态要暴露给涂鸦层（`_spaceDown`）：不然空格+左键平移时，
  //      涂鸦层会先 setPointerCapture 把事件截走，画布跟着画出一道线。
  let _spaceDown = false;
  (function(){
    const cvs = document.getElementById('cvs');
    const live = new Map();          // pointerId → 最近位置
    let mode = null, start = null;

    cvs.addEventListener('wheel', e => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
    }, { passive: false });

    window.addEventListener('keydown', e => {
      if (e.code === 'Space' && !e.repeat &&
          !/^(INPUT|TEXTAREA)$/.test(e.target && e.target.tagName || '')){
        _spaceDown = true; cvs.classList.add('pan'); e.preventDefault();
      }
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space'){ _spaceDown = false; cvs.classList.remove('pan'); }
    });

    const pts  = () => [...live.values()];
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    cvs.addEventListener('pointerdown', e => {
      if (e.pointerType === 'pen') return;                        // 笔：不抢
      const mousePan = e.pointerType === 'mouse' && (e.button === 1 || (_spaceDown && e.button === 0));
      if (e.pointerType === 'mouse' && !mousePan) return;         // 鼠标左键留给涂鸦 / 拖对象
      live.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cvs.setPointerCapture(e.pointerId); } catch (_) {}
      if (live.size === 2){
        const [a, b] = pts();
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const [ccx, ccy] = toPlane(cx, cy);                       // 起手时中点下的画布点
        mode  = 'zoom';
        start = { d: Math.max(1, dist(a, b)), k: V.k, ccx, ccy };
      } else if (live.size === 1){
        mode  = 'pan';
        start = { x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty };
      }
      cvs.classList.add('pan');
      e.preventDefault();
    });

    cvs.addEventListener('pointermove', e => {
      if (!live.has(e.pointerId)) return;
      live.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'pan' && live.size === 1){
        V.tx = start.tx + (e.clientX - start.x);
        V.ty = start.ty + (e.clientY - start.y);
        applyView();
      } else if (mode === 'zoom' && live.size === 2){
        const [a, b] = pts();
        const k2 = Math.min(VIEW_MAX, Math.max(VIEW_MIN,
                     start.k * (Math.max(1, dist(a, b)) / start.d)));
        const r  = cvs.getBoundingClientRect();
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        // 起手时中点下的那个画布点，始终待在当前中点下面 —— 双指不飘
        V.tx = (cx - r.left) - start.ccx * k2;
        V.ty = (cy - r.top)  - start.ccy * k2;
        V.k  = k2;
        applyView();
      }
    });

    const up = e => {
      live.delete(e.pointerId);
      if (live.size === 0){ mode = null; start = null; cvs.classList.remove('pan'); }
      else if (live.size === 1){                 // 双指松开一指 → 接着单指平移
        const [a] = pts();
        mode  = 'pan';
        start = { x: a.x, y: a.y, tx: V.tx, ty: V.ty };
      }
    };
    cvs.addEventListener('pointerup', up);
    cvs.addEventListener('pointercancel', up);
  })();

  // ── 画布涂鸦层 ────────────────────────────────────────────────
  //  一条笔迹 = 一个 <svg:g>（不是位图，不是"拍平的画布"）——
  //  以后「框 = 声明对象」才有东西可声明。
  //
  //  走 Pointer Events，笔/手指/鼠标同一套代码：
  //    · e.pointerType === 'pen' | 'touch' | 'mouse'
  //    · e.pressure        —— 鼠标恒为 0.5，笔给真实压感
  //    · 笔悬停时也会来 pointermove（buttons === 0），悬停提示以后能挂这儿
  //  ⚠️ 掌托拒识不归浏览器管：笔进感应范围时 Wacom 驱动自己抑制触摸。
  (function(){
    const host  = document.getElementById('plane');   // 涂鸦的家 = 内容层（不是视口）
    const svg   = document.getElementById('ink');     // 原画画这儿（蒙版**下面**）
    const svg2  = document.getElementById('ink2');    // 批注画这儿（蒙版**上面**，永远不被蒙）
    const note  = document.getElementById('cvsNote');
    const cntZ  = document.getElementById('cvCnt');
    const cntI  = document.getElementById('cvInk');
    const tPen  = document.getElementById('tPen');
    const tErase= document.getElementById('tErase');
    const tWs     = document.getElementById('tWs');
    const wsMenu  = document.getElementById('wsMenu');
    const tWsRect = document.getElementById('tWsRect');
    const tWsElp  = document.getElementById('tWsElp');
    const tWsPoly = document.getElementById('tWsPoly');
    const tWsLasso= document.getElementById('tWsLasso');
    const tClear= document.getElementById('tClear');
    const NS = 'http://www.w3.org/2000/svg';
    const W0 = 1.4, W1 = 5.2;          // 压感→笔宽 的范围

    let tool = 'pen';
    let cur = null;                    // 正在画的这一笔（一个对象，不是裸 <g>）
    let nObjs = 0;                     // 图片对象数（由对象层回调更新）
    const strokes = [];                // 所有笔迹，顺序 = 画的顺序
    const strokeLog = [];              // 每笔的量测记录（定误触阈值用）
    window.__inkLog = strokeLog;

    function fit(){
      // ⚠️ 用 offsetWidth/Height，**不能**用 getBoundingClientRect ——
      //    后者给的是 transform **之后**的尺寸，一缩放 viewBox 就跟着变、笔迹被缩两次。
      // ⚠️ viewBox 从 -PLANE_CX,-PLANE_CY 起：plane 的原点在它自己中间，
      //    这样 SVG 坐标 == **画布坐标**，笔迹存下来的就是干净坐标、不带偏移。
      const w = host.offsetWidth, h = host.offsetHeight;
      if (w > 0){
        const vb = `${-PLANE_CX} ${-PLANE_CY} ${w} ${h}`;
        svg.setAttribute('viewBox', vb);
        if (svg2) svg2.setAttribute('viewBox', vb);   // 批注层同一套坐标
      }
    }
    window.addEventListener('resize', fit);
    window.__inkFit = fit;             // 画布模式切换后容器才量得到尺寸

    function refresh(){
      cntI.textContent = strokes.length + ' 笔';
      if (note) note.hidden = (strokes.length + nObjs) > 0;
      applyWsView();                                          // 归属/开关变了 → 可见性跟着变
      if (window.__canvasChanged) window.__canvasChanged();   // 通知存盘层
    }
    window.__inkObjCount = n => { nObjs = n; refresh(); };

    // 笔迹的**数据**（坐标 + 每点笔宽）—— 存盘、报给后端、算几何都靠它。
    //  <g> 只是它的画法，这个才是本体。
    window.__inkStrokes = () => strokes.map(s => ({
      pts: s.pts.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
      ws:  s.ws.map(w => Math.round(w * 100) / 100),
      wsp: s.wsp || 0,                     // 0 = 原画；>0 = 属于哪个工作区
    }));

    // 从数据重建笔迹（存盘恢复用）。**不走误触判据** —— 已经在画布上的东西就是已经接受的。
    window.__inkImport = arr => {
      let k = 0;
      (arr || []).forEach(sd => {
        const pts = sd.pts || [], ws = sd.ws || [];
        if (!pts.length) return;
        const g = document.createElementNS(NS, 'g');
        const s = { g, pts: pts.map(p => [p[0], p[1]]), ws: [],
                    wsp: sd.wsp || null,                 // 归属跟着一起恢复
                    type: 'pen', t0: performance.now(), pmax: 0, pmin: 0 };
        if (s.wsp){                                      // 批注换色（同 beginStroke）
          g.classList.add('wsink');
          const ww = wsById(s.wsp);
          if (ww) g.style.setProperty('--inkcol', wsColor(ww));
        }
        for (let i = 0; i < pts.length; i++){
          const w = ws[i] != null ? ws[i] : W0;
          if (i === 0) seg(g, pts[0][0], pts[0][1], pts[0][0] + 0.01, pts[0][1], w);
          else         seg(g, pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1], w);
          s.ws.push(w);
        }
        (s.wsp && svg2 ? svg2 : svg).appendChild(g);   // 批注恢复进上面那层
        strokes.push(s);
        k++;
      });
      refresh();
      return k;
    };

    function at(e){
      return toPlane(e.clientX, e.clientY);       // 缩放/平移都算进去了
    }

    // ── 工作区：画布上任意形状、任意数量的圈选区域（2026-10-07 他定的）──
    //  以前只有"一个矩形"。现在：形状随便（矩形/圆/多边形/套索）、数量随便、**可以重叠**。
    //  重叠根本不是问题 —— 一块地方被两个圈圈到，它就是亮的、同时属于两个，没有归属之争。
    //  ⇒ 蒙版从「一个元素 + 一块大 box-shadow（天生排他）」换成
    //    **SVG mask：一层白底挖 N 个洞**。挖多少、怎么重，都只是"洞"。
    //
    //  工作区仍然是一个"状态"（他选的判据 B）：
    //    画完之后**往里加了新东西** → 意图明确 → 自动保存，不打扰他
    //    没加                     → 意图不明 → 停一会儿问一声
    //  不是看"框里有没有东西"（框住的本来就有），而是看**框完之后有没有新增**。
    const wsList = [];        // 已完成的工作区，按画出来的顺序
    let wsDrag = null;        // 正在画的那个（拖拽中 / 多边形进行中）
    let wsCur  = null;        // 刚画完、还没点「选好了」的那个
    let wsActive = null;      // 画的东西归它 —— **最后点开的那个**（可以有多个同时开着）
    let wsSeq  = 0;           // 编号（◈1 ◈2 …）
    // 工具名 → 形状种类
    const WS_TOOLS = { 'ws-rect': 'rect', 'ws-elp': 'ellipse',
                       'ws-poly': 'poly', 'ws-lasso': 'lasso' };

    // 画布坐标 → 屏幕坐标（工作区画在视口层，不吃 transform）
    const wsScr = (x, y) => [x * V.k + V.tx, y * V.k + V.ty];

    // ── 归属（2026-10-07 他定的核心一条）──────────────────────────
    //  「打开了工作区这个，后面所有的动作都和原画无关了」——
    //  所以一条笔迹/一个图对象现在都带 **wsp**（我属于哪个工作区）：
    //    wsp = null/0 → 原画，永远在
    //    wsp = N      → 工作区 N 的，**只有 N 被打开时**才露出来（最小化 = 收起来）
    //  ⚠️ 叫 wsp 不叫 ws —— 笔迹上的 `s.ws` 早被**每点笔宽**占了，别撞。
    function wsById(id){ return wsList.find(w => w.id === id) || null; }

    function wsVisible(s){
      if (!s.wsp) return true;                       // 原画的东西：永远在
      const w = wsById(s.wsp);                        // 工作区的：**那个工作区开着**才在
      return !!(w && w.open);
    }

    // 把归属算出来的可见性刷到画布上（笔迹 + 图片对象）
    function wsVisibleIds(){ return wsList.filter(w => w.open).map(w => w.id); }
    function applyWsView(){
      strokes.forEach(s => { s.g.style.display = wsVisible(s) ? '' : 'none'; });
      if (window.__canvasFilter) window.__canvasFilter(wsVisibleIds());
      updDbg();
    }

    function wsReset(){
      const done = document.getElementById('wsDone');
      if (done) done.hidden = true;
    }

    // 形状 → SVG 元素。pts 一律是**画布坐标**，这里现换成屏幕坐标。
    //   rect / ellipse：pts = 两个对角；poly / lasso：pts = 一串顶点
    function wsShapeEl(w, dashed){
      let el;
      if (w.kind === 'rect'){
        el = document.createElementNS(NS, 'rect');
        const [x0, y0] = wsScr(w.pts[0][0], w.pts[0][1]);
        const [x1, y1] = wsScr(w.pts[1][0], w.pts[1][1]);
        el.setAttribute('x', Math.min(x0, x1).toFixed(1));
        el.setAttribute('y', Math.min(y0, y1).toFixed(1));
        el.setAttribute('width',  Math.abs(x1 - x0).toFixed(1));
        el.setAttribute('height', Math.abs(y1 - y0).toFixed(1));
      } else if (w.kind === 'ellipse'){
        el = document.createElementNS(NS, 'ellipse');
        const [x0, y0] = wsScr(w.pts[0][0], w.pts[0][1]);
        const [x1, y1] = wsScr(w.pts[1][0], w.pts[1][1]);
        el.setAttribute('cx', ((x0 + x1) / 2).toFixed(1));
        el.setAttribute('cy', ((y0 + y1) / 2).toFixed(1));
        el.setAttribute('rx', (Math.abs(x1 - x0) / 2).toFixed(1));
        el.setAttribute('ry', (Math.abs(y1 - y0) / 2).toFixed(1));
      } else {                                   // poly / lasso
        el = document.createElementNS(NS, 'path');
        const d = w.pts.map((q, i) => (i ? 'L' : 'M') +
          wsScr(q[0], q[1]).map(v => v.toFixed(1)).join(' ')).join(' ');
        el.setAttribute('d', d + ' Z');
      }
      if (dashed) el.setAttribute('class', 'wslive');
      return el;
    }

    function wsBBox(w){                          // 画布坐标下的包围盒
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      w.pts.forEach(p => { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
                           if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; });
      return [x0, y0, x1, y1];
    }

    // 重绘整个工作区层：形状（描边+膜）+ 挖洞 + 标记。
    //  ⚠️ 每次全重建 —— 工作区就几个，成本可忽略，换来的是逻辑简单、不会有残留。
    function drawWS(){
      const svgEl  = document.getElementById('wsSvg');
      const holes  = document.getElementById('wsHoles');
      const shapes = document.getElementById('wsShapes');
      const ui     = document.getElementById('wsUi');
      const done   = document.getElementById('wsDone');
      const minBtn = document.getElementById('wsMin');
      const dropBtn= document.getElementById('wsDrop');
      if (!svgEl) return;

      holes.textContent = ''; shapes.textContent = ''; ui.textContent = '';
      if (done)    done.hidden    = !wsCur;    // 工具条上那三个按钮（不跟画布跑）
      if (dropBtn) dropBtn.hidden = !wsCur;    // 「不要」—— 画完框反悔时按它
      if (minBtn)  minBtn.hidden  = !wsActive;

      const openWs = wsList.filter(w => w.open);
      const mode = document.getElementById('wsMode');
      if (mode){
        if (wsActive){
          mode.hidden = false;
          mode.style.color = wsColor(wsActive);
          mode.style.borderColor = wsColor(wsActive);
          mode.textContent = '◈ ' + (wsActive.name || ('工作区 #' + wsActive.id))
            + (openWs.length > 1 ? '（共 ' + openWs.length + ' 个开着）' : '')
            + ' ｜ 你现在画的都归它';
        } else mode.hidden = true;
      }

      // 蒙版：**所有开着的工作区**一起挖洞 —— 几个圈叠在一起就叠着亮（他 2026-10-07 要的
      //  "叠加选区"）——外加"正在画的 / 待确认的"那两个。挖多洞用 SVG mask，天然没有排他问题。
      const paint = openWs.slice();
      if (wsDrag && paint.indexOf(wsDrag) < 0) paint.push(wsDrag);
      if (wsCur  && paint.indexOf(wsCur)  < 0) paint.push(wsCur);
      if (!paint.length){
        svgEl.classList.remove('on');
      } else {
        svgEl.classList.add('on');
        paint.forEach(w => {
          const shp = wsShapeEl(w, w === wsDrag);           // 带描边 + 那层膜
          shp.style.stroke = wsColor(w);                    // 每个工作区自己的颜色
          shapes.appendChild(shp);
          holes.appendChild(wsShapeEl(w, false));           // 挖洞：洞里 = 露出来
          drawWsExtras(w, shapes);                          // 多边形的起点 + 预览线
        });
      }

      // 图标**常驻**在包围盒左上角外侧：「◈ 工作区 #N」+ ×
      //   点图标 = 开 / 关（反复点都行）；开着的那个底亮起来。
      wsList.forEach(w => {
        const bb = wsBBox(w);
        const [sx, sy] = wsScr(bb[0], bb[1]);
        const it = document.createElement('div');
        it.className = 'wsitem';
        it.style.left = sx.toFixed(0) + 'px';
        it.style.top  = (sy - 4).toFixed(0) + 'px';
        const b = document.createElement('div');
        b.className = 'wsbadge' + (w.open ? ' on' : '');
        b.dataset.ws = w.id;
        b.style.color = wsColor(w); b.style.borderColor = wsColor(w);
        b.textContent = '◈ ' + (w.name || ('工作区 #' + w.id))
          + ((w.tags && w.tags.length) ? '  ' + w.tags.join(' ') : '');
        b.title = w.open ? '点它收起这个工作区' : '点它打开这个工作区';
        it.appendChild(b);
        const d = document.createElement('div');
        d.className = 'wsdel'; d.dataset.ws = w.id; d.textContent = '×';
        it.appendChild(d);
        ui.appendChild(it);
      });

      updDbg();
      renderWsPanel();
    }

    // 多边形画到一半才有的两个图形：起点实心点（点它闭合）+ 跟手的预览线
    function drawWsExtras(w, shapes){
      if (w !== wsDrag || w.kind !== 'poly' || !w.pts.length) return;
      const [cx, cy] = wsScr(w.pts[0][0], w.pts[0][1]);
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx.toFixed(1)); c.setAttribute('cy', cy.toFixed(1));
      c.setAttribute('r', '4');
      c.setAttribute('class', 'wsfirstpt');
      shapes.appendChild(c);
      if (w.hover){
        const last = w.pts[w.pts.length - 1];
        const a = wsScr(last[0], last[1]), b = wsScr(w.hover[0], w.hover[1]);
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', `M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}`);
        p.setAttribute('class', 'wspreview');
        shapes.appendChild(p);
      }
    }

    // 一个工作区画完了 → 进列表、挂编号、**立刻**把「选好了」摆出来
    function wsCommit(w){
      wsList.push(w);
      w.id = ++wsSeq;
      w.open  = false;             // 画完只是"备着"，点「选好了」才开着
      w.name  = '';                // 空 = 用默认的「工作区 #N」
      w.color = WS_COLORS[(w.id - 1) % WS_COLORS.length];   // 按编号轮着给，自动就分得开
      w.tags  = [];
      wsCur = w;
      wsDrag = null;
      drawWS();
      if (window.__canvasChanged) window.__canvasChanged();   // 工作区本身也要存盘
    }

    // 点「选好了」→ **进入**这个工作区（之后画的东西都记在它名下，见 wsp 那段）
    function wsConfirm(){
      if (!wsCur) return;
      wsCur.open = true;
      wsActive = wsCur;            // 刚进去的这个 = 画的东西归它
      wsCur = null;
      applyWsView();
      drawWS();
    }

    // 最小化 = 把**当前活动**的那个收起来。里面的东西**不回原画**，作为「批注」一起收。
    //  ⚠️ 只收当前这个 —— 别的工作区开着的话照旧亮着（他 2026-10-07 要的"叠加选区"）。
    function wsMinimize(){
      if (wsActive) wsActive.open = false;
      wsActive = null;
      applyWsView();
      drawWS();
    }

    // 「不要」= 画完框反悔了：把这个框整个丢掉（还没进去，所以没有批注要清）
    function wsDropIt(){
      if (!wsCur) return;
      const i = wsList.indexOf(wsCur);
      if (i >= 0) wsList.splice(i, 1);
      removeStrokesOf(wsCur.id);
      wsCur = null;
      refresh();
      drawWS();
    }

    // 把某个工作区名下的笔迹全删掉（点 × 删工作区时，批注跟着一起走）
    function removeStrokesOf(id){
      for (let i = strokes.length - 1; i >= 0; i--){
        if (strokes[i].wsp === id){
          strokes[i].g.remove();
          strokes.splice(i, 1);
        }
      }
    }

    window.__wsConfirm  = wsConfirm;
    window.__wsMinimize = wsMinimize;
    window.__wsOpenId   = () => (wsActive ? wsActive.id : null);   // 对象层加图时问"算谁的"
    document.getElementById('wsDone').addEventListener('click', wsConfirm);
    document.getElementById('wsDrop').addEventListener('click', wsDropIt);
    document.getElementById('wsMin').addEventListener('click', wsMinimize);

    // 标记上的点击（事件委托 —— 标记每次重绘都会重建）
    document.getElementById('wsUi').addEventListener('click', ev => {
      const t = ev.target;
      const d = t && t.closest && t.closest('.wsdel');
      if (d){                                   // × ：删掉这个工作区，名下的批注一起走
        const id = +d.dataset.ws;
        const i = wsList.findIndex(w => w.id === id);
        if (i >= 0){
          const gone = wsList.splice(i, 1)[0];
          if (wsCur    === gone) wsCur    = null;
          if (wsActive === gone) wsActive = null;
          removeStrokesOf(id);          // 它名下的批注跟着一起走
          refresh();                    // 顺带 applyWsView + 存盘
        }
        return;
      }
      const b = t && t.closest && t.closest('.wsbadge');
      if (b){                                   // ◈N ：开 / 关（各自独立，可以多个同时开）
        const id = +b.dataset.ws;
        const w  = wsList.find(x => x.id === id);
        if (!w) return;
        if (w.open){ w.open = false; if (wsActive === w) wsActive = null; }
        else       { w.open = true;  wsActive = w; }   // 最后点开的那个 = 画的归它
        applyWsView();
        drawWS();
      }
    });

    // ── 调试面板（临时的，按 ` 开关；看完可以整段摘掉）──────────────
    let wsDbgOn = true;          // ⚠️ 临时的：先默认打开让他看，看完改回 false（或整段摘掉）
    function updDbg(){
      const el = document.getElementById('wsDbg');
      if (!el) return;
      if (!wsDbgOn){ el.classList.remove('on'); return; }
      el.classList.add('on');
      const k = wsList.map(w => w.kind + '#' + w.id).join(' ') || '—';
      el.innerHTML =
        '<b>tool</b> ' + tool + '\n' +
        '<b>view</b> k=' + V.k.toFixed(3) + '  tx=' + V.tx.toFixed(0) + '  ty=' + V.ty.toFixed(0) + '\n' +
        '<b>list</b> ' + wsList.length + '  ' + k + '\n' +
        '<b>open</b> ' + (wsList.filter(w => w.open).map(w => '#' + w.id).join(' ') || '—')
          + '   ← 开着的；画的归 ' + (wsActive ? '#' + wsActive.id : '原画') + '\n' +
        '<b>cur </b> ' + (wsCur ? wsCur.kind + '#' + wsCur.id : '—') + '   ← 正等「选好了」\n' +
        '<b>drag</b> ' + (wsDrag ? wsDrag.kind + '  pts=' + wsDrag.pts.length : '—') + '\n' +
        '<b>ink </b> ' + strokes.length + ' 笔，看得见 ' + strokes.filter(wsVisible).length + ' 笔';
    }
    window.__wsDbg = on => { wsDbgOn = on; updDbg(); };

    window.__drawWS  = drawWS;
    window.__clearWS = () => { wsList.length = 0; wsDrag = null; wsCur = null;
                               wsActive = null; wsReset(); applyWsView(); drawWS(); };

    // ── 工作区管理面板（右栏，挂会话下面）──────────────────────────
    //  一行 = 一个工作区：色点 · 名字（点一下改）· 关键词（点一下删，「+」加）· × 删掉
    const WS_COLORS = ['#56d4dd', '#7bd88f', '#ffd166', '#ff7b72', '#c792ea', '#82aaff'];
    const wsColor = w => w.color || WS_COLORS[(w.id - 1) % WS_COLORS.length];
    let wsEditing = 0;            // 正在改名/加标签时 > 0 → 面板先别重建，不然输入被打断

    function renderWsPanel(){
      const box = document.getElementById('wsRows');
      if (!box || wsEditing) return;
      const cnt = document.getElementById('wsCnt');
      if (cnt) cnt.textContent = String(wsList.length);
      box.textContent = '';
      wsList.forEach(w => {
        const row = document.createElement('div');
        row.className = 'wsrow'; row.dataset.ws = w.id;

        const dot = document.createElement('span');
        dot.className = 'wsdot'; dot.dataset.act = 'color';
        dot.style.background = wsColor(w); dot.title = '点一下换个颜色';
        row.appendChild(dot);

        const nm = document.createElement('span');
        nm.className = 'wsname';                       // 单击 = 跳过去（跟行一样）；双击才改名
        nm.textContent = w.name || ('工作区 #' + w.id);
        nm.title = '双击改名字';
        row.appendChild(nm);

        (w.tags || []).forEach(t => {
          const tg = document.createElement('span');
          tg.className = 'wstg'; tg.dataset.act = 'untag'; tg.dataset.tag = t;
          tg.textContent = t; tg.title = '点一下删掉';
          row.appendChild(tg);
        });

        const add = document.createElement('span');
        add.className = 'wstg add'; add.dataset.act = 'tag';
        add.textContent = '+'; add.title = '加个关键词';
        row.appendChild(add);

        const x = document.createElement('span');
        x.className = 'wsrowx'; x.dataset.act = 'del'; x.textContent = '×';
        x.title = '删掉这个工作区（里面的批注一起没）';
        row.appendChild(x);

        box.appendChild(row);
      });
    }

    // 就地编辑（名字 / 关键词）—— 用 contenteditable 不用 prompt：
    //  WebView2 里 prompt 不一定弹得出来（pywebview 没接 script dialog）。
    function inlineEdit(el, init, done){
      wsEditing++;
      el.classList.add('edit');
      el.contentEditable = 'true';
      el.textContent = init;
      el.focus();
      try {
        const sel = getSelection(), r = document.createRange();
        r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
      } catch (_) {}
      let fin = false;
      const end = ok => {
        if (fin) return;
        fin = true;
        el.contentEditable = 'false';
        el.classList.remove('edit');
        wsEditing--;
        done(ok ? el.textContent.trim() : null);
      };
      el.onkeydown = e => {
        if (e.key === 'Enter'){ e.preventDefault(); end(true); }
        else if (e.key === 'Escape'){ e.preventDefault(); end(false); }
      };
      el.onblur = () => end(true);
    }

    // 视图转到某个工作区：包围盒中心对到视口中心（缩放不动）
    function focusWs(w){
      const r = document.getElementById('cvs').getBoundingClientRect();
      if (r.width <= 0) return;
      const bb = wsBBox(w);
      V.tx = r.width  / 2 - (bb[0] + bb[2]) / 2 * V.k;
      V.ty = r.height / 2 - (bb[1] + bb[3]) / 2 * V.k;
      applyView();
    }

    document.getElementById('wsRows').addEventListener('click', ev => {
      const row = ev.target.closest('.wsrow');
      if (!row) return;
      const w = wsById(+row.dataset.ws);
      if (!w) return;
      const t = ev.target.closest('[data-act]');
      if (!t){ focusWs(w); return; }              // 光点行 = 把视图转过去
      const act = t.dataset.act;
      const save = () => { if (window.__canvasChanged) window.__canvasChanged(); };

      if (act === 'color'){                       // 色点：轮着换
        const i = WS_COLORS.indexOf(wsColor(w));
        w.color = WS_COLORS[(i + 1) % WS_COLORS.length];
        paintWsColors(); drawWS(); save();

      } else if (act === 'tag'){
        inlineEdit(t, '', v => {
          if (v){
            w.tags = w.tags || [];
            if (w.tags.indexOf(v) < 0) w.tags.push(v.slice(0, 12));
          }
          renderWsPanel(); save();
        });

      } else if (act === 'untag'){
        w.tags = (w.tags || []).filter(x => x !== t.dataset.tag);
        renderWsPanel(); save();

      } else if (act === 'del'){                  // 删掉：名下的批注一起走（跟画布上的 × 一样）
        const i = wsList.indexOf(w);
        if (i < 0) return;
        wsList.splice(i, 1);
        if (wsCur    === w) wsCur    = null;
        if (wsActive === w) wsActive = null;
        removeStrokesOf(w.id);
        refresh(); drawWS();
      }
    });

    // 双击名字才改名（单击是"跳过去"，跟整行一样 —— 行里几乎全是名字，
    //  不这样可点的地方就只剩一条缝了）
    document.getElementById('wsRows').addEventListener('dblclick', ev => {
      const nm = ev.target.closest('.wsname');
      if (!nm) return;
      const row = nm.closest('.wsrow');
      const w = wsById(+row.dataset.ws);
      if (!w) return;
      inlineEdit(nm, w.name || ('工作区 #' + w.id), v => {
        if (v != null) w.name = v.slice(0, 24);
        renderWsPanel(); drawWS();
        if (window.__canvasChanged) window.__canvasChanged();
      });
    });

    // 把颜色刷到批注上：工作区里画的笔 = **那个工作区的颜色**
    function paintWsColors(){
      strokes.forEach(s => {
        if (!s.wsp) return;
        const w = wsById(s.wsp);
        if (w) s.g.style.setProperty('--inkcol', wsColor(w));
      });
    }

    // ── 工作区的存盘 / 恢复 ───────────────────────────────────────
    //  ⚠️ 必须存：笔迹上带了 wsp（"我属于工作区 N"），工作区自己不存的话，
    //     重开之后那些笔就成了**没主人的孤儿** —— 永远显示不出来。
    window.__wsDump = () => wsList.map(w => ({
      id: w.id, kind: w.kind,
      name: w.name || '', color: w.color || '', tags: (w.tags || []).slice(),
      pts: w.pts.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
    }));
    window.__wsLoad = arr => {
      wsList.length = 0;
      let mx = 0;
      (arr || []).forEach(wd => {
        if (!wd || !wd.pts || !wd.pts.length) return;
        const id = wd.id || (mx + 1);
        wsList.push({ id, kind: wd.kind || 'rect', open: false,
                      name: wd.name || '', color: wd.color || '', tags: wd.tags || [],
                      pts: wd.pts.map(p => [p[0], p[1]]) });
        if (id > mx) mx = id;
      });
      wsSeq = mx;
      wsDrag = wsCur = wsActive = null;  // 恢复出来一律是"收起来"状态（画布先给原画）
      paintWsColors();
      drawWS();
    };

    function widthOf(e){
      const p = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
      return W0 + p * (W1 - W0);
    }

    function seg(g, x0, y0, x1, y1, w){        // 一段独立 path —— 单条 path 没法变宽
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M ${x0.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)}`);
      p.setAttribute('stroke-width', w.toFixed(2));
      g.appendChild(p);
    }

    // 一笔 = {g, pts, ws, type, t0, pmax, pmin}
    //   pts/ws 是**数据**（存盘、报给后端、算几何全靠它），g 只是**它的画法**。
    function beginStroke(x, y, e){
      const w = widthOf(e);
      const g = document.createElementNS(NS, 'g');
      const s = { g, pts: [[x, y]], ws: [w],
                  wsp: wsActive ? wsActive.id : null,  // 归属：有活动工作区就记在它名下
                  type: e.pointerType, t0: performance.now(),
                  pmax: e.pressure || 0, pmin: e.pressure || 0 };
      if (s.wsp){                              // 批注：用**它所属工作区**的颜色
        g.classList.add('wsink');
        const ww = wsById(s.wsp);
        if (ww) g.style.setProperty('--inkcol', wsColor(ww));
      }
      seg(g, x, y, x + 0.01, y, w);            // 点一下也留个点
      // ⚠️ 批注进**上面那层**（svg2）—— 直接就画在蒙版之上，不用去蒙版里挖洞
      (s.wsp && svg2 ? svg2 : svg).appendChild(g);
      strokes.push(s);
      return s;
    }

    function extendStroke(s, x, y, w, p){
      const [px, py] = s.pts[s.pts.length - 1];
      seg(s.g, px, py, x, y, w);
      s.pts.push([x, y]);
      s.ws.push(w);
      if (p > s.pmax) s.pmax = p;
      if (p < s.pmin) s.pmin = p;
    }

    // ── 橡皮 ──────────────────────────────────────────────────────
    //  ⚠️ 命中走**缓存的包围盒**（s.bbox），不是每次 getBBox() ——
    //     悬停高亮每动一下就查一轮，129 笔就是 129 次 getBBox，会卡。
    //     笔画画完就不变了，缓存的盒永远有效。
    function bbOf(s){ return s.bbox || (s.bbox = s.g.getBBox()); }

    function findStroke(x, y){
      for (let i = strokes.length - 1; i >= 0; i--){   // 从最上面一笔往下找
        if (!wsVisible(strokes[i])) continue;          // 收起来的笔擦不到（跟"原件只读"一条线）
        const b = bbOf(strokes[i]), pad = 6;
        if (x >= b.x - pad && x <= b.x + b.width + pad &&
            y >= b.y - pad && y <= b.y + b.height + pad) return strokes[i];
      }
      return null;
    }

    let erasing = false;                       // 橡皮按下去了（拖着一路擦）
    let hl = null;                             // 当前高亮的那一笔
    function setHL(s){
      if (hl === s) return;
      if (hl) hl.g.classList.remove('hit');
      hl = s;
      if (hl) hl.g.classList.add('hit');
    }

    function eraseStroke(s){
      if (!s) return;
      if (hl === s){ hl = null; }
      const i = strokes.indexOf(s);
      if (i >= 0) strokes.splice(i, 1);
      s.g.remove();
      undoStack.push({ kind: 'restore', s, from: '橡皮' });   // 擦掉也能撤回来
      refresh();
    }

    // ── 自动丢：只剩一条，而且是最没争议的那条 ────────────────────
    //
    //   · 长度 ≤ 1px —— 落笔了但一点没动。三轮数据里零歧义。
    //
    // ⛔ **压力判据试过，拿掉了（2026-10-07），别再加回来。**
    //   走过两版：0.40 → 当场吃掉他两笔真笔画；降到 0.20 → 又吃掉一笔（0.11）。
    //   更要命的不是阈值定高了，是**这个特征本身不稳**：
    //   他原话「这是我在非平面上写的字」——**屏幕立着写不重**。
    //   ⇒ 压力读数不是他的书写特征，是**屏幕角度的函数**。同一支笔、同一个人，
    //     屏幕一斜数就变。拿它当判据，迟早还要咬一口。
    //   （当时的数据：真笔画最低 0.28 / 划过最高 0.22，只隔 0.06 —— 本来就没余量。）
    //
    // ⛔ **「孤立」也试过，同样不行**：真笔画 gap 最大 92px、误触 70/96px，完全重叠。
    //   一个字的第一笔、标点、换行，天然就是孤立的。
    //
    // ⇒ 结论：**误触的判定交给人和橡皮**（悬停预告 + 拖动擦 + 撤销），
    //   程序只处理"完全没动"这一种**没有歧义**的情况。
    //   这也是他自己的规矩：「AI 不做判断，把判断换成人能做的动作」。
    function rejectReason(rec){
      if (rec.len <= 1) return '没动';
      return null;
    }

    function strokeLen(s){
      let L = 0;
      for (let i = 1; i < s.pts.length; i++)
        L += Math.hypot(s.pts[i][0] - s.pts[i-1][0], s.pts[i][1] - s.pts[i-1][1]);
      return L;
    }

    // 两个矩形之间的空隙（重叠 = 0）。用来算"这一笔离最近的其他笔画有多远"。
    // ⚠️ getBBox() 给的是 SVGRect，属性是 .width/.height —— 不是 .w/.h。
    //    写错的话结果是 NaN，然后被当成"算不出来"全丢成 -1（2026-10-07 踩过，155 笔全废）。
    function rectGap(a, b){
      const dx = Math.max(0, Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width)));
      const dy = Math.max(0, Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height)));
      return Math.hypot(dx, dy);
    }

    function gapToOthers(s){
      if (strokes.length < 2) return -1;         // 只有它自己，谈不上"孤立"
      let d = Infinity;
      for (const o of strokes){
        if (o === s || !o.bbox) continue;
        d = Math.min(d, rectGap(s.bbox, o.bbox));
      }
      return Number.isFinite(d) ? Math.round(d) : -1;
    }

    function buildRec(s){
      s.bbox = s.g.getBBox();                    // 存起来复用 —— getBBox 不便宜
      return { type: s.type,
               ms:  Math.round(performance.now() - s.t0),
               len: Math.round(strokeLen(s)),
               pts: s.pts.length,
               // 每个点走多远 = 划动速度。真笔画约 8~16，快速划过去 20~43。
               // 单独用会重叠（真笔画最高 15.9，划过最低 13.3），但和压力合看有用 —— 先存着。
               v: +(strokeLen(s) / Math.max(1, s.pts.length - 1)).toFixed(1),
               pmax: +s.pmax.toFixed(2), pmin: +s.pmin.toFixed(2),
               gap: gapToOthers(s),
               bb: [Math.round(s.bbox.x), Math.round(s.bbox.y),
                    Math.round(s.bbox.width), Math.round(s.bbox.height)] };
    }

    svg.addEventListener('pointerdown', e => {
      // ── 触摸一律不要 ────────────────────────────────────────────
      //  他 2026-10-07 明确说"不会用手指在画布上画" ⇒ 画布是笔（和鼠标）的地盘。
      //  ⚠️ 原来靠"两秒内见过笔就丢 touch"，**漏**：手掌蹭出的 13px 短痕
      //     既有长度（"没动"抓不到）、压力又恒为 0.5（压力判据也抓不到）——
      //     正好卡在两个判据的死角里。现在按类型一刀切，死角没了。
      //  放在 tool 分支**之前**：免得手掌把橡皮也触发了。
      if (e.pointerType === 'touch') return;                   // 手指归手势层（单指平移 / 双指缩放）
      if (_spaceDown || e.button === 1) return;                // 空格/中键 = 平移，别画
      if (e.button !== 0 && e.pointerType === 'pen') return;   // 笔杆上的键不算
      const [x, y] = at(e);
      if (tool === 'erase'){
        erasing = true;                          // 按住就一路擦，不用一下一下点
        try { svg.setPointerCapture(e.pointerId); } catch (_) {}
        eraseStroke(findStroke(x, y));
        e.preventDefault();
        return;
      }
      const wk = WS_TOOLS[tool];
      if (wk){
        if (wk === 'poly'){
          // 多边形：点一下落一个点。
          //   闭合两条路：① 点回**起点那个实心点**（屏幕 14px 内）② 原地双击
          if (!wsDrag){
            wsDrag = { kind: 'poly', pts: [[x, y]], hover: [x, y] };
          } else {
            const p0 = wsDrag.pts[0];
            const near = Math.hypot(x - p0[0], y - p0[1]) * V.k < 14;
            const dbl  = e.detail >= 2;
            if (wsDrag.pts.length >= 3 && (near || dbl)) wsCommit(wsDrag);
            else wsDrag.pts.push([x, y]);
          }
          drawWS();
          e.preventDefault();
          return;
        }
        // 矩形 / 圆 / 套索：按下开始画，松手提交
        try { svg.setPointerCapture(e.pointerId); } catch (_) {}
        wsDrag = { kind: wk, pts: [[x, y], [x, y]] };
        drawWS();
        e.preventDefault();
        return;
      }
      // 拿不到捕获也照画（pointerId 失效时会抛，不该因此断笔）
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      cur = beginStroke(x, y, e);
      refresh();
      e.preventDefault();
    });

    svg.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;     // 触摸一律不管（见 pointerdown）
      const [x, y] = at(e);
      if (tool === 'erase'){
        // 拖着擦：按住划过去的一起删；没按就是**悬停预告**
        if (erasing || e.buttons !== 0) eraseStroke(findStroke(x, y));
        else setHL(findStroke(x, y));
        return;
      }
      const wk2 = WS_TOOLS[tool];
      if (wk2){
        if (!wsDrag) return;
        if (wsDrag.kind === 'poly'){        // 多边形：不落点，但拉一条预览线跟手
          if (wsDrag.pts.length){ wsDrag.hover = [x, y]; drawWS(); }
          return;
        }
        if (wsDrag.kind === 'lasso'){
          const last = wsDrag.pts[wsDrag.pts.length - 1];
          if (Math.hypot(x - last[0], y - last[1]) * V.k < 2) return;   // 采样阈值：太密没意义
          wsDrag.pts.push([x, y]);
        } else if (wsDrag.kind === 'rect' && e.shiftKey){
          const [ax, ay] = wsDrag.pts[0];                 // Shift = 正方形
          const s = Math.max(Math.abs(x - ax), Math.abs(y - ay));
          wsDrag.pts[1] = [ax + (x < ax ? -s : s), ay + (y < ay ? -s : s)];
        } else {
          wsDrag.pts[1] = [x, y];
        }
        drawWS();
        return;
      }
      if (!cur) return;
      if (e.buttons === 0) return;             // 悬停不算画
      extendStroke(cur, x, y, widthOf(e), e.pressure || 0);
      e.preventDefault();
    });

    // 撤销栈：记「画的」和「被丢的」两种动作 ——
    // 这样**被丢掉的那 1.6% 误伤也能捞回来**，自动过滤才敢开。
    const undoStack = [];

    const end = () => {
      if (wsDrag){
        if (wsDrag.kind !== 'poly') wsCommit(wsDrag);   // 拖出来的（矩形/圆/套索）：松手就成立
        return;                                         // 多边形还没点完，等下一次点击
      }
      if (erasing){ erasing = false; return; }   // 橡皮松手，别当成"画完一笔"
      if (!cur) return;
      const s = cur;
      cur = null;
      const rec = buildRec(s);
      strokeLog.push(rec);          // 只留在内存里给 window.__inkLog 查（不再往后端发）
      const why = rejectReason(rec);
      if (why){
        s.g.remove();
        const i = strokes.indexOf(s);
        if (i >= 0) strokes.splice(i, 1);
        undoStack.push({ kind: 'restore', s, from: '误触' });
        raw('ink', 'amb', `丢掉 ${s.type} pmax=${rec.pmax} len=${rec.len} —— ${why}`);
        flow('·', 'amb', `丢掉一笔（${why}）`);
        refresh();
      } else {
        undoStack.push({ kind: 'add', s });
        raw('ink', 'cy', `${s.type} pmax=${rec.pmax} len=${rec.len} t=${rec.ms}ms`);
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', end);
    svg.addEventListener('pointerleave', () => setHL(null));   // 笔离开画布，高亮收掉

    function undo(){
      const a = undoStack.pop();
      if (!a){ flow('·', 'd', '没得撤了'); return; }
      if (a.kind === 'add'){
        a.s.g.remove();
        const i = strokes.indexOf(a.s);
        if (i >= 0) strokes.splice(i, 1);
        flow('·', 'd', '撤销一笔');
      } else {
        svg.appendChild(a.s.g);                 // 把被当成误触丢掉的那一笔记捞回来
        strokes.push(a.s);
        a.s.bbox = a.s.g.getBBox();
        flow('·', 'ok', '捞回一笔（' + (a.from || '') + '）');
      }
      refresh();
    }

    function setTool(t){
      tool = t;
      tPen.classList.toggle('on', t === 'pen');
      tErase.classList.toggle('on', t === 'erase');
      tWs.classList.toggle('on', !!WS_TOOLS[t]);       // 有形状选中 → 「工作区」也亮着
      tWsRect.classList.toggle('on', t === 'ws-rect');
      tWsElp.classList.toggle('on', t === 'ws-elp');
      tWsPoly.classList.toggle('on', t === 'ws-poly');
      tWsLasso.classList.toggle('on', t === 'ws-lasso');
      svg.classList.toggle('erase', t === 'erase');
      if (t !== 'erase') setHL(null);                                  // 换走了就把高亮收掉
      // ⚠️ 切走工具**不收工作区**（2026-10-07 改）——
      //    工作区是个"状态"，不是工具的瞬间效果：他要切回「笔」才能
      //    往里画东西。收掉只有两条路：点它的 ×，或者「清空」。
      //  ⚠️ 换工具 = 丢掉还没点完的那个（半成品不该挂在画布上）。
      //     拖拽中的走不到这儿 —— 手在画布上时点不到工具条。
      if (wsDrag){ wsDrag = null; drawWS(); }
      updDbg();
    }
    tPen.addEventListener('click', () => setTool('pen'));
    tErase.addEventListener('click', () => setTool('erase'));
    tWs.addEventListener('click', () => wsMenu.classList.toggle('on'));   // 展开/收起形状
    tWsRect .addEventListener('click', () => setTool('ws-rect'));
    tWsElp  .addEventListener('click', () => setTool('ws-elp'));
    tWsPoly .addEventListener('click', () => setTool('ws-poly'));
    tWsLasso.addEventListener('click', () => setTool('ws-lasso'));
    document.getElementById('tUndo').addEventListener('click', undo);
    tClear.addEventListener('click', () => {
      svg.innerHTML = ''; strokes.length = 0; undoStack.length = 0;
      wsList.length = 0; wsDrag = null; wsCur = null; wsActive = null;
      wsReset(); applyWsView(); drawWS();                     // 工作区一起清
      refresh();                                   // 草稿纸：不问了，直接没（撤销栈也一起清）
      flow('·', 'd', '画布：清空');
    });

    // Ctrl+Z 也能撤（不然浏览器自己的撤销会来抢）
    window.addEventListener('keydown', ev => {
      // offsetParent === null ⇒ 画布正藏着（display:none），别抢别处的 Ctrl+Z
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && host.offsetParent){
        ev.preventDefault();
        undo();
      }
      // 多边形画到一半 → Esc 丢掉
      if (ev.key === 'Escape' && wsDrag){ wsDrag = null; drawWS(); }
      // ` 开 / 关调试面板（在输入框里打字时不算）
      const tg = (ev.target && ev.target.tagName) || '';
      if (ev.key === '`' && tg !== 'INPUT' && tg !== 'TEXTAREA'){
        wsDbgOn = !wsDbgOn; updDbg();
      }
    });

    fit(); refresh();
  })();

  // ── 画布存盘 / 恢复 ───────────────────────────────────────────
  //  两条路：
  //    · 存 —— 画布一变就把**完整状态**（笔迹坐标 + 图片对象）POST 给后端；
  //            debounce 一下，别每画一笔发一次。
  //    · 恢复 —— 开窗口时 GET 回来重建。**这是"关掉就没了"的解药。**
  //  后端拿到它会顺带做两件事：把图从 %TEMP% 搬进 canvas-files/、把手写认成文字。
  //  ⇒ 所以这一步同时是「画布对 AI 可见」那条路的**上半截**。
  (function(){
    const cvs = document.getElementById('cvs');
    let timer = null;

    function snapshot(){
      // ⚠️ size 报的是**内容坐标系**（plane 的逻辑尺寸），不是视口尺寸 ——
      //    笔迹和对象的坐标都活在那个系里；报视口尺寸的话，
      //    AI 会以为画布只有一屏大，而坐标早就跑到几千去了。
      const p = document.getElementById('plane');
      return {
        size: { w: p.offsetWidth, h: p.offsetHeight },
        strokes: (window.__inkStrokes && window.__inkStrokes()) || [],
        objects: (window.__canvasObjs && window.__canvasObjs()) || [],
        workspaces: (window.__wsDump && window.__wsDump()) || [],
      };
    }

    function pushNow(){
      const body = JSON.stringify(snapshot());
      fetch('/api/canvas', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body })
        .then(r => r.json())
        .then(d => { if (!d.ok) raw('err', 'er', '画布存盘失败：' + (d.err || '')); })
        .catch(() => {});          // 服务没起也不该炸前端
    }

    window.__canvasChanged = () => {
      clearTimeout(timer);
      timer = setTimeout(pushNow, 700);      // debounce：画的过程中不发
    };

    window.__canvasPushNow = pushNow;        // 收尾按钮发消息前可以先刷一次

    // ── 恢复 ──
    async function restore(){
      let st;
      try {
        const r = await fetch('/api/canvas?full=1', { cache: 'no-store' });
        st = await r.json();
      } catch (e) { return; }
      if (!st) return;
      const ink = window.__inkImport;
      // ⚠️ 工作区要在笔迹**之前**恢复 —— 笔迹带着 wsp（属于哪个工作区），
      //    先有工作区才认得出来；顺序反了那些笔一进来就是孤儿。
      if (window.__wsLoad && st.workspaces) window.__wsLoad(st.workspaces);
      // ⚠️ 只在**真有笔迹**时才 import —— __inkImport 末尾会 refresh()，
      //    而 refresh 会触发存盘。空数组进来就把服务端那份**覆盖成空的**
      //    （2026-10-07 真踩到过：dev 那份存档就是这么没的）。
      if (ink && st.strokes && st.strokes.length) ink(st.strokes);
      for (const o of (st.objects || [])) {
        const src = o.url || (o.path ? '/shot/' + o.path.split(/[\\/]/).pop() : null);
        if (src) window.__canvasAdd(src, o);
      }
      if (st.strokes && st.strokes.length){
        flow('·', 'ok', '画布：恢复了 ' + st.strokes.length + ' 笔');
      }
      // 内容都到位了再摆视图 —— 早于这一步会量到空画布，就把原点对到视口中心去了
      if (window.__initView) window.__initView();
    }
    window.__canvasRestore = restore;
    setTimeout(restore, 300);                // 等涂鸦层/对象层都注册好
  })();


})();
