/**
 * 压缩计费端到端测试。
 *
 * 为什么要有它：
 * host 的 tokenUsage 投影只认 assistant/message 与 assistant/attempt，
 * 压缩（compaction/summary）是真实扣费却不计入投影的一次模型调用。
 * 本插件因此自己扫会话日志，把这块补进「会话累计」「本轮」「token」。
 * 这段逻辑有三处容易错，且都只在界面上"数字看起来还算合理"时才暴露：
 *
 *   1. 计价必须用事件自己的时间戳（否则时段边界一过历史金额会变）
 *   2. 「本轮」只能算轮起点之后的压缩（seq 比较），不能把整个会话的压缩都算进去
 *   3. 日志是追加写的，必须增量扫描；文件被重写（变小）时要能整个重来
 *
 * 这里在临时目录里造真实的多帧 zstd 日志，走 apply() 注册的真实路由，
 * 断言响应里的 cost —— 不需要启动 DSH。
 *
 * 用法（从插件根目录）：node tools/compaction-test.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// DSH_HOME 必须在任何取数之前设好：host 半身的 dshHome() 读的是 process.env，
// 而这个测试要的是一个临时会话根目录，绝不能碰到用户真实的 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), "bchip-compaction-"));
process.env.DSH_HOME = home;

const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
const { rateAt, foldCompactionEvents, compactionScanStats } = mod;

const SESSION_ID = "session-compaction-selftest";
const WORKSPACE = "--C-Users-test-project--";
const sessionDir = join(home, "sessions", WORKSPACE, SESSION_ID);
const logFile = join(sessionDir, "session.v4.jsonl.zstd");
mkdirSync(sessionDir, { recursive: true });

let pass = 0;
let total = 0;
const ck = (ok, label, detail = "") => {
  total += 1;
  if (ok) pass += 1;
  console.log("  " + (ok ? "\u2713" : "\u2717") + "  " + label + (detail ? "   " + detail : ""));
};
const near = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9;

/** 一帧 = 一批事件，用真实 zstd 压缩后追加 —— 与 DSH 写日志的方式一致（多帧）。 */
const encodeFrame = (events) => zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
const writeFrames = (frames) => writeFileSync(logFile, Buffer.concat(frames.map(encodeFrame)));
const appendFrame = (events) => appendFileSync(logFile, encodeFrame(events));

// 计价基准：今天（「本日消耗」只统计当天，所以事件时间必须落在当天）
const now = Date.now();
const rate = rateAt(now);
/** 与 host 同一套算法手算一遍，避免"看着像对" */
const price = (b) =>
  (b.uncachedInputTokens * rate.miss + b.cacheReadTokens * rate.hit + b.cacheWriteTokens * rate.miss + b.outputTokens * rate.out) / 1e6;

const ASSISTANT_USAGE = { inputTokens: 500000, outputTokens: 250000, cacheReadTokens: 1000000, cacheWriteTokens: 0 };
const COMPACT_A = { inputTokens: 1000000, outputTokens: 250000, cacheReadTokens: 0, cacheWriteTokens: 0 };
const COMPACT_B = { inputTokens: 200000, outputTokens: 100000, cacheReadTokens: 400000, cacheWriteTokens: 0 };
const COMPACT_C = { inputTokens: 300000, outputTokens: 50000, cacheReadTokens: 0, cacheWriteTokens: 0 };

const bucketsOf = (usage) => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
});

const assistantEvent = (seq) => ({ type: "assistant/message", seq, time: now, data: { turn: 1, step: 1, usage: ASSISTANT_USAGE } });
const compactionEvent = (seq, usage) => ({
  type: "compaction/summary",
  seq,
  time: now,
  data: { compactionId: "c" + seq, provider: "deepseek", model: "deepseek-flash", usage },
});

writeFrames([
  [{ type: "session", seq: 1, time: now, data: { id: SESSION_ID } }, assistantEvent(10)],
  [compactionEvent(100, COMPACT_A)],
  [compactionEvent(200, COMPACT_B)],
]);

