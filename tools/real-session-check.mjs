/**
 * 真实会话的交叉核对：拿本机 ~/.dsh 里压缩次数最多的那个会话，
 * 同时用**插件**和**脚本内独立实现**各算一遍压缩用量，比对结果。
 *
 * 为什么需要：compaction-test.mjs 用的是人造日志，只能证明"我们按预期算"，
 * 不能证明"真实日志里的事件确实长这样"。这个脚本吃的是真文件，能抓到
 * 形状假设错误（例如某次 DSH 升级把 usage 挪了位置）。
 *
 * 与其他测试一致：纯 Node、零依赖、不联网、不用启动 DSH。
 * 找不到会话日志时**跳过**（退出码 0）—— CI 上没有 ~/.dsh，不该因此变红。
 *
 * 用法：node tools/real-session-check.mjs
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const sessionsRoot = join(dshHome, "sessions");

/** 解一个多帧 zstd 日志，返回事件数组。 */
function decode(file) {
  const buf = readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  const events = [];
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* 半行 */
      }
    }
  }
  return events;
}

// ── 找压缩次数最多的会话 ──
let best;
if (existsSync(sessionsRoot)) {
  for (const workspace of readdirSync(sessionsRoot)) {
    let sessionIds;
    try {
      sessionIds = readdirSync(join(sessionsRoot, workspace));
    } catch {
      continue;
    }
    for (const id of sessionIds) {
      const dirPath = join(sessionsRoot, workspace, id);
      let names;
      try {
        names = readdirSync(dirPath).filter((n) => /^session\.v\d+\.jsonl\.zstd$/.test(n)).sort();
      } catch {
        continue;
      }
      if (names.length === 0) continue;
      const file = join(dirPath, names[names.length - 1]);
      try {
        if (statSync(file).size === 0) continue;
      } catch {
        continue;
      }
      const events = decode(file);
      const compactions = events.filter((e) => e.type === "compaction/summary" && e.data && e.data.usage).length;
      if (compactions > 0 && (best === undefined || compactions > best.compactions)) {
        best = { id, file, events, compactions };
      }
    }
  }
}

if (best === undefined) {
  console.log("  ·  跳过：本机没有含压缩事件的会话日志（CI 上属正常）");
  process.exit(0);
}

// ── 独立实现（oracle）：只认 compaction/summary，自己累加 ──
const { rateAt } = await import(pathToFileURL(join(root, "lib", "index.js")).href);
const oracle = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, yuan: 0, count: 0 };
for (const event of best.events) {
  if (event.type !== "compaction/summary") continue;
  const usage = event.data && event.data.usage;
  if (!usage || typeof event.time !== "number") continue;
  const i = Number(usage.inputTokens) || 0;
  const o = Number(usage.outputTokens) || 0;
  const cr = Number(usage.cacheReadTokens) || 0;
  const cw = Number(usage.cacheWriteTokens) || 0;
  const rate = rateAt(event.time);
  oracle.input += i;
  oracle.output += o;
  oracle.cacheRead += cr;
  oracle.cacheWrite += cw;
  oracle.yuan += (i * rate.miss + cr * rate.hit + cw * rate.miss + o * rate.out) / 1e6;
  oracle.count += 1;
}

// ── 插件：走真实路由 ──
process.env.DSH_HOME = dshHome;
const mod = await import(pathToFileURL(join(root, "lib", "index.js")).href);
let registered = null;
const ctx = {
  sessions: { get: (id) => (id === best.id ? { id } : undefined) },
  // 官方投影不参与这次核对（只比压缩），给个全零的累计即可
  sessionProjections: { stateOf: () => ({ totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, last: null }) },
  webServer: { register: (route) => { registered = route; return () => {}; } },
  effect: (fn) => { fn(); },
  deepseekAccount: { getBalance: async () => ({ status: "ready", value: [{ currency: "CNY", balance: "1" }] }) },
  logger: { warn: () => {} },
};
mod.apply(ctx, undefined);

const raw = JSON.stringify({ type: "client-request", rpcId: "r1", method: "fetch", payload: { sessionId: best.id } });
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
const compact = JSON.parse(out).result.value.cost.compact;

console.log("  会话 " + best.id);
console.log("  日志 " + best.file);
console.log("  事件 " + best.events.length + " 条，压缩 " + best.compactions + " 次");
console.log("  oracle  次数=" + oracle.count + " 金额=¥" + oracle.yuan.toFixed(4)
  + " tokens(in/out/hit)=" + oracle.input + "/" + oracle.output + "/" + oracle.cacheRead);
console.log("  插件    次数=" + (compact ? compact.count : 0) + " 金额=¥" + (compact ? compact.yuan.toFixed(4) : "—"));

const okCount = compact !== undefined && compact.count === oracle.count;
const okYuan = compact !== undefined && Math.abs(compact.yuan - oracle.yuan) < 1e-9;
console.log("  " + (okCount ? "✓" : "✗") + "  次数一致");
console.log("  " + (okYuan ? "✓" : "✗") + "  金额一致");
process.exit(okCount && okYuan ? 0 : 1);
