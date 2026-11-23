/**
 * 拉取指数估值数据，生成 ../data.js
 *
 * 运行： node tools/fetch-data.mjs
 * 依赖： Node 18+（内置 fetch），无需 npm install
 *
 * 数据源：蛋卷基金「指数估值」公开接口（danjuanfunds.com）
 *  - pe / pb / 股息率(yeild)：接口直接给
 *  - pe_percentile / pb_percentile：接口给的历史分位（0~1），×100 后使用
 *  - 5 年 PE 序列：pe_history?day=5y，用于画走势图
 *
 * 港股通高股息(CNY, 930915)：蛋卷未收录，保持 manual=true，由 APP 内手动录入。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'data.js');

const API = 'https://danjuanfunds.com/djapi';
const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  Referer: 'https://danjuanfunds.com/',
};

/** 指数配置：顺序即 APP 展示顺序 */
const INDEXES = [
  {
    id: 'csi-dividend',
    name: '中证红利',
    code: '000922',
    src: 'SH000922',
    market: 'A股',
    family: 'dividend',
    weights: { pe: 0.45, pb: 0.2, dy: 0.35 },
  },
  {
    id: 'csi-dividend-lv',
    name: '中证红利低波',
    code: 'H30269',
    src: 'CSIH30269',
    market: 'A股',
    family: 'dividend',
    weights: { pe: 0.45, pb: 0.2, dy: 0.35 },
  },
  {
    id: 'hk-hdy',
    name: '港股通高股息(CNY)',
    code: '930915',
    src: null, // 无公开接口，APP 内手动录入
    market: '港股通',
    family: 'dividend',
    weights: { pe: 0.45, pb: 0.2, dy: 0.35 },
    // 没有历史序列时，用「PE → 分位」经验刻度换算（APP 里会标 * 提示非官方分位）
    fallbackPeAnchors: [
      [4.5, 98], [5.0, 95], [5.5, 90], [6.0, 84], [6.5, 76], [7.0, 67],
      [7.5, 56], [8.0, 44], [8.5, 33], [9.0, 24], [9.5, 16], [10.0, 10],
      [11.0, 5], [12.0, 2], [14.0, 1],
    ],
  },
  {
    id: 'ndx',
    name: '纳指100',
    code: 'NDX',
    src: 'NDX',
    market: '美股',
    family: 'us',
    weights: { pe: 0.6, pb: 0.4 },
  },
  {
    id: 'spx',
    name: '标普500',
    code: 'SP500',
    src: 'SP500',
    market: '美股',
    family: 'us',
    weights: { pe: 0.6, pb: 0.4 },
  },
];

const round = (v, n = 4) => (v == null ? null : Math.round(v * 10 ** n) / 10 ** n);
const pct = (v) => (v == null ? null : round(v * 100, 2));

async function api(pathname) {
  const res = await fetch(API + pathname, { headers: HDR });
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data) throw new Error(`${pathname} → 无 data（result_code=${json.result_code} ${json.message || ''}）`);
  return json.data;
}

async function fetchOne(cfg) {
  const base = {
    id: cfg.id,
    name: cfg.name,
    code: cfg.code,
    market: cfg.market,
    family: cfg.family,
    weights: cfg.weights,
    manual: false,
    pe: null,
    pb: null,
    pePct: null,
    pbPct: null,
    dy: null,
    dyPct: null, // 接口不提供股息率分位，APP 用绝对水平映射
    date: null,
    history: [],
  };
  if (cfg.fallbackPeAnchors) base.fallbackPeAnchors = cfg.fallbackPeAnchors;

  if (!cfg.src) {
    return { ...base, manual: true, pending: true };
  }

  const d = await api(`/index_eva/detail/${cfg.src}`);
  const history = await api(`/index_eva/pe_history/${cfg.src}?day=5y`)
    .then((h) => (h.index_eva_pe_growths || []).map((x) => [x.ts, round(x.pe, 3)]))
    .catch(() => []);

  return {
    ...base,
    pe: round(d.pe, 2),
    pb: round(d.pb, 3),
    pePct: pct(d.pe_percentile),
    pbPct: pct(d.pb_percentile),
    dy: pct(d.yeild),
    date: d.date ? `${new Date(d.ts).getUTCFullYear()}-${d.date}` : null,
    sourceType: d.eva_type, // low / mid / high，数据源自带分类，仅作对照
    history,
  };
}

const main = async () => {
  const indices = [];
  for (const cfg of INDEXES) {
    try {
      const one = await fetchOne(cfg);
      indices.push(one);
      console.log(
        `✓ ${one.name.padEnd(16, ' ')} ${one.manual ? '手动录入' : `PE ${one.pe} (分位 ${one.pePct}%)  PB ${one.pb}  DY ${one.dy}%  曲线 ${one.history.length} 点`}`,
      );
    } catch (err) {
      console.warn(`✗ ${cfg.name} 抓取失败：${err.message}`);
      indices.push({ ...INDEXES.find((x) => x.id === cfg.id), manual: true, pending: true, pe: null, pb: null, pePct: null, pbPct: null, dy: null, dyPct: null, date: null, history: [] });    }
    await new Promise((r) => setTimeout(r, 300)); // 轻一点，别把人家接口打挂
  }

  const payload = {
    generatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    model: 'composite-percentile-v1',
    source: '蛋卷基金指数估值（danjuanfunds.com）',
    indices,
  };

  const js = `/* 自动生成，勿手改；重新生成请运行 node tools/fetch-data.mjs */\nwindow.VALUATION_DATA = ${JSON.stringify(payload, null, 2)};\n`;
  writeFileSync(OUT, js, 'utf8');
  console.log(`\n已写入 ${OUT}（${(Buffer.byteLength(js) / 1024).toFixed(1)} KB）`);
};

main().catch((e) => {
  console.error('生成失败：', e);
  process.exit(1);
});