// ── 桩 ctx：与 selftest.mjs 同形状 ──
let totals = { ...bucketsOf(ASSISTANT_USAGE) };
let openTurnStartSeq = 150; // 轮起点落在 A(100) 与 B(200) 之间
const OTHER_ID = "session-compaction-other";
const NOLOG_ID = "session-compaction-nolog";
const sessionObjects = new Map([
  [SESSION_ID, { id: SESSION_ID }],
  [OTHER_ID, { id: OTHER_ID }],
  [NOLOG_ID, { id: NOLOG_ID }],
]);
const stateOf = (_s, key) => {
  if (key === "tokenUsage") return { totals, last: null };
  if (key === "turnBoundary") return { openTurnStartSeq, lastStepStartSeq: null, lastTurn: 1 };
  if (key === "sessionStats") return { turns: 1, steps: 1 };
  return undefined;
};

let registered = null;
const ctx = {
  sessions: { get: (id) => sessionObjects.get(id) },
  sessionProjections: { stateOf },
  webServer: { register: (route) => { registered = route; return () => {}; } },
  effect: (fn) => { fn(); },
  deepseekAccount: { getBalance: async () => ({ status: "ready", value: [{ currency: "CNY", balance: "10" }] }) },
  logger: { warn: () => {} },
};
mod.apply(ctx, undefined);
if (!registered) {
  console.error("  \u2717 apply() 没有注册路由");
  process.exit(1);
}

const fetchCost = async (sessionId = SESSION_ID) => {
  const raw = JSON.stringify({ type: "client-request", rpcId: "r1", method: "fetch", payload: { sessionId } });
  const req = {
    method: "POST",
    url: "/balance-mini/fetch",
    headers: { host: "127.0.0.1:19387" },
    socket: { remoteAddress: "127.0.0.1" },
    setEncoding() { return this; },
    on(ev, fn) { if (ev === "data") fn(raw); if (ev === "end") fn(); return this; },
  };
  let out = "";
  const res = { writeHead() {}, setHeader() {}, end(chunk) { out += chunk ?? ""; } };
  await registered.handler(req, res);
  await new Promise((r) => setTimeout(r, 10));
  return JSON.parse(out).result.value;
};

// ══ 场景 1：纯函数把压缩事件折成金额 ══
console.log("  ── 场景 1：foldCompactionEvents（纯函数）──");
{
  const folded = foldCompactionEvents([
    compactionEvent(1, COMPACT_A),
    { type: "assistant/message", seq: 2, time: now, data: { usage: ASSISTANT_USAGE } },
    compactionEvent(3, COMPACT_B),
  ]);
  ck(folded.entries.length === 2, "只折压缩事件，不把 assistant/message 算进去", String(folded.entries.length));
  ck(near(folded.yuan, price(bucketsOf(COMPACT_A)) + price(bucketsOf(COMPACT_B))), "金额 = 两次压缩之和", "¥" + folded.yuan.toFixed(6));
  ck(near(folded.buckets.uncachedInputTokens, COMPACT_A.inputTokens + COMPACT_B.inputTokens), "token 桶逐字段相加");
  const noTime = foldCompactionEvents([{ type: "compaction/summary", seq: 9, data: { usage: COMPACT_A } }]);
  ck(noTime.yuan === 0, "没有 time 的压缩事件不计价（不能拿此刻单价硬算）");
}

