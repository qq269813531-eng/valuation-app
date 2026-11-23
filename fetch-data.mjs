/**
 * 五只 ETF 跟踪数据生成器
 *
 * 运行： node fetch-data.mjs
 * 依赖： Node 18+（内置 fetch），无需 npm install
 *
 * 输出： data.js（window.ETF_DATA）
 *
 * 数据来源：
 *  - 实时/收盘行情：东方财富 push2（ETF 价格、涨跌）
 *  - 净值：天天基金 f10/lsjz（最新单位净值，用于估算溢价）
 *  - 指数估值：
 *      · 中证红利 000922 / 红利低波 H30269 / 纳指100 NDX / 标普500 SP500 → 蛋卷基金（PE/PB/股息率/分位）
 *      · 港股通高股息 930914 → 中证指数官网 indexCsiDsPe（逐日 PE，自己算 5 年分位；无 PB、无双股息率）
 *  - 美股指数日线：东方财富 kline（100.NDX / 100.SPX），用于估算 QDII 的公允净值
 *  - 离岸人民币：东方财富 kline（133.USDCNH），用于 QDII 汇率修正
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, 'data.js');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

/** 五只 ETF 配置：数组顺序即卡片顺序 */
const ETFS = [
  {
    code: '515080',
    name: '中证红利',
    fullName: '招商中证红利ETF',
    indexCode: '000922',
    indexName: '中证红利',
    market: 'A',
    family: 'dividend',
    secid: '1.515080',
    indexSecid: '1.000922',
    valSource: 'danjuan',
    valKey: 'SH000922',
    iopvMode: 'index',
  },
  {
    code: '513530',
    name: '港股红利',
    fullName: '华泰柏瑞中证港股通高股息投资ETF(QDII)',
    indexCode: '930914',
    indexName: '港股通高股息',
    market: 'HK',
    family: 'hkDividend',
    secid: '1.513530',
    indexSecid: '2.930914',
    valSource: 'csindex',
    valKey: '930914',
    iopvMode: 'index',
  },
  {
    code: '563020',
    name: '低波红利',
    fullName: '易方达中证红利低波动ETF',
    indexCode: 'H30269',
    indexName: '中证红利低波',
    market: 'A',
    family: 'dividend',
    secid: '1.563020',
    indexSecid: '2.H30269',
    valSource: 'danjuan',
    valKey: 'CSIH30269',
    iopvMode: 'index',
  },
  {
    code: '513100',
    name: '纳指',
    fullName: '国泰纳斯达克100ETF(QDII)',
    indexCode: 'NDX',
    indexName: '纳指100',
    market: 'US',
    family: 'us',
    secid: '1.513100',
    indexSecid: '100.NDX',
    valSource: 'danjuan',
    valKey: 'NDX',
    iopvMode: 'fair',
  },
  {
    code: '513650',
    name: '标普',
    fullName: '南方标普500ETF(QDII)',
    indexCode: 'SP500',
    indexName: '标普500',
    market: 'US',
    family: 'us',
    secid: '1.513650',
    indexSecid: '100.SPX',
    valSource: 'danjuan',
    valKey: 'SP500',
    iopvMode: 'fair',
  },
];

