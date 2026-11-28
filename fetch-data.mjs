/**
 * 五只 ETF 跟踪数据生成器（精简版）
 *
 * 运行： node fetch-data.mjs
 * 依赖： Node 18+（内置 fetch），无需 npm install
 *
 * 输出： data.js（window.ETF_DATA）
 *
 * 只保留两类指标：
 *  - 红利三只：近 12 个月实际分红算出的股息率 + 近 1 年股息率分位
 *  - 美股两只：场内溢价 + 近 1 年溢价分位
 *
 * 数据来源：
 *  - 行情 / 日线：东方财富 push2
 *  - 净值：天天基金 f10/lsjz
 *  - 分红：天天基金 f10 分红送配页
 *  - 美股指数日线：东方财富 kline（100.NDX100 / 100.SPX），用于折算 QDII 公允净值
 *  - 离岸人民币：东方财富 kline（133.USDCNH）
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
    iopvMode: 'index',
    // 固定分红：近 12 个月每份派现合计（元）。要更新时手动改这个数，脚本不去抓。
    ttmDiv: 0.07,
  },
  {
    code: '513530',
    name: '港股红利',
    fullName: '华泰柏瑞中证港股通高股息投资ETF(QDII)',
    indexCode: '930914',
    indexName: '港股通高股息',
    market: 'HK',
    family: 'dividend',
    secid: '1.513530',
    indexSecid: '2.930914',
    iopvMode: 'index',
    ttmDiv: 0.12,
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
    iopvMode: 'index',
    ttmDiv: 0.048,
  },
  {
    code: '513100',
    name: '纳指100',
    fullName: '国泰纳斯达克100ETF(QDII)',
    indexCode: 'NDX',
    indexName: '纳指100',
    market: 'US',
    family: 'us',
    secid: '1.513100',
    indexSecid: '100.NDX100',
    iopvMode: 'fair',
  },
  {
    code: '513650',
    name: '标普500',
    fullName: '南方标普500ETF(QDII)',
    indexCode: 'SP500',
    indexName: '标普500',
    market: 'US',
    family: 'us',
    secid: '1.513650',
    indexSecid: '100.SPX',
    iopvMode: 'fair',
  },
];

const round = (v, n = 2) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** n) / 10 ** n);
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

function closeOnOrBefore(rows, isoDate) {
  let hit = null;
  for (const r of rows) {
    if (r.date <= isoDate) hit = r;
    else break;
  }
  return hit;
}

/* ---------------- 净值 ---------------- */