// ══ 场景 2：会话累计含压缩 ══
console.log("\n  ── 场景 2：会话累计含压缩 ──");
const expectCompactAll = price(bucketsOf(COMPACT_A)) + price(bucketsOf(COMPACT_B));
{
  const v = await fetchCost();
  const base = price(bucketsOf(ASSISTANT_USAGE));
  ck(near(v?.cost?.total, base + expectCompactAll), "会话累计 = 官方投影 + 压缩", "¥" + v?.cost?.total?.toFixed(6));
  ck(v?.cost?.total > base, "不补压缩时会偏低（断言确实加了）", "差额 ¥" + (v?.cost?.total - base).toFixed(6));
  ck(v?.cost?.compact?.count === 2, "压缩次数 = 2", String(v?.cost?.compact?.count));
  ck(near(v?.cost?.compact?.yuan, expectCompactAll), "压缩金额单独报出来", "¥" + v?.cost?.compact?.yuan?.toFixed(6));
  ck(v?.cost?.totalTokens?.uncachedInputTokens === ASSISTANT_USAGE.inputTokens + COMPACT_A.inputTokens + COMPACT_B.inputTokens,
    "token 口径同样并入压缩（否则金额与 token 自相矛盾）");
}

// ══ 场景 3：本轮只算轮起点之后的压缩 ══
console.log("\n  ── 场景 3：本轮只含 seq >= 轮起点的压缩 ──");
{
  const v = await fetchCost();
  const expectTurn = price(bucketsOf(COMPACT_B)); // A 的 seq=100 < 150，属于上一轮
  ck(near(v?.cost?.turn, expectTurn), "本轮金额 = 轮起点之后的压缩（A 被排除）", "¥" + v?.cost?.turn?.toFixed(6));
  ck(v?.cost?.turn < v?.cost?.total, "本轮 ≠ 会话累计（不能把全会话压缩都算进本轮）");
}

// ══ 场景 4：本日消耗也含压缩（口径一致性） ══
console.log("\n  ── 场景 4：本日消耗与压缩口径一致 ──");
{
  const v = await fetchCost();
  ck(v?.cost?.day >= expectCompactAll - 1e-9, "「本日」不小于压缩金额（scanTodayUsage 从不按类型过滤）", "¥" + v?.cost?.day?.toFixed(6));
  ck(v?.cost?.day >= v?.cost?.compact?.yuan - 1e-9, "不会出现「本日 < 压缩」这种矛盾");
}

// ══ 场景 5：增量扫描 —— 追加一帧只算新的 ══
console.log("\n  ── 场景 5：追加一帧（增量扫描）──");
{
  const before = (await fetchCost())?.cost?.compact?.yuan;
  appendFrame([compactionEvent(300, COMPACT_C)]);
  const v = await fetchCost();
  const expectC = price(bucketsOf(COMPACT_C));
  ck(near(v?.cost?.compact?.yuan, before + expectC), "只新增了第三次压缩的金额", "¥" + v?.cost?.compact?.yuan?.toFixed(6));
  ck(v?.cost?.compact?.count === 3, "次数变成 3", String(v?.cost?.compact?.count));
  ck(near(v?.cost?.turn, price(bucketsOf(COMPACT_B)) + expectC), "新压缩 seq=300 在本轮内，也计入本轮");
}

// ══ 场景 5b：**轮结束后回退的「上次」值也必须含压缩**（回归）══
// 只改 totals 的差分会漏掉压缩：轮内显示 ¥3.1，一轮结束立刻掉回 ¥2.6。
// 同一个数在换轮前后对不上，用户只会认为插件算错了。
console.log("\n  ── 场景 5b：轮结束后回退值含压缩（回归）──");
{
  const during = (await fetchCost())?.cost?.turn;
  openTurnStartSeq = null; // 一轮结束
  const after = await fetchCost();
  ck(near(after?.cost?.turn, during), "结束后回退值 = 轮结束时的实时值（压缩没有凭空消失）",
    "¥" + after?.cost?.turn?.toFixed(6) + " vs ¥" + during?.toFixed(6));
  ck(after?.cost?.turn > price(bucketsOf(COMPACT_B)), "回退值大于「只算 totals」的口径（证明压缩被算进去了）",
    "¥" + after?.cost?.turn?.toFixed(6));
  openTurnStartSeq = 300; // 恢复：让后续场景继续有进行中的轮次
  await fetchCost();
}

