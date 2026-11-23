/* ==========================================================
   估值温度计 · 应用逻辑
   ----------------------------------------------------------
   数据：window.VALUATION_DATA（由 data.js 提供）
   模型：综合分位 = Σ(指标分位 × 权重) / Σ权重
        分位越低越便宜 → 买入倍数越高
   ========================================================== */
(function () {
  'use strict';

  var DATA = window.VALUATION_DATA || { indices: [] };
  var LS_MANUAL = 'divapp.manual.v1';
  var LS_BUDGET = 'divapp.budget.v1';

  /* ---------------- 判定档位 ---------------- */
  // max: 分位上限（含）；mult: 定投倍数；cls: 徽标样式；color: 颜色
  var SIGNALS = [
    { min: 0, max: 20, key: 'cheap', label: '低估 · 加码', mult: 2.0, cls: 'pill--cheap', color: 'var(--cheap)', advice: '历史低位，定投翻倍，可分批建仓' },
    { min: 20, max: 35, key: 'cheap2', label: '偏低 · 多买', mult: 1.5, cls: 'pill--cheap2', color: 'var(--cheap-2)', advice: '低于中枢，1.5 倍定投' },
    { min: 35, max: 55, key: 'fair', label: '合理 · 定投', mult: 1.0, cls: 'pill--fair', color: 'var(--fair)', advice: '中枢附近，按计划正常买入' },
    { min: 55, max: 70, key: 'warm', label: '偏高 · 少买', mult: 0.6, cls: 'pill--warm', color: 'var(--warm)', advice: '已偏离中枢，减少新增买入' },
    { min: 70, max: 85, key: 'rich', label: '高估 · 暂停', mult: 0.2, cls: 'pill--rich', color: 'var(--rich)', advice: '明显偏贵，暂停新增，只留定投零头' },
    { min: 85, max: 100, key: 'vrich', label: '极高 · 止盈', mult: 0, cls: 'pill--very-rich', color: 'var(--very-rich)', advice: '历史高位，停止买入并考虑分批止盈' }
  ];

  // 股息率 → 分位 对照（绝对水平映射，非历史分位；可在 APP 内填真实分位覆盖）
  var DY_ANCHORS = [
    [1.0, 97], [1.5, 90], [2.0, 80], [2.5, 68], [3.0, 55],
    [3.5, 42], [4.0, 28], [4.5, 15], [5.0, 6], [5.5, 3], [6.5, 1]
  ];

  /* ==========================================================
     纯函数（不依赖 DOM，可在 Node 里单测）
     ========================================================== */

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /** 经验刻度通用换算：anchors = [[数值, 分位], ...] 升序，数值越大分位越小 */
  function anchorToPct(anchors, v) {
    if (v == null || isNaN(v) || !anchors || !anchors.length) return null;
    if (v <= anchors[0][0]) return anchors[0][1];
    var last = anchors[anchors.length - 1];
    if (v >= last[0]) return last[1];
    for (var i = 1; i < anchors.length; i++) {
      var a = anchors[i - 1], b = anchors[i];
      if (v <= b[0]) {
        var t = (v - a[0]) / (b[0] - a[0]);
        return a[1] + t * (b[1] - a[1]);
      }
    }
    return null;
  }

  /** 股息率 → 估值分位（越高越便宜 → 分位越低） */
  function dyToPct(dy) { return anchorToPct(DY_ANCHORS, dy); }

  function signalOf(p) {
    for (var i = 0; i < SIGNALS.length; i++) if (p <= SIGNALS[i].max) return SIGNALS[i];
    return SIGNALS[SIGNALS.length - 1];
  }

  /** 由历史序列估当前值的历史分位（0~100） */
  function pctFromSeries(values, cur) {
    if (!values || values.length < 10 || cur == null) return null;
    var n = 0;
    for (var i = 0; i < values.length; i++) if (values[i] < cur) n++;
    return (n / values.length) * 100;
  }

  /** 合并「接口数据 + 手动录入」 */
  function resolve(idx, manualMap) {
    var m = (manualMap && manualMap[idx.id]) || {};
    var pick = function (k) {
      return m[k] != null && m[k] !== '' && !isNaN(m[k]) ? Number(m[k]) : (idx[k] == null ? null : idx[k]);
    };
    var r = {
      pe: pick('pe'), pb: pick('pb'),
      pePct: pick('pePct'), pbPct: pick('pbPct'),
      dy: pick('dy'), dyPct: m.dyPct != null && m.dyPct !== '' ? Number(m.dyPct) : null,
      date: m.date || idx.date || null,
      isManual: !!(manualMap && manualMap[idx.id] && Object.keys(manualMap[idx.id]).length),
      pending: !!idx.pending && !(manualMap && manualMap[idx.id]),
      pePctDerived: false
    };

    // 手动只填了 PE、没填分位 → 先用自带 5 年序列估算；序列为空（如港股通高股息）则用经验刻度
    if (r.pePct == null && r.pe != null) {
      var est = null;
      if (idx.history && idx.history.length > 20) {
        est = pctFromSeries(idx.history.map(function (p) { return p[1]; }), r.pe);
      }
      if (est == null && idx.fallbackPeAnchors) est = anchorToPct(idx.fallbackPeAnchors, r.pe);
      if (est != null) { r.pePct = est; r.pePctDerived = true; }
    }
    return r;
  }

  /** 计算综合分位与档位 */
  function scoreOf(idx, manualMap) {
    var v = resolve(idx, manualMap);
    var w = idx.weights || { pe: 0.6, pb: 0.4 };
    var parts = [];

    if (v.pePct != null) {
      parts.push({ key: 'pe', label: '市盈率 PE', weight: w.pe || 0, pct: clamp(v.pePct, 0, 100), value: v.pe, unit: '', derived: v.pePctDerived });
    }
    if (v.pbPct != null && w.pb) {
      parts.push({ key: 'pb', label: '市净率 PB', weight: w.pb, pct: clamp(v.pbPct, 0, 100), value: v.pb, unit: '', derived: false });
    }
    var dyP = v.dyPct != null ? v.dyPct : (v.dy != null ? dyToPct(v.dy) : null);
    if (dyP != null && w.dy) {
      parts.push({ key: 'dy', label: '股息率', weight: w.dy, pct: clamp(dyP, 0, 100), value: v.dy, unit: '%', derived: v.dyPct == null });
    }

    var sw = parts.reduce(function (s, p) { return s + p.weight; }, 0);
    var p = sw > 0 ? parts.reduce(function (s, x) { return s + x.pct * x.weight; }, 0) / sw : null;
    var full = (w.pe || 0) + (w.pb || 0) + (w.dy || 0);

    return {
      v: v, parts: parts, p: p,
      signal: p == null ? null : signalOf(p),
      ready: p != null,
      coverage: full > 0 ? sw / full : 0
    };
  }

  /* ---------------- 存储 ---------------- */
  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 隐私模式忽略 */ }
  }

  var state = {
    view: 'home',
    budget: Number(loadJSON(LS_BUDGET, 3000)) || 3000,
    manual: loadJSON(LS_MANUAL, {}) || {},
    detailId: null
  };

  /* ==========================================================
     DOM 相关
     ========================================================== */
  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, d) { return v == null || isNaN(v) ? '--' : Number(v).toFixed(d == null ? 2 : d); }
  function money(v) {
    if (v == null) return '--';
    if (v >= 10000) return (v / 10000).toFixed(2).replace(/\.?0+$/, '') + ' 万';
    return Math.round(v).toLocaleString('zh-CN');
  }
  function fmtDate(s) { return s ? String(s).slice(0, 10) : '--'; }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, 1800);
  }

  /* ---------------- 迷你走势图 ---------------- */
  var sparkSeq = 0;
  function sparkline(history, color) {
    if (!history || history.length < 3) return '<span class="hint">暂无走势</span>';
    var vals = history.map(function (p) { return p[1]; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var W = 120, H = 34, pad = 3;
    var span = (max - min) || 1;
    var pts = vals.map(function (v, i) {
      var x = pad + i * (W - pad * 2) / (vals.length - 1);
      var y = H - pad - (v - min) / span * (H - pad * 2);
      return [x, y];
    });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var gid = 'sg' + (++sparkSeq);
    var last = pts[pts.length - 1];
    return '' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity=".28"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path d="' + d + ' L' + (W - pad) + ',' + H + ' L' + pad + ',' + H + ' Z" fill="url(#' + gid + ')"/>' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.2" fill="' + color + '"/>' +
      '</svg>';
  }

  /* ---------------- 温度条 ---------------- */
  function tempBar(p) {
    return '' +
      '<div class="temp">' +
      '<div class="temp__track"><i class="temp__marker" style="left:' + clamp(p, 1, 99).toFixed(1) + '%"></i></div>' +
      '<div class="temp__scale"><span>便宜 0</span><span>50</span><span>贵 100</span></div>' +
      '</div>';
  }

  function metric(k, v, unit, sub) {
    return '<div class="metric"><div class="metric__k">' + k + '</div>' +
      '<div class="metric__v">' + (v == null ? '--' : v) + (unit ? '<span>' + unit + '</span>' : '') + '</div>' +
      (sub ? '<div class="metric__k" style="opacity:.85">' + sub + '</div>' : '') + '</div>';
  }

  /* ---------------- 首页 ---------------- */
  function renderHome() {
    var rows = DATA.indices.map(function (idx) { return { idx: idx, s: scoreOf(idx, state.manual) }; });
    var ready = rows.filter(function (r) { return r.s.ready; });

    /* 本月建议 */
    var advice = $('#homeAdvice');
    if (!ready.length) {
      advice.innerHTML = '<div class="advice"><div class="advice__head"><span class="advice__title">本月建议</span></div>' +
        '<p class="hint">还没有可用数据。请到「数据」页更新或手动录入。</p></div>';
    } else {
      var sorted = ready.slice().sort(function (a, b) { return a.s.p - b.s.p; });
      var html = sorted.map(function (r) {
        var sg = r.s.signal;
        return '<div class="advice__row">' +
          '<span class="pill ' + sg.cls + '">' + sg.label.split(' · ')[0] + '</span>' +
          '<span class="advice__name">' + esc(r.idx.name) + '</span>' +
          '<span class="advice__act">' + sg.advice + '（定投 ×' + sg.mult + '）</span>' +
          '</div>';
      }).join('');
      var pend = rows.filter(function (r) { return !r.s.ready; });
      if (pend.length) {
        html += '<div class="advice__row"><span class="pill pill--pending">待录入</span>' +
          '<span class="advice__name">' + pend.map(function (r) { return esc(r.idx.name); }).join('、') + '</span>' +
          '<span class="advice__act">点卡片填写估值</span></div>';
      }
      advice.innerHTML = '<div class="advice"><div class="advice__head">' +
        '<span class="advice__title">本月建议 · 按便宜程度排序</span>' +
        '<span class="chip chip--ok">' + ready.length + '/' + rows.length + ' 有数据</span></div>' +
        '<div class="advice__list">' + html + '</div></div>';
    }

    /* 卡片 */
    $('#cardGrid').innerHTML = rows.map(function (r) {
      var idx = r.idx, s = r.s, v = s.v, sg = s.signal;
      var tag = idx.family === 'dividend' ? (idx.market === '港股通' ? '港股红利' : 'A股红利') : '美股宽基';
      var head = '' +
        '<div class="card__top">' +
        '<div style="min-width:0">' +
        '<div class="card__name">' + esc(idx.name) + '</div>' +
        '<div class="card__code">' + esc(idx.code) + ' · ' + esc(idx.market) + '</div>' +
        '</div>' +
        '<span class="card__tag">' + tag + '</span>' +
        '</div>';

      var body;
      if (!s.ready) {
        body = '<div class="card__score"><div class="score-num" style="font-size:26px;letter-spacing:-.5px">待录入</div></div>' +
          '<p class="hint">这个指数的估值需要手动填一次（PE 分位、股息率），填完自动参与计算。</p>';
      } else {
        var pctTxt = function (p, d) { return p == null ? '' : '分位 ' + Math.round(p) + '%' + (d ? '*' : ''); };
        var dyPart = s.parts.filter(function (x) { return x.key === 'dy'; })[0];
        body = '' +
          '<div class="card__score">' +
          '<div class="score-num" style="color:' + sg.color + '">' + Math.round(s.p) + '<small>%</small></div>' +
          '<div class="card__score-meta"><span class="pill ' + sg.cls + '">' + sg.label + '</span>' +
          (s.coverage < 0.7 ? '<span class="pill pill--pending">口径不全</span>' : '') + '</div>' +
          '</div>' +
          tempBar(s.p) +
          '<div class="metrics">' +
          metric('PE', num(v.pe, 2), '', pctTxt(v.pePct, v.pePctDerived)) +
          metric('PB', num(v.pb, 2), '', pctTxt(v.pbPct, false)) +
          metric('股息率', num(v.dy, 2), '%', dyPart && dyPart.derived ? '刻度换算*' : (idx.family === 'dividend' ? '越高越便宜' : '参考')) +
          '</div>' +
          '<div class="card__foot">' +
          '<div class="spark" style="color:' + sg.color + '">' + sparkline(idx.history, sg.color) + '</div>' +
          '<span class="mult">定投 ×' + sg.mult + '</span>' +
          '</div>';
      }

      return '<button class="card" data-id="' + esc(idx.id) + '" type="button">' +
        (v && v.isManual ? '<span class="badge-manual">手动</span>' : '') +
        head + body + '</button>';
    }).join('');

    $('#homeCount').textContent = '共 ' + rows.length + ' 个指数 · 点击看详情';
    $('#dataDate').textContent = fmtDate(ready.length ? ready[0].s.v.date : null);

    var updated = DATA.generatedAt ? DATA.generatedAt.replace(/:\d{2}$/, '') : '--';
    $('#homeNote').innerHTML =
      '<b>数据：</b>' + esc(DATA.source || '本地数据') + '，更新于 ' + esc(updated) + '。<br>' +
      '<b>怎么读：</b>百分比是指数当前估值在自身历史中的位置（0%=最便宜，100%=最贵）。' +
      '红利类看 PE / PB / 股息率，美股看 PE / PB。<br>' +
      '<b>* 号：</b>该分位是用经验刻度或 5 年序列估算的，不是官方历史分位（港股通高股息只能这样）。<br>' +
      '<b>提醒：</b>分位只说明“相对自己过去贵不贵”，不预测短期涨跌。本工具仅供研究，不构成投资建议。';

    $$('#cardGrid .card').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(el.getAttribute('data-id')); });
    });
  }

  /* ---------------- 详情面板 ---------------- */
  function ring(p, color) {
    var r = 46, C = 2 * Math.PI * r, dash = (clamp(p, 0, 100) / 100) * C;
    return '<div class="ring">' +
      '<svg viewBox="0 0 108 108" aria-hidden="true">' +
      '<circle cx="54" cy="54" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="9"/>' +
      '<circle cx="54" cy="54" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="9" ' +
      'stroke-linecap="round" stroke-dasharray="' + dash.toFixed(1) + ' ' + C.toFixed(1) + '"/>' +
      '</svg>' +
      '<div class="ring__center"><div class="ring__num" style="color:' + color + '">' + Math.round(p) + '<span style="font-size:13px">%</span></div>' +
      '<div class="ring__cap">综合分位</div></div>' +
      '</div>';
  }

  function bigChart(history, color) {
    if (!history || history.length < 3) return '<p class="hint">暂无历史序列。</p>';
    var W = 320, H = 132, pl = 34, pr = 8, pt = 10, pb = 20;
    var vals = history.map(function (p) { return p[1]; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || 1;
    var med = vals.slice().sort(function (a, b) { return a - b; })[Math.floor(vals.length / 2)];
    var x = function (i) { return pl + i * (W - pl - pr) / (vals.length - 1); };
    var y = function (v) { return pt + (1 - (v - min) / span) * (H - pt - pb); };

    var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
    var lastX = x(vals.length - 1), lastY = y(vals[vals.length - 1]);
    var gid = 'bg' + (++sparkSeq);
    var grid = [0, 0.5, 1].map(function (t) {
      var yy = pt + t * (H - pt - pb);
      return '<line x1="' + pl + '" y1="' + yy.toFixed(1) + '" x2="' + (W - pr) + '" y2="' + yy.toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>';
    }).join('');

    return '<div class="chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="PE 五年走势">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity=".22"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      grid +
      '<line x1="' + pl + '" y1="' + y(med).toFixed(1) + '" x2="' + (W - pr) + '" y2="' + y(med).toFixed(1) + '" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 4" opacity=".7"/>' +
      '<path d="' + d + ' L' + lastX.toFixed(1) + ',' + (H - pb) + ' L' + pl + ',' + (H - pb) + ' Z" fill="url(#' + gid + ')"/>' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="3.4" fill="' + color + '"/>' +
      '<text x="' + (pl - 6) + '" y="' + (pt + 4) + '" text-anchor="end" font-size="9" fill="var(--muted)">' + max.toFixed(1) + '</text>' +
      '<text x="' + (pl - 6) + '" y="' + (H - pb + 3) + '" text-anchor="end" font-size="9" fill="var(--muted)">' + min.toFixed(1) + '</text>' +
      '<text x="' + pl + '" y="' + (H - 6) + '" font-size="9" fill="var(--muted)">5 年前</text>' +
      '<text x="' + (W - pr) + '" y="' + (H - 6) + '" text-anchor="end" font-size="9" fill="var(--muted)">现在</text>' +
      '</svg>' +
      '<div class="chart-legend"><span><i style="background:' + color + '"></i>PE（周）</span>' +
      '<span><i style="background:var(--muted);opacity:.6"></i>中位数 ' + med.toFixed(1) + '</span></div></div>';
  }

  function openDetail(id) {
    var idx = DATA.indices.filter(function (x) { return x.id === id; })[0];
    if (!idx) return;
    var s = scoreOf(idx, state.manual);
    var v = s.v, sg = s.signal;
    state.detailId = id;

    var meta = esc(idx.code) + ' · ' + esc(idx.market) + ' · ' +
      (v.isManual ? '手动录入' : '自动抓取') + ' · 数据日 ' + fmtDate(v.date);

    var scoreBlock;
    if (s.ready) {
      scoreBlock = '<div class="ring-wrap">' + ring(s.p, sg.color) +
        '<div class="ring-side"><span class="pill ' + sg.cls + '">' + sg.label + '</span>' +
        '<span class="hint">建议定投倍数 <b>×' + sg.mult + '</b><br>' + sg.advice + '</span></div></div>';
    } else {
      scoreBlock = '<div class="ring-wrap"><div class="ring"><svg viewBox="0 0 108 108">' +
        '<circle cx="54" cy="54" r="46" fill="none" stroke="var(--line)" stroke-width="9"/></svg>' +
        '<div class="ring__center"><div class="ring__num" style="font-size:16px;color:var(--muted)">待录入</div></div></div>' +
        '<div class="ring-side"><span class="pill pill--pending">缺少估值</span>' +
        '<span class="hint">填下面的表单，或者运行 <code>node tools/fetch-data.mjs</code> 更新。</span></div></div>';
    }

    var kv = s.parts.map(function (p) {
      return '<div class="kv__row">' +
        '<div class="kv__top"><span class="kv__k">' + p.label +
        (p.derived ? '<em>' + (p.key === 'dy' ? '按股息率水平换算'
          : (idx.history && idx.history.length > 20 ? '按近5年估算' : '按经验刻度换算')) + '</em>' : '') +
        '</span>' +
        '<span class="kv__v"><b>' + num(p.value, p.key === 'dy' ? 2 : 2) + p.unit + '</b>' +
        '<s>分位 ' + Math.round(p.pct) + '%</s></span></div>' +
        '<div class="kv__bar"><i style="width:' + p.pct.toFixed(1) + '%;background:' + (p.pct < 35 ? 'var(--cheap)' : p.pct < 55 ? 'var(--fair)' : p.pct < 75 ? 'var(--warm)' : 'var(--rich)') + '"></i></div>' +
        '<div class="hint" style="margin-top:4px">权重 ' + Math.round(p.weight * 100) + '%</div>' +
        '</div>';
    }).join('');

    var reasons = '';
    if (s.ready) {
      var list = [];
      var maxPart = s.parts.slice().sort(function (a, b) { return b.pct * b.weight - a.pct * a.weight; })[0];
      list.push('综合分位 <b>' + s.p.toFixed(1) + '%</b>，落在「' + sg.label.replace(' · ', '，') + '」区间（阈值 ' +
        sg.min + '%~' + sg.max + '%）。');
      if (maxPart) {
        list.push('拉高/拉低分数最多的是 <b>' + maxPart.label + '</b>：当前 ' + num(maxPart.value, 2) + maxPart.unit +
          '，处于历史 <b>' + Math.round(maxPart.pct) + '%</b> 分位。');
      }
      var cheapest = s.parts.slice().sort(function (a, b) { return a.pct - b.pct; })[0];
      if (cheapest && cheapest.key !== (maxPart && maxPart.key)) {
        list.push('相对便宜的是 <b>' + cheapest.label + '</b>（' + Math.round(cheapest.pct) + '% 分位）。');
      }
      list.push('操作：' + sg.advice + '；分位每下降 15 个百分点，可再提高一档定投额。');
      reasons = list.map(function (t) { return '<div><span>·</span><span>' + t + '</span></div>'; }).join('');
    }

    var m = state.manual[idx.id] || {};
    var form = '' +
      '<div class="manual-form">' +
      '<div class="field field--full"><span class="field__label">数据日期</span>' +
      '<input type="date" id="fDate" value="' + esc((m.date || v.date || '').slice(0, 10)) + '"></div>' +
      '<div class="field"><span class="field__label">市盈率 PE</span><input type="number" step="0.01" id="fPe" value="' + (v.pe == null ? '' : v.pe) + '" placeholder="如 9.50"></div>' +
      '<div class="field"><span class="field__label">PB（可留空）</span><input type="number" step="0.01" id="fPb" value="' + (v.pb == null ? '' : v.pb) + '" placeholder="如 0.95"></div>' +
      '<div class="field"><span class="field__label">PE 历史分位 %</span><input type="number" step="1" min="0" max="100" id="fPePct" value="' + (v.pePct == null ? '' : Math.round(v.pePct)) + '" placeholder="0-100"></div>' +
      '<div class="field"><span class="field__label">股息率 %</span><input type="number" step="0.01" id="fDy" value="' + (v.dy == null ? '' : v.dy) + '" placeholder="如 4.35"></div>' +
      '</div>' +
      '<p class="hint" style="margin-top:8px">PE 分位可从「中证指数官网 / 韭圈儿 / 理杏仁」查；' +
      '只填 PE + 股息率也能算（有 5 年序列的按序列估算，港股通高股息没有公开序列，按经验刻度换算，标 *）。' +
      '填了真实 PE 分位后，以你填的为准。</p>' +
      '<div class="btns" style="margin-top:12px">' +
      '<button class="btn btn--primary" id="btnSaveManual">保存并计算</button>' +
      '<button class="btn" id="btnResetManual">恢复自动数据</button>' +
      '</div>';

    $('#sheetPanel').innerHTML = '' +
      '<div class="sheet__grip"></div>' +
      '<div class="sheet__head">' +
      '<div><div class="sheet__title">' + esc(idx.name) + '</div><div class="sheet__sub">' + meta + '</div></div>' +
      '<button class="sheet__close" data-close="1" aria-label="关闭">×</button>' +
      '</div>' +
      scoreBlock +
      (s.ready ? '<div class="kv">' + kv + '</div>' : '') +
      bigChart(idx.history, sg ? sg.color : 'var(--muted)') +
      (reasons ? '<div class="section-title" style="margin:14px 0 8px"><h2 style="font-size:13px">判定依据</h2></div><div class="reasons">' + reasons + '</div>' : '') +
      '<div class="section-title" style="margin:18px 0 8px"><h2 style="font-size:13px">手动修正</h2><span>只存在本机</span></div>' +
      form;

    var sheet = $('#sheet');
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';

    $$('#sheet [data-close]').forEach(function (el) {
      el.addEventListener('click', closeDetail);
    });
    $('#btnSaveManual').addEventListener('click', function () {
      var obj = {};
      var grab = function (id, key) {
        var el = $('#' + id);
        if (!el) return;
        var val = el.value.trim();
        if (val !== '' && !isNaN(Number(val))) obj[key] = Number(val);
      };
      grab('fPe', 'pe'); grab('fPb', 'pb'); grab('fPePct', 'pePct'); grab('fDy', 'dy');
      var d = $('#fDate').value;
      if (d) obj.date = d;
      if (!Object.keys(obj).length) { toast('至少填一项'); return; }
      state.manual[idx.id] = obj;
      saveJSON(LS_MANUAL, state.manual);
      renderAll();
      openDetail(idx.id);
      toast('已保存，已重新计算');
    });
    $('#btnResetManual').addEventListener('click', function () {
      delete state.manual[idx.id];
      saveJSON(LS_MANUAL, state.manual);
      renderAll();
      openDetail(idx.id);
      toast('已恢复自动数据');
    });
  }

  function closeDetail() {
    $('#sheet').hidden = true;
    document.body.style.overflow = '';
    state.detailId = null;
  }

  /* ---------------- 定投计划 ---------------- */
  function renderPlan() {
    var budget = Number(state.budget) || 0;
    $('#budgetInput').value = budget || '';
    $$('#budgetChips button').forEach(function (b) {
      b.classList.toggle('is-on', Number(b.getAttribute('data-amount')) === budget);
    });

    var rows = DATA.indices.map(function (idx) { return { idx: idx, s: scoreOf(idx, state.manual) }; });
    var ready = rows.filter(function (r) { return r.s.ready; });
    var base = ready.length ? budget / ready.length : 0;

    var raw = rows.map(function (r) { return r.s.ready ? base * r.s.signal.mult : 0; });
    var sum = raw.reduce(function (a, b) { return a + b; }, 0);
    var scale = sum > budget && sum > 0 ? budget / sum : 1;
    var amounts = raw.map(function (x) { return Math.round((x * scale) / 10) * 10; });
    var total = amounts.reduce(function (a, b) { return a + b; }, 0);
    var rest = Math.max(0, budget - total);

    $('#allocList').innerHTML = rows.map(function (r, i) {
      var sg = r.s.signal;
      var pill = r.s.ready
        ? '<span class="pill ' + sg.cls + '" style="font-size:11px">' + Math.round(r.s.p) + '%</span>'
        : '<span class="pill pill--pending" style="font-size:11px">待录入</span>';
      var mult = r.s.ready ? '×' + sg.mult : '—';
      return '<div class="alloc__row">' +
        '<div><div class="alloc__name">' + esc(r.idx.name) + ' ' + pill + '</div>' +
        '<div class="alloc__sub">等权基准 ¥' + money(base) + ' ' + mult + '</div></div>' +
        '<div class="alloc__mult">' + mult + '</div>' +
        '<div class="alloc__amt' + (amounts[i] ? '' : ' is-zero') + '">¥' + money(amounts[i]) + '</div>' +
        '</div>';
    }).join('');

    $('#allocTotal').innerHTML = '¥' + money(total) + ' <span style="font-size:12px;color:var(--muted);font-weight:500">/ 现金 ¥' + money(rest) + '</span>';

    if (!budget) {
      $('#allocList').innerHTML = '<p class="hint">先填一个月度金额试试。</p>';
      $('#allocTotal').textContent = '--';
    }
  }

  /* ---------------- 数据页 ---------------- */
  function renderData() {
    $('#dataUpdated').textContent = DATA.generatedAt ? '生成于 ' + DATA.generatedAt : '';
    $('#dataList').innerHTML = DATA.indices.map(function (idx) {
      var s = scoreOf(idx, state.manual);
      var v = s.v;
      var status = v.isManual
        ? '<span class="chip chip--warn">手动</span>'
        : (s.ready ? '<span class="chip chip--ok">自动</span>' : '<span class="chip chip--warn">待补</span>');
      return '<div class="datarow">' +
        '<div class="datarow__l"><div class="datarow__name">' + esc(idx.name) + ' <span style="font-size:11px;color:var(--muted)">' + esc(idx.code) + '</span></div>' +
        '<div class="datarow__meta">' + (s.ready
          ? 'PE ' + num(v.pe, 2) + ' · PB ' + num(v.pb, 2) + ' · 股息率 ' + num(v.dy, 2) + '% · ' + fmtDate(v.date)
          : '暂无数据') + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:8px">' + status +
        '<button class="btn btn--ghost" data-edit="' + esc(idx.id) + '">录入</button></div>' +
        '</div>';
    }).join('');

    $$('#dataList [data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openDetail(b.getAttribute('data-edit')); });
    });

    var manualCount = Object.keys(state.manual).length;
    $('#dataStatusText').textContent = '共 ' + DATA.indices.length + ' 个指数，其中 ' + manualCount +
      ' 个使用手动数据；手动数据只保存在本机浏览器，清缓存会丢，记得截图留档。';
  }

  /* ---------------- 说明页 ---------------- */
  function renderAbout() {
    $('#aboutProse').innerHTML = '' +
      '<h3>这个 APP 在算什么</h3>' +
      '<p>它不预测涨跌，只回答一个问题：<b>这个指数现在的估值，放在它自己的历史里算贵还是便宜？</b>答案是一个 0~100% 的分位，越低越便宜。</p>' +
      '<div class="formula">综合分位 = Σ( 指标分位 × 权重 ) ÷ Σ权重\n\n红利类：PE 45% + PB 20% + 股息率 35%\n美股宽基：PE 60% + PB 40%</div>' +
      '<p>股息率越高越便宜，所以先把它换算成分位（股息率 4% ≈ 28% 分位，5% ≈ 6% 分位）。这是个经验对照表，不是历史分位；如果你有真实分位，直接在手填表单里填 PE 分位/股息率覆盖即可。</p>' +

      '<h3>分位对应的操作</h3>' +
      '<table class="tbl"><thead><tr><th>综合分位</th><th>判断</th><th>定投倍数</th></tr></thead><tbody>' +
      '<tr><td>0% – 20%</td><td>低估 · 加码</td><td>×2.0</td></tr>' +
      '<tr><td>20% – 35%</td><td>偏低 · 多买</td><td>×1.5</td></tr>' +
      '<tr><td>35% – 55%</td><td>合理 · 定投</td><td>×1.0</td></tr>' +
      '<tr><td>55% – 70%</td><td>偏高 · 少买</td><td>×0.6</td></tr>' +
      '<tr><td>70% – 85%</td><td>高估 · 暂停</td><td>×0.2</td></tr>' +
      '<tr><td>85% – 100%</td><td>极高 · 止盈</td><td>×0</td></tr>' +
      '</tbody></table>' +

      '<h3>为什么这样配权重</h3>' +
      '<ul>' +
      '<li>红利指数靠分红，<b>股息率</b>最直接，给 35%；PE/PB 看资产定价水平，合计 65%。</li>' +
      '<li>纳指 100、标普 500 的分红率低（1% 上下），股息率没有区分度，主要看 PE、PB。</li>' +
      '<li>同一分位下，港股通高股息的绝对估值更低，但汇率、流动性、股息税会让折价长期存在，所以<b>不要跨市场比绝对值</b>，只看各自的历史分位。</li>' +
      '</ul>' +

      '<h3>数据从哪来</h3>' +
      '<ul>' +
      '<li>PE / PB / 历史分位 / 5 年 PE 序列：蛋卷基金指数估值公开接口，脚本自动抓取。</li>' +
      '<li>港股通高股息（930915，人民币计价）：暂无免费公开接口，在 APP 里手动录入 PE 分位和股息率。</li>' +
      '<li>每只指数的数据日期显示在卡片与详情里，过期了就去「数据」页更新。</li>' +
      '</ul>' +

      '<h3>它做不到什么</h3>' +
      '<ul>' +
      '<li>分位是<b>相对自身历史</b>，全市场估值整体抬升时，所有指数分位都会变高，不代表马上要跌。</li>' +
      '<li>不处理盈利周期：周期股盈利塌陷时 PE 会显得很贵、PB 很便宜，两者会打架。</li>' +
      '<li>没有考虑汇率、股息税、ETF 溢价、你的持仓成本。</li>' +
      '<li>历史分位窗口由数据源决定（约 10 年），不是严格 10 年。</li>' +
      '</ul>' +

      '<h3>免责声明</h3>' +
      '<p>本工具仅用于个人研究记录，<b>不构成任何投资建议</b>。数据可能延迟或有误，请以中证指数公司、交易所及基金公司公告为准。据此操作，风险自负。</p>';
  }

  /* ---------------- 总渲染 & 交互 ---------------- */
  function renderAll() {
    renderHome();
    renderPlan();
    renderData();
  }

  function switchView(name) {
    if (!['home', 'plan', 'data', 'about'].includes(name)) name = 'home';
    state.view = name;
    $$('.view').forEach(function (v) { v.classList.toggle('is-active', v.id === 'view-' + name); });
    $$('.tab').forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-view') === name); });
    if (location.hash !== '#' + name) {
      try { history.replaceState(null, '', '#' + name); } catch (e) { /* file:// 下部分浏览器限制，忽略 */ }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function init() {
    renderAll();
    renderAbout();

    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchView(t.getAttribute('data-view')); });
    });

    $('#btnRefresh').addEventListener('click', function () {
      renderAll();
      toast('已按当前数据重新计算');
    });

    var input = $('#budgetInput');
    input.addEventListener('input', function () {
      state.budget = Math.max(0, Number(input.value) || 0);
      saveJSON(LS_BUDGET, state.budget);
      renderPlan();
    });

    $$('#budgetChips button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.budget = Number(b.getAttribute('data-amount'));
        saveJSON(LS_BUDGET, state.budget);
        renderPlan();
      });
    });

    $('#btnExport').addEventListener('click', function () {
      var payload = {
        exportedAt: new Date().toISOString(),
        data: DATA,
        manual: state.manual,
        computed: DATA.indices.map(function (idx) {
          var s = scoreOf(idx, state.manual);
          return { id: idx.id, name: idx.name, p: s.p == null ? null : Number(s.p.toFixed(1)), signal: s.signal ? s.signal.key : null, mult: s.signal ? s.signal.mult : null };
        })
      };
      var text = JSON.stringify(payload, null, 2);
      try {
        var blob = new Blob([text], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'valuation-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        toast('已导出 JSON');
      } catch (e) {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板'); }, function () { toast('导出失败'); });
        } else { toast('当前环境不支持导出'); }
      }
    });

    $('#btnClearManual').addEventListener('click', function () {
      if (!Object.keys(state.manual).length) { toast('没有手动数据'); return; }
      state.manual = {};
      saveJSON(LS_MANUAL, state.manual);
      renderAll();
      toast('已清除手动数据');
    });

    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

    // 深链：#plan / #data / #about，以及 #detail=ndx 直接打开某只指数
    var hash = (location.hash || '').replace('#', '');
    if (hash.indexOf('detail=') === 0) {
      var id = hash.split('=')[1];
      setTimeout(function () { openDetail(id); }, 30);
    } else if (hash) {
      switchView(hash);
    }
    window.addEventListener('hashchange', function () {
      var h = (location.hash || '').replace('#', '');
      if (h && h.indexOf('detail=') !== 0) switchView(h);
    });

    // 离线缓存（用 file:// 打开时会注册失败，忽略即可）
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  // 供 Node 单测使用
  window.__APP_CALC = { dyToPct: dyToPct, signalOf: signalOf, scoreOf: scoreOf, resolve: resolve, pctFromSeries: pctFromSeries };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();