/** 最近 n 条净值：[{ date, nav }]，用于算溢价历史。接口每页最多 20 条，要翻页。 */
async function emNavHistory(code, want = 260) {
  const pageSize = 20;
  const pages = Math.min(20, Math.ceil(want / pageSize));
  const all = [];
  for (let p = 1; p <= pages; p += 1) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${p}&pageSize=${pageSize}`;
    const j = await getJSON(url, { Referer: 'https://fundf10.eastmoney.com/' });
    const rows = j?.Data?.LSJZList || [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  const j0 = { Data: { LSJZList: all } };
  const j = j0;
  const list = j?.Data?.LSJZList || [];
  const rows = list
    .map((r) => ({ date: r.FSRQ, nav: Number(r.DWJZ) }))
    .filter((r) => r.nav > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) throw new Error('净值为空');
  const last = list[0];
  return {
    rows,
    nav: Number(last.DWJZ),
    navDate: last.FSRQ,
    navChangePct: Number(last.JZZZL),
  };
}

/* ---------------- 分红 ---------------- */

/** 近 365 天每份现金分红合计（元/份）。数据来自天天基金「分红送配」页。 */
// 备用：抓天天基金分红页。现在分红金额改用 ETFS 里写死的 ttmDiv，此函数不再调用；
// 想改回自动抓取时，把 buildOne 里的固定值换回 emDividend 的结果即可。
async function emDividend(code) {
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
      records.sort((a, b) => a.ts - b.ts);
      return { ttmDiv: round(sum, 4) || 0, divCount: count, records };
    } catch (e) {
      lastErr = e;
      await sleep(600);
    }
  }
  throw lastErr || new Error('分红表获取失败');
}

/* ---------------- 分位工具 ---------------- */

/** 把序列线性映射到 0–100，返回分位与两端刻度 */
function toScale(last, values) {
  const vals = values.slice().sort((a, b) => a - b);
  const lo = vals[0];
  const hi = vals[vals.length - 1];
  const span = hi - lo || 1;
  const pct = Math.max(0, Math.min(100, ((last - lo) / span) * 100));
  return { pct: round(pct, 1), lo: round(lo, 4), hi: round(hi, 4), n: vals.length };
}

/**
 * 股息率分位：分红金额固定（最近 12 个月每份分红合计），逐日只换分母（不复权收盘价）。
 * 股息率高 = 价格便宜，所以分位越高越便宜。
 */
async function dividendStat(secid, ttm) {
  const k = await emKline(secid, 300, 0);
  const rows = k.filter((x) => x.close > 0).slice(-250);
  if (rows.length < 60) throw new Error('价格序列太短');
  if (!(ttm > 0)) throw new Error('分红金额为 0');
  const series = rows.map((row) => (ttm / row.close) * 100).filter((v) => isFinite(v) && v > 0);
  const s = toScale(series[series.length - 1], series);
  return { dyPct: s.pct, dyLow: s.lo, dyHigh: s.hi, dyTtm: round(ttm, 4), dyNow: round(series[series.length - 1], 2) };
}

/**
 * 溢价分位（QDII 用）：逐日还原公允净值 = 当日净值 × 指数涨跌 × 汇率涨跌，
 * 再算 场内价 ÷ 公允净值 − 1，得到近 1 年的溢价序列。溢价越高越贵。
 */
async function premiumStat(cfg, navRows) {
  const [px, idx, fx] = await Promise.all([
    emKline(cfg.secid, 300, 1),
    emKline(cfg.indexSecid, 300, 1),
    emKline('133.USDCNH', 300, 1),
  ]);
  const rows = px.filter((r) => r.close > 0).slice(-250);
  if (rows.length < 60) throw new Error('价格序列太短');
  const series = [];
  for (const r of rows) {
    const nv = closeOnOrBefore(navRows, r.date);
    if (!nv) continue;
    const iAtNav = closeOnOrBefore(idx, nv.date);
    const iNow = closeOnOrBefore(idx, r.date);
    const fAtNav = closeOnOrBefore(fx, nv.date);
    const fNow = closeOnOrBefore(fx, r.date);
    if (!iAtNav || !iNow || !fAtNav || !fNow) continue;
    if (!iAtNav.close || !iNow.close || !fAtNav.close || !fNow.close) continue;
    const fair = nv.nav * (iNow.close / iAtNav.close) * (fNow.close / fAtNav.close);
    if (!(fair > 0)) continue;
    series.push((r.close / fair - 1) * 100);
  }
  if (series.length < 30) throw new Error('溢价序列太短');
  const s = toScale(series[series.length - 1], series);
  return { premPct: s.pct, premLow: s.lo, premHigh: s.hi, premNow: round(series[series.length - 1], 2) };
}

/* ---------------- 主流程 ---------------- */

// 10 年期国债收益率（东方财富数据中心，日频）
async function treasury10y() {
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    '?reportName=RPTA_WEB_TREASURYYIELD&columns=ALL' +
    '&sortColumns=SOLAR_DATE&sortTypes=-1&pageSize=5&pageNumber=1';
  const j = JSON.parse(await getText(url, { Referer: 'https://data.eastmoney.com/' }));
  const rows = (j.result && j.result.data) || [];
  for (const r of rows) {
    const y = Number(r.EMM00166466);
    if (isFinite(y) && y > 0) {
      return { y10: Math.round(y * 10000) / 10000, date: String(r.SOLAR_DATE).slice(0, 10) };
    }
  }
  throw new Error('10 年期国债收益率为空');
}

async function buildOne(cfg, quotes) {
  const isDiv = cfg.family === 'dividend';
  const out = {
    code: cfg.code,
    name: cfg.name,
    fullName: cfg.fullName,
    indexCode: cfg.indexCode,
    indexName: cfg.indexName,
    market: cfg.market,
    family: cfg.family,
    secid: cfg.secid,
    indexSecid: cfg.indexSecid,
    iopvMode: cfg.iopvMode,
    price: null,
    changePct: null,
    quoteTime: null,
    nav: null,
    navDate: null,
    navChangePct: null,
    ttmDiv: null,
    divCount: 0,
    dy: null,
    dyPct: null,
    dyLow: null,
    dyHigh: null,
    premPct: null,
    premLow: null,
    premHigh: null,
  };

  const q = quotes[cfg.code];
  if (q) {
    out.price = q.price;
    out.changePct = q.changePct;
    out.quoteTime = q.quoteTime ? q.quoteTime.toISOString() : null;
  }

  let navRows = [];
  try {
    const nav = await emNavHistory(cfg.code);
    navRows = nav.rows;
    out.nav = nav.nav;
    out.navDate = nav.navDate;
    out.navChangePct = nav.navChangePct;
  } catch (e) {
    out.navError = e.message;
  }

  if (isDiv) {
    // 盘中估算净值要用「净值日当天的指数收盘」做锚点
    if (cfg.iopvMode === 'index' && out.nav && out.navDate) {
      try {
        const k = await emKline(cfg.indexSecid, 40);
        const anchor = closeOnOrBefore(k, out.navDate);
        if (anchor) {
          out.navIdxClose = anchor.close;
          out.navIdxDate = anchor.date;
        }
      } catch (e) {
        out.idxError = e.message;
      }
    }
    try {
      // 分红用配置里的固定值（dividend 页不去抓，避免自动更新把预设值冲掉）
      const ttm = cfg.ttmDiv == null ? null : cfg.ttmDiv;
      out.ttmDiv = ttm;
      if (ttm > 0) {
        const s = await dividendStat(cfg.secid, ttm);
        out.dyPct = s.dyPct;
        out.dyLow = s.dyLow;
        out.dyHigh = s.dyHigh;
      }
      out.dy = out.price && ttm > 0 ? round((ttm / out.price) * 100, 2) : null;
    } catch (e) {
      out.divError = e.message;
    }
  } else {
    try {
      const s = await premiumStat(cfg, navRows);
      out.premPct = s.premPct;
      out.premLow = s.premLow;
      out.premHigh = s.premHigh;
    } catch (e) {
      out.premError = e.message;
    }
  }

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
      const extra = cfg.family === 'dividend'
        ? `股息率 ${one.dy ?? '--'}%  分位 ${one.dyPct ?? '--'}%`
        : `溢价分位 ${one.premPct ?? '--'}%`;
      console.log(`✓ ${one.code} ${one.name}  价 ${one.price ?? '--'} (${one.changePct ?? '--'}%)  ${extra}`);
    } catch (e) {
      console.warn(`✗ ${cfg.code} ${cfg.name} 失败：${e.message}`);
      etfs.push({ ...cfg, error: e.message });
    }
    await sleep(400);
  }

  let treasury = null;
  try {
    treasury = await treasury10y();
    console.log(`✓ 10 年期国债 ${treasury.y10}%（${treasury.date}）`);
  } catch (e) {
    console.warn('✗ 10 年期国债获取失败：', e.message);
  }

  const now = new Date();
  const payload = {
    generatedAt: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    generatedAtISO: now.toISOString(),
    model: 'dividend-and-premium-v2',
    source: '东方财富行情 · 天天基金净值与分红 · 东方财富国债收益率',
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