// ══ 场景 6：日志被重写（变小）→ 全量重扫，不叠加旧值 ══
console.log("\n  ── 场景 6：日志被重写（变小）──");
{
  writeFrames([[compactionEvent(400, COMPACT_C)]]);
  ck(statSync(logFile).size > 0, "日志非空");
  const v = await fetchCost();
  ck(v?.cost?.compact?.count === 1, "重扫后只剩 1 次（不会把旧帧叠加）", String(v?.cost?.compact?.count));
  ck(near(v?.cost?.compact?.yuan, price(bucketsOf(COMPACT_C))), "金额只剩重写后那一次", "¥" + v?.cost?.compact?.yuan?.toFixed(6));
}

// ══ 场景 7：没有压缩的会话 —— 金额仍按官方口径 ══
console.log("\n  ── 场景 7：没有压缩的会话 ──");
{
  writeFrames([[assistantEvent(1)]]);
  const v = await fetchCost();
  ck(near(v?.cost?.total, price(bucketsOf(ASSISTANT_USAGE))), "会话累计 = 官方投影（无压缩时不多不少）", "¥" + v?.cost?.total?.toFixed(6));
  ck(v?.cost?.compact === undefined, "compact 为 undefined（界面显示占位而非 ¥0）");
}

// ══ 场景 8：会话存在但还没有日志目录（刚建立的会话）══
// 这是最常见的运行时状态：ctx.sessions 里已经有会话对象，磁盘上却还没有日志。
// 扫描器必须安静地返回 undefined，而不是抛错把整块 cost 打掉。
console.log("\n  ── 场景 8：会话存在但还没有日志目录 ──");
{
  const v = await fetchCost(NOLOG_ID);
  ck(v?.cost !== undefined, "cost 仍然存在（扫描失败不能打掉整块 cost）");
  ck(near(v?.cost?.total, price(bucketsOf(ASSISTANT_USAGE))), "会话累计 = 官方投影口径（没有压缩可补）", "¥" + v?.cost?.total?.toFixed(6));
  ck(v?.cost?.compact === undefined, "compact 为 undefined");
}

// ══ 场景 9：跨会话隔离 —— 每个会话只算自己的压缩 ══
// 缓存按 sessionId 存在 Map 里，键写错就会串号：A 的压缩算到 B 头上，
// 而且数字看起来仍然"合理"，只能靠对照断言抓。
console.log("\n  ── 场景 9：跨会话隔离 ──");
{
  const otherDir = join(home, "sessions", WORKSPACE, OTHER_ID);
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, "session.v4.jsonl.zstd"), encodeFrame([compactionEvent(500, COMPACT_A)]));
  writeFrames([[compactionEvent(600, COMPACT_B)], [compactionEvent(700, COMPACT_C)]]);

  const a = await fetchCost(SESSION_ID);
  const b = await fetchCost(OTHER_ID);
  const expectA = price(bucketsOf(COMPACT_B)) + price(bucketsOf(COMPACT_C));
  const expectB = price(bucketsOf(COMPACT_A));
  ck(near(a?.cost?.compact?.yuan, expectA), "会话 A 只含自己的两次压缩", "¥" + a?.cost?.compact?.yuan?.toFixed(6));
  ck(near(b?.cost?.compact?.yuan, expectB), "会话 B 只含自己的那次压缩", "¥" + b?.cost?.compact?.yuan?.toFixed(6));
  ck(a?.cost?.compact?.count === 2 && b?.cost?.compact?.count === 1, "两个会话的压缩次数互不影响",
    a?.cost?.compact?.count + " vs " + b?.cost?.compact?.count);
}

