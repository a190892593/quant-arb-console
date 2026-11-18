/* ============================================================
   CONVERGENCE · 模拟行情与账本数据
   所有数字由同一套成本模型与持仓账本推导，避免口径漂移。
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 模拟时钟：固定在 2026-11-18 18:42 (UTC+8)，之后随时间前进 ---------- */
  const SIM_BASE = Date.parse("2026-11-18T10:42:00Z");
  const BOOT = Date.now();
  const now = () => SIM_BASE + (Date.now() - BOOT);

  const COST = {
    hlFeeBps: 4.5,        // Hyperliquid taker
    hedgeSlipBps: 6,      // 对冲腿滑点预算
    resolutionBps: 8,     // 结算/预言机风险缓冲
    fundingBpsDay: 0.45,  // 资金费率折算
    fundingCapBps: 24
  };

  const MIN_EDGE_CENTS = 2.5;

  /* ---------- 市场 ---------- */
  const market = {
    BTC: { px: 104320.5, chg: 0.82 },
    ETH: { px: 4182.6, chg: 1.14 },
    SOL: { px: 214.82, chg: 0.41 },
    HYPE: { px: 41.28, chg: -0.36 }
  };

  const equityNow = 1284930.22;

  /* ---------- 事件合约 ----------
     ask/bid 为 Polymarket 最优卖价/买价（美元），fair 为 HL 波动率曲面反推的公允概率。
     delta 为每 1 美元面值的标的方向敞口，用于计算对冲腿规模。
  */
  const events = [
    { id: "btc-140k-ye", title: "BTC 年末收盘 ≥ $140,000", cat: "BTC 价格", und: "BTC", due: "2026-12-31T15:00:00Z", ask: 0.416, bid: 0.406, fair: 0.468, depth: 128000, conf: 91, delta: 0.084, src: "BRTI · UMA" },
    { id: "btc-85k-nov", title: "BTC 11 月收盘 ≤ $85,000", cat: "BTC 价格", und: "BTC", due: "2026-11-30T15:00:00Z", ask: 0.187, bid: 0.179, fair: 0.243, depth: 41500, conf: 82, delta: -0.061, src: "BRTI · UMA" },
    { id: "btc-120k-nov25", title: "BTC ≥ $120,000（11-25 结算）", cat: "BTC 价格", und: "BTC", due: "2026-11-25T15:00:00Z", ask: 0.684, bid: 0.676, fair: 0.712, depth: 96000, conf: 93, delta: 0.31, src: "BRTI · UMA" },
    { id: "btc-110k-nov", title: "BTC 11 月收盘 ≥ $110,000", cat: "BTC 价格", und: "BTC", due: "2026-11-30T15:00:00Z", ask: 0.742, bid: 0.731, fair: 0.781, depth: 152000, conf: 90, delta: 0.22, src: "BRTI · UMA" },
    { id: "btc-95k-dec", title: "BTC 年末收盘 ≤ $95,000", cat: "BTC 价格", und: "BTC", due: "2026-12-31T15:00:00Z", ask: 0.226, bid: 0.218, fair: 0.268, depth: 58300, conf: 84, delta: -0.052, src: "BRTI · UMA" },
    { id: "btc-150k-mar", title: "BTC ≥ $150,000（2027-03 结算）", cat: "BTC 价格", und: "BTC", due: "2027-03-31T15:00:00Z", ask: 0.196, bid: 0.188, fair: 0.226, depth: 44100, conf: 72, delta: 0.039, src: "BRTI · UMA" },
    { id: "btc-130k-jan", title: "BTC ≥ $130,000（2027-01 结算）", cat: "BTC 价格", und: "BTC", due: "2027-01-31T15:00:00Z", ask: 0.287, bid: 0.279, fair: 0.322, depth: 62400, conf: 81, delta: 0.06, src: "BRTI · UMA" },
    { id: "btc-108k-nov21", title: "BTC ≥ $108,000（11-21 结算）", cat: "BTC 价格", und: "BTC", due: "2026-11-21T15:00:00Z", ask: 0.612, bid: 0.604, fair: 0.638, depth: 210000, conf: 95, delta: 0.33, src: "BRTI · UMA" },
    { id: "btc-100k-dec15", title: "BTC ≤ $100,000（12-15 结算）", cat: "BTC 价格", und: "BTC", due: "2026-12-15T15:00:00Z", ask: 0.318, bid: 0.309, fair: 0.362, depth: 84000, conf: 85, delta: -0.07, src: "BRTI · UMA" },
    { id: "btc-70k-ye", title: "BTC 年末收盘 ≤ $70,000", cat: "BTC 价格", und: "BTC", due: "2026-12-31T15:00:00Z", ask: 0.061, bid: 0.055, fair: 0.084, depth: 19400, conf: 61, delta: -0.015, src: "BRTI · UMA" },
    { id: "btc-105k-nov", title: "BTC ≥ $105,000（11-30 结算）", cat: "BTC 价格", und: "BTC", due: "2026-11-30T15:00:00Z", ask: 0.702, bid: 0.692, fair: 0.748, depth: 138000, conf: 91, delta: 0.24, src: "BRTI · UMA" },

    { id: "eth-6500-ye", title: "ETH 年末收盘 ≥ $6,500", cat: "ETH 价格", und: "ETH", due: "2026-12-31T15:00:00Z", ask: 0.238, bid: 0.230, fair: 0.291, depth: 64000, conf: 86, delta: 0.072, src: "CF Ether-Dollar · UMA" },
    { id: "eth-5000-dec15", title: "ETH ≥ $5,000（12-15 结算）", cat: "ETH 价格", und: "ETH", due: "2026-12-15T15:00:00Z", ask: 0.173, bid: 0.166, fair: 0.219, depth: 33200, conf: 80, delta: 0.055, src: "CF Ether-Dollar · UMA" },
    { id: "eth-3400-ye", title: "ETH 年末收盘 ≤ $3,400", cat: "ETH 价格", und: "ETH", due: "2026-12-31T15:00:00Z", ask: 0.141, bid: 0.133, fair: 0.182, depth: 36700, conf: 79, delta: -0.038, src: "CF Ether-Dollar · UMA" },
    { id: "eth-6000-mar", title: "ETH ≥ $6,000（2027-03 结算）", cat: "ETH 价格", und: "ETH", due: "2027-03-31T15:00:00Z", ask: 0.301, bid: 0.291, fair: 0.336, depth: 39500, conf: 75, delta: 0.052, src: "CF Ether-Dollar · UMA" },
    { id: "eth-4400-nov", title: "ETH 11 月收盘 ≥ $4,400", cat: "ETH 价格", und: "ETH", due: "2026-11-30T15:00:00Z", ask: 0.352, bid: 0.343, fair: 0.391, depth: 71000, conf: 88, delta: 0.09, src: "CF Ether-Dollar · UMA" },
    { id: "eth-7000-mar", title: "ETH ≥ $7,000（2027-03 结算）", cat: "ETH 价格", und: "ETH", due: "2027-03-31T15:00:00Z", ask: 0.112, bid: 0.104, fair: 0.152, depth: 15600, conf: 57, delta: 0.028, src: "CF Ether-Dollar · UMA" },
    { id: "eth-3900-nov", title: "ETH ≤ $3,900（11-30 结算）", cat: "ETH 价格", und: "ETH", due: "2026-11-30T15:00:00Z", ask: 0.262, bid: 0.253, fair: 0.301, depth: 46800, conf: 81, delta: -0.045, src: "CF Ether-Dollar · UMA" },

    { id: "sol-320-jan", title: "SOL ≥ $320（2027-01 结算）", cat: "山寨币", und: "SOL", due: "2027-01-31T15:00:00Z", ask: 0.264, bid: 0.255, fair: 0.305, depth: 22800, conf: 74, delta: 0.048, src: "CF SOL-Dollar · UMA" },
    { id: "sol-260-ye", title: "SOL 年末收盘 ≥ $260", cat: "山寨币", und: "SOL", due: "2026-12-31T15:00:00Z", ask: 0.448, bid: 0.437, fair: 0.489, depth: 27900, conf: 77, delta: 0.041, src: "CF SOL-Dollar · UMA" },
    { id: "sol-400-mar", title: "SOL ≥ $400（2027-03 结算）", cat: "山寨币", und: "SOL", due: "2027-03-31T15:00:00Z", ask: 0.087, bid: 0.079, fair: 0.121, depth: 8200, conf: 54, delta: 0.021, src: "CF SOL-Dollar · UMA" },
    { id: "sol-180-ye", title: "SOL 年末收盘 ≤ $180", cat: "山寨币", und: "SOL", due: "2026-12-31T15:00:00Z", ask: 0.204, bid: 0.196, fair: 0.238, depth: 14300, conf: 66, delta: -0.028, src: "CF SOL-Dollar · UMA" },
    { id: "sol-240-nov", title: "SOL ≥ $240（11-28 结算）", cat: "山寨币", und: "SOL", due: "2026-11-28T15:00:00Z", ask: 0.578, bid: 0.568, fair: 0.612, depth: 31200, conf: 83, delta: 0.12, src: "CF SOL-Dollar · UMA" },
    { id: "sol-300-mar", title: "SOL ≥ $300（2027-03 结算）", cat: "山寨币", und: "SOL", due: "2027-03-31T15:00:00Z", ask: 0.219, bid: 0.210, fair: 0.257, depth: 11900, conf: 61, delta: 0.035, src: "CF SOL-Dollar · UMA" },

    { id: "hype-60-ye", title: "HYPE ≥ $60（年末）", cat: "山寨币", und: "HYPE", due: "2026-12-31T15:00:00Z", ask: 0.121, bid: 0.114, fair: 0.168, depth: 12400, conf: 63, delta: 0.026, src: "HL 标记价 · UMA" },
    { id: "hype-55-jan", title: "HYPE ≥ $55（2027-01 结算）", cat: "山寨币", und: "HYPE", due: "2027-01-31T15:00:00Z", ask: 0.308, bid: 0.296, fair: 0.341, depth: 9800, conf: 58, delta: 0.034, src: "HL 标记价 · UMA" },
    { id: "hype-30-ye", title: "HYPE 年末收盘 ≤ $30", cat: "山寨币", und: "HYPE", due: "2026-12-31T15:00:00Z", ask: 0.162, bid: 0.154, fair: 0.198, depth: 7600, conf: 52, delta: -0.03, src: "HL 标记价 · UMA" },
    { id: "hype-75-mar", title: "HYPE ≥ $75（2027-03 结算）", cat: "山寨币", und: "HYPE", due: "2027-03-31T15:00:00Z", ask: 0.071, bid: 0.064, fair: 0.098, depth: 5400, conf: 48, delta: 0.018, src: "HL 标记价 · UMA" },

    { id: "eth-btc-0032", title: "ETH/BTC ≥ 0.032（年末）", cat: "相对价值", und: "ETH", due: "2026-12-31T15:00:00Z", ask: 0.392, bid: 0.380, fair: 0.431, depth: 18600, conf: 69, delta: 0.031, src: "指数比值 · UMA" },
    { id: "eth-btc-0028", title: "ETH/BTC ≤ 0.028（年末）", cat: "相对价值", und: "ETH", due: "2026-12-31T15:00:00Z", ask: 0.278, bid: 0.269, fair: 0.316, depth: 11700, conf: 64, delta: -0.02, src: "指数比值 · UMA" },
    { id: "sol-eth-007", title: "SOL/ETH ≥ 0.07（年末）", cat: "相对价值", und: "SOL", due: "2026-12-31T15:00:00Z", ask: 0.341, bid: 0.330, fair: 0.382, depth: 9200, conf: 56, delta: 0.022, src: "指数比值 · UMA" }
  ];

  /* ---------- 扫描覆盖面 ----------
     上面 33 个是手工标定的可交易样本；其余按确定性规则补齐到 412 个，
     净边刻意压在阈值之下。这样「已覆盖 412 / 通过 29」是真实统计，而不是写死的文案。
  */
  const CURATED_COUNT = events.length;
  const UNIVERSE_SIZE = 412;

  (function fillUniverse() {
    const rand = mulberry32(90210);
    const between = (a, b) => a + (b - a) * rand();
    const unds = ["BTC", "ETH", "SOL", "HYPE"];
    const catOf = { BTC: "BTC 价格", ETH: "ETH 价格", SOL: "山寨币", HYPE: "山寨币" };
    const srcOf = {
      BTC: "BRTI · UMA", ETH: "CF Ether-Dollar · UMA",
      SOL: "CF SOL-Dollar · UMA", HYPE: "HL 标记价 · UMA"
    };
    const ladders = {
      BTC: [72000, 78000, 86000, 92000, 98000, 102000, 112000, 118000, 126000, 134000, 142000, 148000, 155000, 162000],
      ETH: [2800, 3100, 3400, 3700, 3900, 4200, 4400, 4700, 5000, 5400, 5800, 6200, 6800],
      SOL: [150, 170, 185, 200, 215, 235, 255, 275, 300, 330, 360, 400],
      HYPE: [22, 26, 30, 34, 38, 42, 46, 50, 55, 60, 70, 80]
    };
    const months = ["2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06"];

    for (let i = 0; events.length < UNIVERSE_SIZE; i++) {
      const und = unds[i % unds.length];
      const ladder = ladders[und];
      const level = ladder[Math.floor(rand() * ladder.length)];
      const cmp = rand() < 0.55 ? "≥" : "≤";
      const month = months[Math.floor(rand() * months.length)];
      const day = 2 + Math.floor(rand() * 26);
      const mid = between(0.05, 0.9);
      const half = between(0.002, 0.004);
      const gross = between(0.004, 0.014);   // 毛边始终小于两腿成本的两倍，净边进不了执行队列
      const ask = Math.min(0.96, mid + half);
      const bid = Math.max(0.02, mid - half);
      const fair = Math.min(0.97, mid + gross);

      events.push({
        id: "scn-" + String(i).padStart(3, "0"),
        title: und + " " + cmp + " $" + level.toLocaleString("en-US") + "（" + month.slice(5) + "-" + String(day).padStart(2, "0") + " 结算）",
        cat: catOf[und],
        und: und,
        due: month + "-" + String(day).padStart(2, "0") + "T15:00:00Z",
        ask: +ask.toFixed(4), bid: +bid.toFixed(4), fair: +fair.toFixed(4),
        depth: Math.round(between(3000, 38000)),
        conf: Math.round(between(45, 90)),
        delta: (rand() < 0.5 ? 1 : -1) * between(0.004, 0.03),
        src: srcOf[und]
      });
    }
  })();

  /* ---------- 基准快照 ----------
     实时报价围绕这份快照做均值回归式抖动。没有回归项时，随机游走会把报价推到边界，
     页面开几小时后所有事件都会挤到 95¢ 附近，净边失真。
  */
  const base = {
    market: {
      BTC: { ...market.BTC },
      ETH: { ...market.ETH },
      SOL: { ...market.SOL },
      HYPE: { ...market.HYPE }
    },
    quotes: events.map(e => ({ ask: e.ask, bid: e.bid, fair: e.fair }))
  };

  /* ---------- 持仓账本 ---------- */
  const positions = [
    { evId: "btc-140k-ye", qty: 420000, avg: 0.386, hedgeUsd: 34800, hedgeEntry: 105980 },
    { evId: "eth-6500-ye", qty: 260000, avg: 0.221, hedgeUsd: 18240, hedgeEntry: 4246.2 },
    { evId: "btc-110k-nov", qty: 240000, avg: 0.718, hedgeUsd: 52270, hedgeEntry: 105420 },
    { evId: "sol-320-jan", qty: 120000, avg: 0.249, hedgeUsd: 4720, hedgeEntry: 219.6 },
    { evId: "btc-120k-nov25", qty: 180000, avg: 0.668, hedgeUsd: 45000, hedgeEntry: 104980 },
    { evId: "eth-4400-nov", qty: 150000, avg: 0.334, hedgeUsd: 13100, hedgeEntry: 4211.8 },
    { evId: "hype-60-ye", qty: 62880, avg: 0.109, hedgeUsd: 1275, hedgeEntry: 42.14 },
    { evId: "eth-6000-mar", qty: 100000, avg: 0.289, hedgeUsd: 5150, hedgeEntry: 4198.4 },
    { evId: "btc-95k-dec", qty: 140000, avg: 0.214, hedgeUsd: 7100, hedgeEntry: 104860 }
  ];

  /* ---------- 进行中订单 ---------- */
  const orders = [
    {
      id: "ORD-8841", evId: "btc-140k-ye", status: "hedging", statusText: "对冲中", notional: 35776, qty: 86000,
      opened: "18:41:22", strategy: "概率差 · 自动", slippageBps: 5.8,
      legs: [
        { venue: "POLYMARKET", side: "buy", label: "买入 YES", qty: 86000, filled: 86000, price: 0.416, notional: 35776, done: true },
        { venue: "HYPERLIQUID", side: "short", label: "做空 BTC-PERP", qty: 7224, filled: 4480, price: 104312.0, notional: 4480, done: false, note: "缺口 $2,744 · 已排队补单" }
      ]
    },
    {
      id: "ORD-8840", evId: "eth-6500-ye", status: "filled", statusText: "已成交", notional: 9996, qty: 42000,
      opened: "18:26:09", strategy: "概率差 · 自动", slippageBps: 4.1,
      legs: [
        { venue: "POLYMARKET", side: "buy", label: "买入 YES", qty: 42000, filled: 42000, price: 0.238, notional: 9996, done: true },
        { venue: "HYPERLIQUID", side: "short", label: "做空 ETH-PERP", qty: 3024, filled: 3024, price: 4186.4, notional: 3024, done: true }
      ]
    },
    {
      id: "ORD-8839", evId: "sol-320-jan", status: "leg1", statusText: "等待合约腿", notional: 2555, qty: 9680,
      opened: "18:12:47", strategy: "概率差 · 自动", slippageBps: 0,
      legs: [
        { venue: "POLYMARKET", side: "buy", label: "买入 YES", qty: 9680, filled: 8120, price: 0.264, notional: 2555, done: false, note: "被动成交中 · 剩余 1,560 股" },
        { venue: "HYPERLIQUID", side: "short", label: "做空 SOL-PERP", qty: 465, filled: 0, price: 0, notional: 0, done: false, note: "合约腿完成后启动，避免裸敞口" }
      ]
    },
    {
      id: "ORD-8838", evId: "btc-110k-nov", status: "settling", statusText: "收尾", notional: 63070, qty: 85000,
      opened: "17:54:31", strategy: "结算收敛 · 自动", slippageBps: 7.4,
      legs: [
        { venue: "POLYMARKET", side: "buy", label: "买入 YES", qty: 85000, filled: 85000, price: 0.742, notional: 63070, done: true },
        { venue: "HYPERLIQUID", side: "short", label: "做空 BTC-PERP", qty: 18700, filled: 17952, price: 104180.5, notional: 17952, done: false, note: "距计划 748 股 · 在滑点预算内" }
      ]
    }
  ];

  /* ---------- 待接管 ---------- */
  const reviews = [
    {
      id: "RV-2201", evId: "btc-120k-nov25", kind: "深度不足",
      reason: "Polymarket 卖盘深度不足：计划 96,000 YES，盘口可成交 41,200",
      action: "已暂停对冲腿，保留已成交的 41,200 股裸敞口",
      advice: "缩减至 41,200 股后继续，或放弃本次机会并回滚合约腿",
      seconds: 4 * 3600 + 12 * 60 + 8,
      severity: "warn"
    },
    {
      id: "RV-2200", evId: "hype-60-ye", kind: "资金费率异常",
      reason: "HL HYPE 永续资金费率 0.041%/h，持有 3 天将吞掉 78% 的净边",
      action: "已挂起对冲腿，未建立任何头寸",
      advice: "等待费率回落至 0.012%/h 以下，或改用两次 8 小时滚动对冲",
      seconds: 14 * 3600 + 38 * 60,
      severity: "warn"
    },
    {
      id: "RV-2199", evId: "eth-7000-mar", kind: "模型置信度不足",
      reason: "置信度 57 低于阈值 62，且净边 3.9¢ 伴随盘口单边撤单",
      action: "已冻结自动执行，事件留在观察列表",
      advice: "人工核验 Polymarket 盘口后决定是否以半仓进入",
      seconds: 9 * 3600 + 5 * 60,
      severity: "warn"
    }
  ];

  /* ---------- 审计日志 ---------- */
  const audit = [
    { t: "18:41:22", actor: "自动引擎", action: "开仓", obj: "BTC 年末收盘 ≥ $140,000", venue: "PM + HL", detail: "买入 86,000 YES @ 41.6¢；对冲 BTC-PERP $7,224（已成交 62%）" },
    { t: "18:38:04", actor: "风控", action: "拦截", obj: "BTC ≥ $120,000（11-25 结算）", venue: "PM", detail: "盘口深度 41,200 < 计划 96,000，暂停第二腿并转待接管" },
    { t: "18:31:47", actor: "林 · 自营", action: "人工补单", obj: "ORD-8831 · SOL 年末 ≥ $260", venue: "HL", detail: "手动补对冲 $12,400，缺口从 $15,800 收窄至 $3,400" },
    { t: "18:20:11", actor: "自动引擎", action: "结算退出", obj: "ETH 年末 ≤ $3,400", venue: "PM", detail: "事件以 NO 结算，回收 $36,700，实现盈利 $2,140" },
    { t: "17:58:33", actor: "自动引擎", action: "扫描", obj: "全市场 412 个事件", venue: "PM + HL", detail: "本轮命中 29 个信号，3 个因置信度转为观察，自动执行 11 笔" },
    { t: "17:42:09", actor: "风控", action: "拦截", obj: "SOL ≥ $240（11-28 结算）", venue: "PM", detail: "结算前 48h 冻结加仓规则生效，拒绝新增 31,200 股" },
    { t: "16:55:20", actor: "林 · 自营", action: "调整限额", obj: "单事件集中度", venue: "组合", detail: "18% → 15%，已同步至下单前校验" },
    { t: "16:12:44", actor: "自动引擎", action: "补对冲", obj: "BTC 年末收盘 ≤ $95,000", venue: "HL", detail: "缺口 $1,240 触发补单，成交价 104,205.0，滑点 2.1bps" },
    { t: "15:30:02", actor: "风控", action: "熔断演练", obj: "全组合", venue: "PM + HL", detail: "撤单 + 停止新开仓耗时 240ms，通过；未触发实际平仓" }
  ];

  /* ---------- 风控事件 ---------- */
  const riskEvents = [
    { t: "18:38", level: "warn", title: "深度不足拦截", detail: "BTC ≥ $120,000 · 计划 96,000 / 可成交 41,200", val: "转人工" },
    { t: "17:42", level: "warn", title: "结算前冻结加仓", detail: "SOL ≥ $240（11-28 结算）", val: "已拦截" },
    { t: "16:12", level: "ok", title: "对冲缺口自动补足", detail: "BTC ≤ $95,000 · 缺口 $1,240", val: "2.1bps" },
    { t: "14:07", level: "warn", title: "HL 资金费率告警", detail: "HYPE-PERP 0.041%/h，超过 0.015% 阈值", val: "降档" },
    { t: "10:22", level: "ok", title: "限额复核通过", detail: "单场所、净 Delta、集中度全部在限内", val: "5/5" },
    { t: "09:05", level: "bad", title: "模型置信度告警", detail: "ETH ≥ $7,000 · 置信度 57 < 62", val: "冻结" }
  ];

  /* ---------- 结算日历 ---------- */
  const calendar = [
    { evId: "btc-108k-nov21", exposure: 42840, note: "BRTI 15:00 UTC 定价" },
    { evId: "btc-120k-nov25", exposure: 122220, note: "近月，Delta 抬升中" },
    { evId: "sol-240-nov", exposure: 31200, note: "结算前 48h 已冻结加仓" },
    { evId: "btc-85k-nov", exposure: 41500, note: "尾部保护，UMA 争议窗口 2h" },
    { evId: "eth-4400-nov", exposure: 52350, note: "与 ETH 月线收盘挂钩" },
    { evId: "btc-100k-dec15", exposure: 84000, note: "12-15 16:00 UTC 结算" }
  ];

  /* ---------- 风险限额 ---------- */
  const limitDefaults = [
    { id: "pm", name: "单场所敞口 · Polymarket", desc: "按合约成本口径，含未结算头寸", value: 1200000, used: 0, kind: "usd" },
    { id: "hl", name: "Hyperliquid 保证金占用", desc: "维持保证金 + 缓冲，按 4.8x 折算", value: 120000, used: 0, kind: "usd" },
    { id: "delta", name: "组合净 Delta", desc: "两腿差额的标的等值敞口", value: 250000, used: 0, kind: "usd" },
    { id: "settle", name: "7 日内结算敞口", desc: "临近结算事件的合约成本合计", value: 300000, used: 0, kind: "usd" },
    { id: "conc", name: "单事件集中度", desc: "最大单一事件成本占净值比例", value: 15, used: 0, kind: "pct" }
  ];

  const rules = [
    { id: "daily-loss", name: "日亏损降档", desc: "当日回撤 ≥ 1.5% 时停止开新仓，仅允许平仓与补对冲", on: true },
    { id: "latency", name: "报价延迟熔断", desc: "任一场所心跳 > 800ms 立即暂停开仓，保留已有对冲", on: true },
    { id: "settle-freeze", name: "结算前冻结加仓", desc: "48 小时内结算的事件只减不加，避免结算滑点", on: true },
    { id: "fat-edge", name: "巨边人工复核", desc: "净边 > 800bps 不自动执行，先排除陈旧报价", on: true },
    { id: "gap-fill", name: "对冲缺口自动补足", desc: "缺口 > $2,500 时按对手价补单，最多追 3 次", on: true }
  ];

  /* ---------- 活动流 ---------- */
  const feed = [
    { t: "18:41", kind: "ok", title: "自动开仓 BTC 年末 ≥ $140k", detail: "86,000 YES @ 41.6¢ · 对冲 62%", val: "+$3,752 预期" },
    { t: "18:38", kind: "warn", title: "深度不足，转人工接管", detail: "BTC ≥ $120k · 缺口 54,800 股", val: "RV-2201" },
    { t: "18:31", kind: "ok", title: "人工补对冲 SOL-PERP", detail: "林 · 自营 · 补 $12,400", val: "−$3,400 缺口" },
    { t: "18:20", kind: "ok", title: "事件结算，ETH ≤ $3,400 命中", detail: "回收 $36,700 · 持有 11 天", val: "+$2,140" },
    { t: "17:58", kind: "ok", title: "扫描完成：29 个信号", detail: "412 个事件 · 耗时 1.8s", val: "11 笔执行" },
    { t: "17:42", kind: "warn", title: "结算前冻结加仓生效", detail: "SOL ≥ $240 · 拒绝 31,200 股", val: "已拦截" }
  ];

  /* ---------- 净值序列（确定性） ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildEquity() {
    const rand = mulberry32(20261118);
    const n = 365;
    const raw = [1];
    for (let i = 1; i < n; i++) {
      let r = 0.00078 + (rand() - 0.5) * 0.0062;
      // 两段可控回撤：9 月与 10 月初
      if (i === 296 || i === 297 || i === 298) r -= 0.009;
      if (i === 214) r -= 0.013;
      raw.push(raw[i - 1] * (1 + r));
    }
    const factor = equityNow / raw[n - 1];
    const vals = raw.map(v => v * factor);
    const start = Date.parse("2025-11-19T00:00:00Z");
    return vals.map((v, i) => ({ t: start + i * 86400000, v }));
  }

  const equity = buildEquity();

  /* ---------- 派生计算 ---------- */
  function derive(ev, at) {
    const nowMs = at || now();
    const dueMs = Date.parse(ev.due);
    const days = Math.max(0.25, (dueMs - nowMs) / 86400000);
    const mid = (ev.ask + ev.bid) / 2;
    const gross = (ev.fair - mid) * 100;                 // ¢，相对中间价
    const halfSpread = Math.max(0, (ev.ask - ev.bid) / 2);
    const spreadBps = halfSpread * 10000;                // 跨越点差的成本（占面值）
    const hedgeRatio = Math.abs(ev.delta);
    const feeBps = COST.hlFeeBps * hedgeRatio;           // 对冲腿手续费，按 Delta 折算到面值
    const slipBps = COST.hedgeSlipBps * hedgeRatio;
    const fundingBps = Math.min(COST.fundingCapBps, COST.fundingBpsDay * days) * hedgeRatio;
    const resBps = COST.resolutionBps;
    const costBps = spreadBps + feeBps + slipBps + fundingBps + resBps;
    const grossBps = gross * 100;
    const netBps = grossBps - costBps;
    const net = netBps / 100;
    const hedgeUsd = (ev.depth / ev.ask) * Math.abs(ev.delta);
    // 持有期回报 = 净边 ÷ 卖价（占用资金口径）；年化按剩余天数简单折算。
    // 除以面值会低估 1/ask 倍，这里统一按设计契约用卖价作分母。
    const holdReturn = net > 0 ? (net / 100) / ev.ask : 0;
    const annualized = holdReturn > 0 ? holdReturn * (365 / days) * 100 : 0;

    let status = "ready", statusText = "可执行";
    if (grossBps > 800) { status = "review"; statusText = "待复核"; }
    else if (days < 1.2) { status = "watch"; statusText = "临近结算"; }
    else if (net < MIN_EDGE_CENTS || ev.conf < 62 || ev.depth < 15000) { status = "watch"; statusText = "观察"; }
    if (positions.some(p => p.evId === ev.id)) { status = "active"; statusText = "执行中"; }

    return {
      ...ev, days, mid, gross, grossBps, costBps, netBps, net, hedgeUsd, holdReturn, annualized,
      status, statusText, spreadBps, feeBps, slipBps, fundingBps, resBps,
      edgeWidth: Math.max(4, Math.min(100, netBps / 6))
    };
  }

  function positionView(p) {
    const ev = events.find(e => e.id === p.evId);
    const d = derive(ev);
    const mk = market[ev.und] || market.BTC;
    const contractPnl = p.qty * (ev.bid - p.avg);
    const hedgePnl = p.hedgeUsd * (p.hedgeEntry - mk.px) / p.hedgeEntry;
    const target = p.qty * Math.abs(ev.delta);
    const ratio = target > 0 ? p.hedgeUsd / target : 1;
    const cost = p.qty * p.avg;
    const deltaUsd = target - p.hedgeUsd;
    return { ...p, ev, d, mark: ev.bid, cost, target, ratio, contractPnl, hedgePnl, pnl: contractPnl + hedgePnl, deltaUsd, mk };
  }

  function book() {
    const rows = positions.map(positionView);
    const face = rows.reduce((s, r) => s + r.qty, 0);
    const cost = rows.reduce((s, r) => s + r.cost, 0);
    const hedge = rows.reduce((s, r) => s + r.hedgeUsd, 0);
    const target = rows.reduce((s, r) => s + r.target, 0);
    const pnl = rows.reduce((s, r) => s + r.pnl, 0);
    const margin = hedge / 4.8;
    // 与结算日历同口径：按四舍五入后的剩余天数判断，避免出现"7 天后结算"却不在 7 日敞口里
    const settle7 = rows.filter(r => Math.round(r.d.days) <= 7).reduce((s, r) => s + r.cost, 0);
    const maxCost = rows.reduce((m, r) => Math.max(m, r.cost), 0);
    const byUnd = {};
    rows.forEach(r => {
      const k = r.ev.und;
      byUnd[k] = byUnd[k] || { face: 0, cost: 0 };
      byUnd[k].face += r.qty;
      byUnd[k].cost += r.cost;
    });
    return {
      rows, face, cost, hedge, target, pnl, margin, settle7, maxCost,
      netDelta: Math.max(0, target - hedge),
      undehedged: rows.filter(r => r.ratio < 0.9).length,
      byUnd, nowMs: now()
    };
  }

  window.CONV = {
    now, SIM_BASE, equityNow, market, base, events, CURATED_COUNT, UNIVERSE_SIZE,
    positions, orders, reviews, audit, riskEvents,
    calendar, limitDefaults, rules, feed, equity, COST, MIN_EDGE_CENTS,
    derive, positionView, book
  };
})();
