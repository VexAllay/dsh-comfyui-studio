/**
 * DSH ComfyUI Studio 的桥。
 *
 * 面板里的 ComfyUI 在 iframe 里，而且和 DSH 是跨源的：外面拿不到它的
 * JS 上下文，反过来，跨源 postMessage 是浏览器允许的。所以这里只听一条
 * 消息，把外面传来的工作流塞进前端自己的图里。
 *
 * 两个原则：
 *   1. 不假设 API 名字。ComfyUI 1.5x 把入口挪过位置，所以这里按候选
 *      顺序试，并把「到底有哪些方法」一起回报给外面，免得再次瞎猜。
 *   2. 不谎报成功。加载完要数画布上的节点，数不出来就算失败，错误原样
 *      回给 DSH 面板。
 */
import { app } from "../../scripts/app.js";

const CHANNEL = "dcs-open-workflow";
const HELLO = CHANNEL + "-hello";
const ACK = CHANNEL + "-ack";

function post(target, payload) {
  try {
    if (target) target.postMessage(payload, "*");
  } catch (_) {}
}

function nodeCount() {
  const graph = app && app.graph;
  if (graph && Array.isArray(graph._nodes)) return graph._nodes.length;
  return -1;
}

function advertise() {
  const wm = app && app.workflowManager;
  return {
    type: HELLO,
    loadGraphData: typeof (app && app.loadGraphData),
    workflowManager: wm === null || wm === undefined ? "none" : typeof wm,
    workflowManagerLoad: typeof (wm && wm.loadGraphData),
    graphConfigure: typeof (app && app.graph && app.graph.configure),
    nodes: nodeCount(),
    keys: Object.keys(app ?? {}).filter((key) => /load|graph|workflow|setup/i.test(key)).slice(0, 40),
  };
}

function sayHello() {
  post(window.parent, advertise());
}

// 模块刚落地时 app 可能还没 setup 完，隔一会儿再报一次，两次覆盖两种时序。
sayHello();
setTimeout(sayHello, 1200);
setTimeout(sayHello, 4000);

/** 按候选顺序尝试把工作流塞进画布，成功要求画布上真的出现节点。 */
async function loadWorkflow(graph) {
  const want = Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
  const attempts = [];
  if (typeof app?.loadGraphData === "function") {
    // 1.55 的签名是 loadGraphData(data, clean, restoreView, workflow, options)，
    // 只传 data 时 clean/restoreView 都是 undefined，前端可能判成「没开始」
    // 并静默返回 undefined —— 界面上就是一张空画布。这里显式传 true, true。
    attempts.push(["app.loadGraphData", () => app.loadGraphData(graph, true, true)]);
  }
  const wm = app?.workflowManager;
  if (typeof wm?.loadGraphData === "function") {
    attempts.push(["app.workflowManager.loadGraphData", () => wm.loadGraphData(graph)]);
  }
  if (typeof app?.graph?.configure === "function") {
    attempts.push(["app.graph.configure", () => app.graph.configure(graph)]);
  }

  const failures = [];
  for (const [label, run] of attempts) {
    try {
      const result = await run();
      // 画布建节点不是同步完成的，等两帧再数。
      await new Promise((resolve) => setTimeout(resolve, 120));
      try {
        app?.graph?.setDirtyCanvas?.(true, true);
      } catch (_) {}
      const got = nodeCount();
      // 前端自己用 false 表示失败、undefined 表示「没开始」（例如还在等确认）。
      if (result === false) {
        failures.push(label + ": 前端返回 false（拒绝载入）");
        continue;
      }
      if (want > 0 && got <= 0) {
        failures.push(label + (result === undefined ? ": 前端没开始载入（可能仍在等确认）" : ": 画布还是空的"));
        continue;
      }
      return { method: label, nodes: got };
    } catch (error) {
      failures.push(label + ": " + String((error && error.message) || error));
    }
  }
  throw new Error(failures.length > 0 ? failures.join(" | ") : "前端没有可用的 loadGraphData");
}

window.addEventListener("message", async (event) => {
  const data = event.data;
  if (data === null || typeof data !== "object") return;
  const source = event.source;
  // 面板打开时会主动 ping 一次：hello 是广播，错过就错过，ping 才能确认桥活着。
  if (data.type === "dcs-ping") {
    post(source, advertise());
    return;
  }
  if (data.type !== CHANNEL) return;
  const graph = data.graph;
  if (graph === null || typeof graph !== "object") {
    post(source, { type: ACK, ok: false, detail: "消息里没有工作流数据" });
    return;
  }
  try {
    const result = await loadWorkflow(graph);
    post(source, { type: ACK, ok: true, detail: result.method, nodes: result.nodes, name: String(data.name || "") });
  } catch (error) {
    post(source, { type: ACK, ok: false, detail: String((error && error.message) || error), name: String(data.name || "") });
  }
});
