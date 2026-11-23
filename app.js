/* ETF 温度计 —— 盘中行情 + 估值分位 + 买卖建议
   数据：data.js（Actions 每日生成） + 东财实时行情（浏览器直连） */
(function () {
  'use strict';

  var DATA = (typeof window !== 'undefined' && window.ETF_DATA) || {};
  var ETFS = Array.isArray(DATA.etfs) ? DATA.etfs : [];
  
  var LEVELS = [
    { cls: 'lv-cheap', label: '便宜', action: '可加仓', mult: 1.5, desc: '估值处于近 5 年低位，值得多买' },
    { cls: 'lv-low',   label: '偏低', action: '正常买', mult: 1.2, desc: '估值低于历史中位，可以正常买' },
    { cls: 'lv-fair',  label: '适中', action: '正常买入', mult: 1.0, desc: '估值在中位附近，正常买入' },
    { cls: 'lv-warm',  label: '偏高', action: '少买', mult: 0.6, desc: '估值已高于历史中位，减少买入' },
    { cls: 'lv-rich',  label: '偏贵', action: '暂停买入', mult: 0.2, desc: '估值处于近 5 年高位，暂停买入等回落' }
  ];

  var state = {
    quotes: {},       // code -> { price, changePct, time, digits }
    view: 'home',
    openCode: null,
    lastUpdate: null,
    timer: null
  };

  /* ---------------- 小工具 ---------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, d) {
    if (v == null || !isFinite(v)) return '--';
    return Number(v).toFixed(d == null ? 2 : d);
  }
  function signed(v, d) {
    if (v == null || !isFinite(v)) return '--';
    return (v > 0 ? '+' : '') + Number(v).toFixed(d == null ? 2 : d) + '%';
  }
  function dig(v) {
    var s = String(v), i = s.indexOf('.');
    if (i < 0) return 0;
    return Math.min(3, s.length - i - 1);
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hm(ts) {
    if (!ts) return '--';
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function md(ts) {
    if (!ts) return '--';
    var d = new Date(ts);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function ym(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function money(v) {
    if (v == null || !isFinite(v)) return '--';
    return '¥' + Math.round(v).toLocaleString('zh-CN');
  }

  /* ---------------- 交易时段 ---------------- */

  function sessionState(d) {
    var now = d || new Date();
    var wd = now.getDay();
    if (wd === 0 || wd === 6) return 'closed';
    var m = now.getHours() * 60 + now.getMinutes();
    if (m >= 555 && m < 690) return 'open';   // 9:15 - 11:30
    if (m >= 780 && m < 900) return 'open';   // 13:00 - 15:00
    if (m >= 690 && m < 780) return 'break';  // 午休
    return 'closed';
  }

  function nextOpenDelay(now) {
    var base = now || new Date();
    var best = null;
    for (var i = 0; i < 8; i++) {
      var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      var cands = [
        new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 15, 0),
        new Date(d.getFullYear(), d.getMonth(), d.getDate(), 13, 0, 0)
      ];
      for (var k = 0; k < cands.length; k++) {
        if (cands[k] > base && (!best || cands[k] < best)) best = cands[k];
      }
    }
    if (!best) return 3600e3;
    return Math.min(best - base, 1800e3);
  }

  /* ---------------- 估值模型 ---------------- */

  function levelOf(pct) {
    if (pct == null || !isFinite(pct)) return 2;
    if (pct < 20) return 0;
    if (pct < 40) return 1;
    if (pct < 60) return 2;
    if (pct < 80) return 3;
    return 4;
  }

  // 股息率分位是「越高越便宜」，所以档位要反向映射
  function invertLevel(pct) {
    if (pct == null || !isFinite(pct)) return 2;
    if (pct >= 80) return 0;
    if (pct >= 60) return 1;
    if (pct >= 40) return 2;
    if (pct >= 20) return 3;
    return 4;
  }

  function adjustLevel(lv, premium) {
    if (premium == null || !isFinite(premium)) return lv;
    if (premium > 5) return 4;
    if (premium > 2) return Math.min(4, lv + 1);
    return lv;
  }

  function quoteOf(code) { return state.quotes[code]; }

  function iopvOf(etf, q) {
    if (q && q.iopv) return q.iopv;
    if (etf.iopvMode === 'fair') return etf.fairNav;
    return etf.nav;
  }

  function model(etf) {
    var q = quoteOf(etf.code) || {};
    var price = q.price != null ? q.price : etf.price;
    var chg = q.changePct != null ? q.changePct : etf.changePct;
    var ts = q.time != null ? q.time : (etf.quoteTime ? Date.parse(etf.quoteTime) : null);
    var iopv = iopvOf(etf, q);
    var premium = q.premium != null ? q.premium
      : ((price != null && iopv) ? (price / iopv - 1) * 100 : null);
    // 股息率 = 该 ETF 近 12 个月实际每份分红 ÷ 现价（分红金额由 fetch-data.mjs 烤进 ttmDiv）
    var dy = (etf.ttmDiv != null && price)
      ? (etf.ttmDiv / price) * 100
      : etf.dy;
    var y10 = (DATA.treasury && DATA.treasury.y10 != null) ? DATA.treasury.y10 : null;
    var y5 = (DATA.treasury && DATA.treasury.y5 != null) ? DATA.treasury.y5 : null;
    // 利差按 10 年期国债算
    var spread = (dy != null && dy > 0 && y10 != null) ? dy - y10 : null;
    var isDiv = etf.family !== 'us';
    var base, level;
    if (isDiv) {
      // 红利类：看「近 1 年股息率分位」（越高越便宜），再用与 10 年国债的利差修正一档
      base = invertLevel(etf.dyPct);
      level = base;
      if (spread != null) {
        if (spread >= 4) level = Math.max(0, level - 1);
        else if (spread < 2) level = Math.min(4, level + 1);
      }
    } else {
      // 美股 QDII：看 PE 分位，再用场内溢价修正
      base = levelOf(etf.pePct);
      level = adjustLevel(base, premium);
    }
    var scorePct = isDiv ? (etf.dyPct == null ? 50 : 100 - etf.dyPct) : etf.pePct;
    return {
      etf: etf, price: price, chg: chg, ts: ts, iopv: iopv, premium: premium,
      base: base, level: level, digits: 3, dy: dy, y5: y5, y10: y10,
      spread: spread, isDiv: isDiv, scorePct: scorePct
    };
  }

  function pctText(v) {
    return v == null ? '—' : num(v, 1) + '%';
  }

  function dyText(v) {
    return (v == null || v === 0) ? '—' : num(v, 2) + '%';
  }

  // 股息利差 = 股息率 − 10 年期国债收益率，单位是百分点。
  // 现在直接排在卡片第一行指标里（跟股息率分位同一行），不再单独占一行。
  function spreadStat(m) {
    if (m.spread == null) {
      return '<div class="etf__stat"><i>股息利差</i><b class="is-na">—</b></div>';
    }
    var tone = m.spread > 0 ? 'is-down' : 'is-up'; // 利差大=划算=绿，利差薄=红
    return '<div class="etf__stat"><i>股息利差</i>' +
      '<b class="' + tone + '">' + signed(m.spread, 2) + '</b></div>';
  }

  // 溢价配色：正溢价标红（多付钱）、负溢价标绿（折价），±0.1% 以内算中性。
  // 卡片、数据页、详情面板共用这一套，避免三处颜色不一样。
  function premTone(p) {
    if (p == null) return 'is-na';
    if (p > 0.1) return 'is-up';
    if (p < -0.1) return 'is-down';
    return 'is-flat';
  }

  function adviceOf(m) {
    var L = LEVELS[m.level];
    if (m.isDiv) {
      if (m.spread != null && m.level !== m.base) {
        return m.level < m.base
          ? '股息利差 ' + signed(m.spread, 1) + '，仍算划算，可多买一点'
          : '股息利差只剩 ' + signed(m.spread, 1) + '，比国债多不了多少，先收手';
      }
      return L.desc;
    }
    if (m.premium != null && m.premium > 2 && m.level !== m.base) {
      return '场内溢价 ' + num(m.premium, 1) + '%，等溢价收敛再买';
    }
    return L.desc;
  }

  /* ---------------- 图形 ---------------- */

  function sparkSVG(hist, color) {
    var pts = (hist || []).filter(function (p) { return p && p.length === 2 && isFinite(p[1]); }).slice(-260);
    if (pts.length < 3) return '';
    var W = 300, H = 40;
    var xs = pts.map(function (p) { return p[0]; });
    var ys = pts.map(function (p) { return p[1]; });
    var x0 = xs[0], x1 = xs[xs.length - 1];
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (y1 - y0 < 1e-9) { y1 = y0 + 1; }
    var sx = function (v) { return 2 + ((v - x0) / (x1 - x0 || 1)) * (W - 4); };
    var sy = function (v) { return H - 4 - ((v - y0) / (y1 - y0)) * (H - 8); };
    var d = pts.map(function (p, i) {
      return (i ? 'L' : 'M') + sx(p[0]).toFixed(1) + ',' + sy(p[1]).toFixed(1);
    }).join(' ');
    var area = d + ' L' + sx(x1).toFixed(1) + ',' + H + ' L' + sx(x0).toFixed(1) + ',' + H + ' Z';
    var last = pts[pts.length - 1];
    return '<svg class="etf__spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + area + '" fill="' + color + '" opacity="0.10"></path>' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></path>' +
      '<circle cx="' + sx(last[0]).toFixed(1) + '" cy="' + sy(last[1]).toFixed(1) + '" r="2.4" fill="' + color + '"></circle>' +
      '</svg>';
  }

  function chartSVG(hist, color) {
    var pts = (hist || []).filter(function (p) { return p && p.length === 2 && isFinite(p[1]); }).slice(-260);
    if (pts.length < 3) return '<p class="fine">暂无估值曲线</p>';
    var W = 320, H = 160, PL = 30, PR = 10, PT = 12, PB = 20;
    var xs = pts.map(function (p) { return p[0]; });
    var ys = pts.map(function (p) { return p[1]; });
    var x0 = xs[0], x1 = xs[xs.length - 1];
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var pad = (y1 - y0) * 0.1 || 1;
    var lo = y0 - pad, hi = y1 + pad;
    var sx = function (v) { return PL + ((v - x0) / (x1 - x0 || 1)) * (W - PL - PR); };
    var sy = function (v) { return PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB); };
    var d = pts.map(function (p, i) {
      return (i ? 'L' : 'M') + sx(p[0]).toFixed(1) + ',' + sy(p[1]).toFixed(1);
    }).join(' ');
    var area = d + ' L' + sx(x1).toFixed(1) + ',' + (H - PB) + ' L' + sx(x0).toFixed(1) + ',' + (H - PB) + ' Z';
    var rows = [hi, (lo + hi) / 2, lo].map(function (v) {
      return '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + sy(v).toFixed(1) + '" y2="' + sy(v).toFixed(1) +
        '" stroke="currentColor" stroke-opacity="0.12" stroke-width="1" stroke-dasharray="3 4"></line>' +
        '<text x="' + (PL - 4) + '" y="' + (sy(v) + 3).toFixed(1) + '" text-anchor="end" font-size="8" fill="currentColor" fill-opacity="0.55">' +
        num(v, v >= 100 ? 0 : 1) + '</text>';
    }).join('');
    var last = pts[pts.length - 1];
    var xa = ym(x0), xb = ym(x1);
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="auto" role="img">' + rows +
      '<path d="' + area + '" fill="' + color + '" opacity="0.10"></path>' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"></path>' +
      '<circle cx="' + sx(last[0]).toFixed(1) + '" cy="' + sy(last[1]).toFixed(1) + '" r="3" fill="' + color + '"></circle>' +
      '<text x="' + PL + '" y="' + (H - 6) + '" font-size="8" fill="currentColor" fill-opacity="0.55">' + xa + '</text>' +
      '<text x="' + (W - PR) + '" y="' + (H - 6) + '" text-anchor="end" font-size="8" fill="currentColor" fill-opacity="0.55">' + xb + '</text>' +
      '</svg>';
  }

  var LV_COLOR = { 0: '#12a15a', 1: '#7dbb3f', 2: '#d9a10b', 3: '#ef7d21', 4: '#e5484d' };

  // 温度条：红利类直接画「股息率分位」（0 = 分位最低 = 贵，100 = 分位最高 = 便宜，
  // 所以刻度从右到左反过来、配色也反过来）；美股类画 PE 分位（0 = 便宜，100 = 贵）。
  function tempBar(pct, kind) {
    var p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    var div = kind === 'div';
    return '<div class="temp' + (div ? ' temp--div' : '') + '">' +
      '<div class="temp__track"><span class="temp__marker" style="left:' + p.toFixed(1) + '%"></span></div>' +
      '<div class="temp__scale"><span>' + (div ? '0 贵' : '0 便宜') + '</span><span>50 中位</span><span>' + (div ? '100 便宜' : '100 贵') + '</span></div>' +
      '</div>';
  }

  /* ---------------- 卡片 ---------------- */

  function quoteLabel(ts) {
    var st = sessionState();
    if (st === 'open') return hm(ts);
    if (st === 'break') return '午休';
    return '收盘';
  }

  function cardHTML(m) {
    var e = m.etf, L = LEVELS[m.level];
    var chgCls = m.chg > 0 ? 'is-up' : (m.chg < 0 ? 'is-down' : 'is-flat');
    var prem = m.premium == null ? null : m.premium;
    var premCls = premTone(prem);
    var tag = e.market === 'US' ? 'QDII · 美股' : (e.market === 'HK' ? 'QDII · 港股' : 'A股');
    return '<article class="etf ' + L.cls + '" data-code="' + esc(e.code) + '" role="button" tabindex="0">' +
      '<div class="etf__top">' +
        '<div><h3 class="etf__name">' + esc(e.name) + '</h3>' +
        '<p class="etf__sub">' + esc(e.code) + ' · ' + esc(e.indexName) + ' ' + esc(e.indexCode) + '</p></div>' +
        '<span class="etf__tag">' + tag + '</span>' +
      '</div>' +
      '<div class="etf__priceRow">' +
        '<strong class="etf__price">' + num(m.price, m.digits) + '</strong>' +
        '<span class="etf__chg ' + chgCls + '">' + signed(m.chg) + '</span>' +
        '<span class="etf__time">' + quoteLabel(m.ts) + '</span>' +
      '</div>' +
      '<div class="etf__stats' + (m.isDiv ? '' : ' etf__stats--2') + '">' +
        (m.isDiv
          ? '<div class="etf__stat"><i>股息率</i><b' + (m.dy == null || m.dy === 0 ? ' class="is-na"' : '') + '>' + dyText(m.dy) + '</b></div>' +
            '<div class="etf__stat"><i>股息率分位（1年）</i><b>' + pctText(e.dyPct) + '</b></div>' +
            spreadStat(m)
          : '<div class="etf__stat"><i>PE 分位</i><b>' + pctText(e.pePct) + '</b></div>' +
            '<div class="etf__stat"><i>场内溢价</i><b class="' + premCls + '">' + (prem == null ? '—' : signed(prem, 1)) + '</b></div>') +
      '</div>' +
      tempBar(m.isDiv ? e.dyPct : e.pePct, m.isDiv ? 'div' : '') +
      sparkSVG(e.history, LV_COLOR[m.level]) +
      '<div class="etf__foot">' +
        '<span class="pill ' + L.cls + '">' + L.label + ' · ' + L.action + '</span>' +
        '<span class="etf__adv">' + esc(adviceOf(m)) + '</span>' +
      '</div>' +
      '</article>';
  }

  function quoteStamp() {
    var t = 0;
    for (var k in state.quotes) {
      var v = state.quotes[k] && state.quotes[k].time;
      if (v && v > t) t = v;
    }
    return t || state.lastUpdate;
  }

  function renderHome() {
    var ms = ETFS.map(model);
    var counts = [0, 0, 0, 0, 0];
    ms.forEach(function (m) { counts[m.level]++; });
    var names = { 0: '便宜', 1: '偏低', 2: '适中', 3: '偏高', 4: '偏贵' };
    var parts = [];
    for (var i = 0; i < 5; i++) if (counts[i]) parts.push(counts[i] + ' 只' + names[i]);
    var text = '红利类看「股息率分位 + 股息利差」，美股看「PE 分位 + 溢价」：' +
      (parts.length ? parts.join('、') : '数据加载中') + '。';
    var usDown = ms.filter(function (m) { return !m.isDiv && m.level > m.base && m.premium != null && m.premium > 2; });
    if (usDown.length) {
      text += '其中' +
        usDown.map(function (m) { return m.etf.name + '（溢价 ' + signed(m.premium, 1) + '）'; }).join('、') +
        ' 场内价明显高于净值，已按「偏贵」处理——同样的资产要多付钱，先别追高。';
    }
    var divAdj = ms.filter(function (m) { return m.isDiv && m.level !== m.base && m.spread != null; });
    if (divAdj.length) {
      text += divAdj.map(function (m) {
        return m.etf.name + ' 股息利差 ' + signed(m.spread, 1) + '，' +
          (m.level < m.base ? '把档位抬高了一档。' : '偏薄，把档位下调了一档。');
      }).join('');
    }
    if (!usDown.length && !divAdj.length) {
      var cheap = ms.filter(function (m) { return m.level <= 1; });
      text += cheap.length
        ? cheap.map(function (m) { return m.etf.name; }).join('、') + ' 目前算便宜或偏低，可以多买一点。'
        : '五只都谈不上便宜，按档位看就行。';
    }

    var st = sessionState();
    var dotCls = st === 'open' ? 'is-live' : (st === 'break' ? 'is-break' : '');
    var stText = st === 'open' ? '交易中' : (st === 'break' ? '午间休市' : '已收盘');
    var genTs = DATA.generatedAtISO ? Date.parse(DATA.generatedAtISO) : null;
    $('#homeAdvice').innerHTML =
      '<div class="advice__head"><span class="advice__dot ' + dotCls + '"></span>' +
      stText + ' · ' + (quoteStamp() ? md(quoteStamp()) + ' 收盘价' : '暂无行情') +
      ' · 估值 ' + (genTs ? md(genTs) : '--') + '</div>' +
      '<p class="advice__text">' + esc(text) + '</p>';

    $('#cardGrid').innerHTML = ms.map(cardHTML).join('');
    $('#homeMeta').textContent = ms.length + ' 只 · 点开看明细';
    $('#homeNote').textContent = '红利类：股息率分位越高越便宜，股息利差 = 股息率 − 10 年国债；美股：PE 分位越低越便宜，溢价超过 2% 降档、5% 直接归为偏贵。颜色越红代表越贵。';
    $('#dataDate').textContent = '行情 ' + (quoteStamp() ? md(quoteStamp()) : '--') +
      ' · 估值 ' + (genTs ? md(genTs) : '--');
  }

  /* ---------------- 数据页 ---------------- */

  function renderData() {
    $('#dataList').innerHTML = ETFS.map(function (e) {
      var m = model(e);
      var bits = (m.isDiv ? [
        '净值 <b>' + num(e.nav, 4) + '</b>（' + esc(e.navDate || '--') + '）',
        '股息率 <b>' + dyText(m.dy) + '</b>',
        '股息率分位 <b>' + pctText(e.dyPct) + '</b>',
        '股息利差 <b class="' + (m.spread == null ? 'is-na' : (m.spread > 0 ? 'is-down' : 'is-up')) + '">' + (m.spread == null ? '—' : signed(m.spread, 2)) + '</b>',
        '10 年国债 <b>' + (m.y10 == null ? '—' : num(m.y10, 2) + '%') + '</b>',
        'PE 分位 <b>' + pctText(e.pePct) + '</b>',
        '价格分位 <b>' + pctText(e.pricePct) + '</b>',
        '估值日 ' + esc((e.valDate || '--').slice(5))
      ] : [
        '净值 <b>' + num(e.nav, 4) + '</b>（' + esc(e.navDate || '--') + '）',
        'PE <b>' + num(e.pe, 2) + '</b>',
        'PE 分位 <b>' + pctText(e.pePct) + '</b>',
        'PB 分位 <b>' + pctText(e.pbPct) + '</b>',
        '价格分位 <b>' + pctText(e.pricePct) + '</b>',
        '综合 <b>' + pctText(e.composite) + '</b>',
        '估值日 ' + esc((e.valDate || '--').slice(5))
      ]).map(function (s) { return '<span class="datarow__bit">' + s + '</span>'; });
      return '<div class="datarow">' +
        '<div class="datarow__top"><span class="datarow__name">' + esc(e.name) + ' ' + esc(e.code) + '</span>' +
        '<span class="pill ' + LEVELS[m.level].cls + '">' + LEVELS[m.level].label + '</span></div>' +
        '<div class="datarow__meta">' + bits.join('<span class="datarow__sep"> · </span>') +
        '<span class="datarow__sep"> · </span><span class="datarow__bit">估算净值 ' + num(m.iopv, 4) + '</span>' +
        '<span class="datarow__sep"> · </span>' +
        '<span class="datarow__bit">溢价 <b class="' + premTone(m.premium) + '">' + signed(m.premium, 2) + '</b></span><br>' +
        '<span class="datarow__bit">' + esc(e.valNote || '') + '</span></div>' +
        '</div>';
    }).join('');
    $('#dataUpdated').textContent = DATA.generatedAt || '';
    $('#dataStatusText').textContent =
      '数据源：' + (DATA.source || '--') + '。行情、IOPV 由浏览器直连腾讯财经，估值与净值每日早上由 GitHub Actions 重新生成；' +
      '股息率按这只 ETF 近 12 个月的实际分红 ÷ 现价计算，不分红的显示「—」；综合分位是 PE 分位、PB 分位、价格分位三者的平均，只在详情面板作参考。红利类按「股息率分位 + 股息利差」定档，美股类按「PE 分位 + 溢价」定档。';
  }

  /* ---------------- 说明页 ---------------- */

  function renderAbout() {
    $('#aboutProse').innerHTML =
      '<p><b>价格</b>：ETF 场内成交价，交易日 9:15–11:30、13:00–15:00 每 20 秒刷新一次。</p>' +
      '<p><b>PE 分位 / PB 分位</b>：当前市盈率、市净率在过去 5 年里的位置，0% 最便宜、100% 最贵。分位低只说明「相对自己便宜」，不代表绝对安全。</p>' +
      '<p><b>价格分位</b>：指数最新收盘价在过去 5 年（约 1250 个交易日）里排第几。它只跟价格有关，不看盈利，用来对照 PE 分位。</p>' +
      '<p><b>综合分位</b>：PE 分位、PB 分位、价格分位三者的平均，只在详情面板里作参考，不参与打分。513530 的指数没有免费 PB 数据，只取另外两个。</p>' +
      '<p><b>股息率</b>：这只 ETF 近 12 个月实际每份分红合计 ÷ 现价，不是指数的估算股息率。分红记录来自天天基金「分红送配」，没分过红的显示「—」。</p>' +
      '<p><b>股息利差</b>：股息率 − 10 年期国债收益率，直接看数字，单位是百分点。国债收益率取中债 10 年期到期收益率（东财数据中心）。利差越大，说明「拿这份现金分红」相对无风险利率越划算（卡片上标绿）；负利差意味着分红还不如存国债（标红）。<b>它参与红利类的档位调整</b>：≥4 升一档、&lt;2 降一档。分红的确定性、红利税和 QDII 的汇率都没折算进去，港股那只是税前口径。</p>' +
      '<p><b>场内溢价</b>：场内价 ÷ 估算净值 − 1。参考净值优先取交易所实时 IOPV；QDII 用「净值 × 指数涨跌 × 汇率」折算。溢价高说明你在为同样的资产多付钱。卡片、数据页、详情面板用同一套配色：溢价为正标红（你在多付钱），为负标绿（折价），±0.1% 以内算平。</p>' +
      '<p><b>温度条</b>：红利类卡片画的是股息率分位，左端红=分位最低（最贵）、右端绿=分位最高（最便宜），指针位置就是那个百分数；美股类卡片画的是 PE 分位，左端绿=便宜、右端红=贵。</p>' +
      '<h3>买入建议怎么来的</h3>' +
      '<p><b>三个红利 ETF</b>（中证红利、港股红利、低波红利）只看两个指标：① <b>股息率分位</b>——近 1 年里股息率排第几，越高说明价格越便宜；② <b>股息利差</b>——股息率减去 10 年期国债收益率。档位先由股息率分位定（≥80% 便宜、60–80% 偏低、40–60% 适中、20–40% 偏高、<20% 偏贵），再看利差：利差 ≥ 4 个百分点升一档（更便宜），< 2 个百分点降一档。</p>' +
      '<p><b>两个美股 ETF</b>（纳指、标普）看 PE 分位和场内溢价：PE 分位定基础档（<20% 便宜 … ≥80% 偏贵），溢价超过 2% 降一档、超过 5% 直接归为「偏贵 · 暂停买入」。</p>' +
      '<p>PE 分位、PB 分位、价格分位、综合分位这些仍然在详情面板里作为参考显示，不参与红利类的打分。</p>' +
'<h3>数据与更新</h3>' +
      '<p>估值、净值、股息率每天由 GitHub Actions 跑 <code>node fetch-data.mjs</code> 写进 <code>data.js</code>；行情是浏览器实时拉的。想手动更新，在仓库里跑 <code>node fetch-data.mjs</code> 再提交即可。</p>' +
      '<p><b>装到桌面</b>：iPhone 用 Safari 打开后点「分享」→「添加到主屏幕」；安卓和电脑 Chrome 用地址栏右侧的安装图标。装好后从图标进入，全屏显示，最近一次数据离线也能看。</p>' +
      '<p class="fine">本页仅为个人研究记录，不构成投资建议。数据来自公开接口，可能延迟、缺失或有误；ETF 有跟踪误差、汇率与限购风险，决策请自行核实。</p>';
  }

  /* ---------------- 详情面板 ---------------- */

  function sheetHTML(m) {
    var e = m.etf, L = LEVELS[m.level];
    var chgCls = m.chg > 0 ? 'is-up' : (m.chg < 0 ? 'is-down' : 'is-flat');
    var y10txt = m.y10 == null ? '—' : num(m.y10, 2) + '%' + (DATA.treasury && DATA.treasury.date ? '（' + DATA.treasury.date + '）' : '');
    var kvRows = m.isDiv ? [
      ['股息率分位（1 年）', pctText(e.dyPct) + (e.dyLow == null ? '' : '（1 年 P25–最高 ' + num(e.dyLow, 2) + '%–' + num(e.dyHigh, 2) + '%）')],
      ['股息率', dyText(m.dy)],
      ['股息利差', m.spread == null ? '—' : signed(m.spread, 2), m.spread == null ? 'is-na' : (m.spread > 0 ? 'is-down' : 'is-up')],
      ['10 年国债', y10txt],
      ['场内溢价', signed(m.premium, 2), premTone(m.premium)],
      ['估算净值', num(m.iopv, 4)],
      ['近 12 月分红', e.ttmDiv == null ? '—' : num(e.ttmDiv, 4) + ' 元/份'],
      ['最新净值', num(e.nav, 4) + (e.navDate ? '（' + e.navDate + '）' : '')],
      ['参考：PE 分位', pctText(e.pePct) + (e.pe == null ? '' : '，PE ' + num(e.pe, 2))],
      ['参考：PB 分位', pctText(e.pbPct) + (e.pb == null ? '' : '，PB ' + num(e.pb, 2))],
      ['参考：价格分位', pctText(e.pricePct) + (e.pxLow == null ? '' : '（5 年 ' + num(e.pxLow, 0) + '–' + num(e.pxHigh, 0) + '）')],
      ['估值日', e.valDate || '—']
    ] : [
      ['PE 分位', pctText(e.pePct) + (e.pe == null ? '' : '，PE ' + num(e.pe, 2))],
      ['场内溢价', signed(m.premium, 2), premTone(m.premium)],
      ['PB 分位', pctText(e.pbPct) + (e.pb == null ? '' : '，PB ' + num(e.pb, 2))],
      ['价格分位', pctText(e.pricePct) + (e.pxLow == null ? '' : '（5 年区间 ' + num(e.pxLow, 0) + '–' + num(e.pxHigh, 0) + '）')],
      ['综合分位', pctText(e.composite)],
      ['估算净值', num(m.iopv, 4)],
      ['股息率', dyText(m.dy)],
      ['最新净值', num(e.nav, 4) + (e.navDate ? '（' + e.navDate + '）' : '')],
      ['估值日', e.valDate || '—']
    ];
    var kv = kvRows.map(function (row) {
      return '<div class="kv__row"><span class="kv__k">' + row[0] + '</span><span class="kv__v ' + (row[2] || '') + '">' + esc(row[1]) + '</span></div>';
    }).join('');

    var reasons = m.isDiv ? [
      '股息率分位 ' + pctText(e.dyPct) + '：股息率 ' + dyText(m.dy) + ' 在过去 1 年里排第几（下端切掉 P25 以下的假谷，上端到一年最高值），越高越便宜',
      m.spread == null ? '股息利差缺失' : '股息利差 ' + signed(m.spread, 2) + '（' + num(m.dy, 2) + '% − 10 年国债 ' + num(m.y10, 2) + '%）' +
        (m.spread >= 4 ? '，高利差把档位抬了一档' : (m.spread < 2 ? '，利差偏薄把档位降了一档' : '，利差在中位，不调整档位')),
      '结论：' + L.label + ' · ' + L.action
    ] : [
      'PE 分位 ' + pctText(e.pePct) + (e.pe == null ? '' : '（PE ' + num(e.pe, 2) + '）') + '，决定基础档位',
      m.premium == null ? '溢价数据缺失' : '场内溢价 ' + signed(m.premium, 2) + (m.level > m.base ? '，超过阈值已降档' : '，未触发降档'),
      '结论：' + L.label + ' · ' + L.action
    ];

    return '<div class="sheet__grip"></div>' +
      '<div class="sheet__head">' +
        '<div><h3 class="sheet__title">' + esc(e.name) + '</h3>' +
        '<p class="sheet__sub">' + esc(e.code) + ' · ' + esc(e.fullName || '') + '</p></div>' +
        '<button class="sheet__close" type="button" data-close="1" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="sheet__price"><strong>' + num(m.price, m.digits) + '</strong>' +
      '<span class="sheet__chg ' + chgCls + '">' + signed(m.chg) + '</span>' +
      '<span class="etf__time">' + quoteLabel(m.ts) + '</span></div>' +
      '<div class="sheet__brief"><span class="pill ' + L.cls + '">' + L.label + ' · ' + L.action + '</span> ' + esc(adviceOf(m)) + '</div>' +
      tempBar(m.isDiv ? e.dyPct : e.pePct, m.isDiv ? 'div' : '') +
      '<div class="kv">' + kv + '</div>' +
      '<div class="chart"><div class="chart__cap"><span>' + esc(e.indexName) + ' PE 走势</span><span>来源：' + esc(e.valNote || '--') + '</span></div>' +
        chartSVG(e.history, LV_COLOR[m.level]) + '</div>' +
      '<ul class="reasons">' + reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' +
      '<p class="fine" style="margin-top:14px">溢价按实时 IOPV（交易所参考净值）估算，QDII 会受汇率与时差影响；本页不构成投资建议。</p>';
  }

  function openSheet(code) {
    var etf = null;
    for (var i = 0; i < ETFS.length; i++) if (ETFS[i].code === code) etf = ETFS[i];
    if (!etf) return;
    state.openCode = code;
    $('#sheetPanel').innerHTML = sheetHTML(model(etf));
    $('#sheetPanel').scrollTop = 0;
    $('#sheet').classList.add('is-open');
  }

  function closeSheet() {
    state.openCode = null;
    $('#sheet').classList.remove('is-open');
  }

  function openSheetHTML(html) {
    state.openCode = null;
    $('#sheetPanel').innerHTML = html;
    $('#sheetPanel').scrollTop = 0;
    $('#sheet').classList.add('is-open');
  }

  /* ---------------- 安装到桌面 ---------------- */

  var LS_INSTALL = 'etf_install_hint_v1';

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function showInstall(mode) {
    var el = $('#installBar');
    if (!el || isStandalone() || localStorage.getItem(LS_INSTALL) === '1') return;
    state.installMode = mode;
    $('#installText').textContent = mode === 'ios'
      ? '点底部「分享」→「添加到主屏幕」，之后像 App 一样打开'
      : '加到桌面或应用列表，打开更快、还能离线看最近一次数据';
    $('#installGo').textContent = mode === 'ios' ? '看步骤' : '添加';
    el.hidden = false;
  }

  function closeInstall(remember) {
    var el = $('#installBar');
    if (el) el.hidden = true;
    if (remember) localStorage.setItem(LS_INSTALL, '1');
  }

  function installGuide(mode) {
    var head = mode === 'ios' ? '装到 iPhone 主屏' : '装到桌面';
    var sub = mode === 'ios' ? 'Safari 里三步，之后像 App 一样打开' : 'Chrome / Edge 一键安装，之后从图标打开';
    var body = mode === 'ios'
      ? '<ol class="steps">' +
        '<li>用 <b>Safari</b> 打开本页（微信里打开的要先点右上角「在浏览器中打开」）。</li>' +
        '<li>点底部中间的 <b>分享</b> 按钮（方框向上箭头）。</li>' +
        '<li>往下滑，选 <b>「添加到主屏幕」</b>，再点右上角「添加」。</li>' +
        '</ol>' +
        '<p class="fine">安卓 Chrome 会直接弹出安装提示；没弹的话在右上角菜单里选「安装应用」或「添加到主屏幕」。</p>'
      : '<ol class="steps">' +
        '<li>点地址栏右侧的 <b>安装</b> 图标（显示器加箭头），或打开浏览器菜单。</li>' +
        '<li>选 <b>「安装 ETF 温度计」</b> / 「应用」→「安装此站点」。</li>' +
        '<li>装好后从桌面、开始菜单或应用列表打开，全屏显示。</li>' +
        '</ol>' +
        '<p class="fine">没有安装入口，说明浏览器不支持或已经装过；直接用书签收藏也行。</p>';
    openSheetHTML(
      '<div class="sheet__grip"></div>' +
      '<div class="sheet__head"><div><h3 class="sheet__title">' + head + '</h3>' +
      '<p class="sheet__sub">' + sub + '</p></div>' +
      '<button class="sheet__close" type="button" data-close="1" aria-label="关闭">×</button></div>' +
      body +
      '<p class="fine">装好后从图标进入，页面全屏显示，行情照常实时刷新。</p>'
    );
  }

  function onInstallGo() {
    var d = state.deferred;
    if (state.installMode !== 'ios' && d && d.prompt) {
      state.deferred = null;
      closeInstall(true);
      var p = d.prompt();
      if (p && p.catch) p.catch(function () { installGuide('desktop'); });
      return;
    }
    installGuide(state.installMode === 'ios' ? 'ios' : 'desktop');
  }

  function initInstall() {
    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      state.deferred = ev;
      showInstall('desktop');
    });
    window.addEventListener('appinstalled', function () {
      state.deferred = null;
      closeInstall(true);
      toast('已添加到桌面');
    });

    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && !isStandalone() && localStorage.getItem(LS_INSTALL) !== '1') {
      setTimeout(function () { showInstall('ios'); }, 2500);
    }
  }

  /* ---------------- 实时行情 ---------------- */

  /* 腾讯批量行情：一次请求拿齐 5 只的价格、IOPV、溢价率、净值 */

  var TX_URL = 'https://qt.gtimg.cn/q=';

  function txTime(s) {
    if (!s || s.length < 14) return null;
    return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
      +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)).getTime();
  }

  function fetchLive() {
    var symbols = ETFS.map(function (e) { return 'sh' + e.code; });
    var url = TX_URL + symbols.join(',') + '&_=' + Date.now();
    return fetch(url, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('行情 HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var text = new TextDecoder('gbk').decode(buf);
        var re = /v_((?:sh|sz)\d{6})="([^"]*)"/g;
        var map = {}, m;
        while ((m = re.exec(text))) map[m[1]] = m[2].split('~');
        var got = 0;
        ETFS.forEach(function (e) {
          var a = map['sh' + e.code];
          if (!a || a.length < 84) return;
          var price = +a[3], prev = +a[4], iopv = +a[78], prem = +a[77], nav = +a[81];
          if (!price) return;
          state.quotes[e.code] = {
            price: price,
            changePct: prev ? (price / prev - 1) * 100 : null,
            iopv: iopv > 0 ? iopv : null,
            premium: isFinite(prem) ? prem : null,
            nav: nav > 0 ? nav : null,
            time: txTime(a[30])
          };
          got++;
        });
        state.lastUpdate = Date.now();
        if (!got) throw new Error('行情为空');
        return true;
      });
  }

  function schedule(delay) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(tick, delay);
  }

  function tick() {
    var st = sessionState();
    if (st === 'open') {
      fetchLive().then(function (ok) {
        if (ok) renderActive();
      }).catch(function () {
        /* 静默，保留旧数据 */
      }).then(function () {
        schedule(20000);
      });
    } else if (st === 'break') {
      schedule(60000);
    } else {
      schedule(nextOpenDelay());
    }
  }

  function renderActive() {
    if (state.view === 'home') renderHome();
    else if (state.view === 'data') renderData();
    if (state.openCode) {
      var etf = null;
      for (var i = 0; i < ETFS.length; i++) if (ETFS[i].code === state.openCode) etf = ETFS[i];
      if (etf) $('#sheetPanel').innerHTML = sheetHTML(model(etf));
    }
  }

  /* ---------------- 事件 ---------------- */

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('is-on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, 2000);
  }

  function switchView(name) {
    state.view = name;
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].classList.toggle('is-active', views[i].id === 'view-' + name);
    var tabs = document.querySelectorAll('#tabbar .tab');
    for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle('is-active', tabs[j].getAttribute('data-view') === name);
    if (name === 'home') renderHome();
    else if (name === 'data') renderData();
    else if (name === 'about') renderAbout();
    window.scrollTo(0, 0);
  }

  function bind() {
    $('#tabbar').addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.tab') : null;
      if (btn) switchView(btn.getAttribute('data-view'));
    });

    $('#cardGrid').addEventListener('click', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.etf') : null;
      if (card) openSheet(card.getAttribute('data-code'));
    });

    $('#cardGrid').addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var card = ev.target.closest ? ev.target.closest('.etf') : null;
      if (card) { ev.preventDefault(); openSheet(card.getAttribute('data-code')); }
    });

    $('#sheet').addEventListener('click', function (ev) {
      if (ev.target.getAttribute && ev.target.getAttribute('data-close')) closeSheet();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && $('#sheet').classList.contains('is-open')) closeSheet();
    });

    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('#installGo')) { onInstallGo(); return; }
      if (t.closest('#installClose')) closeInstall(true);
    });

    initInstall();

    $('#btnRefresh').addEventListener('click', function () {
      var btn = this;
      btn.classList.add('is-spin');
      fetchLive().then(function (ok) {
        renderActive();
        toast(ok ? '行情已更新' : '未取到新行情');
      }).catch(function () {
        toast('行情刷新失败，显示上次数据');
      }).then(function () {
        btn.classList.remove('is-spin');
      });
    });

  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    if (!ETFS.length) {
      var g = $('#cardGrid');
      if (g) g.innerHTML = '<div class="etf" style="padding:20px"><b>数据文件版本不对</b><p class="etf__adv" style="margin-top:8px">页面需要新版 data.js（内含 ETF_DATA），请重新上传仓库根目录的 data.js 后刷新。</p></div>';
      return;
    }
    ETFS.forEach(function (e) {
      state.quotes[e.code] = {
        price: e.price, changePct: e.changePct,
        time: e.quoteTime ? Date.parse(e.quoteTime) : null,
        digits: Math.max(2, Math.min(3, dig(e.price) || 3))
      };
    });
    bind();
    switchView('home');
    renderData();
    renderAbout();

    // 首屏先拿一次行情（即使不在交易时段，也能拿到最新指数价算溢价）
    fetchLive().then(function () { renderActive(); }).catch(function () {}).then(function () {
      schedule(sessionState() === 'open' ? 20000 : 5000);
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').then(function (reg) {
          // 发现新版本：让它立刻接管，然后自动刷一次。
          // 用 sessionStorage 记一次，避免极端情况下反复刷新。
          reg.addEventListener('updatefound', function () {
            var nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', function () {
              if (nw.state === 'activated' && !sessionStorage.getItem('sw_reloaded')) {
                sessionStorage.setItem('sw_reloaded', '1');
                location.reload();
              }
            });
          });
          reg.update().catch(function () {});
        }).catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