// ══ 场景 10：末帧只写了一半（读取时正在追加）══
// 日志是边跑边写的：readFileSync 可能读到半个 zstd 帧。此时必须**停在它前面**，
// 不能把半帧当完整帧解压（会抛错），也不能丢掉已处理的部分。
console.log("\n  ── 场景 10：末帧只写了一半 ──");
{
  const frameA = encodeFrame([compactionEvent(800, COMPACT_A)]);
  const frameB = encodeFrame([compactionEvent(900, COMPACT_C)]);
  writeFileSync(logFile, Buffer.concat([frameA, frameB.subarray(0, 8)]));

  const partial = await fetchCost();
  ck(partial?.cost?.compact?.count === 1, "半帧被跳过，只算完整那一帧", String(partial?.cost?.compact?.count));
  ck(near(partial?.cost?.compact?.yuan, price(bucketsOf(COMPACT_A))), "金额只含完整帧", "¥" + partial?.cost?.compact?.yuan?.toFixed(6));

  // 把剩下的字节补上 —— 下一次必须从上次停下的位置接着解，且不重复计入第一帧
  writeFileSync(logFile, Buffer.concat([frameA, frameB]));
  const done = await fetchCost();
  ck(done?.cost?.compact?.count === 2, "补齐后两帧都在（且第一帧没有重复计）", String(done?.cost?.compact?.count));
  ck(near(done?.cost?.compact?.yuan, price(bucketsOf(COMPACT_A)) + price(bucketsOf(COMPACT_C))), "两帧金额相加", "¥" + done?.cost?.compact?.yuan?.toFixed(6));
}

// ══ 场景 11：只有压缩、没有对话用量 ══
// `priceBuckets` 对全零桶返回 undefined，此时总金额必须**等于压缩金额**，
// 而不是被 undefined 吞掉（addYuan 的意义就在这里）。
console.log("\n  ── 场景 11：只有压缩、没有对话用量 ──");
{
  totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  writeFrames([[compactionEvent(1000, COMPACT_C)]]);
  const v = await fetchCost();
  ck(near(v?.cost?.total, price(bucketsOf(COMPACT_C))), "会话累计 = 压缩金额（官方口径为空也不吞掉）", "¥" + v?.cost?.total?.toFixed(6));
  ck(v?.cost?.totalTokens?.uncachedInputTokens === COMPACT_C.inputTokens, "token 也只有压缩那部分");
}

// ══ 场景 12：增量扫描的**确定性**性能判据 ══
//
// 不测墙钟时间（机器快慢、GC 抖动都会让断言飘）。测"本次解压了多少字节"——
// 这个数与机器无关，且恰好是增量是否生效的直接证据：冷启动应接近整个文件，
// 追加一帧应**只有那一帧**。
console.log("\n  ── 场景 12：增量扫描只解压新帧（确定性判据）──");
{
  totals = { ...bucketsOf(ASSISTANT_USAGE) };
  const many = [];
  for (let i = 0; i < 300; i += 1) many.push([compactionEvent(2000 + i, COMPACT_B)]);
  writeFrames(many);

  const cold = await fetchCost();
  const coldStats = compactionScanStats(SESSION_ID);
  const fileSize = statSync(logFile).size;
  ck(coldStats.decompressedBytes > fileSize * 0.9, "冷启动：解压量接近文件大小", coldStats.decompressedBytes + " / " + fileSize + " B");
  ck(cold?.cost?.compact?.count === 300, "300 次压缩全部计入", String(cold?.cost?.compact?.count));

  const oneFrame = encodeFrame([compactionEvent(3000, COMPACT_C)]);
  appendFileSync(logFile, oneFrame);
  await fetchCost();
  const incStats = compactionScanStats(SESSION_ID);
  ck(incStats.decompressedBytes === oneFrame.length, "追加一帧：只解压那一帧（与文件总大小无关）",
    incStats.decompressedBytes + " vs " + oneFrame.length + " B");
  ck(incStats.decompressedBytes < fileSize * 0.01, "解压量 < 全量的 1%");
}

rmSync(home, { recursive: true, force: true });

console.log("\n  " + (pass === total ? "✓" : "✗") + "  " + pass + "/" + total + " 通过");
process.exit(pass === total ? 0 : 1);