const round = (v, n = 2) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** n) / 10 ** n);
const toPct = (v) => (v == null ? null : round(v * 100, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
const getJSON = async (url, headers) => JSON.parse(await getText(url, headers));

/* ---------------- 行情 ---------------- */

/** 批量行情：返回 { code: { price, changePct, change, quoteTime, name, digits } } */
async function emQuotes(secids) {
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids.join(',')}` +
    `&fields=f1,f2,f3,f4,f12,f14,f124&ut=${EM_UT}`;
  const j = await getJSON(url);
  const out = {};
  for (const d of j?.data?.diff || []) {
    const digits = d.f1 ?? 2;
    out[d.f12] = {
      name: d.f14,
      price: round(d.f2 / 10 ** digits, digits),
      change: round(d.f4 / 10 ** digits, digits),
      changePct: round(d.f3 / 100, 2),
      quoteTime: d.f124 ? new Date(d.f124 * 1000) : null,
    };
  }
  return out;
}

/** 日线（最近 n 根）：[{ date: 'YYYY-MM-DD', close }] */
async function emKline(secid, lmt = 20, fqt = 1) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=${fqt}&lmt=${lmt}` +
    `&end=20500101&fields1=f1,f2,f3&fields2=f51,f53`;
  const j = await getJSON(url);
  return (j?.data?.klines || []).map((line) => {
    const [date, close] = line.split(',');
    return { date, close: Number(close) };
  });
}

/* ---------------- 股息率分位 ---------------- */

/**
 * 近 1 年股息率分位：用 ETF 自己的日收盘价和分红记录，逐日还原「过去 12 个月分红 ÷ 当日价格」，
 * 再看今天的股息率在过去 250 个交易日里排第几。股息率高 = 价格便宜，所以这个分位越高越便宜。
 */
async function dyPercentile(secid, records) {
  // 注意：分红金额是每份名义金额，价格必须用不复权（fqt=0），否则前复权价会把历史股息率抬高
  const k = await emKline(secid, 300, 0);
  const rows = k.filter((x) => x.close > 0).slice(-250);
  if (rows.length < 60) throw new Error('价格序列太短');
  const year = 365 * 86400000;
  const series = rows.map((row) => {
    const ts = Date.parse(row.date);
    let ttm = 0;
    for (const r of records) if (r.ts <= ts && r.ts > ts - year) ttm += r.amount;
    return { date: row.date, dy: ttm > 0 ? (ttm / row.close) * 100 : null };
  }).filter((x) => x.dy != null);
  if (!series.length) throw new Error('无分红，无法算股息率分位');
  const last = series[series.length - 1].dy;
  // 用 P10–P90 当刻度：分红是滚动 12 个月加总，分红笔数变化会造成假峰假谷，
  // 直接拿 min/max 会被这些极端值带偏，所以把两端各切掉 10% 再拉成 0–100。
  const vals = series.map((s) => s.dy).sort((a, b) => a - b);
  const q = (p) => {
    const idx = (vals.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return vals[lo] + (vals[hi] - vals[lo]) * (idx - lo);
  };
  const p10 = q(0.1);
  const p90 = q(0.9);
  const span = p90 - p10 || 1;
  const pct = Math.max(0, Math.min(100, ((last - p10) / span) * 100));
  return {
    dyPct: round(pct, 1),
    dyNow: round(last, 2),
    dyLow: round(p10, 2),
    dyHigh: round(p90, 2),
    dyMin: round(vals[0], 2),
    dyMax: round(vals[vals.length - 1], 2),
  };
}

/* ---------------- 国债收益率 ---------------- */

/**
 * 中国 5 年期国债到期收益率（%），东财数据中心的中美国债收益率表。
 * EMM00166462 = 中国国债收益率5年，EMM00166466 = 10年（见 akshare bond_em 的字段映射）。
 */
async function cn5yYield() {
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD' +
    '&columns=ALL&sortColumns=SOLAR_DATE&sortTypes=-1&pageSize=5&pageNumber=1';
  const j = await getJSON(url, { Referer: 'https://data.eastmoney.com/' });
  const rows = j?.result?.data || [];
  for (const row of rows) {
    const v = Number(row.EMM00166462);
    if (Number.isFinite(v) && v > 0) {
      return { y5: round(v, 4), y10: row.EMM00166466 == null ? null : round(Number(row.EMM00166466), 4), date: String(row.SOLAR_DATE || '').slice(0, 10) };
    }
  }
  throw new Error('无国债收益率数据');
}

/* ---------------- 价格分位 ---------------- */
/* ---------------- 价格分位 ---------------- */

/**
 * 指数近 5 年收盘价分位：最新收盘在近 1250 个交易日里的位置。
 * 红利类指数多年上涨、PE 又长期下移，只看 PE 分位会显得「一直很贵」，
 * 价格分位是一个只跟价格有关的对照。
 */
async function priceStat(indexSecid) {
  const k = await emKline(indexSecid, 1300);
  const closes = k.map((x) => x.close).filter((v) => v > 0);
  if (closes.length < 200) throw new Error('价格序列太短');
  const win = closes.slice(-1250);
  const last = win[win.length - 1];
  let below = 0;
  for (const c of win) if (c <= last) below += 1;
  return {
    pricePct: round((below / win.length) * 100, 1),
    pxLow: round(Math.min(...win), 2),
    pxHigh: round(Math.max(...win), 2),
    pxWindow: win.length,
  };
}

/* ---------------- 净值 ---------------- */

async function emNav(code) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1`;
  const j = await getJSON(url, { Referer: 'https://fundf10.eastmoney.com/' });
  const row = j?.Data?.LSJZList?.[0];
  if (!row) throw new Error('净值为空');
  return {
    nav: Number(row.DWJZ),
    navDate: row.FSRQ,
    navChangePct: Number(row.JZZZL),
    purchase: row.SGZT || '',
  };
}

/* ---------------- 估值 ---------------- */

async function danjuanValuation(srcKey) {
  const hdr = { Referer: 'https://danjuanfunds.com/' };
  const detail = await getJSON(`https://danjuanfunds.com/djapi/index_eva/detail/${srcKey}`, hdr);
  if (!detail?.data) throw new Error(`蛋卷无数据（${srcKey}）`);
  const d = detail.data;
  let history = [];
  try {
    const h = await getJSON(`https://danjuanfunds.com/djapi/index_eva/pe_history/${srcKey}?day=5y`, hdr);
    history = (h?.data?.index_eva_pe_growths || []).map((x) => [x.ts, round(x.pe, 3)]);
  } catch {
    history = [];
  }
  return {
    pe: round(d.pe, 2),
    pb: round(d.pb, 3),
    pePct: toPct(d.pe_percentile),
    pbPct: toPct(d.pb_percentile),
    dy: toPct(d.yeild),
    valDate: d.date ? `${new Date(d.ts).getUTCFullYear()}-${String(d.date).slice(0, 5)}` : null,
    history,
    note: '蛋卷基金指数估值',
  };
}

/** 中证指数官网逐日 PE（920914 这类蛋卷没覆盖的指数用） */
async function csindexValuation(indexCode) {
  const url = `https://www.csindex.com.cn/csindex-home/perf/indexCsiDsPe?indexCode=${indexCode}`;
  const j = await getJSON(url, { Referer: 'https://www.csindex.com.cn/' });
  const rows = (j?.data || []).filter((x) => x.peg != null && Number.isFinite(Number(x.peg)));
  if (!rows.length) throw new Error('中证 PE 为空');
  const history = rows.map((x) => {
    const s = String(x.tradeDate);
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return [Date.parse(`${iso}T00:00:00+08:00`), round(Number(x.peg), 3)];
  });
  const window = history.slice(-1250); // 约 5 年（逐日）
  const last = window[window.length - 1][1];
  const below = window.filter(([, v]) => v < last).length;
  // 曲线按周抽样，和蛋卷的 5 年周线口径一致
  const weekly = [];
  for (let i = 0; i < history.length; i += 5) weekly.push(history[i]);
  if (weekly.length && weekly[weekly.length - 1][0] !== history[history.length - 1][0]) {
    weekly.push(history[history.length - 1]);
  }
  return {
    pe: round(last, 2),
    pb: null,
    pePct: round((below / window.length) * 100, 1),
    pbPct: null,
    dy: null,
    valDate: new Date(history[history.length - 1][0]).toISOString().slice(0, 10),
    history: weekly.slice(-1250),
    note: '中证指数官网（自算 5 年 PE 分位）',
  };
}

/* ---------------- QDII 公允净值 ---------------- */

function closeOnOrBefore(rows, isoDate) {
  let hit = null;
  for (const r of rows) {
    if (r.date <= isoDate) hit = r;
    else break;
  }
  return hit;
}

async function fairNav(etf, nav, navDate) {
  try {
    const [idx, fx] = await Promise.all([emKline(etf.indexSecid, 40), emKline('133.USDCNH', 40)]);
    const atNav = closeOnOrBefore(idx, navDate);
    const last = idx[idx.length - 1];
    const fxAtNav = closeOnOrBefore(fx, navDate);
    const fxLast = fx[fx.length - 1];
    if (!atNav || !last || !fxAtNav || !fxLast || !atNav.close || !fxAtNav.close) throw new Error('缺少指数/汇率数据');
    const ratio = (last.close / atNav.close) * (fxLast.close / fxAtNav.close);
    return {
      fairNav: round(nav * ratio, 3),
      basis: `${etf.indexName} ${atNav.close}→${last.close}（${atNav.date}→${last.date}），USDCNH ${fxAtNav.close}→${fxLast.close}`,
    };
  } catch (e) {
    return { fairNav: null, basis: `公允净值估算失败：${e.message}` };
  }
}

/* ---------------- 分红 ---------------- */

/** 近 365 天每份现金分红合计（元/份）。数据来自天天基金「分红送配」页。 */
async function emDividend(code) {
  // 天天基金偶尔会返回结构异常的页面，单笔每份派现超过 0.2 元基本可判定是误解析，重试一次再放弃
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const html = await getText(`https://fundf10.eastmoney.com/fhsp_${code}.html`, {
        Referer: 'https://fundf10.eastmoney.com/',
      });
      const re =
        /<tr><td[^>]*>\d{4}年<\/td><td[^>]*>([\d-]+)<\/td><td[^>]*>[\d-]*<\/td><td[^>]*>每10份派现金([\d.]+)元<\/td><td[^>]*>[\d-]*<\/td><\/tr>/g;
      const cutoff = Date.now() - 365 * 86400000;
      let sum = 0;
      let count = 0;
      let m;
      let bad = false;
      const records = [];
      while ((m = re.exec(html))) {
        const ts = Date.parse(m[1]);
        if (Number.isNaN(ts)) continue;
        const amount = Number(m[2]) / 10; // 每份派现
        if (!Number.isFinite(amount) || amount > 0.2) {
          bad = true;
          break;
        }
        records.push({ date: m[1], ts, amount });
        if (ts >= cutoff) {
          sum += amount;
          count += 1;
        }
      }
      if (bad) {
        lastErr = new Error('分红表解析异常（单笔金额过大）');
        await sleep(600);
        continue;
      }
      if (count > 0 && sum / count > 0.2) {
        lastErr = new Error('分红表解析异常（均值过大）');
        await sleep(600);
        continue;
      }
      records.sort((a, b) => a.ts - b.ts);
      return { ttmDiv: round(sum, 4) || 0, divCount: count, records };
    } catch (e) {
      lastErr = e;
      await sleep(600);
    }
  }
  throw lastErr || new Error('分红表获取失败');
}

/* ---------------- 主流程 ---------------- */

async function buildOne(cfg, quotes) {
  const out = {
    ...cfg,
    price: null,
    changePct: null,
    quoteTime: null,
    nav: null,
    navDate: null,
    navChangePct: null,
    purchase: '',
    fairNav: null,
    fairBasis: null,
    pe: null,
    pb: null,
    pePct: null,
    pbPct: null,
    pricePct: null,
    pxLow: null,
    pxHigh: null,
    dyPct: null,
    dyLow: null,
    dyHigh: null,
    composite: null,
    dy: null,
    ttmDiv: null,
    divCount: 0,
    valDate: null,
    history: [],
    valNote: '',
  };

  const q = quotes[cfg.code];
  if (q) {
    out.price = q.price;
    out.changePct = q.changePct;
    out.quoteTime = q.quoteTime ? q.quoteTime.toISOString() : null;
  }

  try {
    const nav = await emNav(cfg.code);
    Object.assign(out, nav);
  } catch (e) {
    out.navError = e.message;
  }

  // 盘中估算净值要用「净值日当天的指数收盘」做锚点，否则跨休市日会重复计算涨跌
  if (cfg.iopvMode === 'index' && out.nav && out.navDate) {
    try {
      const k = await emKline(cfg.indexSecid, 40);
      const anchor = closeOnOrBefore(k, out.navDate);
      if (anchor) {
        out.navIdxClose = anchor.close;
        out.navIdxDate = anchor.date;
      }
    } catch (e) {
      out.navError = `指数锚点失败：${e.message}`;
    }
  }

  if (cfg.iopvMode === 'fair' && out.nav && out.navDate) {
    const f = await fairNav(cfg, out.nav, out.navDate);
    out.fairNav = f.fairNav;
    out.fairBasis = f.basis;
  }

  try {
    const v = cfg.valSource === 'csindex' ? await csindexValuation(cfg.valKey) : await danjuanValuation(cfg.valKey);
    Object.assign(out, {
      pe: v.pe,
      pb: v.pb,
      pePct: v.pePct,
      pbPct: v.pbPct,
      dy: v.dy,
      valDate: v.valDate,
      history: v.history.slice(-1250),
      valNote: v.note,
    });
  } catch (e) {
    out.valError = e.message;
  }

  // 股息率用这只 ETF 自己的实际分红（近 12 个月每份分红 ÷ 现价），不用指数的估算值
  try {
    const div = await emDividend(cfg.code);
    out.ttmDiv = div.ttmDiv;
    out.divCount = div.divCount;
    if (div.ttmDiv > 0 && div.records.length) {
      const dstat = await dyPercentile(cfg.secid, div.records);
      out.dyPct = dstat.dyPct;
      out.dyLow = dstat.dyLow;
      out.dyHigh = dstat.dyHigh;
      out.dyHistoryBasis = '近 250 个交易日，按每日收盘价与滚动 12 个月分红还原';
    }
    const px = out.price || null;
    out.dy = px && out.ttmDiv != null ? round((out.ttmDiv / px) * 100, 2) : null;
  } catch (e) {
    out.divError = e.message;
  }

  // 价格分位
  try {
    const ps = await priceStat(cfg.indexSecid);
    out.pricePct = ps.pricePct;
    out.pxLow = ps.pxLow;
    out.pxHigh = ps.pxHigh;
  } catch (e) {
    out.pxError = e.message;
  }

  // 综合分位：PE / PB / 价格三个分位的均值，缺哪个就跳过哪个
  const parts = [out.pePct, out.pbPct, out.pricePct].filter((v) => v != null);
  out.composite = parts.length ? round(parts.reduce((a, b) => a + b, 0) / parts.length, 1) : null;

  return out;
}

async function main() {
  const secids = [...ETFS.map((e) => e.secid), ...ETFS.map((e) => e.indexSecid)];
  let quotes = {};
  try {
    quotes = await emQuotes(secids);
  } catch (e) {
    console.warn('行情获取失败：', e.message);
  }

  const etfs = [];
  for (const cfg of ETFS) {
    try {
      const one = await buildOne(cfg, quotes);
      etfs.push(one);
      console.log(
        `✓ ${one.code} ${one.name}  价 ${one.price ?? '--'} (${one.changePct ?? '--'}%)  ` +
          `净值 ${one.nav ?? '--'}@${one.navDate ?? '--'}  PE ${one.pe ?? '--'} 分位 ${one.pePct ?? '--'}%  ` +
          `DY ${one.dy ?? '--'}%  曲线 ${one.history.length} 点`,
      );
    } catch (e) {
      console.warn(`✗ ${cfg.code} ${cfg.name} 失败：${e.message}`);
      etfs.push({ ...cfg, pe: null, pb: null, pePct: null, dy: null, valDate: null, history: [], error: e.message });
    }
    await sleep(400);
  }

  let treasury = null;
  try {
    treasury = await cn5yYield();
    console.log(`✓ 5 年期国债收益率 ${treasury.y5}%（${treasury.date}）`);
  } catch (e) {
    console.warn(`✗ 国债收益率失败：${e.message}`);
  }

  const now = new Date();
  const payload = {
    generatedAt: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    generatedAtISO: now.toISOString(),
    model: 'pe-percentile-5y-v1',
    source: '东方财富行情 · 蛋卷基金估值 · 中证指数官网 · 中债国债收益率',
    treasury,
    etfs,
  };

  const js =
    '/* 自动生成，勿手改；重新生成：node fetch-data.mjs */\n' +
    `window.ETF_DATA = ${JSON.stringify(payload, null, 2)};\n`;
  writeFileSync(OUT, js, 'utf8');
  console.log(`\n已写入 ${OUT}（${(Buffer.byteLength(js) / 1024).toFixed(1)} KB）`);
}

main().catch((e) => {
  console.error('生成失败：', e);
  process.exit(1);
});
