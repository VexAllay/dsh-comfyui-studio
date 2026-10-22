/**
 * dsh-comfyui-studio — 浏览器半边（client half）。
 *
 * 形态与 dsh-plugin-wallpaper-engine 的产物一致：一个
 * `window.__ModuleLoader__.load({ id, factory })` 包裹的普通浏览器模块，
 * factory 返回 { apply, inject } 交给 Cordis Loader。
 *
 * 界面由两件东西组成（做法对齐 dsh-imagegen）：
 *   1. 侧边栏双段 tab —— 在 shell 的「新会话」按钮上方插一格
 *      「会话 | ComfyUI」，点 ComfyUI 进入工作台，点会话回到对话；
 *   2. 工作台 —— **接管中心列**（把对话列 display:none，在它旁边插一个
 *      兄弟节点），所以顶栏、侧边栏一律不动。内部三栏：左工作流清单、
 *      中 ComfyUI 原生界面（同源反代，可自由编辑工作流）、右最近出图。
 *
 * 样式全部走 DSH 自己的 --dsw-* 变量（带回退值），跟随主题明暗。
 *
 * 失败策略：DOM 挂载问题只 warn，绝不 throw —— web shell 会因插件 apply
 * 抛错而整个 boot 失败，外部插件不能把 GUI 拖下水。
 */

/**
 * 浏览器半边必须是 DSH 客户端模块系统认的模块形态 ——
 * `window.__ModuleLoader__.load({ id, factory })`，factory 返回 { apply, inject }。
 *
 * 教训：DSH 的 client-modules 会 import `exports["./client"]` 并据此建 fiber；
 * 写成纯 IIFE 没有 exports，会被判成 "import failed" 直接把 web boot 拖死。
 */
window.__ModuleLoader__.load({
	id: "dsh-comfyui-studio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 宿主路由族前缀（与 lib/index.js 的 BASE 一致）。 */
		const BASE = "/api/dsh-comfyui-studio";

		/** 客户端服务依赖：slots 就绪意味着 shell 的 DOM 已经挂上。 */
		const inject = ["slots"];

		/** 侧边栏列标记（web shell 与 DSH Desktop 两种形态）。 */
		const SIDEBAR_COLUMN_SELECTOR = [
			'[data-pane="sidebar"]',
			'[class*="sidebarCol"]',
			'[class*="dshDesktopSidebarSurface"]',
			'[class*="dshDesktopUpstreamSidebar"]',
		].join(", ");

		/** 中心列（对话区）标记 —— 工作台要接管的正是它所在的这格。 */
		const CONVERSATION_SELECTOR = [
			'[data-pane="conversation"]',
			'[class*="centerCol"]',
			'[class*="conversationCol"]',
			'[class*="chatCol"]',
		].join(", ");

		/** shell 给「新会话」按钮的可访问名。 */
		const NEW_SESSION_LABELS = ["new session", "new chat", "新会话", "新建会话", "新对话", "新话题"];

		/** 面板打开时的状态轮询间隔。 */
		const POLL_MS = 5000;
		/** 锚点探测的节流间隔（React 流式渲染时 DOM 每秒变动上百次）。 */
		const THROTTLE_MS = 250;
		/** 多久还找不到锚点就放弃监听。 */
		const GIVE_UP_MS = 30000;

		/**
		 * 自检上报：宿主侧 /alive 会把它落进 loaded.json —— 我看不到浏览器，
		 * 靠这条回执确认「客户端插件有没有被加载」「锚点找到没有」。
		 */
		function report(phase, extra) {
			try {
				void fetch(BASE + "/alive", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						phase,
						href: String(window.location.href),
						ua: String(navigator.userAgent),
						...extra,
					}),
					keepalive: true,
				});
			} catch {
				/* 上报失败不影响界面 */
			}
		}

		/** 入口图标（画板 glyph）。 */
		const ENTRY_ICON =
			'<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M5 6h6M5 9h4"/><circle cx="11.4" cy="10.6" r="1.1"/></svg>';

		// ── 小工具 ────────────────────────────────────────────────────────────

		/** 建元素：tag(className, text)。 */
		function el(tag, className, text) {
			const node = document.createElement(tag);
			if (className !== undefined) node.className = className;
			if (text !== undefined) node.textContent = text;
			return node;
		}

		/** 宿主路由家族的一层封装：一律 JSON 出、JSON 入。 */
		async function api(path, options) {
			const init = options === undefined ? {} : options;
			const response = await fetch(`${BASE}${path}`, {
				method: init.method ?? "GET",
				headers: init.body === undefined ? undefined : { "content-type": "application/json" },
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			});
			const text = await response.text();
			let payload;
			try { payload = JSON.parse(text); } catch { payload = { ok: false, error: text.slice(0, 400) }; }
			return payload;
		}

		/** shell 的「新会话」按钮（当前形态 + 旧形态兜底）。 */
		function newSessionButton(root, allowLooseFallback = true) {
			const hooked = root.querySelector('button[data-dsh-part="new-session"], button[class*="newSession"]');
			if (hooked !== null) return hooked;
			const labelled = Array.from(root.querySelectorAll("button")).find((button) => {
				const name = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`
					.toLowerCase()
					.replace(/\s+/g, " ");
				return NEW_SESSION_LABELS.some((label) => name.includes(label));
			});
			if (labelled !== undefined) return labelled;
			if (!allowLooseFallback) return undefined;
			return Array.from(root.children).find((child) => child.tagName === "BUTTON");
		}

		/** 侧边栏根节点，或未挂载时的 undefined。 */
		function sidebarRoot() {
			const column = document.querySelector(SIDEBAR_COLUMN_SELECTOR);
			const logoRow = (column ?? document).querySelector('[class*="logoRow"]');
			if (logoRow !== null) {
				for (let candidate = logoRow.parentElement; candidate !== null; candidate = candidate.parentElement) {
					if (candidate === document.body) break;
					if (newSessionButton(candidate, false) !== undefined) return candidate;
					if (candidate === column) break;
					if (column !== null && !column.contains(candidate)) break;
				}
				return logoRow.parentElement ?? column ?? undefined;
			}
			if (column === null) return undefined;
			return column.firstElementChild ?? column;
		}

		// ── 样式（全部走 --dsw-* 变量，跟着主题走） ───────────────────────────

		const STYLE_ID = "dsh-comfyui-studio-style";
		const CSS = `
/* 侧边栏上的分段 tab：会话 | ComfyUI（体量与 shell 的导航项对齐） */
.dcs-tabs{display:grid;grid-template-columns:1fr 1fr;gap:2px;margin:2px 0 6px;padding:3px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:9px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));}
.dcs-tab{display:flex;align-items:center;justify-content:center;gap:5px;height:30px;padding:0 6px;
  border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);
  font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;}
.dcs-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));
  color:var(--dsw-alias-label-primary,inherit);}
.dcs-tab[data-active]{color:var(--dsw-alias-label-primary,inherit);
  background:var(--dsw-specific-sidebar-nav-item-active,rgba(127,127,127,.18));font-weight:500;}
.dcs-tab svg{flex:none;}

/* 工作台根：接管中心列，自己撑满这一格 */
.dcs-root{position:relative;display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;
  background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;}
.dcs-root[hidden]{display:none;}
/* 兜底：.dcs-btn 设了 display:inline-flex，会盖掉 hidden 属性的 UA 样式，
   导致「启动中…」这类本该隐藏的按钮一直留在工具条上。 */
.dcs-root [hidden]{display:none !important;}
/* 找不到中心列时的兜底：整页覆盖，保证点 tab 一定有界面 */
.dcs-root[data-fallback]{position:fixed;inset:0;z-index:40;flex:none;}

.dcs-bar{display:flex;align-items:center;gap:8px;flex:none;padding:8px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));}
.dcs-bar .dcs-meta{opacity:.6;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw;}
.dcs-spacer{flex:1;min-width:4px;}

.dcs-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);
  font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}
.dcs-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}
.dcs-btn:disabled{opacity:.45;cursor:default;}
.dcs-btn[data-kind="primary"]{background:var(--dsw-alias-brand-bg,rgba(90,140,255,.18));
  border-color:var(--dsw-alias-brand-border,rgba(90,140,255,.4));
  color:var(--dsw-alias-brand-text,var(--dsw-alias-label-primary,inherit));}

.dcs-body{flex:1;display:flex;min-height:0;min-width:0;overflow:hidden;}
/* 顶栏分段：ComfyUI 本体 / 工作台 */
.dcs-seg{display:flex;gap:2px;padding:2px;border-radius:9px;flex:none;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));}
.dcs-seg button{height:24px;padding:0 12px;border:0;border-radius:7px;background:transparent;
  color:inherit;font:inherit;font-size:12px;cursor:pointer;}
.dcs-seg button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}
.dcs-seg button[data-on]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));font-weight:600;}
/* 两个视图互斥显示 */
.dcs-view{flex:1;display:flex;min-width:0;min-height:0;overflow:hidden;}
/* 工作台左参数栏 */
.dcs-rail{flex:none;width:248px;display:flex;flex-direction:column;gap:8px;padding:10px;
  overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));}
.dcs-rail-title{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);}
.dcs-rail select,.dcs-rail input,.dcs-rail textarea{width:100%;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:8px;
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:inherit;font:inherit;
  font-size:12px;padding:6px 8px;min-width:0;}
.dcs-rail textarea{height:92px;resize:vertical;line-height:1.45;}
.dcs-rail input,.dcs-rail select{height:28px;}
.dcs-chips{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;}
.dcs-chip{height:26px;font-size:12px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:inherit;}
.dcs-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}
.dcs-chip[data-on]{background:var(--dsw-alias-brand-bg,rgba(90,140,255,.16));
  border-color:var(--dsw-alias-brand-border,rgba(90,140,255,.4));
  color:var(--dsw-alias-brand-text,var(--dsw-alias-label-primary,inherit));}
.dcs-row{display:flex;gap:6px;}
.dcs-row > *{flex:1;min-width:0;}
.dcs-rail-foot{margin-top:auto;display:flex;gap:6px;}
.dcs-side-head{display:flex;align-items:center;gap:6px;padding:8px 10px;font-size:12px;
  color:var(--dsw-alias-label-secondary,inherit);
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));}

.dcs-stage{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base,transparent);overflow:hidden;}
.dcs-stage iframe{flex:1;width:100%;height:100%;display:block;border:0;background:#fff;}
.dcs-stage iframe[hidden]{display:none;}
/* 覆盖在 iframe 之上：内嵌加载失败时盖住白板，而不是和它上下各占一半 */
.dcs-placeholder{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;
  background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-secondary,inherit);}
.dcs-placeholder[hidden]{display:none;}
.dcs-placeholder h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}
.dcs-placeholder p{margin:0;font-size:12.5px;max-width:460px;line-height:1.8;}
/* 只在桌面壳的 CSP 真的拦掉 iframe 时亮：白板旁边给一句话和出口 */
.dcs-stage-hint{position:absolute;left:10px;right:10px;bottom:10px;z-index:3;display:flex;
  align-items:center;gap:10px;padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.6;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-secondary,inherit);
  box-shadow:0 4px 16px rgba(0,0,0,.08);}
.dcs-stage-hint[hidden]{display:none;}
.dcs-stage-hint span{flex:1;min-width:0;}

.dcs-rail-status{font-size:11.5px;line-height:1.55;word-break:break-word;
  color:var(--dsw-alias-label-tertiary,inherit);}
.dcs-rail-status[data-tone="warn"]{color:var(--dsw-alias-status-warning,#e0a33a);}
.dcs-rail-status[data-tone="error"]{color:var(--dsw-alias-status-danger,#d05252);}

.dcs-notice{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:11.5px;color:var(--dsw-alias-label-tertiary,inherit);text-align:right;}
.dcs-notice[data-tone="warn"]{color:var(--dsw-alias-status-warning,#e0a33a);}
.dcs-notice[data-tone="error"]{color:var(--dsw-alias-status-danger,#d05252);}

.dcs-mask{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.42);}
.dcs-mask[hidden]{display:none;}
.dcs-card{width:min(520px,92%);border-radius:12px;padding:18px;
  background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-layer-2,#1b1b1f));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  box-shadow:0 18px 50px rgba(0,0,0,.35);}
.dcs-card h3{margin:0 0 12px;font-size:14px;}
.dcs-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;}
.dcs-field label{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);}
.dcs-field input,.dcs-field select{padding:6px 9px;border-radius:7px;font:inherit;font-size:12.5px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);}
.dcs-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}
.dcs-lightbox{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.8);cursor:zoom-out;}
.dcs-lightbox[hidden]{display:none;}
.dcs-lightbox img{max-width:94%;max-height:94%;border-radius:8px;}
`;

		/** 一次性注入样式。 */
		function installStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.append(style);
		}

		// ── 工作台 ────────────────────────────────────────────────────────────

		/** 顶栏提示的自动消失定时器。 */
		let noticeTimer = null;
		let lastNotice = "";

		/** 界面全部状态。 */
		const state = {
			view: "work",
			workflows: [],
			summary: null,
			summaryFor: "",
			running: false,
			ratio: "auto",
			open: false,
			status: null,
			config: null,
			images: [],
			notice: "",
			noticeTone: "",
			launchingUi: false,
			cspBlocked: false,
			frameLoaded: false,
			bridgeReady: false,
			bridgeInfo: null,
			poll: null,
		};

		/** 面板内的可变节点引用。 */
		const refs = {};

		/** 组装工作台（只建一次，插在中心列旁边）。 */
		function buildView() {
			const root = el("div", "dcs-root");
			root.hidden = true;
			root.dataset.dcsRoot = "";

			// 工作台自己的工具条（不是 DSH 的顶栏）
			const bar = el("div", "dcs-bar");
			// 顶栏左边分两块：ComfyUI 本体 / 工作台（参数控制台）
			refs.seg = el("div", "dcs-seg");
			refs.segButtons = new Map();
			for (const [key, label] of [["work", "工作台"], ["comfy", "ComfyUI"]]) {
				const button = el("button", undefined, label);
				button.type = "button";
				button.addEventListener("click", () => { setView(key); });
				refs.segButtons.set(key, button);
				refs.seg.append(button);
			}
			// 「面板」入口：只开合 fandc 面板，不参与 工作台/ComfyUI 的视图切换。
			const panelButton = el("button", undefined, "面板");
			panelButton.type = "button";
			panelButton.dataset.dcsPanelToggle = "";
			panelButton.setAttribute("title", "展开 / 收起 ComfyUI 面板");
			panelButton.addEventListener("click", () => {
				try {
					fandcClient?.panelStore?.toggle();
				} catch (error) {
					console.warn("[comfyui-studio] 面板开关失败：", error);
				}
			});
			refs.seg.append(panelButton);

			refs.notice = el("span", "dcs-notice", "");
			bar.append(refs.seg, el("div", "dcs-spacer"), refs.notice);

			refs.reload = el("button", "dcs-btn", "重载");
			refs.reload.title = "重新载入右侧 ComfyUI 界面";
			refs.reload.addEventListener("click", () => { reloadFrame(); });
			refs.launch = el("button", "dcs-btn", "启动 ComfyUI");
			refs.launch.addEventListener("click", () => { void doLaunch(); });
			refs.settings = el("button", "dcs-btn", "设置");
			refs.settings.addEventListener("click", () => { void toggleSettings(true); });
			bar.append(refs.reload, refs.launch, refs.settings);

			// 主体：画布 + 最近出图（工作流列表已去掉 —— ComfyUI 自己就带工作流面板，
			// 这里再放一份只是白底占宽度）
			const body = el("div", "dcs-body");

			const viewComfy = el("div", "dcs-view");
			const stage = el("main", "dcs-stage");
			refs.frame = document.createElement("iframe");
			refs.frame.dataset.role = "frame";
			refs.frame.setAttribute("allow", "clipboard-read; clipboard-write");
			refs.frame.addEventListener("load", () => {
				state.frameLoaded = true;
				refs.placeholder.hidden = true;
				renderMeta();
				pingBridge();
				report("frame", { loaded: true, url: refs.frame.dataset.src, bridgeReady: state.bridgeReady });
			});
			refs.placeholder = el("div", "dcs-placeholder");
			refs.placeholder.append(el("h3", undefined, "本地 ComfyUI 未接入"));
			refs.placeholderText = el("p", undefined, "点上面的「启动 ComfyUI」拉起本机整合包；已经开着的会直接嵌进来。");
			refs.placeholder.append(refs.placeholderText);
			// 桌面壳 CSP 拦掉 iframe 时的提示条（正常情况下一直隐藏）
			refs.hint = el("div", "dcs-stage-hint");
			refs.hint.hidden = true;
			refs.hintText = el("span", undefined, "");
			refs.hint.append(refs.hintText);
			stage.append(refs.placeholder, refs.hint, refs.frame);
			refs.frame.hidden = true;

			// 工作台页的左参数栏
			const fieldLabel = (text) => el("div", "dcs-rail-title", text);
			const railNumber = (placeholder, title) => {
				const input = document.createElement("input");
				input.type = "number";
				input.placeholder = placeholder;
				input.title = title ?? placeholder;
				return input;
			};
			const rail = el("aside", "dcs-rail");
			refs.wfSelect = document.createElement("select");
			refs.wfSelect.title = "要出图的工作流";
			refs.wfSelect.addEventListener("change", () => { void selectWorkflow(); });
			rail.append(refs.wfSelect);

			refs.promptInput = document.createElement("textarea");
			refs.promptInput.placeholder = "正向提示词";
			rail.append(fieldLabel("正向提示词"), refs.promptInput);

			refs.negativeInput = document.createElement("textarea");
			refs.negativeInput.placeholder = "负向提示词";
			refs.negativeInput.style.height = "58px";
			rail.append(fieldLabel("负向提示词"), refs.negativeInput);

			const ratios = [
				["auto", "自动", 0, 0],
				["1:1", "1:1", 1024, 1024],
				["3:4", "3:4", 896, 1152],
				["4:3", "4:3", 1152, 896],
				["9:16", "9:16", 768, 1344],
				["2:3", "2:3", 832, 1216],
				["3:2", "3:2", 1216, 832],
				["16:9", "16:9", 1344, 768],
				["21:9", "21:9", 1536, 640],
			];
			const chips = el("div", "dcs-chips");
			refs.ratioChips = new Map();
			for (const [key, label, width, height] of ratios) {
				const chip = el("button", "dcs-chip", label);
				chip.type = "button";
				chip.title = width === 0 ? "用工作流里的原尺寸" : width + "×" + height;
				chip.addEventListener("click", () => {
					state.ratio = key;
					if (width > 0) {
						refs.widthInput.value = String(width);
						refs.heightInput.value = String(height);
					}
					syncChips();
				});
				refs.ratioChips.set(key, chip);
				chips.append(chip);
			}
			rail.append(fieldLabel("比例"), chips);

			const sizeRow = el("div", "dcs-row");
			refs.widthInput = railNumber("宽");
			refs.heightInput = railNumber("高");
			sizeRow.append(refs.widthInput, refs.heightInput);
			rail.append(fieldLabel("尺寸"), sizeRow);

			const sampleRow = el("div", "dcs-row");
			refs.stepsInput = railNumber("步数");
			refs.cfgInput = railNumber("CFG");
			sampleRow.append(refs.stepsInput, refs.cfgInput);
			rail.append(fieldLabel("采样"), sampleRow);

			const seedRow = el("div", "dcs-row");
			refs.seedInput = railNumber("种子", "留空就用工作流里的种子");
			refs.seedInput.title = "留空就用工作流里的种子";
			refs.batchInput = railNumber("张数");
			refs.batchInput.min = "1";
			refs.batchInput.max = "4";
			refs.dice = el("button", "dcs-chip", "随机");
			refs.dice.type = "button";
			refs.dice.title = "换一个随机种子";
			refs.dice.style.flex = "none";
			refs.dice.style.padding = "0 10px";
			refs.dice.addEventListener("click", () => {
				refs.seedInput.value = String(Math.floor(Math.random() * 281474976710656));
			});
			seedRow.append(refs.seedInput, refs.batchInput, refs.dice);
			rail.append(fieldLabel("种子 / 张数"), seedRow);

			refs.railStatus = el("div", "dcs-rail-status", "就绪");
			rail.append(refs.railStatus);

			const foot = el("div", "dcs-rail-foot");
			refs.run = el("button", "dcs-btn", "生成");
			refs.run.dataset.kind = "primary";
			refs.run.style.flex = "1";
			refs.run.addEventListener("click", () => { void doGenerate(); });
			foot.append(refs.run);
			rail.append(foot);


			viewComfy.append(stage);
			const viewWork = el("div", "dcs-view");
			viewWork.hidden = true;
			viewWork.append(rail);
			refs.viewComfy = viewComfy;
			refs.viewWork = viewWork;
			body.append(viewComfy, viewWork);

			// 设置对话框
			const mask = el("div", "dcs-mask");
			mask.hidden = true;
			const card = el("div", "dcs-card");
			card.append(el("h3", undefined, "ComfyUI 接入设置"));
			refs.inputs = {};
			const fields = [
				["comfyRoot", "整合包根目录（含 ComfyUI/ 与 python/ 的那一层）", "text"],
				["host", "主机", "text"],
				["port", "端口", "text"],
				["launchMode", "启动方式", "select"],
				["extraArgs", "额外启动参数（空格分隔）", "text"],
			];
			for (const [key, label, kind] of fields) {
				const field = el("div", "dcs-field");
				field.append(el("label", undefined, label));
				let input;
				if (kind === "select") {
					input = document.createElement("select");
					for (const [value, text] of [["python", "直接拉起整合包内嵌 python（推荐）"], ["launcher", "拉起绘世启动器"]]) {
						const option = document.createElement("option");
						option.value = value;
						option.textContent = text;
						input.append(option);
					}
				} else {
					input = document.createElement("input");
					input.type = "text";
				}
				refs.inputs[key] = input;
				field.append(input);
				card.append(field);
			}
			const actions = el("div", "dcs-actions");
			refs.settingsCancel = el("button", "dcs-btn", "取消");
			refs.settingsCancel.addEventListener("click", () => { void toggleSettings(false); });
			refs.settingsSave = el("button", "dcs-btn", "保存");
			refs.settingsSave.dataset.kind = "primary";
			refs.settingsSave.addEventListener("click", () => { void saveSettings(); });
			actions.append(refs.settingsCancel, refs.settingsSave);
			card.append(actions);
			mask.append(card);
			refs.mask = mask;

			// 大图查看
			const lightbox = el("div", "dcs-lightbox");
			lightbox.hidden = true;
			refs.lightboxImg = document.createElement("img");
			lightbox.append(refs.lightboxImg);
			lightbox.addEventListener("click", () => { lightbox.hidden = true; });
			refs.lightbox = lightbox;

			root.append(bar, body, mask, lightbox);
			setView(state.view);
			refs.root = root;
			return root;
		}

		/** 出图守夜定时器：只在工作台可见时跑。 */
		let imageTimer = 0;

		/** 切换顶栏两块：comfy（本体）/ work（工作台）。 */
		function setView(view) {
			state.view = view === "work" ? "work" : "comfy";
			if (refs.viewComfy !== undefined) refs.viewComfy.hidden = state.view !== "comfy";
			if (refs.viewWork !== undefined) refs.viewWork.hidden = state.view !== "work";
			for (const [key, button] of refs.segButtons ?? []) {
				if (key === state.view) button.dataset.on = "";
				else delete button.dataset.on;
			}
						if (state.view === "work") {
				void loadWorkflows();
				void refreshImages();
				startImageWatch();
			} else {
				stopImageWatch();
			}
		}

		/** 工作台可见时盯一下出图：图可能是右侧 ComfyUI 里生成的，工作台自己收不到事件。 */
		function startImageWatch() {
			if (imageTimer !== 0) return;
			imageTimer = window.setInterval(() => {
				if (state.open !== true || state.view !== "work") return;
				if (document.visibilityState === "hidden") return;
				void refreshImages();
			}, 5000);
		}

		function stopImageWatch() {
			if (imageTimer === 0) return;
			window.clearInterval(imageTimer);
			imageTimer = 0;
		}

		/** 拉工作流列表（宿主 /workflows 返回文件名数组）。 */
		async function loadWorkflows() {
			if (refs.wfSelect === undefined) return;
			let list = [];
			try {
				const payload = await api("/workflows");
				const body = payload?.json ?? payload;
				if (Array.isArray(body)) list = body.map((name) => String(name));
			} catch {
				list = [];
			}
			if (list.length === 0) {
				if (refs.wfSelect.options.length === 0) {
					const option = document.createElement("option");
					option.value = "";
					option.textContent = "没找到工作流";
					refs.wfSelect.append(option);
				}
				return;
			}
			const same = list.length === state.workflows.length && list.every((name, index) => state.workflows[index] === name);
			if (same) return;
			const current = refs.wfSelect.value;
			state.workflows = list;
			refs.wfSelect.textContent = "";
			for (const name of list) {
				const option = document.createElement("option");
				option.value = name;
				option.textContent = name.replace(/\.json$/i, "");
				refs.wfSelect.append(option);
			}
			if (list.includes(current)) refs.wfSelect.value = current;
			else {
				// 没选过（或旧选择已不在列表）：用配置里的默认工作流
				let wanted = state.config?.defaultWorkflow;
				if (wanted === undefined) {
					try {
						const payload = await api("/config");
						if (payload?.config !== undefined) state.config = payload.config;
					} catch { /* 读不到配置就保持列表第一个 */ }
					wanted = state.config?.defaultWorkflow;
				}
				if (typeof wanted === "string" && list.includes(wanted)) refs.wfSelect.value = wanted;
			}
			if (refs.wfSelect.value !== state.summaryFor) await loadSummary();
		}

		/** 换工作流：重新认一遍参数。 */
		async function selectWorkflow() {
			state.summary = null;
			state.summaryFor = "";
			state.ratio = "auto";
			syncChips();
			await loadSummary();
		}

		/** 认这个工作流的可调参数（宿主 /inspect 用 object_info 认节点）。 */
		async function loadSummary() {
			const name = refs.wfSelect?.value ?? "";
			if (name === "") return;
			state.summaryFor = name;
			try {
				const payload = await api("/inspect?name=" + encodeURIComponent(name));
				const body = payload?.json ?? payload;
				state.summary = body?.summary ?? null;
			} catch {
				state.summary = null;
			}
			applySummary();
		}

		/** 把认到的参数填进栏里。 */
		function applySummary() {
			if (refs.promptInput === undefined) return;
			const summary = state.summary;
			refs.promptInput.value = summary?.positive?.text ?? "";
			refs.negativeInput.value = summary?.negative?.text ?? "";
			refs.widthInput.value = summary?.size?.width ?? "";
			refs.heightInput.value = summary?.size?.height ?? "";
			refs.stepsInput.value = summary?.sampler?.steps ?? "";
			refs.cfgInput.value = summary?.sampler?.cfg ?? "";
			refs.seedInput.value = summary?.sampler?.seed ?? "";
			refs.batchInput.value = summary?.size?.batch ?? 1;
			refs.promptInput.placeholder = summary?.positive === null || summary?.positive === undefined
				? "这个工作流没认出提示词节点"
				: "正向提示词";
			syncChips();
		}

		/** 尺寸档位高亮。 */
		function syncChips() {
			for (const [key, chip] of refs.ratioChips ?? []) {
				if (key === state.ratio) chip.dataset.on = "";
				else delete chip.dataset.on;
			}
		}

		/** 组装 overrides：key 是宿主算好的「节点.参数」路径。 */
		function collectOverrides() {
			const summary = state.summary;
			const overrides = {};
			const put = (key, value) => {
				if (typeof key === "string" && key !== "") overrides[key] = value;
			};
			const number = (input) => {
				const raw = input?.value ?? "";
				if (raw === "") return undefined;
				const value = Number(raw);
				return Number.isFinite(value) ? value : undefined;
			};
			if (refs.promptInput.value !== "") put(summary?.positive?.key, refs.promptInput.value);
			if (refs.negativeInput.value !== "") put(summary?.negative?.key, refs.negativeInput.value);
			const sampler = summary?.sampler?.keys ?? {};
			const steps = number(refs.stepsInput);
			if (steps !== undefined) put(sampler.steps, Math.trunc(steps));
			const cfg = number(refs.cfgInput);
			if (cfg !== undefined) put(sampler.cfg, cfg);
			const seed = number(refs.seedInput);
			if (seed !== undefined) put(sampler.seed, Math.trunc(seed));
			const size = summary?.size?.keys ?? {};
			const width = number(refs.widthInput);
			if (width !== undefined) put(size.width, Math.trunc(width));
			const height = number(refs.heightInput);
			if (height !== undefined) put(size.height, Math.trunc(height));
			const batch = number(refs.batchInput);
			if (batch !== undefined && batch > 1) put(size.batch_size, Math.trunc(batch));
			return overrides;
		}

		/** 参数栏底部那行常驻状态：生成走到哪一步，不靠会消失的通知。 */
		function setRunStatus(text, tone) {
			if (refs.railStatus === undefined) return;
			refs.railStatus.textContent = text;
			if (tone === undefined || tone === "") delete refs.railStatus.dataset.tone;
			else refs.railStatus.dataset.tone = tone;
		}

		/** 栏底「生成」：POST /run，由宿主转成 API 格式再提交。 */
		async function doGenerate() {
			const name = refs.wfSelect?.value ?? "";
			if (name === "") {
				state.notice = "先选一个工作流";
				state.noticeTone = "error";
				renderMeta();
				setRunStatus("先选一个工作流", "warn");
				return;
			}
			if (state.running === true) return;
			state.running = true;
			refs.run.disabled = true;
			refs.run.textContent = "生成中…";
			setRunStatus("正在提交「" + name + "」…");
			state.notice = "正在提交「" + name + "」…";
			state.noticeTone = "";
			renderMeta();
			try {
				const payload = await api("/run", { method: "POST", body: { name, overrides: collectOverrides() } });
				const body = payload?.json ?? payload;
				if (body?.ok !== true) throw new Error(String(body?.error ?? body?.result?.error?.message ?? "提交被拒绝"));
				const promptId = body?.result?.prompt_id;
				state.notice = "已提交「" + name + "」，等出图…";
				setRunStatus("已提交，等出图…");
				state.noticeTone = "";
				renderMeta();
				report("run", { ok: true, name, nodeCount: body.nodeCount, promptId });
				if (typeof promptId === "string") void pollGeneration(promptId, name);
			} catch (error) {
				state.notice = "生成失败：" + String(error);
				setRunStatus("提交失败：" + String(error), "error");
				state.noticeTone = "error";
				renderMeta();
				report("run", { ok: false, name, error: String(error) });
			} finally {
				state.running = false;
				refs.run.disabled = false;
				refs.run.textContent = "生成";
			}
		}

		/** 盯这次提交：出图就刷「最近出图」。 */
		async function pollGeneration(promptId, name) {
			const deadline = Date.now() + 10 * 60 * 1000;
			for (;;) {
				await new Promise((resolve) => window.setTimeout(resolve, 2500));
				if (state.open !== true) return;
				try {
					const payload = await api("/comfy", { method: "POST", body: { path: "/history/" + encodeURIComponent(promptId) } });
					const history = payload?.json ?? payload;
					const entry = history?.[promptId];
					if (entry !== null && entry !== undefined) {
						if (entry?.status?.status_str === "error") {
							state.notice = "生成失败：「" + name + "」执行报错，右侧 ComfyUI 能看详情";
							setRunStatus("执行报错，右侧 ComfyUI 有详情", "error");
							state.noticeTone = "error";
							renderMeta();
							void refreshImages();
							return;
						}
						if (entry?.status?.completed === true || entry?.outputs !== undefined) {
							state.notice = "生成完成：「" + name + "」已进「最近出图」";
							state.noticeTone = "";
							renderMeta();
							void refreshImages().then(() => {
								const first = state.images[0];
								setRunStatus(first === undefined ? "生成完成" : "完成：" + first.filename);
							});
							return;
						}
					}
				} catch {
					/* 单次轮询失败无所谓 */
				}
				if (Date.now() > deadline) {
					state.notice = "生成超时：「" + name + "」还在队列里，右侧能看到进度";
					setRunStatus("超时：还在队列里，右侧能看进度", "warn");
					state.noticeTone = "error";
					renderMeta();
					return;
				}
			}
		}

		/** 顶栏通知与「启动 ComfyUI」按钮状态。 */
		function renderMeta() {
			const status = state.status;
			const reachable = status?.reachable === true;
			const launching = status?.launching === true;
			if (reachable) {
				refs.launch.hidden = true;
			} else if (launching) {
				refs.launch.hidden = false;
				refs.launch.textContent = "启动中…";
				refs.launch.disabled = true;
			} else {
				refs.launch.hidden = false;
				refs.launch.textContent = "启动 ComfyUI";
				refs.launch.disabled = false;
				refs.placeholderText.textContent = status?.error === undefined
					? "点上面的「启动 ComfyUI」拉起本机整合包；已经开着的会直接嵌进来。"
					: `连接失败：${status.error}。点「启动 ComfyUI」拉起本机整合包，或先在「设置」里确认路径。`;
			}
			refs.notice.textContent = state.notice;
			refs.notice.dataset.tone = state.noticeTone;
			refs.notice.title = state.notice;
			// 成功类提示 4 秒后自动消失（报错留着，等人处理）。
			// 只在文案变化时重新计时：轮询每 5 秒都会走这里，否则定时器会被无限续命。
			if (state.notice !== lastNotice) {
				lastNotice = state.notice;
				if (noticeTimer !== null) window.clearTimeout(noticeTimer);
				noticeTimer = null;
				if (state.notice !== "" && state.noticeTone !== "error") {
					const shown = state.notice;
					noticeTimer = window.setTimeout(() => {
						noticeTimer = null;
						if (state.notice !== shown || state.noticeTone === "error") return;
						state.notice = "";
						refs.notice.textContent = "";
						refs.notice.title = "";
					}, 4000);
				}
			}
		}

		/**
		 * 内嵌 ComfyUI 的地址。
		 *
		 * 默认走**同源反代**（`${BASE}/comfy-ui/`）。直连 `http://127.0.0.1:8188/`
		 * 从 `dsh-app://`（secure 上下文）里嵌进来会被判成混合内容整块拦掉：白板、
		 * 不触发任何 CSP 事件、load 照常触发 —— 从界面上完全看不出原因，所以不再
		 * 默认直连（实测桌面版就是这样一块白板）。
		 *
		 * 反代全在宿主侧完成：HTML 注入同源 <base>，ComfyUI 前端用
		 * `location.pathname.split('/').slice(0,-1)` 推 api_base，于是 /api/*、
		 * /view、/extensions/* 全都带着前缀回到宿主，静态资源同理 —— 全程同源，
		 * 既没有跨源模块脚本的 CORS 问题，也没有混合内容拦截。
		 */
		function embedUrl(useDirect) {
			if (useDirect === true) {
				const direct = state.status?.url;
				if (typeof direct === "string" && direct !== "") return direct;
			}
			return `${BASE}/comfy-ui/`;
		}

		/** CSP 拦掉内嵌时的提示（只有真的发生才亮，正常时一直隐藏）。 */
		function renderHint() {
			if (refs.hint === undefined) return;
			refs.hint.hidden = state.cspBlocked !== true;
			if (state.cspBlocked === true) {
				refs.hintText.textContent = `右侧界面被安全策略拦住了（CSP frame-src）。这是桌面壳的限制，插件绕不过去，请直接在浏览器打开 ${state.status?.url ?? "本机 ComfyUI 地址"}。`;
			}
		}

		/** 同步 iframe。 */
		/** 手动重载右侧界面（ComfyUI 卡在加载中时用）。 */
		function reloadFrame() {
			if (refs.frame === undefined) return;
			state.frameLoaded = false;
			state.bridgeReady = false;
			refs.frame.dataset.src = "";
			refs.frame.removeAttribute("src");
			if (refs.placeholder !== undefined) {
				refs.placeholder.hidden = false;
				refs.placeholderText.textContent = "正在重新载入 ComfyUI…";
			}
			state.notice = "";
			renderMeta();
			window.setTimeout(() => { syncFrame(); }, 0);
		}

		function syncFrame() {
			if (refs.frame === undefined) return;
			const reachable = state.status?.reachable === true;
			if (!reachable) {
				if (refs.frame.dataset.src !== "") {
					refs.frame.dataset.src = "";
					refs.frame.hidden = true;
					refs.frame.removeAttribute("src");
				}
				refs.placeholder.hidden = false;
				refs.placeholderText.textContent = "ComfyUI 没在运行。点上面的「启动 ComfyUI」拉起整合包。";
				return;
			}
			const url = embedUrl(false);
			if (refs.frame.dataset.src !== url) {
				refs.frame.dataset.src = url;
				refs.frame.hidden = false;
				refs.placeholder.hidden = true;
				state.frameLoaded = false;
				state.bridgeReady = false;
				refs.frame.src = url;
				// 只用 load 事件做判据：ComfyUI 首屏要拉几十个 chunk，冷启动超过 6 秒很常见，
				// 拿「桥有没有打招呼」当判据会把好好的界面误判成没起来（8 秒也一样会误判）。
				// 是否真白由用户点「重载」或去浏览器核对，这里给出可操作提示而不是盖死。
				window.setTimeout(() => {
					if (state.frameLoaded === true || state.open !== true) return;
					report("frame", { loaded: false, url });
					refs.placeholder.hidden = false;
					refs.placeholderText.textContent =
						"右侧 8 秒还没载入完成。点「重载」再试一次；仍不行看顶栏地址是否可达，或去「设置」核对路径/端口。";
				}, 8000);
			}
		}

		/** 渲染最近出图缩略图。 */
		function renderImages() {
			if (refs.thumbs === undefined) return;
			refs.thumbs.textContent = "";
			refs.imagesCount.textContent = String(state.images.length);
			for (const image of state.images) {
				const thumb = document.createElement("img");
				thumb.loading = "lazy";
				thumb.src = `${BASE}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder ?? "")}&type=${encodeURIComponent(image.type ?? "output")}`;
				thumb.title = image.filename;
				thumb.addEventListener("click", () => {
					refs.lightboxImg.src = thumb.src;
					refs.lightbox.hidden = false;
				});
				refs.thumbs.append(thumb);
			}
		}

		// ── 数据动作 ──────────────────────────────────────────────────────────

		/** 拉一次状态。 */
		async function refreshStatus() {
			try {
				state.status = await api("/status");
			} catch (error) {
				state.status = { reachable: false, error: String(error) };
			}
			renderMeta();
			if (state.open) syncFrame();
		}

		/** 拉最近出图（/history → outputs.images）。 */
		async function refreshImages() {
			try {
				const payload = await api("/comfy", { method: "POST", body: { path: "/history?max_items=24" } });
				const history = payload?.json ?? payload;
				const found = [];
				if (history !== null && typeof history === "object") {
					for (const record of Object.values(history)) {
						const outputs = record?.outputs ?? {};
						for (const output of Object.values(outputs)) {
							for (const image of output?.images ?? []) {
								if (image?.filename !== undefined) found.push(image);
							}
						}
					}
				}
				state.images = found.reverse().slice(0, 36);
			} catch {
				/* 历史读不到不影响主流程 */
			}
			renderImages();
		}

		/** 全量刷新。 */
		async function refreshAll() {
			await refreshStatus();
			if (state.status?.reachable === true) {
				await refreshImages();
			}
		}

		/** 选中动作的序号：快速连点时只认最后一次的结果。 */
		let selectSeq = 0;

		/** iframe 的真实源：直连时是 8188，走同源反代时是 DSH 自己的源。 */
		function frameOrigin() {
			const src = refs.frame?.src ?? "";
			try { return new URL(src).origin; } catch { return state.status?.url ?? ""; }
		}

		/** 问一下桥还在不在：hello 是广播，面板晚打开就错过了。 */
		function pingBridge() {
			const frame = refs.frame;
			if (frame === undefined || state.frameLoaded !== true || frame.contentWindow === null) return;
			const origin = frameOrigin();
			if (origin === "") return;
			try {
				frame.contentWindow.postMessage({ type: "dcs-ping" }, origin);
			} catch {
				// 跨源时 postMessage 本身不会抛；这里只防 frame 已被移除
			}
		}

		/**
		 * 桥的回话。
		 *
		 * 桥会先报一次「我在，我的加载入口是这些」，收到工作流后再回一条
		 * ack（带成功/失败与画布节点数）。面板按 ack 下结论，绝不在发出
		 * 消息时就宣布成功——这正是之前「节点不显示却提示已送进」的来源。
		 */
		function onBridgeMessage(event) {
			const data = event?.data;
			if (data === null || typeof data !== "object") return;
			const frame = refs.frame;
			if (frame === undefined || frame === null) return;
			if (event.source !== null && event.source !== frame.contentWindow) return;
			if (data.type === "dcs-open-workflow-hello") {
				state.bridgeReady = true;
				// hello 到了说明界面真的活着：把兜底那层说明撤掉。
				if (refs.placeholder !== undefined) refs.placeholder.hidden = true;
				if (refs.frame !== undefined) refs.frame.hidden = false;
				state.bridgeInfo = {
					load: String(data.loadGraphData ?? "undefined"),
					wm: String(data.workflowManagerLoad ?? "undefined"),
					nodes: Number(data.nodes),
					keys: Array.isArray(data.keys) ? data.keys : [],
				};
				renderMeta();
				return;
			}
			if (data.type !== "dcs-open-workflow-ack") return;
			state.bridgeReady = true;
			const label = data.name ? `「${data.name}」` : "工作流";
			const nodes = Number(data.nodes);
			if (data.ok === true) {
				state.notice = Number.isFinite(nodes) && nodes > 0
					? `右侧已打开${label}，画布上有 ${nodes} 个节点。`
					: `右侧已打开${label}。`;
				state.noticeTone = "";
			} else {
				state.notice = `右侧没能打开${label}：${String(data.detail ?? "未知原因").slice(0, 160)}`;
				state.noticeTone = "error";
			}
			renderMeta();
		}

		/** 一键启动。 */
		async function doLaunch() {
			if (state.launchingUi === true) return;
			state.launchingUi = true;
			state.notice = "正在启动…";
			state.noticeTone = "";
			renderMeta();
			try {
				const payload = await api("/launch", { method: "POST", body: {} });
				if (payload?.ok !== true) {
					state.notice = payload?.error ?? "启动失败";
					state.noticeTone = "error";
					renderMeta();
					return;
				}
				state.status = { ...(state.status ?? {}), launching: true };
				renderMeta();
				// 整合包冷启动通常 60–180 秒，宿主侧给 6 分钟：这里也等满 6 分钟再放弃。
				for (let attempt = 0; attempt < 90; attempt += 1) {
					await new Promise((resolve) => { window.setTimeout(resolve, 4000); });
					if (state.open !== true) return;   // 用户已退回对话，不再空转
					await refreshStatus();
					if (state.status?.reachable === true) {
						state.notice = "已就绪";
						state.noticeTone = "";
						await refreshAll();
						return;
					}
					state.notice = `正在启动…（已等 ${(attempt + 1) * 4} 秒）`;
					renderMeta();
				}
				state.notice = "启动超时，去 ComfyUI 窗口看看日志";
				state.noticeTone = "warn";
			} catch (error) {
				state.notice = `启动失败：${String(error).slice(0, 60)}`;
				state.noticeTone = "error";
			} finally {
				state.launchingUi = false;
				renderMeta();
			}
		}

		/** 设置表单项（读、写、回填都用这一份）。 */
		const CONFIG_KEYS = ["comfyRoot", "host", "port", "launchMode", "extraArgs"];

		/** 设置对话框显隐与回填（每次打开都先从宿主读一次，避免拿空值覆盖）。 */
		async function toggleSettings(open) {
			if (refs.mask === undefined) return;
			if (open) {
				refs.mask.hidden = false;
				refs.settingsSave.disabled = true;   // 读到配置之前不许保存
				try {
					const payload = await api("/config");
					if (payload?.config !== undefined) state.config = payload.config;
					else if (payload?.ok === true && payload.host !== undefined) state.config = payload;
				} catch { /* 读不到就用内存里的值 */ }
				const config = state.config ?? {};
				for (const key of CONFIG_KEYS) {
					if (refs.inputs[key] !== undefined) refs.inputs[key].value = String(config[key] ?? "");
				}
				refs.settingsSave.disabled = false;
				return;
			}
			refs.mask.hidden = true;
		}

		/** 保存设置。 */
		async function saveSettings() {
			const patch = {};
			for (const key of CONFIG_KEYS) {
				patch[key] = String(refs.inputs[key]?.value ?? "").trim();
			}
			// host 为空会让 upstreamBase 变成 http://:8188，此后所有请求都 fetch failed。
			if (patch.host === "") {
				state.notice = "主机不能为空";
				state.noticeTone = "error";
				renderMeta();
				return;
			}
			const port = Number(patch.port);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				state.notice = "端口必须是 1–65535 的整数";
				state.noticeTone = "error";
				renderMeta();
				return;
			}
			patch.port = port;
			refs.settingsSave.disabled = true;
			try {
				const payload = await api("/config", { method: "POST", body: patch });
				if (payload?.ok !== true) {
					state.notice = payload?.error ?? "保存失败";
					state.noticeTone = "error";
					renderMeta();
					return;
				}
				state.config = payload.config ?? patch;
				await toggleSettings(false);
				state.notice = "设置已保存";
				state.noticeTone = "";
				await refreshAll();
			} catch (error) {
				state.notice = `保存失败：${String(error).slice(0, 60)}`;
				state.noticeTone = "error";
				renderMeta();
			} finally {
				refs.settingsSave.disabled = false;
			}
		}

		// ── 视图接管（中心列） ────────────────────────────────────────────────

		/** 找到中心列（对话区）。 */
		function conversationPane() {
			const pane = document.querySelector(CONVERSATION_SELECTOR);
			if (pane === null) return undefined;
			// 侧边栏里也有 data-pane，排除掉
			if (pane.matches(SIDEBAR_COLUMN_SELECTOR)) return undefined;
			return pane;
		}

		/** 把工作台挂到中心列旁边（第一次进入时建，之后复用）。 */
		function attachView() {
			if (refs.root === undefined) buildView();
			const pane = conversationPane();
			if (pane !== undefined) {
				// 插在对话列后面，作为它的兄弟
				if (refs.root.parentElement !== pane.parentElement || refs.root.previousElementSibling !== pane) {
					pane.parentElement?.insertBefore(refs.root, pane.nextSibling);
				}
				delete refs.root.dataset.fallback;
				return pane;
			}
			// 兜底：中心列找不到（shell 换了布局）就整页覆盖 —— 点 ComfyUI 必须有界面，
			// 不能像之前那样 tab 高亮着、屏幕上什么也不发生。
			refs.root.dataset.fallback = "";
			if (refs.root.parentElement !== document.body) document.body.append(refs.root);
			return undefined;
		}

		/** 面板开合：接管 / 让出中心列。 */
		function setOpen(open) {
			state.open = open;
			const pane = attachView();
			renderHint();
			if (pane !== undefined) {
				if (open) {
					// 记下原值再隐藏，退出时还原（不破坏 shell 自己的布局状态）
					if (refs.hiddenPane !== pane) {
						refs.hiddenPane = pane;
						refs.paneDisplay = pane.style.display;
					}
					pane.style.display = "none";
					refs.root.hidden = false;
				} else {
					if (refs.hiddenPane !== undefined && refs.hiddenPane.isConnected) {
						refs.hiddenPane.style.display = refs.paneDisplay ?? "";
					}
					refs.hiddenPane = undefined;
					refs.root.hidden = true;
				}
			} else {
				refs.root.hidden = open !== true;
			}
			if (open) pingBridge();
			// 面板由顶栏「面板」按钮手动开合：进工作台不自动展开，离开时收起。
			try {
				const store = fandcClient?.panelStore;
				if (store && !open) store.close();
			} catch (error) {
				console.warn("[comfyui-studio] fandc 面板联动失败：", error);
			}
			if (refs.comfyTab !== undefined) {
				if (open) refs.comfyTab.dataset.active = "";
				else delete refs.comfyTab.dataset.active;
			}
			if (refs.sessionTab !== undefined) {
				if (open) delete refs.sessionTab.dataset.active;
				else refs.sessionTab.dataset.active = "";
			}
			if (open) {
				void refreshAll();
				if (state.poll === null) {
					state.poll = window.setInterval(() => { void refreshStatus(); }, POLL_MS);
				}
			} else if (state.poll !== null) {
				window.clearInterval(state.poll);
				state.poll = null;
			}
		}

		// ── 侧边栏双段 tab ────────────────────────────────────────────────────

		/** 在 shell 的「新会话」按钮上方放「会话 | ComfyUI」分段 tab。 */
		function placeTabs(root) {
			const button = newSessionButton(root);
			if (button === undefined) return undefined;
			const existing = root.querySelector("[data-dcs-tabs]");
			if (existing !== null && existing.parentElement === button.parentElement) {
				refs.tabs = existing;
				refs.sessionTab = existing.querySelector('[data-dcs-tab="session"]') ?? undefined;
				refs.comfyTab = existing.querySelector('[data-dcs-tab="comfy"]') ?? undefined;
				return existing;
			}
			existing?.remove();
			const tabs = el("div", "dcs-tabs");
			tabs.dataset.dcsTabs = "";

			const sessionTab = el("button", "dcs-tab");
			sessionTab.type = "button";
			sessionTab.dataset.dcsTab = "session";
			sessionTab.dataset.active = "";
			sessionTab.textContent = "会话";
			sessionTab.setAttribute("aria-label", "会话");
			sessionTab.addEventListener("click", () => { setOpen(false); });

			const comfyTab = el("button", "dcs-tab");
			comfyTab.type = "button";
			comfyTab.dataset.dcsTab = "comfy";
			comfyTab.setAttribute("aria-label", "ComfyUI");
			comfyTab.setAttribute("title", "本地 ComfyUI（绘世整合包）");
			const label = el("span", undefined, "ComfyUI");
			comfyTab.append(label);
			comfyTab.addEventListener("click", () => { setOpen(true); });

			tabs.append(sessionTab, comfyTab);
			// shell 的「新会话」按钮保持原位：tab 只插在它前面。
			button.parentElement?.insertBefore(tabs, button);
			refs.tabs = tabs;
			refs.sessionTab = sessionTab;
			refs.comfyTab = comfyTab;
			if (state.open) comfyTab.dataset.active = "";
			else sessionTab.dataset.active = "";
			return tabs;
		}

		// ── 生命周期 ──────────────────────────────────────────────────────────

		/** 挂载 tab 与工作台，返回卸载器。 */
		function mount() {
			installStyle();

			// 桌面壳是 dsh-app:// 自定义协议，页面 CSP 可能根本不许嵌 8188。
			// 被拦时 Chrome 只留一个白板、连报错都不给 —— 这里把原因记下来：
			// 提示条 + /alive 上报，下次一眼就能分辨「白屏」到底是不是 CSP。
			const onCspViolation = (event) => {
				const directive = String(event.effectiveDirective ?? event.violatedDirective ?? "");
				report("csp", { directive, blocked: String(event.blockedURI ?? "").slice(0, 120) });
				if (directive.startsWith("frame-src") || directive.startsWith("child-src")) {
					state.cspBlocked = true;
					renderHint();
				}
			};
			document.addEventListener("securitypolicyviolation", onCspViolation);

			// 桥的回话（hello / ack）走 window 级 message，和 iframe 的源无关。
			window.addEventListener("message", onBridgeMessage);

			let root;
			let tabs;
			let lastPhase = "";
			let stopped = false;   // 彻底放弃或卸载后置真
			let timer = 0;         // 合并用的定时器
			let lastRun = 0;       // 上次真正执行的时间
			let giveUpTimer = 0;

			/**
			 * 找侧边栏根并插入 tab。
			 *
			 * 这里必须限频：DSH 是 React SPA，聊天区流式渲染时 DOM 每秒变动几十
			 * 上百次；`[class*="sidebarCol"]` 这类属性选择器要遍历整棵 DOM，每次
			 * 变动都跑一遍会把主线程堵死（实测会把整个 GUI 卡到打不开）。
			 * 因此这里最多每 250ms 跑一次，并且找到入口后立刻停止观察。
			 */
			const ensure = () => {
				if (stopped) return;
				const wait = THROTTLE_MS - (Date.now() - lastRun);
				if (wait > 0) {
					if (timer !== 0) return;
					timer = window.setTimeout(() => { timer = 0; ensure(); }, wait);
					return;
				}
				lastRun = Date.now();
				try {
					if (root !== undefined && !root.isConnected) {
						root = undefined;
						tabs = undefined;
					}
					if (root === undefined) root = sidebarRoot();
					if (root === undefined) {
						if (lastPhase !== "no-root") {
							lastPhase = "no-root";
							report("mount", { hasRoot: false });
						}
						return;
					}
					tabs = placeTabs(root);
					if (tabs !== undefined) {
						if (lastPhase !== "ok") {
							lastPhase = "ok";
							report("mount", { hasRoot: true, hasEntry: true });
						}
						stopObserving();
						void refreshStatus();
					} else if (lastPhase !== "has-root-no-button") {
						lastPhase = "has-root-no-button";
						report("mount", { hasRoot: true, hasEntry: false });
					}
				} catch (error) {
					// 任何 DOM 异常都不许往上抛，更不能影响宿主页面。
					console.warn("[comfyui-studio] 侧边栏探测异常：", error);
				}
			};

			const observer = new MutationObserver(ensure);

			/** 停止观察（找到 tab 后就不再需要盯着 DOM 了；停止不等于放弃）。 */
			const stopObserving = () => {
				observer.disconnect();
				if (giveUpTimer !== 0) {
					window.clearTimeout(giveUpTimer);
					giveUpTimer = 0;
				}
			};

			// 30 秒还找不到就放弃：页面早就渲染完了还找不到，说明选择器不对，
			// 继续监听只会白烧 CPU。
			giveUpTimer = window.setTimeout(() => {
				if (tabs !== undefined) return;
				report("warn", { reason: root === undefined ? "no-sidebar-root-30s" : "no-button-30s" });
				console.warn("[comfyui-studio] 30 秒内没找到侧边栏锚点，已停止监听（不影响界面）");
				stopped = true;
				stopObserving();
			}, GIVE_UP_MS);

			// DSH 是 React SPA，切换会话 / 新建会话时会把侧边栏整棵替换掉，
			// 我们的两格 tab 跟着一起消失。低频巡检把入口补回去 —— 否则用户要刷新
			// 页面才能再点到「ComfyUI」。2 秒一次，只读 isConnected，几乎不耗 CPU。
			const keepAlive = window.setInterval(() => {
				if (stopped) return;
				if (tabs !== undefined && tabs.isConnected) return;
				root = undefined;
				tabs = undefined;
				ensure();
			}, 2000);

			/**
			 * 点侧边栏里的会话行（或「新会话」）就退回对话视图。
			 *
			 * 只有「点会话 / 新会话 / 项目」才算要回对话：点搜索框、设置、折叠按钮
			 * 都不该把工作台关掉 —— 之前侧边栏里任何点击都退，「碰一下 tab 就没了」
			 * 就是这么来的。捕获阶段监听，免得 shell 自己的处理器先把事件吃掉。
			 */
			const onDocumentClick = (event) => {
				if (state.open !== true) return;
				const target = event.target;
				if (!(target instanceof Element)) return;
				if (target.closest("[data-dcs-tabs]") !== null) return;        // 我们自己的 tab
				if (target.closest("[data-dcs-root]") !== null) return;        // 工作台内部
				if (target.closest(SIDEBAR_COLUMN_SELECTOR) === null) return;  // 只在侧边栏里生效
				// 侧边栏里除我们自己的 tab 之外的任何点击都算「回对话」（会话行、工作区、搜索…）。
				setOpen(false);
			};
			document.addEventListener("click", onDocumentClick, true);

			observer.observe(document.body, { childList: true, subtree: true });
			ensure();

			return () => {
				stopped = true;
				observer.disconnect();
				window.clearInterval(keepAlive);
				document.removeEventListener("securitypolicyviolation", onCspViolation);
				window.removeEventListener("message", onBridgeMessage);
				document.removeEventListener("click", onDocumentClick, true);
				if (giveUpTimer !== 0) window.clearTimeout(giveUpTimer);
				if (state.poll !== null) window.clearInterval(state.poll);
				if (refs.hiddenPane !== undefined && refs.hiddenPane.isConnected) {
					refs.hiddenPane.style.display = refs.paneDisplay ?? "";
				}
				tabs?.remove();
				refs.root?.remove();
				document.getElementById(STYLE_ID)?.remove();
			};
		}

		/** Cordis Loader 入口。 */
		function apply(ctx) {
			try {
				report("apply", { ctxKeys: Object.keys(ctx ?? {}).join(",") });
				if (ctx !== undefined && typeof ctx.effect === "function") {
					ctx.effect(() => mount(), "dsh-comfyui-studio: 侧边栏 tab 与工作台");
					return;
				}
				mount();
			} catch (error) {
				// 插件绝不能把 GUI 的 boot 拖下水。
				console.warn("[comfyui-studio] apply 失败：", error);
			}
		}


		// ── fandc520/dsh-comfyui 并入的客户端（原样内联，勿手改）──────────────
		// 面板 / 设置页 / 工具卡 / i18n / lightbox 全部来自这套代码；这里把它的
		// factory 体当普通函数跑一遍，拿到 { apply, inject } 与 studio 的合并。
		const loadFandcClient = (require) => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/i18n.ts
		/** zh/en dictionaries for dsh-comfyui UI (settings page, tool card, panel). */
		const zh = {
			settingsTitle: "ComfyUI",
			settingsDesc: "连接你的 ComfyUI 服务器，让 Agent 直接生成与处理图像、视频。",
			baseUrl: "服务器地址",
			baseUrlHint: "ComfyUI 的 HTTP 地址（默认 http://127.0.0.1:8188）。",
			apiKeyEnv: "API Key 环境变量名",
			apiKeyEnvHint: "密钥名：环境变量或凭据存储（默认 COMFYUI_API_KEY）。",
			hasApiKey: "已配置 API Key",
			noApiKey: "未配置 API Key（本地服务通常不需要）",
			save: "保存",
			saved: "已保存",
			saveFailed: "保存失败",
			test: "测试连接",
			testing: "正在测试…",
			testOk: "连接成功 · ComfyUI {version} · {ms} ms",
			testFail: "连接失败：{message}",
			configNotWritable: "设置服务不可用，请通过 cordis.yml 修改配置。",
			mediaHost: "媒体访问地址",
			mediaHostHint: "媒体在聊天中显示的完整地址（如 http://192.168.1.5:3080）。留空自动检测；图片不显示时填你访问本页的地址。",
			comfyuiDirs: "ComfyUI 目录",
			comfyuiDirsHint: "本机 ComfyUI 安装目录（可多个，支持映射/多实例/便携版）。Agent 据此定位 models、工作流、音色库等文件。",
			comfyuiDirAdd: "＋ 添加目录",
			comfyuiDirRemove: "移除该目录",
			comfyuiDirPlaceholder: "如 D:\\ComfyUI",
			skillsDir: "技能包目录",
			skillsDirHint: "工作流技能包（SKILL.md 与参考文档）目录。留空 = 数据目录下 skills/；填绝对路径可放到别的盘或同步盘。改后需手动搬移已有目录。当前实际使用：{current}",
			language: "界面语言",
			languageHint: "界面语言，切换后页面自动刷新。",
			cardGenerating: "ComfyUI 生成中…",
			cardBackground: "后台任务",
			cardBackgroundDone: "已完成",
			cardPrompt: "任务 ID",
			cardElapsed: "耗时",
			cardMedia: "结果",
			cardEmpty: "无媒体输出",
			cardFailed: "执行失败",
			cardInterrupted: "已中断",
			cardCollect: "使用 job_output 收集后台任务结果",
			cardRecovered: "已从资产索引恢复（ComfyUI 历史已失效）",
			cardPollStalled: "后台任务状态收集失败（已重试 {n} 次）：{message}",
			cardLoadFailed: "加载失败，点下方下载",
			cardDownload: "下载",
			cardWorkflow: "工作流",
			cardMode: "模式",
			cardListed: "已列出 {runs} 个运行工作流，{graphs} 个图工作流",
			cardHandWritten: "手写工作流",
			cardWaiting: "等待 ComfyUI…",
			cardQueued: "排队中（前面还有 {n} 个）",
			cardStep: "步数 {value}/{max}",
			cardInReply: "结果图见对话回复，文件：",
			panelTitle: "面板",
			panelReset: "复位位置与大小",
			close: "关闭",
			lbPrev: "上一张",
			lbNext: "下一张",
			tabWorkflows: "工作流",
			tabAssets: "资产",
			tabQueue: "队列",
			error: "出错",
			refresh: "刷新",
			ours: "本插件",
			connChecking: "正在检测 ComfyUI 连接…",
			connOk: "连接正常 · ComfyUI {version} · {ms} ms",
			connFailTitle: "无法连接 ComfyUI",
			connFailBody: "后端未能连上 ComfyUI（{message}）。请先启动本机 ComfyUI，确保后端能检测到其端口；若使用远程服务器，请到设置页检查服务器地址并点「测试连接」。",
			wfAdd: "新建工作流",
			wfName: "名称",
			wfDesc: "概述",
			wfDescPlaceholder: "告诉 Agent 这个工作流做什么",
			wfNameCopyHint: "点击复制工作流名称",
			wfNameCopied: "已复制工作流名称",
			wfParams: "可调参数",
			wfTags: "标签",
			wfTagAll: "全部",
			wfTagAdd: "自定义标签，回车添加",
			wfTagRemove: "点击移除标签",
			wfParamsEmpty: "未定义参数。点击\"识别参数\"自动提取提示词/分辨率/步数/种子，或\"高级参数\"手动指定任意节点输入。",
			wfParamsDrop: "拖拽/点击/粘贴上传",
			wfPasteHint: "悬停此处后按 Ctrl+V 粘贴剪贴板里的图片/文件",
			wfUploadSection: "加载区",
			wfUploadHint: "点击大图选择图像，或粘贴/上传新图像；选中后图生图默认使用该图像",
			wfUploadZone: "拖拽 / 点击 / 粘贴上传到 ComfyUI input 目录",
			wfUploaded: "已上传",
			wfCopyName: "复制文件名",
			wfLoadArea: "加载区",
			wfLoadHint: "点击放入素材（加载区的素材按顺序填入工作流未指定的加载参数）",
			wfLoadEmpty: "加载区为空，点击下方“添加加载区”放入素材",
			wfLoadPicked: "已加载",
			wfLoadAddSlot: "＋ 添加加载区",
			wfLoadAddMedia: "添加素材",
			wfLoadRemoveSlot: "删除加载区",
			wfLoadNone: "空",
			wfLoadNoneHint: "清空该加载位（保留加载位，不放素材）",
			wfLoadSlotLabel: "加载位",
			wfLoadSummary: "加载位 {slots} 个 · 已放入 {loaded} 个素材，未指定的加载参数按顺序取用",
			wfTabAll: "全部",
			wfTabImported: "已导入",
			wfTabGenerated: "已生成",
			wfTypeAll: "全部类型",
			wfUploadedToast: "文件已上传",
			wfPickerUpload: "粘贴 / 点击上传",
			wfLoadNoFiles: "没有可用的图像",
			wfParamsUploading: "上传中…",
			uploadKind_image: "图片",
			uploadKind_video: "视频",
			uploadKind_audio: "音频",
			wfMediaClear: "清空",
			wfMediaEmpty: "文件名（留空=移除该参考位）",
			wfRefSlot: "参考",
			wfParamsRecognize: "识别参数",
			wfParamsRecognizing: "识别中…",
			wfParamsRecognizeFailed: "识别失败：无法连接 ComfyUI 或工作流无效",
			wfParamsAdd: "高级参数",
			wfParamAdd: "添加",
			wfParamLabel: "名称",
			wfParamCustomLabel: "自定义名称",
			wfParamCustomHint: "仅用于展示与 Agent 描述，传参键由系统自动生成；留空使用默认",
			wfParamDefault: "默认值",
			wfParamRandom: "随机",
			wfParamDelete: "删除",
			wfParamNode: "节点",
			wfParamInput: "输入",
			wfJson: "工作流 JSON（ComfyUI UI 导出的 API 格式）",
			wfSave: "保存",
			wfSaveRun: "保存并运行",
			wfCancel: "取消",
			wfEdit: "编辑",
			wfRun: "运行",
			wfDelete: "删除",
			wfQueued: "已入队：",
			wfJsonError: "工作流 JSON 解析失败",
			wfUpdated: "更新于",
			wfEmpty: "没有检测到任何工作流，请通过新建、导入或提取来创建执行流程。",
			wfLibrarySection: "API 工作流",
			wfRefresh: "刷新",
			wfImportFile: "导入 JSON",
			exportPresets: "导出预设",
			importPresets: "导入预设",
			transferExportTitle: "导出工作流预设",
			transferImportTitle: "导入工作流预设",
			transferExportHint: "共 {total} 个可导出工作流，已选 {selected} 个。运行参数与技能包会一并导出。",
			transferSelectAll: "全选",
			transferSelectNone: "全不选",
			transferExportRun: "导出 ({n})",
			transferImportRun: "导入 ({n})",
			transferExporting: "正在导出…",
			transferImporting: "正在导入…",
			transferExportDone: "已导出 {n} 个工作流：{names}（浏览器正在下载预设包）",
			transferExportFile: "文件 {file}（{size} KB）",
			transferExportWarnings: "导出警告：{warnings}",
			transferSelectedList: "将导出：{names}",
			transferExportEmpty: "没有可导出的工作流",
			transferPickFile: "点击选择或拖入 .zip 预设包",
			transferPickHint: "导入会创建为新工作流，不会覆盖库中已有的工作流",
			transferPackageInfo: "包内共 {n} 个工作流 · 导出于 {date}",
			transferParamBadge: "参数 {n}",
			transferSkillBadge: "技能包 · {n} 个文件",
			transferSkillRequired: "技能包 · {n} 个文件 · 必读",
			transferImportDone: "已导入 {n} 个工作流",
			transferImportedItem: "✓ {src} → {dst}",
			transferImportFailedItem: "✗ {src}：{reason}",
			transferImportNote: "重名工作流自动追加（导入）后缀",
			transferFinish: "完成",
			wfComfyuiSection: "ComfyUI 工作流",
			wfComfyuiHint: "面板自动检测 ComfyUI 中保存的工作流。\n注：非 API 流程，无法直接执行，需经过提取转化为 API 工作流，或自行导入 API 工作流即可执行。",
			wfComfyuiEmpty: "ComfyUI 端没有检测到保存的工作流",
			wfExtracted: "已提取",
			wfNotExtracted: "未提取",
			wfView: "查看",
			wfExtract: "提取",
			wfExtractedNotice: "已提取并加入插件库",
			wfExtractTitle: "提取执行流",
			wfExtractModeAll: "整体提取",
			wfExtractModeAllHint: "所有分量合成一个执行流（运行时全部执行）",
			wfExtractModeSplit: "按分量提取",
			wfExtractModeSplitHint: "每个独立流程一个执行流（推荐）",
			wfExtractModeMain: "只提取主流程",
			wfExtractModeMainHint: "只提取最大分量（通常是当前测试区块）",
			wfExtractRun: "提取",
			wfExtractEmpty: "图里没有可提取的分量",
			wfComponents: "分量",
			wfComponentLabel: "分量",
			wfNodes: "节点",
			wfBypassed: "已绕过节点",
			wfIsolated: "悬空节点",
			wfViewBack: "返回",
			wfViewNodes: "节点清单",
			wfViewJson: "JSON 预览",
			wfViewEmpty: "图中没有可执行的节点",
			assetAll: "全部工作流",
			assetBack: "返回",
			assetEmpty: "还没有生成记录。运行工作流后，结果会出现在这里。",
			assetGone: "源文件已被 ComfyUI 清理",
			assetDelete: "删除资产",
			assetDeleteTitle: "删除该资产？",
			assetDeleteBody: "将从资产库移除这条记录，并删除 ComfyUI 输出目录里的 {count} 个文件。此操作不可恢复。",
			assetDeleteNoDir: "未能定位 ComfyUI 输出目录，只会移除资产记录，磁盘文件保留（可在 cordis.yml 的 outputDir 里指定输出目录）。",
			assetDeleteDone: "已删除记录，磁盘文件删除 {deleted} 个",
			assetDeleteFailed: "删除失败：{message}",
			confirmDelete: "确定删除",
			cancel: "取消",
			skillButton: "技能包",
			skillBadge: "技能包",
			skillBadgeRequired: "技能包·必读",
			skillBadgeHint: "该工作流挂了技能包：Agent 运行前会读它。",
			skillTitle: "技能包",
			skillIntro: "点击「启用技能包」后，可为这个工作流添加给 Agent 看的额外 skills 说明：什么时候用、参数怎么填、有哪些坑。",
			skillEnable: "启用技能包",
			skillDetach: "停用（保留文件）",
			skillDestroy: "销毁技能包",
			skillDestroyConfirm: "⚠ 永久删除整个技能包（{count} 个文件），不可恢复",
			skillDestroyConfirmButton: "确认销毁",
			skillDropHint: "可把文件拖到这里导入",
			skillRequired: "运行前必读",
			skillDir: "目录",
			skillSummary: "摘要",
			skillSummaryPlaceholder: "一句话说明这个工作流适合做什么",
			skillSummaryHint: "Agent 靠它决定要不要读正文，等同 skills 里的 description 字段。",
			skillSave: "保存",
			skillSaved: "已保存",
			skillDirty: "未保存",
			skillDirtyPrompt: "当前文件有未保存的修改。",
			skillSaveAndSwitch: "保存并切换",
			skillDiscard: "丢弃修改",
			skillImport: "↑ 导入文件",
			skillImportHint: "导入本地文件到技能包：md/txt/json/yaml 进 references，脚本进 scripts，图片/csv 进 assets（也可直接拖进左栏）。",
			skillImported: "已导入",
			skillImageHint: "图片只能预览，不能在此编辑；Agent 会在正文点名它时才去读取。",
			skillNewFile: "＋ 新建文件",
			skillNewDir: "＋ 新建目录",
			skillReveal: "📂 打开目录",
			skillRevealHint: "在文件管理器中打开这个技能包的文件夹，方便直接拷贝文件进去。打开的是运行 DSH 那台机器上的目录；若你正从另一台机器访问本页面，请按下方显示的路径自行前往。",
			skillRevealed: "已打开",
			skillRefresh: "刷新",
			skillRefreshHint: "重新读取技能包目录，显示 Agent 写入或文件管理器里新增/替换的文件。",
			skillRefreshed: "已刷新",
			skillNewDirPlaceholder: "目录名，如 templates",
			skillNewDirHint: "技能包可以有任意一层子目录。常用：{presets}；也可以自己起名（字母/数字/汉字/下划线/连字符）。",
			skillDirCreated: "已创建目录",
			skillNewPlaceholder: "文件名（默认 .md）",
			skillCreate: "创建",
			skillRename: "重命名",
			skillDeleteFile: "删除文件",
			skillDeleteConfirm: "删除文件",
			skillReadFailed: "读取失败",
			skillFailed: "操作失败",
			skillDeleteWithWorkflow: "该工作流有技能包，要一起删除吗？",
			skillDeleteBoth: "一起删除",
			skillKeepPack: "只删工作流",
			queueEmpty: "当前没有任务",
			queueError: "无法读取队列（ComfyUI 未运行？）",
			jobFilterLabel: "历史",
			jobFilterAll: "全部",
			jobFilterPending: "待生成",
			jobFilterInProgress: "生成中",
			jobFilterCompleted: "已完成",
			jobFilterFailed: "失败",
			jobFilterCancelled: "已取消",
			jobActive: "进行中",
			jobDelete: "删除",
			jobInterrupt: "中断",
			jobRerun: "重跑",
			jobViewAssets: "查看资产",
			jobMore: "更多操作",
			jobClearQueue: "清空队列",
			jobClearHistory: "清空历史",
			jobFree: "释放内存",
			jobDuration: "耗时",
			jobOurs: "本插件"
		};
		const en = {
			settingsTitle: "ComfyUI",
			settingsDesc: "Connect your ComfyUI server so the agent can generate and process images and videos directly.",
			baseUrl: "Server URL",
			baseUrlHint: "ComfyUI HTTP address (default http://127.0.0.1:8188).",
			apiKeyEnv: "API key env var",
			apiKeyEnvHint: "Name of the key: env var or credential store (default COMFYUI_API_KEY).",
			hasApiKey: "API key configured",
			noApiKey: "No API key configured (usually not needed for local servers)",
			save: "Save",
			saved: "Saved",
			saveFailed: "Save failed",
			test: "Test connection",
			testing: "Testing…",
			testOk: "Connected · ComfyUI {version} · {ms} ms",
			testFail: "Connection failed: {message}",
			configNotWritable: "Settings service unavailable — edit cordis.yml instead.",
			mediaHost: "Media base URL",
			mediaHostHint: "Base URL for media shown in chat (e.g. http://192.168.1.5:3080). Auto-detected when empty; set it if images do not load over LAN or a reverse proxy.",
			comfyuiDirs: "ComfyUI directories",
			comfyuiDirsHint: "ComfyUI install roots on this machine (multiple allowed: mapped/multiple/portable installs). The agent uses them to locate models, workflows and voice libraries.",
			comfyuiDirAdd: "+ Add directory",
			comfyuiDirRemove: "Remove this directory",
			comfyuiDirPlaceholder: "e.g. D:\\ComfyUI",
			skillsDir: "Skill pack directory",
			skillsDirHint: "Directory for workflow skill packs (SKILL.md + reference files). Empty = skills/ under the plugin data dir; an absolute path may target another drive or a synced folder. Existing packs are not moved automatically. Currently in use: {current}",
			language: "Language",
			languageHint: "UI language; the page reloads after switching.",
			cardGenerating: "ComfyUI generating…",
			cardBackground: "Background job",
			cardBackgroundDone: "Completed",
			cardPrompt: "Prompt ID",
			cardElapsed: "Elapsed",
			cardMedia: "Results",
			cardEmpty: "No media outputs",
			cardFailed: "Execution failed",
			cardInterrupted: "Interrupted",
			cardCollect: "Collect the background job result with job_output",
			cardRecovered: "Recovered from the asset index (ComfyUI history was evicted)",
			cardPollStalled: "Failed to collect the background job status after {n} retries: {message}",
			cardLoadFailed: "failed to load, use the download link below",
			cardDownload: "Download",
			cardWorkflow: "Workflow",
			cardMode: "Mode",
			cardListed: "Listed {runs} runnable workflows, {graphs} graph workflows",
			cardHandWritten: "Hand-written workflow",
			cardWaiting: "Waiting for ComfyUI…",
			cardQueued: "Queued ({n} ahead)",
			cardStep: "Step {value}/{max}",
			cardInReply: "Results are shown in the reply. Files:",
			panelTitle: "Panel",
			panelReset: "Reset position & size",
			close: "Close",
			lbPrev: "Previous image",
			lbNext: "Next image",
			tabWorkflows: "Workflows",
			tabAssets: "Assets",
			tabQueue: "Queue",
			error: "Error",
			refresh: "Refresh",
			ours: "ours",
			connChecking: "Checking the ComfyUI connection…",
			connOk: "Connected · ComfyUI {version} · {ms} ms",
			connFailTitle: "Cannot reach ComfyUI",
			connFailBody: "The backend could not reach ComfyUI ({message}). Start the local ComfyUI and make sure the backend can see its port; for a remote server, check the URL in settings and run \"Test connection\".",
			wfAdd: "New workflow",
			wfName: "Name",
			wfDesc: "Overview",
			wfDescPlaceholder: "Tells the agent what this workflow does",
			wfNameCopyHint: "Click to copy the workflow name",
			wfNameCopied: "Workflow name copied",
			wfParams: "Parameters",
			wfTags: "Tags",
			wfTagAll: "All",
			wfTagAdd: "Custom tag, press Enter to add",
			wfTagRemove: "Click to remove tag",
			wfParamsEmpty: "No parameters yet. Click \"Detect\" to auto-extract prompt / resolution / steps / seed, or \"Advanced\" to expose any node input manually.",
			wfParamsDrop: "Drop / Click / Paste to upload",
			wfPasteHint: "Hover here and press Ctrl+V to paste an image/file",
			wfUploadSection: "Load area",
			wfUploadHint: "Click the preview to pick an image, or paste/upload a new one; the selection becomes the default source for image-to-image",
			wfUploadZone: "Drag / Click / Paste to upload into the ComfyUI input dir",
			wfUploaded: "Uploaded",
			wfCopyName: "Copy file name",
			wfLoadArea: "Load area",
			wfLoadHint: "Click to put media in this slot (slots fill the workflow unset loader parameters in order)",
			wfLoadEmpty: "Load area is empty — use \"Add slot\" below to put media in it",
			wfLoadPicked: "Loaded",
			wfLoadAddSlot: "+ Add slot",
			wfLoadAddMedia: "Add media",
			wfLoadRemoveSlot: "Delete slot",
			wfLoadNone: "None",
			wfLoadNoneHint: "Empty this slot (the slot stays, with no media)",
			wfLoadSlotLabel: "Slot",
			wfLoadSummary: "{slots} slot(s) · {loaded} loaded; unset loader parameters take them in order",
			wfTabAll: "All",
			wfTabImported: "Imported",
			wfTabGenerated: "Generated",
			wfTypeAll: "All types",
			wfUploadedToast: "File uploaded",
			wfPickerUpload: "Paste / Click to upload",
			wfLoadNoFiles: "No images available",
			wfParamsUploading: "Uploading…",
			uploadKind_image: "image",
			uploadKind_video: "video",
			uploadKind_audio: "audio",
			wfMediaClear: "Clear",
			wfMediaEmpty: "filename (empty = drop this slot)",
			wfRefSlot: "Ref ",
			wfParamsRecognize: "Detect",
			wfParamsRecognizing: "Detecting…",
			wfParamsRecognizeFailed: "Detection failed: ComfyUI unreachable or invalid workflow",
			wfParamsAdd: "Advanced",
			wfParamAdd: "Add",
			wfParamLabel: "Name",
			wfParamCustomLabel: "Custom name",
			wfParamCustomHint: "Shown to the user and the agent only; the parameter key is generated automatically. Leave empty for the default",
			wfParamDefault: "Default",
			wfParamRandom: "Random",
			wfParamDelete: "Delete",
			wfParamNode: "Node",
			wfParamInput: "Input",
			wfJson: "Workflow JSON (API format exported from the ComfyUI UI)",
			wfSave: "Save",
			wfSaveRun: "Save & Run",
			wfCancel: "Cancel",
			wfEdit: "Edit",
			wfRun: "Run",
			wfDelete: "Delete",
			wfQueued: "Queued: ",
			wfJsonError: "Workflow JSON could not be parsed",
			wfUpdated: "updated",
			wfEmpty: "No workflows detected — create one via New, Import, or Extract.",
			wfLibrarySection: "API workflows",
			wfRefresh: "Refresh",
			wfImportFile: "Import JSON",
			exportPresets: "Export presets",
			importPresets: "Import presets",
			transferExportTitle: "Export workflow presets",
			transferImportTitle: "Import workflow presets",
			transferExportHint: "{total} exportable workflows, {selected} selected. Parameters and skill packs are included.",
			transferSelectAll: "Select all",
			transferSelectNone: "Select none",
			transferExportRun: "Export ({n})",
			transferImportRun: "Import ({n})",
			transferExporting: "Exporting…",
			transferImporting: "Importing…",
			transferExportDone: "Exported {n} workflows: {names} (the browser is downloading the package)",
			transferExportFile: "File {file} ({size} KB)",
			transferExportWarnings: "Export warnings: {warnings}",
			transferSelectedList: "Will export: {names}",
			transferExportEmpty: "No exportable workflows",
			transferPickFile: "Click to choose, or drop a .zip preset package here",
			transferPickHint: "Import creates new workflows — nothing in your library is overwritten",
			transferPackageInfo: "{n} workflows in package · exported {date}",
			transferParamBadge: "{n} params",
			transferSkillBadge: "Skill pack · {n} files",
			transferSkillRequired: "Skill pack · {n} files · required",
			transferImportDone: "Imported {n} workflows",
			transferImportedItem: "✓ {src} → {dst}",
			transferImportFailedItem: "✗ {src}: {reason}",
			transferImportNote: "Name clashes get an \"(imported)\" suffix",
			transferFinish: "Done",
			wfComfyuiSection: "ComfyUI workflows",
			wfComfyuiHint: "Auto-detects workflows saved in ComfyUI.\nNote: these are UI graphs, not directly runnable — extract them into API workflows, or import an API workflow instead.",
			wfComfyuiEmpty: "No workflows detected on the ComfyUI server",
			wfExtracted: "extracted",
			wfNotExtracted: "not extracted",
			wfView: "View",
			wfExtract: "Extract",
			wfExtractedNotice: "extracted into the library",
			wfExtractTitle: "Extract runnable workflows",
			wfExtractModeAll: "All as one",
			wfExtractModeAllHint: "Merge every component into one runnable workflow (everything executes)",
			wfExtractModeSplit: "Per component",
			wfExtractModeSplitHint: "One runnable workflow per independent flow (recommended)",
			wfExtractModeMain: "Main flow only",
			wfExtractModeMainHint: "Only the largest component (usually the flow under test)",
			wfExtractRun: "Extract",
			wfExtractEmpty: "No extractable components in this graph",
			wfComponents: "components",
			wfComponentLabel: "Component",
			wfNodes: "nodes",
			wfBypassed: "bypassed nodes",
			wfIsolated: "dangling nodes",
			wfViewBack: "Back",
			wfViewNodes: "Nodes",
			wfViewJson: "JSON preview",
			wfViewEmpty: "No executable nodes in this graph",
			assetAll: "All workflows",
			assetBack: "Back",
			assetEmpty: "Nothing generated yet. Results appear here after workflows run.",
			assetGone: "Source file evicted by ComfyUI",
			assetDelete: "Delete asset",
			assetDeleteTitle: "Delete this asset?",
			assetDeleteBody: "Removes the record from the asset library and deletes {count} file(s) from the ComfyUI output directory. This cannot be undone.",
			assetDeleteNoDir: "The ComfyUI output directory could not be located, so only the record is removed and the files stay on disk (set outputDir in cordis.yml to enable file deletion).",
			assetDeleteDone: "Record removed, {deleted} file(s) deleted",
			assetDeleteFailed: "Delete failed: {message}",
			confirmDelete: "Delete",
			cancel: "Cancel",
			skillButton: "Skill pack",
			skillBadge: "Skill pack",
			skillBadgeRequired: "Skill pack (required)",
			skillBadgeHint: "This workflow has a skill pack: the agent reads it before running.",
			skillTitle: "Skill pack",
			skillIntro: "Click \"Create skill pack\" to add extra skill instructions for this workflow: when to use it, how to fill its parameters, and which pitfalls to avoid.",
			skillEnable: "Create skill pack",
			skillDetach: "Detach (keep files)",
			skillDestroy: "Destroy pack",
			skillDestroyConfirm: "⚠ Permanently delete the whole pack ({count} files) — cannot be undone",
			skillDestroyConfirmButton: "Destroy",
			skillDropHint: "Drop files here to import",
			skillRequired: "Required before running",
			skillDir: "Directory",
			skillSummary: "Summary",
			skillSummaryPlaceholder: "One line on what this workflow is for",
			skillSummaryHint: "The agent uses it to decide whether to read the body — like the description field of a skill.",
			skillSave: "Save",
			skillSaved: "Saved",
			skillDirty: "Unsaved",
			skillDirtyPrompt: "The current file has unsaved changes.",
			skillSaveAndSwitch: "Save and switch",
			skillDiscard: "Discard changes",
			skillImport: "Import files",
			skillImportHint: "Import local files into the pack: md/txt/json/yaml go to references, scripts to scripts, images/csv to assets (drag onto the list works too).",
			skillImported: "Imported",
			skillImageHint: "Images are preview-only here; the agent reads one only when the body points at it.",
			skillNewFile: "+ New file",
			skillNewDir: "+ New folder",
			skillReveal: "📂 Open folder",
			skillRevealHint: "Open this pack folder in the file manager so you can copy files straight in. It opens on the machine running DSH; if you are viewing this page from another machine, use the path shown below instead.",
			skillRevealed: "Opened",
			skillRefresh: "Refresh",
			skillRefreshHint: "Re-read the pack directory to show files added or replaced by the agent or the file manager.",
			skillRefreshed: "Refreshed",
			skillNewDirPlaceholder: "Folder name, e.g. templates",
			skillNewDirHint: "A pack may hold any one-level sub-directory. Common ones: {presets}; custom names work too (letters, digits, CJK, underscore, dash).",
			skillDirCreated: "Folder created",
			skillNewPlaceholder: "File name (.md by default)",
			skillCreate: "Create",
			skillRename: "Rename",
			skillDeleteFile: "Delete file",
			skillDeleteConfirm: "Delete file",
			skillReadFailed: "Read failed",
			skillFailed: "Operation failed",
			skillDeleteWithWorkflow: "This workflow has a skill pack. Delete it too?",
			skillDeleteBoth: "Delete both",
			skillKeepPack: "Workflow only",
			queueEmpty: "No tasks right now",
			queueError: "Cannot read the queue (ComfyUI not running?)",
			jobFilterLabel: "History",
			jobFilterAll: "All",
			jobFilterPending: "Pending",
			jobFilterInProgress: "Running",
			jobFilterCompleted: "Completed",
			jobFilterFailed: "Failed",
			jobFilterCancelled: "Cancelled",
			jobActive: "Active",
			jobDelete: "Delete",
			jobInterrupt: "Interrupt",
			jobRerun: "Rerun",
			jobViewAssets: "View assets",
			jobMore: "More actions",
			jobClearQueue: "Clear queue",
			jobClearHistory: "Clear history",
			jobFree: "Free memory",
			jobDuration: "Took",
			jobOurs: "ours"
		};
		const LANG_KEY = "dsh-comfyui.lang";
		/** Current plugin UI language, read from localStorage (default zh). */
		function getLang() {
			try {
				return localStorage.getItem(LANG_KEY) === "en" ? "en" : "zh";
			} catch {
				return "zh";
			}
		}
		/** Persist the plugin UI language choice. */
		function setLang(lang) {
			try {
				localStorage.setItem(LANG_KEY, lang);
			} catch {}
		}
		const DICTS = {
			zh,
			en
		};
		/** Build a plugin-local translator for one language. Resolves {name}
		* placeholders from the first rest argument (same contract as the DSH
		* locale bind), falling back to the key itself when untranslated. */
		function makeT(lang) {
			const dict = DICTS[lang];
			return (key, ...rest) => {
				const template = dict[key] ?? key;
				const params = rest[0] ?? {};
				if (params !== null && typeof params === "object") return template.replace(/\{(\w+)\}/g, (match, name) => {
					const value = params[name];
					return value === void 0 ? match : String(value);
				});
				return template;
			};
		}
		//#endregion
		//#region src/client/card.tsx
		/**
		* Tool cards for comfyui_run and comfyui_workflow (tool.call.toolview, keys
		* 'comfyui_run' / 'comfyui_workflow'). Running calls show the workflow name
		* and live progress (polled from /comfyui/queue); settled calls show status
		* and the output files as links. The media itself is NOT rendered here: the
		* model pastes it into its reply (see CLAUDE.md contract 18) — dsh 0.2
		* collapses finished tool rows and PTC mode shows no card at all, so an image
		* wall here was either invisible or a duplicate of the reply.
		*/
		/** Discriminate the settled result node from a running call. */
		function isResultNode(block) {
			return block.kind === "tool-result";
		}
		function parseArgs(raw) {
			try {
				const parsed = JSON.parse(raw);
				return typeof parsed === "object" && parsed !== null ? parsed : {};
			} catch {
				return {};
			}
		}
		/** The output files as links (the images themselves are in the model's reply). */
		function MediaLinks({ media, t }) {
			if (media.length === 0) return (0, react.createElement)("div", { className: "dsc-meta" }, t("cardEmpty"));
			return (0, react.createElement)("div", { className: "dsc-files" }, (0, react.createElement)("span", { className: "dsc-meta" }, t("cardInReply")), media.map((item) => (0, react.createElement)("a", {
				key: `${item.node}-${item.index}-${item.filename}`,
				className: "dsc-file",
				href: item.url,
				target: "_blank",
				rel: "noreferrer",
				title: item.filename
			}, item.filename)));
		}
		/**
		* Poll /comfyui/queue (every 2 s while `active`) for one prompt's queue
		* position and sampler progress. A running sync call does not know its
		* prompt id yet, so without one this follows the first prompt of ours that
		* is running (else pending) — sync calls block, so that is the call's own.
		*/
		function useQueueState(promptId, active) {
			const [state, setState] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (!active) return void 0;
				let stopped = false;
				let timer;
				const poll = async () => {
					try {
						const data = await (await fetch("/comfyui/queue", { headers: { accept: "application/json" } })).json();
						if (stopped) return;
						const running = data.running ?? [];
						const pending = data.pending ?? [];
						const match = (entry) => promptId !== void 0 ? entry.promptId === promptId : entry.ours;
						const run = running.find(match);
						const waitIndex = pending.findIndex(match);
						if (run !== void 0) setState({
							phase: "running",
							value: run.progress?.value ?? 0,
							max: run.progress?.max ?? 0
						});
						else if (waitIndex >= 0) setState({
							phase: "pending",
							ahead: running.length + waitIndex
						});
						else setState(null);
					} catch {}
					if (!stopped) timer = window.setTimeout(() => {
						poll();
					}, 2e3);
				};
				poll();
				return () => {
					stopped = true;
					if (timer !== void 0) window.clearTimeout(timer);
				};
			}, [promptId, active]);
			return state;
		}
		function ProgressLine({ state, t }) {
			if (state === null) return (0, react.createElement)("div", { className: "dsc-meta" }, t("cardWaiting"));
			if (state.phase === "pending") return (0, react.createElement)("div", { className: "dsc-meta" }, t("cardQueued", { n: state.ahead }));
			const percent = state.max > 0 ? Math.min(100, Math.round(state.value / state.max * 100)) : 0;
			return (0, react.createElement)("div", { className: "dsc-progress" }, (0, react.createElement)("div", { className: "dsc-progress-track" }, (0, react.createElement)("div", {
				className: "dsc-progress-fill",
				style: { width: `${percent}%` }
			})), (0, react.createElement)("span", { className: "dsc-meta" }, state.max > 0 ? t("cardStep", {
				value: state.value,
				max: state.max
			}) : t("cardWaiting")));
		}
		/** A saved workflow's name by id, for the running card of comfyui_workflow run. */
		function useWorkflowName(id) {
			const [name, setName] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				if (id === void 0) return void 0;
				let stopped = false;
				fetch("/comfyui/workflows", { headers: { accept: "application/json" } }).then(async (response) => await response.json()).then((data) => {
					const found = data.workflows?.find((workflow) => workflow.id === id);
					if (!stopped && found !== void 0) setName(found.name);
				}).catch(() => void 0);
				return () => {
					stopped = true;
				};
			}, [id]);
			return name;
		}
		function ResultCard({ title, result, t }) {
			const failed = result.status === "interrupted";
			return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-card-head" }, title !== "" ? (0, react.createElement)("span", { className: "dsc-badge" }, title) : null, (0, react.createElement)("span", { className: failed ? "dsc-badge dsc-badge--err" : "dsc-badge dsc-badge--ok" }, failed ? t("cardInterrupted") : result.status), (0, react.createElement)("span", { className: "dsc-meta" }, `${t("cardPrompt")} ${result.promptId}`), (0, react.createElement)("span", { className: "dsc-meta" }, `${t("cardElapsed")} ${result.elapsedMs} ms`)), (0, react.createElement)("div", { className: "dsc-meta" }, result.summary), (0, react.createElement)(MediaLinks, {
				media: result.media,
				t
			}));
		}
		/** Transient-failure retry budget for the jobs/media poll (backoff steps). */
		const POLL_MAX_FAILURES = 20;
		/** 'unknown' grace polls (~5 min at 3 s) before treating history as evicted.
		* The route answers 'queued' while ComfyUI still holds the prompt, so this
		* only counts polls where the job is in neither history nor the queue. */
		const POLL_UNKNOWN_GRACE = 100;
		function BackgroundCard({ label, promptId, t }) {
			const [result, setResult] = (0, react.useState)(null);
			const queue = useQueueState(promptId, result === null);
			(0, react.useEffect)(() => {
				let stopped = false;
				let timer;
				let failures = 0;
				let unknowns = 0;
				const schedule = (delay, fn) => {
					timer = window.setTimeout(fn, delay);
				};
				const recoverFromAssets = async () => {
					try {
						const data = await (await fetch("/comfyui/assets", { headers: { accept: "application/json" } })).json();
						if (stopped || data.ok !== true || !Array.isArray(data.assets)) return null;
						const media = data.assets.find((entry) => entry.promptId === promptId)?.media ?? [];
						return media.length > 0 ? media : null;
					} catch {
						return null;
					}
				};
				const poll = async () => {
					try {
						const data = await (await fetch(`/comfyui/jobs/media?promptId=${encodeURIComponent(promptId)}`, { headers: { accept: "application/json" } })).json();
						if (stopped) return;
						if (data.ok !== true || data.status === void 0) throw new Error(data.error ?? "invalid jobs/media response");
						failures = 0;
						if (data.status === "completed" || data.status === "failed") {
							setResult({
								status: data.status,
								media: data.media,
								error: data.error
							});
							return;
						}
						if (data.status === "unknown") {
							unknowns += 1;
							const recovered = await recoverFromAssets();
							if (stopped) return;
							if (recovered !== null) {
								setResult({
									status: "completed",
									media: recovered,
									recovered: true
								});
								return;
							}
							if (unknowns > POLL_UNKNOWN_GRACE) {
								setResult({
									status: "completed",
									media: []
								});
								return;
							}
							schedule(3e3, () => {
								poll();
							});
							return;
						}
						unknowns = 0;
						schedule(3e3, () => {
							poll();
						});
					} catch (error) {
						if (stopped) return;
						failures += 1;
						if (failures > POLL_MAX_FAILURES) {
							const message = error instanceof Error ? error.message : String(error);
							setResult({
								status: "failed",
								error: t("cardPollStalled", {
									n: POLL_MAX_FAILURES,
									message
								})
							});
							return;
						}
						schedule(Math.min(3e3 * failures, 3e4), () => {
							poll();
						});
					}
				};
				poll();
				return () => {
					stopped = true;
					if (timer !== void 0) window.clearTimeout(timer);
				};
			}, [promptId, t]);
			if (result !== null && (result.status === "completed" || result.status === "failed")) {
				const media = result.media ?? [];
				return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-card-head" }, (0, react.createElement)("span", { className: result.status === "failed" ? "dsc-badge dsc-badge--err" : "dsc-badge dsc-badge--ok" }, result.status === "failed" ? t("cardFailed") : t("cardBackgroundDone")), (0, react.createElement)("span", { className: "dsc-meta" }, `${label} · ${promptId}`)), result.status !== "failed" && result.recovered === true ? (0, react.createElement)("div", { className: "dsc-meta" }, t("cardRecovered")) : null, result.status === "failed" ? (0, react.createElement)("div", { className: "dsc-meta dsc-job-error" }, result.error ?? t("cardFailed")) : (0, react.createElement)(MediaLinks, {
					media,
					t
				}));
			}
			return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-card-head" }, (0, react.createElement)("span", { className: "dsc-badge" }, t("cardBackground")), (0, react.createElement)("span", { className: "dsc-meta" }, `${label} · ${promptId}`)), (0, react.createElement)(ProgressLine, {
				state: queue,
				t
			}));
		}
		function SettledCard({ block, t }) {
			if (block.isError === true) return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-card-head" }, (0, react.createElement)("span", { className: "dsc-badge dsc-badge--err" }, t("cardFailed"))), (0, react.createElement)("div", { className: "dsc-meta" }, block.error?.name ?? "error"));
			const meta = block.meta;
			if (meta === void 0 || typeof meta !== "object") return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("span", { className: "dsc-badge" }, block.call?.name ?? "comfyui"));
			if ("action" in meta) {
				if (meta.action === "run") {
					if (meta.background !== void 0) return (0, react.createElement)(BackgroundCard, {
						label: meta.workflowName ?? "",
						promptId: meta.background.promptId,
						t
					});
					if (meta.result !== void 0) return (0, react.createElement)(ResultCard, {
						title: meta.workflowName ?? "",
						result: meta.result,
						t
					});
				}
				if (meta.action === "list") {
					const runs = meta.workflows?.length ?? 0;
					const graphs = meta.comfyuiWorkflows?.length ?? 0;
					return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-card-head" }, (0, react.createElement)("span", { className: "dsc-badge" }, "comfyui_workflow")), (0, react.createElement)("div", { className: "dsc-meta" }, t("cardListed", {
						runs,
						graphs
					})));
				}
				if (meta.action === "get") return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-card-head" }, (0, react.createElement)("span", { className: "dsc-badge" }, "comfyui_workflow")), (0, react.createElement)("div", { className: "dsc-meta" }, meta.name ?? meta.id ?? "get"));
				return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("span", { className: "dsc-badge" }, "comfyui_workflow"));
			}
			if (meta.kind === "background") return (0, react.createElement)(BackgroundCard, {
				label: meta.label,
				promptId: meta.promptId,
				t
			});
			return (0, react.createElement)(ResultCard, {
				title: "",
				result: meta,
				t
			});
		}
		/** A call still running: what is generating, and how far along it is. */
		function RunningCard({ block, t }) {
			const args = parseArgs(block.argsRaw);
			const isRun = block.name === "comfyui_run" || args.action === "run";
			const workflowId = block.name === "comfyui_workflow" && typeof args.id === "string" ? args.id : void 0;
			const savedName = useWorkflowName(isRun ? workflowId : void 0);
			const queue = useQueueState(void 0, isRun && args.mode !== "async");
			if (!isRun) return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-card-head" }, (0, react.createElement)("span", { className: "dsc-badge" }, block.name), typeof args.action === "string" ? (0, react.createElement)("span", { className: "dsc-meta" }, args.action) : null));
			const title = block.name === "comfyui_run" ? t("cardHandWritten") : savedName ?? workflowId ?? "";
			return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-card-head" }, (0, react.createElement)("span", { className: "dsc-badge" }, t("cardGenerating")), title !== "" ? (0, react.createElement)("span", { className: "dsc-meta" }, `${t("cardWorkflow")} ${title}`) : null, (0, react.createElement)("span", { className: "dsc-meta" }, `${t("cardMode")} ${String(args.mode ?? "sync")}`)), args.mode === "async" ? null : (0, react.createElement)(ProgressLine, {
				state: queue,
				t
			}));
		}
		/** The card component: picks running vs settled rendering from the block. */
		function ComfyUICard({ t, block }) {
			if (isResultNode(block)) return (0, react.createElement)(SettledCard, {
				block,
				t
			});
			return (0, react.createElement)(RunningCard, {
				block,
				t
			});
		}
		//#endregion
		//#region src/client/api.ts
		/** Same-origin JSON helpers shared by the settings page and the panel. */
		async function getJson(url) {
			const response = await fetch(url, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		}
		/**
		* GET a list endpoint and return the array under `key`. Routes report failure
		* as HTTP 200 `{ ok: false, error }`, so a plain getJson hands the caller
		* `undefined` for the list — which crashed the whole panel on `.length` inside
		* the slot error boundary, i.e. "click does nothing" (Issue #5). Throwing the
		* route's error instead lets the caller show it next to the section.
		*/
		async function getList(url, key) {
			const data = await getJson(url);
			const list = data[key];
			if (Array.isArray(list)) return list;
			throw new Error(typeof data.error === "string" ? data.error : `unexpected response from ${url}`);
		}
		async function postJson(url, body) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => ({}));
				throw new Error(payload.error ?? `HTTP ${response.status}`);
			}
			return response.json();
		}
		/** POST raw bytes (an imported file) and read the JSON reply. */
		async function postRaw(url, bytes) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: bytes
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => ({}));
				throw new Error(payload.error ?? `HTTP ${response.status}`);
			}
			return response.json();
		}
		//#endregion
		//#region src/client/settings.tsx
		/**
		* The ComfyUI settings page (settings.section, id 'comfyui'). Reads the
		* redacted host config over /comfyui/config, persists edits through the same
		* route, and probes the server over /comfyui/test.
		*/
		/** The ComfyUI settings page component. */
		function ComfyUISettings({ t }) {
			const [config, setConfig] = (0, react.useState)(null);
			const [baseUrl, setBaseUrl] = (0, react.useState)("");
			const [apiKeyEnv, setApiKeyEnv] = (0, react.useState)("");
			const [mediaHost, setMediaHost] = (0, react.useState)("");
			const [comfyuiDirs, setComfyuiDirs] = (0, react.useState)([]);
			const [skillsDir, setSkillsDir] = (0, react.useState)("");
			const [loadError, setLoadError] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const [saveState, setSaveState] = (0, react.useState)("idle");
			const [testing, setTesting] = (0, react.useState)(false);
			const [testResult, setTestResult] = (0, react.useState)(null);
			const [lang, setLangState] = (0, react.useState)(getLang());
			(0, react.useEffect)(() => {
				let cancelled = false;
				getJson("/comfyui/config").then((view) => {
					if (cancelled) return;
					setConfig(view);
					setBaseUrl(view.baseUrl);
					setApiKeyEnv(view.apiKeyEnv);
					setMediaHost(view.mediaHost ?? "");
					setComfyuiDirs(Array.isArray(view.comfyuiDirs) ? view.comfyuiDirs : []);
					setSkillsDir(view.skillsDir ?? "");
				}).catch((error) => {
					if (cancelled) return;
					setLoadError(error instanceof Error ? error.message : String(error));
				});
				return () => {
					cancelled = true;
				};
			}, []);
			const save = async () => {
				setSaving(true);
				setSaveState("idle");
				try {
					const dirs = comfyuiDirs.map((dir) => dir.trim()).filter((dir) => dir !== "");
					const payload = await postJson("/comfyui/config", { patch: {
						baseUrl,
						apiKeyEnv,
						mediaHost,
						comfyuiDirs: dirs,
						skillsDir: skillsDir.trim()
					} });
					if (payload.config !== void 0) {
						setConfig(payload.config);
						setBaseUrl(payload.config.baseUrl);
						setApiKeyEnv(payload.config.apiKeyEnv);
						setMediaHost(payload.config.mediaHost ?? "");
						setComfyuiDirs(payload.config.comfyuiDirs ?? []);
						setSkillsDir(payload.config.skillsDir ?? "");
					}
					setSaveState("saved");
				} catch (error) {
					setSaveState("failed");
					setTestResult({
						ok: false,
						text: error instanceof Error ? error.message : String(error)
					});
				} finally {
					setSaving(false);
				}
			};
			const test = async () => {
				setTesting(true);
				setTestResult(null);
				try {
					const payload = await postJson("/comfyui/test", {});
					if (payload.ok === true) setTestResult({
						ok: true,
						text: t("testOk", {
							version: payload.version ?? "unknown",
							ms: payload.latencyMs ?? 0
						})
					});
					else setTestResult({
						ok: false,
						text: t("testFail", { message: payload.error ?? "unknown error" })
					});
				} catch (error) {
					setTestResult({
						ok: false,
						text: t("testFail", { message: error instanceof Error ? error.message : String(error) })
					});
				} finally {
					setTesting(false);
				}
			};
			if (loadError !== null) return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-meta" }, `${t("saveFailed")}: ${loadError}`));
			if (config === null) return (0, react.createElement)("div", { className: "dsc-card" }, (0, react.createElement)("div", { className: "dsc-meta" }, "…"));
			return (0, react.createElement)("div", { className: "dsc-form" }, (0, react.createElement)("div", { className: "dsc-meta" }, t("settingsDesc")), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("language")), (0, react.createElement)("select", {
				className: "dsc-input",
				value: lang,
				onChange: (event) => {
					const next = event.target.value === "en" ? "en" : "zh";
					setLangState(next);
					setLang(next);
					window.location.reload();
				}
			}, (0, react.createElement)("option", { value: "zh" }, "中文"), (0, react.createElement)("option", { value: "en" }, "English")), (0, react.createElement)("div", { className: "dsc-hint" }, t("languageHint"))), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("baseUrl")), (0, react.createElement)("input", {
				value: baseUrl,
				placeholder: "http://127.0.0.1:8188",
				onChange: (event) => {
					setBaseUrl(event.target.value);
					setSaveState("idle");
				}
			}), (0, react.createElement)("div", { className: "dsc-hint" }, t("baseUrlHint"))), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("apiKeyEnv")), (0, react.createElement)("input", {
				value: apiKeyEnv,
				placeholder: "COMFYUI_API_KEY",
				onChange: (event) => {
					setApiKeyEnv(event.target.value);
					setSaveState("idle");
				}
			}), (0, react.createElement)("div", { className: "dsc-hint" }, `${t("apiKeyEnvHint")} — ${config.hasApiKey ? t("hasApiKey") : t("noApiKey")}`)), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("mediaHost")), (0, react.createElement)("input", {
				value: mediaHost,
				placeholder: "http://192.168.1.5:3080",
				onChange: (event) => {
					setMediaHost(event.target.value);
					setSaveState("idle");
				}
			}), (0, react.createElement)("div", { className: "dsc-hint" }, t("mediaHostHint"))), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("comfyuiDirs")), comfyuiDirs.map((dir, index) => (0, react.createElement)("div", {
				key: `dsc-dir-${index}`,
				style: {
					display: "flex",
					gap: "8px",
					marginBottom: "8px",
					alignItems: "center"
				}
			}, (0, react.createElement)("input", {
				className: "dsc-input",
				value: dir,
				placeholder: t("comfyuiDirPlaceholder"),
				style: { flex: "1" },
				onChange: (event) => {
					const next = comfyuiDirs.slice();
					next[index] = event.target.value;
					setComfyuiDirs(next);
					setSaveState("idle");
				}
			}), (0, react.createElement)("button", {
				className: "dsc-btn",
				title: t("comfyuiDirRemove"),
				disabled: !config.writable,
				onClick: () => {
					const next = comfyuiDirs.slice();
					next.splice(index, 1);
					setComfyuiDirs(next);
					setSaveState("idle");
				}
			}, "×"))), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: !config.writable,
				onClick: () => {
					setComfyuiDirs([...comfyuiDirs, ""]);
					setSaveState("idle");
				}
			}, t("comfyuiDirAdd")), (0, react.createElement)("div", { className: "dsc-hint" }, t("comfyuiDirsHint"))), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("skillsDir")), (0, react.createElement)("input", {
				className: "dsc-input",
				value: skillsDir,
				placeholder: config.skillsRoot,
				onChange: (event) => {
					setSkillsDir(event.target.value);
					setSaveState("idle");
				}
			}), (0, react.createElement)("div", { className: "dsc-hint" }, t("skillsDirHint", { current: config.skillsRoot }))), (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: saving || !config.writable,
				onClick: () => void save()
			}, t("save")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: testing,
				onClick: () => void test()
			}, testing ? t("testing") : t("test")), saveState === "saved" ? (0, react.createElement)("span", { className: "dsc-note" }, t("saved")) : null, saveState === "failed" ? (0, react.createElement)("span", { className: "dsc-note" }, t("saveFailed")) : null), testResult !== null ? (0, react.createElement)("div", {
				className: testResult.ok ? "dsc-note" : "dsc-note",
				style: testResult.ok ? { color: "#22c55e" } : { color: "#ef4444" }
			}, testResult.text) : null, config.writable ? null : (0, react.createElement)("div", { className: "dsc-hint" }, t("configNotWritable")));
		}
		//#endregion
		//#region src/client/panel-store.ts
		/**
		* Shared open/close/tab state for the ComfyUI panel. The overlay occupant
		* and the session-header trigger are separate registrations in one bundle,
		* so they coordinate through this module-level store plus useSyncExternalStore.
		*/
		const listeners$1 = /* @__PURE__ */ new Set();
		let open = false;
		let tab = "workflows";
		let assetFilter = "";
		function emit$1() {
			for (const listener of listeners$1) listener();
		}
		const panelStore = {
			isOpen: () => open,
			toggle: () => {
				open = !open;
				emit$1();
			},
			open: () => {
				if (!open) {
					open = true;
					emit$1();
				}
			},
			close: () => {
				if (open) {
					open = false;
					emit$1();
				}
			},
			getTab: () => tab,
			setTab: (next) => {
				if (tab !== next) {
					tab = next;
					emit$1();
				}
			},
			getAssetFilter: () => assetFilter,
			setAssetFilter: (name) => {
				if (assetFilter !== name) {
					assetFilter = name;
					emit$1();
				}
			},
			subscribe(listener) {
				listeners$1.add(listener);
				return () => {
					listeners$1.delete(listener);
				};
			}
		};
		/** React hook reading the panel open state. */
		function usePanelOpen() {
			return (0, react.useSyncExternalStore)(panelStore.subscribe, panelStore.isOpen, panelStore.isOpen);
		}
		/** React hook reading the active panel tab. */
		function usePanelTab() {
			return (0, react.useSyncExternalStore)(panelStore.subscribe, panelStore.getTab, panelStore.getTab);
		}
		//#endregion
		//#region src/client/connection.tsx
		/**
		* Connection probe + reminder toast. Opening the panel used to give zero
		* feedback when ComfyUI was down: the workflows/queue tabs just stayed empty
		* with no explanation. The header trigger now fires a real backend probe
		* (POST /comfyui/test → the host connects to the configured ComfyUI server —
		* local port or remote URL alike); when it fails, the panel closes again —
		* the trigger must not stay highlighted against a dead backend — and a fixed
		* toast at the top of the page tells the user to start ComfyUI or fix the
		* server address. The probe never blocks the panel: it opens immediately,
		* the toast settles whenever the probe answers.
		*/
		const listeners = /* @__PURE__ */ new Set();
		let state = { status: "hidden" };
		/** Dedupe concurrent probes (rapid trigger clicks). */
		let inFlight = null;
		/** Skip re-probing while a "connected" verdict is still fresh. */
		let lastOkAt = 0;
		/** The ok toast only shows on fail→ok transitions, never on healthy opens. */
		let hadFailure = false;
		let okHideTimer = null;
		function emit() {
			for (const listener of listeners) listener();
		}
		function setState(next) {
			state = next;
			emit();
		}
		function clearOkTimer() {
			if (okHideTimer !== null) {
				clearTimeout(okHideTimer);
				okHideTimer = null;
			}
		}
		/** Close button on the toast; also ends the transient ok feedback early. */
		function dismissConnectionToast() {
			clearOkTimer();
			if (state.status !== "hidden") setState({ status: "hidden" });
		}
		/**
		* Probe the ComfyUI server through the host and surface the result as toast
		* state. A success within the last 30s skips the round-trip entirely, so
		* healthy repeated panel opens do not hammer the server; failures always
		* re-probe on the next open (the user may have just started ComfyUI).
		*/
		function probeConnection() {
			if (inFlight !== null) return inFlight;
			if (Date.now() - lastOkAt < 3e4) return Promise.resolve();
			if (state.status !== "fail") {
				clearOkTimer();
				setState({ status: "probing" });
			}
			inFlight = (async () => {
				try {
					const payload = await postJson("/comfyui/test", {});
					if (payload.ok === true) {
						lastOkAt = Date.now();
						const recovered = hadFailure;
						hadFailure = false;
						if (recovered) {
							setState({
								status: "ok",
								version: payload.version,
								latencyMs: payload.latencyMs
							});
							clearOkTimer();
							okHideTimer = setTimeout(dismissConnectionToast, 4e3);
						} else setState({ status: "hidden" });
					} else {
						hadFailure = true;
						setState({
							status: "fail",
							message: payload.error ?? "unknown error"
						});
						panelStore.close();
						// 顶部 toast 在 Electron 标题栏拖拽区里可能点不到 ×：10 秒后自动收起，别挡着别的东西。
						clearOkTimer();
						okHideTimer = setTimeout(dismissConnectionToast, 1e4);
					}
				} catch (error) {
					hadFailure = true;
					setState({
						status: "fail",
						message: error instanceof Error ? error.message : String(error)
					});
					panelStore.close();
					// 顶部 toast 在 Electron 标题栏拖拽区里可能点不到 ×：10 秒后自动收起，别挡着别的东西。
					clearOkTimer();
					okHideTimer = setTimeout(dismissConnectionToast, 1e4);
				} finally {
					inFlight = null;
				}
			})();
			return inFlight;
		}
		function getConnState() {
			return state;
		}
		function subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/** Fixed top-center status toast; mounted next to the header trigger so it
		* renders (and can be dismissed) even when the panel is closed again. The
		* probing variant fades in after a short CSS delay, so a fast successful
		* probe never paints anything. */
		function ConnectionToast({ t }) {
			const conn = (0, react.useSyncExternalStore)(subscribe, getConnState, getConnState);
			if (conn.status === "hidden") return null;
			return (0, react.createElement)("div", {
				className: `dsc-conn-toast dsc-conn-toast--${conn.status}`,
				role: "status"
			}, (0, react.createElement)("span", {
				className: "dsc-conn-toast-dot",
				"aria-hidden": true
			}), (0, react.createElement)("div", { className: "dsc-conn-toast-body" }, conn.status === "fail" ? (0, react.createElement)("div", { className: "dsc-conn-toast-body-inner" }, (0, react.createElement)("div", { className: "dsc-conn-toast-title" }, t("connFailTitle")), (0, react.createElement)("div", { className: "dsc-conn-toast-text" }, t("connFailBody", { message: conn.message ?? "" }))) : (0, react.createElement)("div", { className: "dsc-conn-toast-title" }, conn.status === "probing" ? t("connChecking") : t("connOk", {
				version: conn.version ?? "unknown",
				ms: conn.latencyMs ?? 0
			}))), (0, react.createElement)("button", {
				className: "dsc-conn-toast-close",
				"aria-label": t("close"),
				onClick: dismissConnectionToast
			}, "✕"));
		}
		//#endregion
		//#region src/client/trigger.tsx
		/**
		* The session-header trigger (conversation.session.header.actions, id
		* 'comfyui'): a labelled button that toggles the ComfyUI panel, plus the
		* connection reminder toast shown when the backend cannot reach ComfyUI.
		*/
		/**
		* ComfyUI brand glyph (mono), inlined from @lobehub/icons-static-svg
		* (lobehub.com/icons). currentColor fill keeps it theme-aware.
		*/
		function ComfyUIIcon() {
			return (0, react.createElement)("svg", {
				viewBox: "0 0 24 24",
				width: "1em",
				height: "1em",
				fill: "currentColor",
				fillRule: "evenodd",
				style: {
					flex: "none",
					lineHeight: 1
				},
				"aria-hidden": true
			}, (0, react.createElement)("path", { d: "M5.485 23.76c-.568 0-1.026-.207-1.325-.598-.307-.402-.387-.964-.22-1.54l.672-2.315a.605.605 0 00-.1-.536.622.622 0 00-.494-.243H2.085c-.568 0-1.026-.207-1.325-.598-.307-.403-.387-.964-.22-1.54l2.31-7.917.255-.87c.343-1.18 1.592-2.14 2.786-2.14h2.313c.276 0 .519-.18.595-.442l.764-2.633C9.906 1.208 11.155.249 12.35.249l4.945-.008h3.62c.568 0 1.027.206 1.325.597.307.402.387.964.22 1.54l-1.035 3.566c-.343 1.178-1.593 2.137-2.787 2.137l-4.956.01H11.37a.618.618 0 00-.594.441l-1.928 6.604a.605.605 0 00.1.537c.118.153.3.243.495.243l3.275-.006h3.61c.568 0 1.026.206 1.325.598.307.402.387.964.22 1.54l-1.036 3.565c-.342 1.179-1.592 2.138-2.786 2.138l-4.957.01h-3.61z" }));
		}
		/** Header-action button toggling the ComfyUI panel. Opening it also fires a
		* backend connectivity probe: when ComfyUI is down, a reminder toast explains
		* why the panel stays empty instead of the click appearing to do nothing. */
		function ComfyUITrigger({ t }) {
			const open = usePanelOpen();
			return (0, react.createElement)(react.Fragment, null, (0, react.createElement)("button", {
				className: "dsc-trigger",
				title: t("panelTitle"),
				"aria-label": t("panelTitle"),
				"aria-pressed": open,
				onClick: () => {
					const opening = !panelStore.isOpen();
					panelStore.toggle();
					if (opening) probeConnection();
				}
			}, (0, react.createElement)("span", { className: "dsc-trigger-glyph" }, (0, react.createElement)(ComfyUIIcon)), (0, react.createElement)("span", null, t("panelTitle"))), (0, react.createElement)(ConnectionToast, { t }));
		}
		//#endregion
		//#region src/client/lightbox.tsx
		/**
		* Shared lightbox: opens a generated image full-screen with prev/next
		* navigation, keyboard support, and a download pill. Used by both the panel
		* (assets/queue previews) and the tool card (result images).
		*/
		/** Full-screen media overlay with prev/next navigation. */
		function Lightbox({ t, images, kinds, index, onClose, onIndex }) {
			const count = images.length;
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
					else if (event.key === "ArrowLeft") onIndex((index - 1 + count) % count);
					else if (event.key === "ArrowRight") onIndex((index + 1) % count);
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [
				index,
				count,
				onClose,
				onIndex
			]);
			const src = images[index];
			if (src === void 0) return null;
			const kind = kinds?.[index] ?? "image";
			const media = kind === "video" ? (0, react.createElement)("video", {
				className: "dsc-lightbox-media",
				src,
				controls: true,
				autoPlay: true
			}) : kind === "audio" ? (0, react.createElement)("audio", {
				className: "dsc-lightbox-media",
				src,
				controls: true,
				autoPlay: true
			}) : kind === "image" ? (0, react.createElement)("img", {
				className: "dsc-lightbox-img",
				src,
				alt: ""
			}) : (0, react.createElement)("div", { className: "dsc-lightbox-media" }, src);
			return (0, react.createElement)("div", {
				className: "dsc-lightbox",
				onClick: onClose
			}, (0, react.createElement)("div", {
				className: "dsc-lightbox-body",
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("button", {
				className: "dsc-lightbox-close",
				"aria-label": t("close"),
				onClick: (event) => {
					event.stopPropagation();
					onClose();
				}
			}, "✕"), count > 1 ? (0, react.createElement)("button", {
				className: "dsc-lightbox-nav dsc-lightbox-nav--prev",
				"aria-label": t("lbPrev"),
				onClick: (event) => {
					event.stopPropagation();
					onIndex((index - 1 + count) % count);
				}
			}, "‹") : null, media, (0, react.createElement)("div", { className: "dsc-lightbox-meta" }, (0, react.createElement)("span", null, `${index + 1} / ${count}`), (0, react.createElement)("a", {
				className: "dsc-lightbox-download",
				href: src,
				download: "",
				target: "_blank",
				rel: "noreferrer"
			}, t("cardDownload"))), count > 1 ? (0, react.createElement)("button", {
				className: "dsc-lightbox-nav dsc-lightbox-nav--next",
				"aria-label": t("lbNext"),
				onClick: (event) => {
					event.stopPropagation();
					onIndex((index + 1) % count);
				}
			}, "›") : null));
		}
		//#endregion
		//#region src/client/panel.tsx
		/**
		* The ComfyUI panel (shell.overlay, id 'comfyui.panel'): a floating panel
		* with three tabs — workflow library management, generated asset preview,
		* and the live ComfyUI queue. Draggable by its header and resizable via the
		* corner handle; geometry persists in localStorage. Renders null while closed
		* (the overlay layer is click-through, so nothing blocks the app underneath).
		*/
		const GEOM_KEY = "dsh-comfyui-panel-geom-v2";
		function loadGeom() {
			try {
				const raw = localStorage.getItem(GEOM_KEY);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				const geom = {};
				if (typeof parsed.x === "number") geom.x = parsed.x;
				if (typeof parsed.y === "number") geom.y = parsed.y;
				if (typeof parsed.width === "number" && parsed.width >= 300) geom.width = parsed.width;
				if (typeof parsed.height === "number" && parsed.height >= 200) geom.height = parsed.height;
				if (typeof parsed.opacity === "number" && parsed.opacity >= 0.2 && parsed.opacity <= 1) geom.opacity = parsed.opacity;
				return geom;
			} catch {
				return {};
			}
		}
		function saveGeom(geom) {
			try {
				localStorage.setItem(GEOM_KEY, JSON.stringify(geom));
			} catch {}
		}
		/** Default panel width from styles.ts (`.dsc-panel` width var), used only to
		* estimate the panel extent while clamping a saved position. */
		const PANEL_WIDTH_FALLBACK = 400;
		/** Approx. height of the drag-handle band (`.dsc-panel-head`). */
		const HEAD_BAND = 48;
		/** Minimum margin kept between the panel and the viewport edge. */
		const EDGE = 8;
		/** Minimum gap above the panel: keeps it clear of the window title bar,
		* so dragging can never park the header against the very top edge. */
		const TOP_BAND = 56;
		/**
		* Clamp a top-left corner so the drag-handle band always stays inside the
		* viewport. The failure this prevents: once the header is pushed past the top
		* edge (or a saved position from a larger monitor no longer fits), there is no
		* grab surface left and the panel cannot be moved back at all.
		*/
		function clampPos(x, y, width, vw, vh) {
			const maxX = Math.max(EDGE, vw - width - EDGE);
			const maxY = Math.max(TOP_BAND, vh - HEAD_BAND - EDGE);
			return {
				x: Math.min(Math.max(x, EDGE), maxX),
				y: Math.min(Math.max(y, TOP_BAND), maxY)
			};
		}
		/** Snap persisted geometry back within reach of the cursor. Geometry that
		* never carried an explicit position (the CSS-anchored default) is returned
		* unchanged; geometry already inside the safe area keeps its object identity
		* so callers can skip pointless re-renders. */
		function healGeom(geom, vw, vh) {
			if (geom.x === void 0 || geom.y === void 0) return geom;
			const pos = clampPos(geom.x, geom.y, geom.width ?? PANEL_WIDTH_FALLBACK, vw, vh);
			if (pos.x === geom.x && pos.y === geom.y) return geom;
			return {
				...geom,
				x: pos.x,
				y: pos.y
			};
		}
		/** Fallback suggestions when the config route has not answered yet; the
		* authoritative list comes from the host (`presetDirs`). */
		const SKILL_FALLBACK_DIRS = [
			"references",
			"scripts",
			"assets"
		];
		/** Imported binaries land in assets/; the editor previews these instead of
		* trying to read them as text. */
		const SKILL_IMAGE_EXTENSIONS = [
			".png",
			".jpg",
			".jpeg",
			".webp",
			".gif",
			".svg"
		];
		function isSkillImage(path) {
			const dot = path.lastIndexOf(".");
			return dot !== -1 && SKILL_IMAGE_EXTENSIONS.includes(path.slice(dot).toLowerCase());
		}
		/** Preset workflow classification tags (users can add custom ones). Stored as
		* plain text, so the tag identity is the label itself. */
		const PRESET_TAGS = [
			"图生图",
			"文生图",
			"文生视频",
			"图生视频",
			"参考生视频",
			"文生音频",
			"参考生音频"
		];
		const JOB_FILTERS = [
			{
				key: "all",
				label: "jobFilterAll"
			},
			{
				key: "completed",
				label: "jobFilterCompleted"
			},
			{
				key: "failed",
				label: "jobFilterFailed"
			},
			{
				key: "cancelled",
				label: "jobFilterCancelled"
			}
		];
		function shortId(promptId) {
			return promptId.length > 10 ? `${promptId.slice(0, 10)}…` : promptId;
		}
		/** Open a job's preview image URL (via the media proxy) when it has one. */
		function previewUrlOf(job) {
			const preview = job.previewOutput;
			if (preview === void 0 || preview === null || preview.filename === void 0 || preview.filename === null) return null;
			return `/comfyui/media?file=${encodeURIComponent(preview.filename)}&subfolder=${encodeURIComponent(preview.subfolder ?? "")}&type=${encodeURIComponent(preview.type ?? "output")}`;
		}
		/** Opens a generated image in a large overlay with prev/next navigation. */
		/** Whether a node input is fed by a link ([nodeId, slot]) rather than a widget value. */
		function isLinkValue(value) {
			return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
		}
		/** Short description of a node input's current value, for the advanced
		* picker's dropdown. */
		function inputValueKind(value) {
			if (value === null) return "null";
			if (Array.isArray(value)) return "array";
			if (typeof value === "object") return "object";
			return typeof value;
		}
		/** Read a parameter default as a boolean. Defaults saved before the editor
		* had a checkbox are strings ("true"/"false"), so they are coerced here rather
		* than silently reading as `true` for every non-empty string. */
		function asBool(value) {
			if (typeof value === "boolean") return value;
			if (typeof value === "number") return value !== 0;
			return /^(true|1|yes|on)$/i.test(value.trim());
		}
		/** Tooltip for a number field: the declared type and bounds, when known. */
		function numberRangeHint(param) {
			const parts = [param.numberKind ?? "number"];
			if (param.min !== void 0 || param.max !== void 0) parts.push(`${param.min ?? "-∞"} ~ ${param.max ?? "∞"}`);
			if (param.step !== void 0) parts.push(`step ${param.step}`);
			return parts.join(" · ");
		}
		function newParamId() {
			if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
			return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
		}
		/** Parse the draft workflow into a plain object (empty on invalid JSON). */
		function parseDraftWorkflow(workflow) {
			if (typeof workflow !== "string") return workflow;
			try {
				const parsed = JSON.parse(workflow);
				return typeof parsed === "object" && parsed !== null ? parsed : {};
			} catch {
				return {};
			}
		}
		/**
		* Custom dropdown for loader-node file lists: each option shows a small
		* server-side thumbnail (images only; <select> cannot render images).
		*/
		function UploadSelect(props) {
			const [open, setOpen] = (0, react.useState)(false);
			const [live, setLive] = (0, react.useState)(null);
			const ref = (0, react.useRef)(null);
			const refreshRef = (0, react.useRef)(props.onRefresh);
			refreshRef.current = props.onRefresh;
			(0, react.useEffect)(() => {
				if (!open) return;
				const onDoc = (event) => {
					if (ref.current !== null && !ref.current.contains(event.target)) setOpen(false);
				};
				document.addEventListener("mousedown", onDoc);
				return () => document.removeEventListener("mousedown", onDoc);
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const fn = refreshRef.current;
				if (fn === void 0) return;
				let cancelled = false;
				fn().then((latest) => {
					if (!cancelled && latest !== void 0) setLive(latest);
				});
				return () => {
					cancelled = true;
				};
			}, [open]);
			const options = live ?? props.options;
			const thumbUrl = (name) => props.kind === "image" ? `/comfyui/media?file=${encodeURIComponent(String(name))}&type=input` : null;
			const current = options.some((option) => String(option) === props.value) ? props.value : String(props.value);
			return (0, react.createElement)("div", {
				ref,
				className: "dsc-upload-select"
			}, (0, react.createElement)("button", {
				className: "dsc-upload-select-btn",
				onClick: () => setOpen(!open),
				title: String(current)
			}, thumbUrl(props.value) !== null ? (0, react.createElement)("img", {
				className: "dsc-upload-select-thumb",
				src: thumbUrl(props.value) ?? "",
				alt: "",
				loading: "lazy"
			}) : null, (0, react.createElement)("span", { className: "dsc-upload-select-name" }, String(current))), open ? (0, react.createElement)("div", { className: "dsc-upload-select-pop" }, options.map((option) => {
				const name = String(option);
				return (0, react.createElement)("div", {
					key: name,
					className: `dsc-upload-select-item${name === props.value ? " dsc-upload-select-item--active" : ""}`,
					onClick: () => {
						props.onChange(name);
						setOpen(false);
					}
				}, thumbUrl(option) !== null ? (0, react.createElement)("img", {
					className: "dsc-upload-select-thumb",
					src: thumbUrl(option) ?? "",
					alt: "",
					loading: "lazy"
				}) : null, (0, react.createElement)("span", { className: "dsc-upload-select-name" }, name));
			})) : null);
		}
		/** Merge a freshly fetched option list with the previous one (latest first,
		* deduped) so the dropdown never drops options mid-session. */
		function mergeOptions(prev, latest) {
			const seen = /* @__PURE__ */ new Set();
			const out = [];
			for (const item of [...latest, ...prev]) {
				const key = String(item);
				if (!seen.has(key)) {
					seen.add(key);
					out.push(item);
				}
			}
			return out;
		}
		/** Copy text to the clipboard; falls back to a hidden textarea when the
		* clipboard API is unavailable (non-secure LAN http). */
		function copyText(text) {
			if (navigator.clipboard !== void 0) return navigator.clipboard.writeText(text).then(() => true).catch(() => copyViaTextarea(text));
			return Promise.resolve(copyViaTextarea(text));
		}
		function copyViaTextarea(text) {
			const textarea = document.createElement("textarea");
			textarea.value = text;
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			let ok = false;
			try {
				ok = document.execCommand("copy");
			} catch {
				ok = false;
			}
			document.body.removeChild(textarea);
			return ok;
		}
		/** Read a file's pixel size in the browser (image only) and report it to the
		* plugin so the workflow output size can default to the source image. Returns
		* the size text for display, or undefined when unreadable. */
		async function recordMediaSize(file, name) {
			try {
				const bitmap = await createImageBitmap(file);
				const width = bitmap.width;
				const height = bitmap.height;
				bitmap.close();
				await fetch("/comfyui/media-size", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name,
						width,
						height
					})
				}).catch(() => void 0);
				return `${width}×${height}`;
			} catch {
				return;
			}
		}
		/** SHA-256 hex digest (pure JS — crypto.subtle needs a secure context, which a
		* LAN http origin is not). Uses the standard padding/compression; the input is
		* any byte array. */
		function sha256Hex(data) {
			const K = new Uint32Array([
				1116352408,
				1899447441,
				3049323471,
				3921009573,
				961987163,
				1508970993,
				2453635748,
				2870763221,
				3624381080,
				310598401,
				607225278,
				1426881987,
				1925078388,
				2162078206,
				2614888103,
				3248222580,
				3835390401,
				4022224774,
				264347078,
				604807628,
				770255983,
				1249150122,
				1555081692,
				1996064986,
				2554220882,
				2821834349,
				2952996808,
				3210313671,
				3336571891,
				3584528711,
				113926993,
				338241895,
				666307205,
				773529912,
				1294757372,
				1396182291,
				1695183700,
				1986661051,
				2177026350,
				2456956037,
				2730485921,
				2820302411,
				3259730800,
				3345764771,
				3516065817,
				3600352804,
				4094571909,
				275423344,
				430227734,
				506948616,
				659060556,
				883997877,
				958139571,
				1322822218,
				1537002063,
				1747873779,
				1955562222,
				2024104815,
				2227730452,
				2361852424,
				2428436474,
				2756734187,
				3204031479,
				3329325298
			]);
			const H = new Uint32Array([
				1779033703,
				3144134277,
				1013904242,
				2773480762,
				1359893119,
				2600822924,
				528734635,
				1541459225
			]);
			const len = data.length;
			const total = len + 1 + (56 - (len + 1) % 64 + 64) % 64 + 8;
			const msg = new Uint8Array(total);
			msg.set(data);
			msg[len] = 128;
			const bitLenLo = len * 8 >>> 0;
			const bitLenHi = Math.floor(len / 536870912);
			const dv = new DataView(msg.buffer);
			dv.setUint32(total - 8, bitLenHi);
			dv.setUint32(total - 4, bitLenLo);
			const w = /* @__PURE__ */ new Uint32Array(64);
			for (let offset = 0; offset < total; offset += 64) {
				for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4);
				for (let i = 16; i < 64; i++) {
					const s0 = (w[i - 15] >>> 7 | w[i - 15] << 25) ^ (w[i - 15] >>> 18 | w[i - 15] << 14) ^ w[i - 15] >>> 3;
					const s1 = (w[i - 2] >>> 17 | w[i - 2] << 15) ^ (w[i - 2] >>> 19 | w[i - 2] << 13) ^ w[i - 2] >>> 10;
					w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
				}
				let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
				for (let i = 0; i < 64; i++) {
					const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
					const ch = e & f ^ ~e & g;
					const temp1 = h + S1 + ch + K[i] + w[i] >>> 0;
					const temp2 = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + (a & b ^ a & c ^ b & c) >>> 0;
					h = g;
					g = f;
					f = e;
					e = d + temp1 >>> 0;
					d = c;
					c = b;
					b = a;
					a = temp1 + temp2 >>> 0;
				}
				H[0] = H[0] + a >>> 0;
				H[1] = H[1] + b >>> 0;
				H[2] = H[2] + c >>> 0;
				H[3] = H[3] + d >>> 0;
				H[4] = H[4] + e >>> 0;
				H[5] = H[5] + f >>> 0;
				H[6] = H[6] + g >>> 0;
				H[7] = H[7] + h >>> 0;
			}
			let out = "";
			for (let i = 0; i < 8; i++) out += H[i].toString(16).padStart(8, "0");
			return out;
		}
		/** `image.png` + hash → `image_3f9a2b1c0d.png`: keeps the name readable while
		* making it content-unique, so re-uploading the same file reuses the name. */
		function renameWithHash(original, hash) {
			const short = hash.slice(0, 10);
			const dot = original.lastIndexOf(".");
			return `${dot > 0 ? original.slice(0, dot) : original}_${short}${dot > 0 ? original.slice(dot) : ""}`;
		}
		/** Upload a file with content-hash naming and dedup: same bytes → same file
		* name, and (for root uploads) the existing file is reused instead of creating
		* a duplicate. Returns the file name on the ComfyUI server. */
		async function uploadDedup(file, subfolder) {
			const hash = sha256Hex(new Uint8Array(await file.arrayBuffer()));
			const dedup = subfolder === void 0 || subfolder === "";
			if (dedup) {
				const lookup = await fetch("/comfyui/media-lookup", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ hash })
				}).then((response) => response.json()).catch(() => void 0);
				if (lookup !== void 0 && lookup.ok === true && lookup.found === true && typeof lookup.name === "string") return lookup.name;
			}
			const renamed = new File([file], renameWithHash(file.name, hash), { type: file.type });
			const form = new FormData();
			form.append("image", renamed);
			if (!dedup) form.append("subfolder", subfolder);
			const data = await (await fetch("/comfyui/upload", {
				method: "POST",
				body: form
			})).json();
			if (data.ok !== true || typeof data.name !== "string") throw new Error(data.error ?? "upload failed");
			if (dedup) await fetch("/comfyui/media-hash", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					hash,
					name: data.name
				})
			}).catch(() => void 0);
			return data.name;
		}
		/**
		* Parameter editor: lists the workflow's adjustable parameters (auto-detected
		* prompt/size/steps/seed) with editable name/label/default and a random
		* toggle for number parameters, plus an "advanced" picker that exposes any
		* node input as a custom parameter.
		*/
		function ParameterEditor(props) {
			const { t, params, workflow, onChange } = props;
			const [advanced, setAdvanced] = (0, react.useState)(false);
			const [advNode, setAdvNode] = (0, react.useState)("");
			const [advInput, setAdvInput] = (0, react.useState)("");
			const [advLabel, setAdvLabel] = (0, react.useState)("");
			const [recognizing, setRecognizing] = (0, react.useState)(false);
			const [recognizeError, setRecognizeError] = (0, react.useState)(null);
			const [uploading, setUploading] = (0, react.useState)({});
			const [numDraft, setNumDraft] = (0, react.useState)({});
			const [hovered, setHovered] = (0, react.useState)(null);
			const hoverRef = (0, react.useRef)(null);
			const latestRef = (0, react.useRef)({
				params,
				uploadFile: async () => void 0
			});
			/** Re-fetch a parameter's live option list (ComfyUI input dir files) and
			* merge it into the stored options, so uploads made anywhere show up in the
			* dropdown without reloading the workflow editor. */
			const refreshOptions = async (param) => {
				const rawNode = workflow[param.nodeId];
				const classType = typeof rawNode?.class_type === "string" ? rawNode.class_type : "";
				if (classType === "") return void 0;
				const result = await postJson("/comfyui/workflows/input-options", {
					classType,
					inputKey: param.inputKey
				});
				if (result.ok !== true || !Array.isArray(result.options)) return void 0;
				const latest = result.options;
				const index = params.findIndex((entry) => entry.id === param.id);
				if (index !== -1 && params[index]?.options !== void 0) update(index, { options: mergeOptions(params[index].options, latest) });
				return latest;
			};
			/** Upload a dropped file through the plugin proxy into ComfyUI's input dir. */
			const uploadFile = async (param, file) => {
				setUploading((prev) => ({
					...prev,
					[param.id]: true
				}));
				try {
					const name = await uploadDedup(file, param.subfolder);
					recordMediaSize(file, name);
					const index = params.findIndex((entry) => entry.id === param.id);
					if (index !== -1) update(index, { default: name });
					refreshOptions(param);
				} finally {
					setUploading((prev) => ({
						...prev,
						[param.id]: false
					}));
				}
			};
			latestRef.current = {
				params,
				uploadFile
			};
			/** Global paste: Ctrl+V with the mouse hovering an upload parameter routes
			* the clipboard file (e.g. a screenshot) to that parameter — same mental
			* model as pasting an image into a chat input. */
			(0, react.useEffect)(() => {
				const onPaste = (event) => {
					const targetId = hoverRef.current;
					if (targetId === null) return;
					const file = event.clipboardData?.files?.[0];
					if (file === void 0) return;
					const param = latestRef.current.params.find((entry) => entry.id === targetId);
					if (param === void 0 || param.upload === void 0) return;
					event.preventDefault();
					latestRef.current.uploadFile(param, file);
				};
				document.addEventListener("paste", onPaste);
				return () => document.removeEventListener("paste", onPaste);
			}, []);
			/** Auto-generate the internal parameter name from the input key, deduped against existing params. */
			const genParamName = (base) => {
				let name = base;
				let index = 2;
				while (params.some((param) => param.name === name)) name = `${base}_${index++}`;
				return name;
			};
			const nodeEntries = Object.entries(workflow).map(([id, raw]) => [id, raw]);
			const advNodeInfo = nodeEntries.find(([id]) => id === advNode)?.[1];
			const advInputs = advNodeInfo !== void 0 && advNodeInfo.inputs !== void 0 ? Object.entries(advNodeInfo.inputs).filter(([, value]) => !isLinkValue(value)) : [];
			const selectedInput = advInputs.find(([key]) => key === advInput);
			/** Server-side auto-detection: prompt/size/steps/seed + dropdown options (object_info). */
			const recognize = async () => {
				if (recognizing) return;
				setRecognizing(true);
				setRecognizeError(null);
				try {
					const result = await postJson("/comfyui/workflows/recognize", { workflow });
					if (result.ok === true && Array.isArray(result.parameters)) {
						onChange(result.parameters);
						setAdvanced(false);
					} else setRecognizeError(result.error ?? t("wfParamsRecognizeFailed"));
				} catch {
					setRecognizeError(t("wfParamsRecognizeFailed"));
				} finally {
					setRecognizing(false);
				}
			};
			const update = (index, patch) => {
				onChange(params.map((param, i) => i === index ? {
					...param,
					...patch
				} : param));
			};
			const addAdvanced = async () => {
				if (advNode === "" || advInput === "" || selectedInput === void 0 || advNodeInfo === void 0) return;
				const [, value] = selectedInput;
				const type = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
				if (!params.some((param) => param.nodeId === advNode && param.inputKey === advInput && param.upload === "media") && typeof value === "string") {
					let parsed;
					try {
						parsed = JSON.parse(value);
					} catch {
						parsed = void 0;
					}
					if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "object" && item !== null && typeof item.file === "string")) {
						const items = parsed;
						const firstFile = items[0]?.file;
						const slash = typeof firstFile === "string" ? firstFile.indexOf("/") : -1;
						const subfolder = typeof firstFile === "string" && slash > 0 ? firstFile.slice(0, slash) : void 0;
						const added = items.map((item, i) => ({
							id: newParamId(),
							name: genParamName(`media_${i + 1}`),
							label: `${t("wfRefSlot")}${i + 1}`,
							type: "string",
							nodeId: advNode,
							inputKey: advInput,
							default: typeof item.name === "string" ? item.name : "",
							upload: "media",
							subfolder
						}));
						onChange([...params, ...added]);
						setAdvanced(false);
						setAdvNode("");
						setAdvInput("");
						setAdvLabel("");
						return;
					}
				}
				let options;
				let upload;
				let numberSpec;
				if (typeof advNodeInfo.class_type === "string") try {
					const result = await postJson("/comfyui/workflows/input-options", {
						classType: advNodeInfo.class_type,
						inputKey: advInput
					});
					if (result.ok === true && Array.isArray(result.options) && result.options.length > 0) options = result.options;
					upload = result.upload;
					numberSpec = result.number;
				} catch {}
				onChange([...params, {
					id: newParamId(),
					name: genParamName(advInput),
					label: advLabel !== "" ? advLabel : `${advNode} · ${advInput}`,
					type,
					nodeId: advNode,
					inputKey: advInput,
					default: typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "",
					numberKind: type === "number" ? numberSpec?.kind : void 0,
					min: type === "number" ? numberSpec?.min : void 0,
					max: type === "number" ? numberSpec?.max : void 0,
					step: type === "number" ? numberSpec?.step : void 0,
					options,
					upload
				}]);
				setAdvanced(false);
				setAdvNode("");
				setAdvInput("");
				setAdvLabel("");
			};
			/** Update a parameter's default; DynamicCombo parents refresh their child (size) parameter. */
			const updateDefault = (index, value) => {
				update(index, { default: value });
				const param = params[index];
				if (param === void 0 || typeof value !== "string") return;
				if (param.options === void 0 || param.options.length === 0) return;
				const childIndex = params.findIndex((entry) => entry.nodeId === param.nodeId && entry.inputKey.startsWith(`${param.inputKey}.`));
				if (childIndex === -1) return;
				const child = params[childIndex];
				if (child === void 0) return;
				const rawNode = workflow[child.nodeId];
				postJson("/comfyui/workflows/input-options", {
					classType: typeof rawNode?.class_type === "string" ? rawNode.class_type : "",
					inputKey: param.inputKey,
					parentValue: value
				}).then((result) => {
					const data = result;
					if (data.ok === true && data.child !== void 0 && childIndex < params.length) update(childIndex, {
						options: data.child.options,
						default: data.child.default
					});
				}).catch(() => void 0);
			};
			return (0, react.createElement)("div", { className: "dsc-params" }, params.length === 0 ? (0, react.createElement)("div", { className: "dsc-hint" }, t("wfParamsEmpty")) : (0, react.createElement)("div", { className: "dsc-list" }, params.map((param, index) => (0, react.createElement)("div", {
				key: param.id,
				className: "dsc-param-row"
			}, (0, react.createElement)("div", { className: "dsc-param-fields" }, (0, react.createElement)("input", {
				className: "dsc-input dsc-input--sm",
				value: param.label,
				placeholder: t("wfParamLabel"),
				onChange: (event) => update(index, { label: event.target.value })
			})), param.upload === "media" ? (0, react.createElement)("div", {
				className: "dsc-param-upload-wrap",
				onMouseEnter: () => {
					hoverRef.current = param.id;
					setHovered(param.id);
				},
				onMouseLeave: () => {
					hoverRef.current = null;
					setHovered(null);
				}
			}, (0, react.createElement)("input", {
				className: "dsc-input dsc-input--sm dsc-param-default",
				value: String(param.default),
				placeholder: t("wfMediaEmpty"),
				title: `${param.subfolder ?? ""}/`,
				onChange: (event) => updateDefault(index, event.target.value)
			}), (0, react.createElement)("label", {
				className: hovered === param.id ? "dsc-dropzone dsc-dropzone--over" : "dsc-dropzone",
				title: t("wfPasteHint"),
				tabIndex: 0,
				onDragOver: (event) => event.preventDefault(),
				onDrop: (event) => {
					event.preventDefault();
					const file = event.dataTransfer?.files?.[0];
					if (file !== void 0) uploadFile(param, file);
				},
				onPaste: (event) => {
					const file = event.clipboardData?.files?.[0];
					if (file !== void 0) uploadFile(param, file);
				}
			}, (0, react.createElement)("input", {
				type: "file",
				style: { display: "none" },
				onChange: (event) => {
					const file = event.target.files?.[0];
					if (file !== void 0) uploadFile(param, file);
					event.target.value = "";
				}
			}), uploading[param.id] === true ? t("wfParamsUploading") : t("wfParamsDrop")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => updateDefault(index, "")
			}, t("wfMediaClear"))) : param.upload !== void 0 ? (0, react.createElement)("div", {
				className: "dsc-param-upload-wrap",
				onMouseEnter: () => {
					hoverRef.current = param.id;
					setHovered(param.id);
				},
				onMouseLeave: () => {
					hoverRef.current = null;
					setHovered(null);
				}
			}, param.options !== void 0 && param.options.length > 0 ? (0, react.createElement)(UploadSelect, {
				value: String(param.default),
				options: param.options,
				kind: param.upload,
				onChange: (value) => updateDefault(index, value),
				onRefresh: () => refreshOptions(param)
			}) : null, (0, react.createElement)("label", {
				className: hovered === param.id ? "dsc-dropzone dsc-dropzone--over" : "dsc-dropzone",
				title: t("wfPasteHint"),
				tabIndex: 0,
				onDragOver: (event) => event.preventDefault(),
				onDrop: (event) => {
					event.preventDefault();
					const file = event.dataTransfer?.files?.[0];
					if (file !== void 0) uploadFile(param, file);
				},
				onPaste: (event) => {
					const file = event.clipboardData?.files?.[0];
					if (file !== void 0) uploadFile(param, file);
				}
			}, (0, react.createElement)("input", {
				type: "file",
				style: { display: "none" },
				onChange: (event) => {
					const file = event.target.files?.[0];
					if (file !== void 0) uploadFile(param, file);
					event.target.value = "";
				}
			}), uploading[param.id] === true ? t("wfParamsUploading") : `${t("wfParamsDrop")} ${t(`uploadKind_${param.upload}`)}`)) : param.options !== void 0 && param.options.length > 0 ? (0, react.createElement)("select", {
				className: "dsc-input dsc-input--sm dsc-param-default",
				value: String(param.default),
				onChange: (event) => updateDefault(index, event.target.value)
			}, param.options.map((option) => (0, react.createElement)("option", {
				key: String(option),
				value: String(option)
			}, String(option)))) : param.type === "string" ? (0, react.createElement)("textarea", {
				className: "dsc-input dsc-param-default",
				rows: 2,
				value: String(param.default),
				placeholder: t("wfParamDefault"),
				onChange: (event) => updateDefault(index, event.target.value)
			}) : param.type === "boolean" ? (0, react.createElement)("label", { className: "dsc-param-bool dsc-param-default" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: asBool(param.default),
				onChange: (event) => updateDefault(index, event.target.checked)
			}), (0, react.createElement)("span", null, asBool(param.default) ? "true" : "false")) : param.type === "number" ? (0, react.createElement)("input", {
				className: "dsc-input dsc-input--sm dsc-param-default",
				inputMode: param.numberKind === "int" ? "numeric" : "decimal",
				value: numDraft[param.id] ?? String(param.default),
				placeholder: t("wfParamDefault"),
				title: numberRangeHint(param),
				onChange: (event) => {
					const raw = event.target.value;
					setNumDraft((prev) => ({
						...prev,
						[param.id]: raw
					}));
					const parsed = Number(raw);
					if (raw.trim() !== "" && Number.isFinite(parsed)) updateDefault(index, parsed);
				},
				onBlur: () => {
					const raw = numDraft[param.id];
					setNumDraft((prev) => {
						const next = { ...prev };
						delete next[param.id];
						return next;
					});
					if (raw === void 0) return;
					const parsed = Number(raw);
					const value = raw.trim() === "" || !Number.isFinite(parsed) ? 0 : parsed;
					updateDefault(index, param.numberKind === "int" ? Math.round(value) : value);
				}
			}) : (0, react.createElement)("input", {
				className: "dsc-input dsc-input--sm dsc-param-default",
				value: String(param.default),
				placeholder: t("wfParamDefault"),
				onChange: (event) => updateDefault(index, event.target.value)
			}), (0, react.createElement)("div", { className: "dsc-param-meta" }, (0, react.createElement)("span", { className: "dsc-meta" }, `${param.type}${param.type === "number" ? `/${param.numberKind ?? "?"}` : ""} · #${param.nodeId}.${param.inputKey}`), param.type === "number" ? (0, react.createElement)("label", { className: "dsc-param-random" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: param.random === true,
				onChange: (event) => update(index, { random: event.target.checked })
			}), (0, react.createElement)("span", null, t("wfParamRandom"))) : null, (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => onChange(params.filter((_, i) => i !== index))
			}, t("wfParamDelete")))))), (0, react.createElement)("div", { className: "dsc-toolbar" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: recognizing,
				onClick: () => {
					recognize();
				}
			}, recognizing ? t("wfParamsRecognizing") : t("wfParamsRecognize")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => setAdvanced(!advanced)
			}, t("wfParamsAdd"))), recognizeError !== null ? (0, react.createElement)("div", { className: "dsc-hint dsc-hint--error" }, recognizeError) : null, advanced ? (0, react.createElement)("div", { className: "dsc-param-advanced" }, (0, react.createElement)("div", { className: "dsc-param-fields" }, (0, react.createElement)("select", {
				className: "dsc-input dsc-input--sm",
				value: advNode,
				onChange: (event) => {
					setAdvNode(event.target.value);
					setAdvInput("");
				}
			}, (0, react.createElement)("option", { value: "" }, "—"), nodeEntries.map(([id, node]) => (0, react.createElement)("option", {
				key: id,
				value: id
			}, `#${id} ${node.class_type ?? ""}`))), advNodeInfo !== void 0 ? (0, react.createElement)("select", {
				className: "dsc-input dsc-input--sm",
				value: advInput,
				onChange: (event) => setAdvInput(event.target.value)
			}, (0, react.createElement)("option", { value: "" }, "—"), advInputs.map(([key, value]) => (0, react.createElement)("option", {
				key,
				value: key
			}, `${key} (${inputValueKind(value)})`))) : null, (0, react.createElement)("input", {
				className: "dsc-input dsc-input--sm",
				value: advLabel,
				placeholder: t("wfParamCustomLabel"),
				onChange: (event) => setAdvLabel(event.target.value)
			}), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: advNode === "" || advInput === "",
				onClick: () => {
					addAdvanced();
				}
			}, t("wfParamAdd"))), (0, react.createElement)("div", { className: "dsc-hint" }, t("wfParamCustomHint"))) : null);
		}
		function formatTs(ts) {
			const date = new Date(ts);
			return Number.isNaN(date.getTime()) ? ts : date.toLocaleString();
		}
		function formatBytes(bytes) {
			if (bytes === void 0) return "";
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${(bytes / 1048576).toFixed(2)} MB`;
		}
		/** Small gear glyph for the panel's own settings popover. */
		function GearIcon() {
			return (0, react.createElement)("svg", {
				width: 13,
				height: 13,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round"
			}, (0, react.createElement)("circle", {
				cx: 8,
				cy: 8,
				r: 2.6
			}), (0, react.createElement)("path", {
				d: "M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"
			}));
		}
		/** The panel shell: header (drag handle), tabs, and the active tab body. */
		function ComfyUIPanel({ t }) {
			const open = usePanelOpen();
			const tab = usePanelTab();
			const [geom, setGeom] = (0, react.useState)(() => healGeom(loadGeom(), window.innerWidth, window.innerHeight));
			const [dragging, setDragging] = (0, react.useState)(null);
			const [lightbox, setLightbox] = (0, react.useState)(null);
			const [showSettings, setShowSettings] = (0, react.useState)(false);
			const alpha = typeof geom.opacity === "number" ? geom.opacity : 1;
			const setAlpha = (next) => setGeom((prev) => {
				const updated = { ...prev, opacity: next };
				saveGeom(updated);
				return updated;
			});
			const panelRef = (0, react.useRef)(null);
			const dragRef = (0, react.useRef)(null);
			const openPreview = (images, kinds, index) => setLightbox({
				images,
				kinds,
				index
			});
			(0, react.useEffect)(() => {
				if (open) {
					setGeom((prev) => healGeom(prev, window.innerWidth, window.innerHeight));
					return;
				}
				saveGeom(geom);
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onResize = () => setGeom((prev) => healGeom(prev, window.innerWidth, window.innerHeight));
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, [open]);
			const startDrag = (event, mode) => {
				if (event.button !== 0) return;
				if (mode === "move") {
					const target = event.target;
					if (target !== null && target.closest("button, input, textarea, select, a, label")) return;
				}
				const rect = panelRef.current?.getBoundingClientRect();
				if (rect === void 0) return;
				dragRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					origX: rect.left,
					origY: rect.top,
					width: rect.width,
					height: rect.height
				};
				setDragging(mode);
				const el = event.currentTarget;
				if (el !== null && typeof el.setPointerCapture === "function") el.setPointerCapture(event.pointerId);
			};
			const moveDrag = (event) => {
				const d = dragRef.current;
				if (d === null) return;
				if (dragging === "move") {
					const pos = clampPos(Math.round(d.origX + event.clientX - d.startX), Math.round(d.origY + event.clientY - d.startY), d.width, window.innerWidth, window.innerHeight);
					setGeom((prev) => ({
						...prev,
						x: pos.x,
						y: pos.y
					}));
				} else if (dragging === "resize") {
					const width = Math.max(300, Math.min(720, d.width + event.clientX - d.startX));
					const height = Math.max(200, Math.min(Math.max(300, window.innerHeight - 40), d.height + event.clientY - d.startY));
					setGeom((prev) => ({
						...prev,
						width,
						height
					}));
				}
			};
			const endDrag = () => {
				if (dragRef.current === null) return;
				dragRef.current = null;
				setDragging(null);
				setGeom((prev) => {
					saveGeom(prev);
					return prev;
				});
			};
			if (!open) return null;
			const panelStyle = {};
			if (geom.x !== void 0 && geom.y !== void 0) {
				panelStyle.left = `${geom.x}px`;
				panelStyle.top = `${geom.y}px`;
				panelStyle.right = "auto";
				panelStyle.bottom = "auto";
				// bottom 被置空后高度会退化成内容高度，内容一多就把面板撑出视口、body 滚不动
				panelStyle.maxHeight = `calc(100vh - ${geom.y}px - 12px)`;
			}
			if (geom.width !== void 0) panelStyle.width = `${geom.width}px`;
			if (geom.height !== void 0) panelStyle.height = `${geom.height}px`;
			if (alpha < 1) panelStyle.opacity = `${alpha}`;
			return (0, react.createElement)("div", {
				ref: panelRef,
				className: `dsc-panel${dragging !== null ? " dsc-panel--dragging" : ""}`,
				style: panelStyle
			}, (0, react.createElement)("div", {
				className: "dsc-panel-head",
				onPointerDown: (event) => startDrag(event, "move"),
				onPointerMove: (event) => moveDrag(event),
				onPointerUp: () => endDrag(),
				onPointerCancel: () => endDrag()
			}, (0, react.createElement)("span", { className: "dsc-panel-title" }, (0, react.createElement)("span", { className: "dsc-trigger-glyph" }, (0, react.createElement)(ComfyUIIcon)), (0, react.createElement)("span", null, t("panelTitle"))), (0, react.createElement)("span", { className: "dsc-panel-head-actions" }, (0, react.createElement)("button", {
				className: "dsc-panel-reset" + (showSettings ? " dsc-panel-reset--active" : ""),
				type: "button",
				title: "面板设置",
				"aria-label": "面板设置",
				onClick: () => setShowSettings((value) => !value)
			}, (0, react.createElement)(GearIcon)), (0, react.createElement)("button", {
				className: "dsc-panel-reset",
				type: "button",
				title: t("panelReset"),
				"aria-label": t("panelReset"),
				onClick: () => {
					setGeom({});
					try {
						localStorage.removeItem(GEOM_KEY);
					} catch {}
				}
			}, "↺"), (0, react.createElement)("button", {
				className: "dsc-panel-close",
				"aria-label": t("close"),
				onClick: () => panelStore.close()
			}, "✕"))), showSettings ? (0, react.createElement)("div", {
				className: "dsc-panel-settings"
			}, (0, react.createElement)("div", {
				className: "dsc-panel-settings-row"
			}, (0, react.createElement)("span", { className: "dsc-panel-settings-label" }, "透明度"), (0, react.createElement)("span", {
				className: "dsc-panel-settings-value"
			}, `${Math.round(alpha * 100)}%`)), (0, react.createElement)("input", {
				type: "range",
				min: "30",
				max: "100",
				step: "1",
				value: String(Math.round(alpha * 100)),
				"aria-label": "面板透明度",
				onChange: (event) => {
					const next = Math.max(0.3, Math.min(1, Number(event.target.value) / 100));
					setAlpha(next);
				}
			}), (0, react.createElement)("button", {
				className: "dsc-btn dsc-panel-settings-reset",
				type: "button",
				onClick: () => setAlpha(1)
			}, "重置")) : null, (0, react.createElement)("div", { className: "dsc-tabs" }, (0, react.createElement)(TabButton, {
				t,
				active: tab === "workflows",
				label: t("tabWorkflows"),
				onClick: () => panelStore.setTab("workflows")
			}), (0, react.createElement)(TabButton, {
				t,
				active: tab === "assets",
				label: t("tabAssets"),
				onClick: () => panelStore.setTab("assets")
			}), (0, react.createElement)(TabButton, {
				t,
				active: tab === "queue",
				label: t("tabQueue"),
				onClick: () => panelStore.setTab("queue")
			})), (0, react.createElement)("div", { className: "dsc-panel-body" }, (0, react.createElement)(TabBoundary, {
				key: tab,
				t
			}, tab === "workflows" ? (0, react.createElement)(WorkflowsTab, { t }) : tab === "assets" ? (0, react.createElement)(AssetsTab, {
				t,
				onPreview: openPreview
			}) : (0, react.createElement)(QueueTab, {
				t,
				onPreview: openPreview
			}))), lightbox !== null ? (0, react.createElement)(Lightbox, {
				t,
				images: lightbox.images,
				kinds: lightbox.kinds,
				index: lightbox.index,
				onClose: () => setLightbox(null),
				onIndex: (index) => setLightbox({
					images: lightbox.images,
					kinds: lightbox.kinds,
					index
				})
			}) : null, (0, react.createElement)("div", {
				className: "dsc-panel-resize",
				onPointerDown: (event) => startDrag(event, "resize"),
				onPointerMove: (event) => moveDrag(event),
				onPointerUp: () => endDrag(),
				onPointerCancel: () => endDrag()
			}));
		}
		function TabButton(props) {
			return (0, react.createElement)("button", {
				className: props.active ? "dsc-tab dsc-tab--active" : "dsc-tab",
				onClick: props.onClick
			}, props.label);
		}
		function ErrorNote({ t, message }) {
			return (0, react.createElement)("div", { className: "dsc-err" }, `${t("error")}: ${message}`);
		}
		/**
		* Catches a tab's render error and shows it in place. Without this the host's
		* slot error boundary swallows the whole overlay silently, so a tab crash
		* reads as "clicking the button does nothing" with a clean console (Issue #5).
		*/
		var TabBoundary = class extends react.Component {
			state = { error: null };
			static getDerivedStateFromError(error) {
				return { error: error instanceof Error ? error : new Error(String(error)) };
			}
			componentDidCatch(error) {
				console.error("[dsh-comfyui] panel tab render error", error);
			}
			render() {
				if (this.state.error !== null) return (0, react.createElement)(ErrorNote, {
					t: this.props.t,
					message: this.state.error.message
				});
				return this.props.children;
			}
		};
		/** Load area at the bottom of the workflow library, modeled on the ComfyUI
		* LoadImage node — a list of **slots** rather than a single image.
		*
		* A lone slot stretches across the panel; from two slots on they share a
		* fixed width and wrap into rows. A slot is either filled with a file or
		* empty (added but not yet picked, or emptied through the picker's "空"
		* tile); the whole card is the pick button, and hovering reveals an × in the
		* corner that removes the slot. Filled slots feed the workflow's loader
		* parameters in order, so a run that takes two reference images picks up
		* slots 1 and 2 without the agent naming files. */
		function LoadArea(props) {
			const [slots, setSlots] = (0, react.useState)([]);
			const [files, setFiles] = (0, react.useState)([]);
			/** Slot index the picker is currently filling; null = picker closed. */
			const [pickerFor, setPickerFor] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const refresh = (0, react.useCallback)(async () => {
				const data = await fetch("/comfyui/loadarea").then((response) => response.json()).catch(() => void 0);
				if (data?.ok === true) {
					setSlots(data.slots ?? (data.current !== null && data.current !== void 0 ? [data.current] : []));
					setFiles(data.files ?? []);
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const post = async (body) => {
				setBusy(true);
				setError(null);
				try {
					const response = await fetch("/comfyui/current-image", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body)
					});
					const data = await response.json().catch(() => ({}));
					if (data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
					await refresh();
					return true;
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
					return false;
				} finally {
					setBusy(false);
				}
			};
			const upload = async (file) => {
				setBusy(true);
				setError(null);
				try {
					const name = await uploadDedup(file);
					const sizeText = await recordMediaSize(file, name);
					await refresh();
					props.onNotice(`${props.t("wfUploaded")}：${name}${sizeText !== void 0 ? `（${sizeText}）` : ""}`);
					return name;
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
					throw cause;
				} finally {
					setBusy(false);
				}
			};
			const pick = async (file) => {
				const index = pickerFor;
				setPickerFor(null);
				if (await post({
					name: file.name,
					kind: file.kind,
					source: file.source,
					...index !== null ? { index } : {}
				})) props.onNotice(`${props.t("wfLoadPicked")}：${file.name}`);
			};
			/** "＋ 添加加载区": opens a slot and goes straight to the picker for it, so
			* adding material is one gesture; closing the picker leaves the empty slot. */
			const addSlot = async () => {
				const index = slots.length;
				if (await post({ action: "addSlot" })) setPickerFor(index);
			};
			const loaded = slots.filter((slot) => slot !== null).length;
			return (0, react.createElement)("div", { className: "dsc-loadarea" }, (0, react.createElement)("div", { className: "dsc-loadarea-head" }, (0, react.createElement)("span", { className: "dsc-loadarea-title" }, props.t("wfLoadArea")), (0, react.createElement)("span", { className: "dsc-meta" }, slots.length === 0 ? props.t("wfLoadEmpty") : props.t("wfLoadSummary", {
				slots: slots.length,
				loaded
			}))), (0, react.createElement)("div", { className: "dsc-loadslots" }, slots.map((slot, index) => (0, react.createElement)(LoadSlot, {
				key: index,
				t: props.t,
				slot,
				index,
				busy,
				wide: slots.length === 1,
				onPick: () => setPickerFor(index),
				onRemove: () => {
					post({
						action: "removeSlot",
						index
					});
				}
			}))), (0, react.createElement)("div", { className: "dsc-toolbar" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => {
					addSlot();
				}
			}, props.t("wfLoadAddSlot"))), pickerFor !== null ? (0, react.createElement)(LoadPicker, {
				t: props.t,
				files,
				current: (pickerFor < slots.length ? slots[pickerFor]?.name : void 0) ?? null,
				onUpload: upload,
				onPick: pick,
				onClear: () => {
					const index = pickerFor;
					setPickerFor(null);
					post({
						action: "clear",
						index
					});
				},
				onClose: () => setPickerFor(null)
			}) : null, error !== null ? (0, react.createElement)("div", { className: "dsc-hint dsc-hint--error" }, error) : null);
		}
		/** One load-area slot card. The card is the pick button (empty slots show
		* "加载位 N / 添加素材"); the × in the corner, revealed on hover, removes the
		* slot. Emptying a slot without removing it is done from the picker's "空"
		* tile, so the card carries no button row of its own. */
		function LoadSlot(props) {
			const { t, slot, index } = props;
			const size = slot?.width !== void 0 && slot.height !== void 0 ? `（${slot.width}×${slot.height}）` : "";
			return (0, react.createElement)("div", { className: props.wide ? "dsc-loadslot dsc-loadslot--wide" : "dsc-loadslot" }, (0, react.createElement)("button", {
				className: "dsc-loadslot-pick",
				onClick: props.onPick,
				disabled: props.busy,
				title: slot !== null ? slot.name : t("wfLoadHint")
			}, slot === null ? (0, react.createElement)("span", { className: "dsc-loadslot-empty" }, (0, react.createElement)("span", { className: "dsc-loadslot-index" }, `${t("wfLoadSlotLabel")} ${index + 1}`), (0, react.createElement)("span", { className: "dsc-loadslot-add" }, t("wfLoadAddMedia"))) : slot.kind === "video" ? (0, react.createElement)("video", {
				className: "dsc-loadslot-media",
				src: slot.url,
				preload: "metadata",
				muted: true
			}) : slot.kind === "audio" ? (0, react.createElement)("span", { className: "dsc-loadslot-empty" }, "♪") : (0, react.createElement)("img", {
				className: "dsc-loadslot-media",
				src: slot.url,
				alt: "",
				loading: "lazy"
			}), slot !== null ? (0, react.createElement)("span", { className: "dsc-loadslot-name" }, `${slot.name}${size}`) : null), (0, react.createElement)("button", {
				className: "dsc-loadslot-x",
				disabled: props.busy,
				title: t("wfLoadRemoveSlot"),
				"aria-label": t("wfLoadRemoveSlot"),
				onClick: props.onRemove
			}, "×"));
		}
		/** The load-area picker dialog: tab bar (全部/已导入/已生成) with a
		* paste/click upload zone on the right, and a masonry image grid below. */
		function LoadPicker(props) {
			const [tab, setTab] = (0, react.useState)("all");
			const [type, setType] = (0, react.useState)("all");
			const hoverRef = (0, react.useRef)(false);
			const [uploadFlash, setUploadFlash] = (0, react.useState)(null);
			const [scrollTo, setScrollTo] = (0, react.useState)(null);
			const cardRefs = (0, react.useRef)(/* @__PURE__ */ new Map());
			const flashTimer = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => () => {
				if (flashTimer.current !== void 0) window.clearTimeout(flashTimer.current);
			}, []);
			(0, react.useEffect)(() => {
				const onPaste = (event) => {
					if (!hoverRef.current) return;
					const file = event.clipboardData?.files?.[0];
					if (file === void 0) return;
					event.preventDefault();
					handleUpload(file);
				};
				document.addEventListener("paste", onPaste);
				return () => document.removeEventListener("paste", onPaste);
			});
			/** Upload, then flash a confirmation and scroll the grid to the new file. */
			const handleUpload = async (file) => {
				try {
					const name = await props.onUpload(file);
					setScrollTo(name);
					setUploadFlash(`${props.t("wfUploadedToast")}：${name}`);
					if (flashTimer.current !== void 0) window.clearTimeout(flashTimer.current);
					flashTimer.current = window.setTimeout(() => setUploadFlash(null), 2500);
				} catch {}
			};
			const bySource = tab === "all" ? props.files : props.files.filter((file) => file.source === tab);
			const filtered = type === "all" ? bySource : bySource.filter((file) => file.kind === type);
			(0, react.useEffect)(() => {
				if (scrollTo === null) return;
				let found;
				for (const [key, el] of cardRefs.current) if (key.endsWith(`:${scrollTo}`)) {
					found = el;
					break;
				}
				if (found !== void 0) {
					found.scrollIntoView({
						block: "center",
						behavior: "smooth"
					});
					setScrollTo(null);
				}
			}, [scrollTo, filtered]);
			const columns = [
				[],
				[],
				[]
			];
			filtered.forEach((file, index) => {
				columns[index % 3].push(file);
			});
			const tabs = [
				{
					id: "all",
					label: props.t("wfTabAll")
				},
				{
					id: "imported",
					label: props.t("wfTabImported")
				},
				{
					id: "generated",
					label: props.t("wfTabGenerated")
				}
			];
			const typeOptions = [
				{
					id: "all",
					label: props.t("wfTypeAll")
				},
				{
					id: "image",
					label: props.t("uploadKind_image")
				},
				{
					id: "video",
					label: props.t("uploadKind_video")
				},
				{
					id: "audio",
					label: props.t("uploadKind_audio")
				}
			];
			return (0, react.createElement)("div", {
				className: "dsc-picker-overlay",
				onClick: props.onClose
			}, (0, react.createElement)("div", {
				className: "dsc-picker",
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("div", { className: "dsc-picker-bar" }, (0, react.createElement)("div", { className: "dsc-picker-tabs" }, tabs.map((entry) => (0, react.createElement)("button", {
				key: entry.id,
				className: `dsc-picker-tab${tab === entry.id ? " dsc-picker-tab--active" : ""}`,
				onClick: () => setTab(entry.id)
			}, entry.label))), (0, react.createElement)("label", {
				className: "dsc-dropzone dsc-picker-upload",
				title: props.t("wfPasteHint"),
				onMouseEnter: () => {
					hoverRef.current = true;
				},
				onMouseLeave: () => {
					hoverRef.current = false;
				},
				onDragOver: (event) => event.preventDefault(),
				onDrop: (event) => {
					event.preventDefault();
					const file = event.dataTransfer?.files?.[0];
					if (file !== void 0) handleUpload(file);
				}
			}, (0, react.createElement)("input", {
				type: "file",
				style: { display: "none" },
				onChange: (event) => {
					const file = event.target.files?.[0];
					if (file !== void 0) handleUpload(file);
					event.target.value = "";
				}
			}), props.t("wfPickerUpload")), (0, react.createElement)("select", {
				className: "dsc-picker-type",
				value: type,
				onChange: (event) => setType(event.target.value)
			}, typeOptions.map((option) => (0, react.createElement)("option", {
				key: option.id,
				value: option.id
			}, option.label)))), filtered.length === 0 && props.onClear === void 0 ? (0, react.createElement)("div", { className: "dsc-picker-empty" }, props.t("wfLoadNoFiles")) : (0, react.createElement)("div", { className: "dsc-picker-grid" }, columns.map((column, columnIndex) => (0, react.createElement)("div", {
				key: columnIndex,
				className: "dsc-picker-col"
			}, columnIndex === 0 && props.onClear !== void 0 ? (0, react.createElement)("div", {
				className: `dsc-picker-card dsc-picker-card--none${props.current === null ? " dsc-picker-card--active" : ""}`,
				role: "button",
				tabIndex: 0,
				onClick: () => props.onClear?.(),
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						props.onClear?.();
					}
				},
				title: props.t("wfLoadNoneHint")
			}, (0, react.createElement)("span", { className: "dsc-picker-thumb dsc-picker-thumb--media" }, "∅"), (0, react.createElement)("span", { className: "dsc-picker-name" }, props.t("wfLoadNone"))) : null, column.map((file) => (0, react.createElement)("div", {
				key: `${file.source}:${file.name}`,
				className: `dsc-picker-card${file.name === props.current ? " dsc-picker-card--active" : ""}`,
				role: "button",
				tabIndex: 0,
				onClick: () => {
					props.onPick(file);
				},
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						props.onPick(file);
					}
				},
				title: file.name,
				ref: (el) => {
					if (el !== null) cardRefs.current.set(`${file.source}:${file.name}`, el);
					else cardRefs.current.delete(`${file.source}:${file.name}`);
				}
			}, file.kind === "image" ? (0, react.createElement)("img", {
				className: "dsc-picker-thumb",
				src: file.url,
				alt: "",
				loading: "lazy"
			}) : file.kind === "video" ? (0, react.createElement)("video", {
				className: "dsc-picker-thumb dsc-picker-player",
				src: file.url,
				controls: true,
				preload: "metadata",
				onClick: (event) => event.stopPropagation()
			}) : (0, react.createElement)("audio", {
				className: "dsc-picker-player dsc-picker-player--audio",
				src: file.url,
				controls: true,
				preload: "metadata",
				onClick: (event) => event.stopPropagation()
			}), (0, react.createElement)("span", { className: "dsc-picker-name" }, file.name), file.width !== void 0 && file.height !== void 0 ? (0, react.createElement)("span", { className: "dsc-meta" }, `${file.width}×${file.height}`) : null))))), uploadFlash !== null ? (0, react.createElement)("div", { className: "dsc-picker-toast" }, uploadFlash) : null));
		}
		/** Tag editor: preset classification chips (图生图 etc.) toggle on/off, plus
		* free-form custom tags added with Enter and removed by clicking. */
		function TagEditor(props) {
			const [custom, setCustom] = (0, react.useState)("");
			const toggle = (tag) => {
				props.onChange(props.tags.includes(tag) ? props.tags.filter((entry) => entry !== tag) : [...props.tags, tag]);
			};
			const addCustom = () => {
				const tag = custom.trim();
				if (tag === "" || props.tags.includes(tag)) return;
				props.onChange([...props.tags, tag]);
				setCustom("");
			};
			const customTags = props.tags.filter((tag) => !PRESET_TAGS.includes(tag));
			return (0, react.createElement)("div", { className: "dsc-tag-editor" }, (0, react.createElement)("div", { className: "dsc-tag-row" }, PRESET_TAGS.map((tag) => (0, react.createElement)("button", {
				key: tag,
				className: `dsc-tag-chip${props.tags.includes(tag) ? " dsc-tag-chip--active" : ""}`,
				onClick: () => toggle(tag)
			}, tag))), customTags.length > 0 ? (0, react.createElement)("div", { className: "dsc-tag-row" }, customTags.map((tag) => (0, react.createElement)("button", {
				key: tag,
				className: "dsc-tag-chip dsc-tag-chip--active",
				title: props.t("wfTagRemove"),
				onClick: () => toggle(tag)
			}, `✕ ${tag}`))) : null, (0, react.createElement)("input", {
				className: "dsc-input dsc-input--sm dsc-tag-input",
				value: custom,
				placeholder: props.t("wfTagAdd"),
				onChange: (event) => setCustom(event.target.value),
				onKeyDown: (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						addCustom();
					}
				}
			}));
		}
		/**
		* The skill-pack editor for one workflow: attach/detach the pack, toggle the
		* run-time gate, and manage its files (SKILL.md plus references/ and scripts/).
		*
		* The pack is what `comfyui_workflow action: skill` hands the agent, so this
		* view is the only place its content is authored. Each file saves explicitly —
		* no autosave — because the model reads whatever is on disk the moment it asks.
		* SKILL.md is edited as a summary field plus a body: the `---` frontmatter that
		* carries the summary is composed on the host, never typed here.
		*/
		function SkillPackEditor(props) {
			const { t } = props;
			const [pack, setPack] = (0, react.useState)(null);
			const [enabled, setEnabled] = (0, react.useState)(props.workflow.skillDir !== void 0);
			const [active, setActive] = (0, react.useState)("SKILL.md");
			const [summary, setSummary] = (0, react.useState)("");
			const [text, setText] = (0, react.useState)("");
			const [dirty, setDirty] = (0, react.useState)(false);
			const [pendingOpen, setPendingOpen] = (0, react.useState)(null);
			const [creating, setCreating] = (0, react.useState)(null);
			const [creatingDir, setCreatingDir] = (0, react.useState)(null);
			const [presetDirs, setPresetDirs] = (0, react.useState)(SKILL_FALLBACK_DIRS);
			const [renaming, setRenaming] = (0, react.useState)(null);
			const [confirming, setConfirming] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)(null);
			/** Load one file into the editor; SKILL.md arrives pre-split into summary + body. */
			const openFile = (0, react.useCallback)(async (path) => {
				if (isSkillImage(path)) {
					setActive(path);
					setSummary("");
					setText("");
					setDirty(false);
					setError(null);
					return;
				}
				try {
					const data = await getJson(`/comfyui/workflows/skill?id=${encodeURIComponent(props.workflow.id)}&path=${encodeURIComponent(path)}`);
					if (data.ok !== true) {
						setError(data.error ?? t("skillReadFailed"));
						return;
					}
					setActive(path);
					if (path === "SKILL.md") {
						setSummary(data.summary ?? "");
						setText(data.body ?? "");
					} else {
						setSummary("");
						setText(data.content ?? "");
					}
					setDirty(false);
					setError(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, [props.workflow.id, t]);
			/** Re-read the pack listing, then the requested file. */
			const refresh = (0, react.useCallback)(async (path) => {
				try {
					const data = await getJson(`/comfyui/workflows/skill?id=${encodeURIComponent(props.workflow.id)}`);
					setEnabled(data.enabled === true);
					setPack(data.pack ?? null);
					if (Array.isArray(data.presetDirs) && data.presetDirs.length > 0) setPresetDirs(data.presetDirs);
					if (data.enabled === true) await openFile(path ?? "SKILL.md");
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, [props.workflow.id, openFile]);
			/** Re-read the pack listing and — only when nothing is unsaved — the file
			* currently open, so files added or replaced outside this panel (the agent
			* writing via comfyui_skill, or the file manager after `打开目录`) show up
			* without leaving and re-entering the view. */
			const refreshFiles = async () => {
				setBusy(true);
				setNotice(null);
				try {
					const data = await getJson(`/comfyui/workflows/skill?id=${encodeURIComponent(props.workflow.id)}`);
					setEnabled(data.enabled === true);
					setPack(data.pack ?? null);
					if (Array.isArray(data.presetDirs) && data.presetDirs.length > 0) setPresetDirs(data.presetDirs);
					setError(null);
					props.onChanged();
					if (data.enabled === true && !dirty) await openFile(active);
					setNotice(t("skillRefreshed"));
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			};
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			/** Every mutation goes through here so the listing and the flags stay in sync. */
			const mutate = async (body, after) => {
				setBusy(true);
				setNotice(null);
				try {
					const data = await postJson("/comfyui/workflows/skill", {
						id: props.workflow.id,
						...body
					});
					if (data.ok !== true) {
						setError(data.error ?? t("skillFailed"));
						return false;
					}
					setEnabled(data.enabled === true);
					setPack(data.pack ?? null);
					setError(null);
					props.onChanged();
					if (after !== void 0 && data.enabled === true) await openFile(after);
					return true;
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
					return false;
				} finally {
					setBusy(false);
				}
			};
			const saveFile = async () => {
				const body = {
					action: "write",
					path: active,
					content: text
				};
				if (active === "SKILL.md") body.summary = summary;
				const ok = await mutate(body);
				if (ok) {
					setDirty(false);
					setNotice(`${t("skillSaved")} ${active}`);
				}
				return ok;
			};
			/** Switching files with unsaved edits parks the request until the user decides. */
			const selectFile = (path) => {
				if (path === active) return;
				if (dirty) {
					setPendingOpen(path);
					return;
				}
				openFile(path);
			};
			const createFile = async () => {
				if (creating === null) return;
				const name = creating.name.trim();
				if (name === "") return;
				const path = `${creating.bucket}/${name.includes(".") ? name : `${name}.md`}`;
				if (await mutate({
					action: "write",
					path,
					content: ""
				}, path)) setCreating(null);
			};
			/** Open the pack directory in the desktop file manager (on the machine
			* running DSH — the hint says so, and the path stays visible below). */
			const revealDir = async () => {
				setNotice(null);
				try {
					const data = await postJson("/comfyui/workflows/skill/reveal", { id: props.workflow.id });
					if (data.ok !== true) {
						setError(data.error ?? t("skillFailed"));
						return;
					}
					setError(null);
					setNotice(`${t("skillRevealed")} ${data.dir ?? ""}`);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			};
			const createDir = async () => {
				if (creatingDir === null) return;
				const name = creatingDir.trim();
				if (name === "") return;
				if (await mutate({
					action: "mkdir",
					name
				})) {
					setCreatingDir(null);
					setNotice(`${t("skillDirCreated")} ${name}/`);
				}
			};
			const applyRename = async () => {
				if (renaming === null) return;
				const to = renaming.to.trim();
				if (to === "") return;
				const bucket = renaming.from.includes("/") ? `${renaming.from.split("/")[0] ?? ""}/` : "";
				const target = to.includes("/") ? to : `${bucket}${to}`;
				if (await mutate({
					action: "rename",
					path: renaming.from,
					to: target
				}, target)) setRenaming(null);
			};
			/** Import local files into the pack. The destination bucket comes from the
			* host (one extension rule, shared with the agent-facing listing), so the
			* panel only sends the name and the bytes. */
			const importFiles = async (files) => {
				if (files.length === 0) return;
				setBusy(true);
				setNotice(null);
				let imported = null;
				let failed = 0;
				for (const file of files) try {
					const bytes = await file.arrayBuffer();
					const data = await postRaw(`/comfyui/workflows/skill/import?id=${encodeURIComponent(props.workflow.id)}&name=${encodeURIComponent(file.name)}`, bytes);
					if (data.ok !== true) {
						failed += 1;
						setError(data.error ?? t("skillFailed"));
						continue;
					}
					setPack(data.pack ?? null);
					imported = data.path ?? null;
				} catch (cause) {
					failed += 1;
					setError(cause instanceof Error ? cause.message : String(cause));
				}
				setBusy(false);
				props.onChanged();
				if (imported !== null) {
					if (failed === 0) {
						setError(null);
						setNotice(`${t("skillImported")} ${imported}`);
					}
					await openFile(imported);
				}
			};
			const head = (0, react.createElement)("div", { className: "dsc-view-head" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: props.onBack
			}, t("wfViewBack")), (0, react.createElement)("div", {
				className: "dsc-wf-name",
				title: props.workflow.name
			}, `${t("skillTitle")} · ${props.workflow.name}`));
			if (!enabled) return (0, react.createElement)("div", null, head, (0, react.createElement)("div", { className: "dsc-hint" }, t("skillIntro")), error !== null ? (0, react.createElement)(ErrorNote, {
				t,
				message: error
			}) : null, (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => void mutate({ action: "enable" }, "SKILL.md")
			}, t("skillEnable"))));
			const files = pack?.files ?? [];
			const impliedDirs = files.filter((file) => file.path.includes("/")).map((file) => file.path.split("/")[0] ?? "").filter((dir) => dir !== "");
			const packDirs = [.../* @__PURE__ */ new Set([...pack?.dirs ?? [], ...impliedDirs])].sort((a, b) => a.localeCompare(b));
			const buckets = [{
				label: "",
				items: files.filter((file) => !file.path.includes("/"))
			}, ...packDirs.map((bucket) => ({
				label: bucket,
				items: files.filter((file) => file.path.startsWith(`${bucket}/`))
			}))];
			/** Where a new file may go: the pack's own directories first, then the
			* presets it has not used yet. */
			const targetDirs = [...packDirs, ...presetDirs.filter((dir) => !packDirs.includes(dir))];
			/** One row in the pack file list; clicking opens it for editing. */
			const fileButton = (file) => (0, react.createElement)("button", {
				key: file.path,
				className: `dsc-skill-file${file.path === active ? " dsc-skill-file--active" : ""}`,
				onClick: () => selectFile(file.path)
			}, (0, react.createElement)("span", { className: "dsc-skill-file-name" }, file.path.includes("/") ? file.path.split("/")[1] : file.path), (0, react.createElement)("span", { className: "dsc-skill-file-size" }, formatBytes(file.size)));
			const fileList = (0, react.createElement)("div", {
				className: "dsc-skill-files",
				onDragOver: (event) => event.preventDefault(),
				onDrop: (event) => {
					event.preventDefault();
					const dropped = Array.from(event.dataTransfer?.files ?? []);
					if (dropped.length > 0) importFiles(dropped);
				}
			}, (0, react.createElement)("div", { className: "dsc-skill-actions" }, (0, react.createElement)("label", {
				className: "dsc-btn dsc-btn--sm",
				title: t("skillImportHint")
			}, t("skillImport"), (0, react.createElement)("input", {
				type: "file",
				multiple: true,
				style: { display: "none" },
				disabled: busy,
				onChange: (event) => {
					const picked = Array.from(event.target.files ?? []);
					event.target.value = "";
					if (picked.length > 0) importFiles(picked);
				}
			})), creating === null ? (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				disabled: busy,
				onClick: () => {
					setCreatingDir(null);
					setCreating({
						bucket: targetDirs[0] ?? "references",
						name: ""
					});
				}
			}, t("skillNewFile")) : null, creatingDir === null ? (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				disabled: busy,
				onClick: () => {
					setCreating(null);
					setCreatingDir("");
				}
			}, t("skillNewDir")) : null, (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				disabled: busy,
				title: t("skillRevealHint"),
				onClick: () => void revealDir()
			}, t("skillReveal")), (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				disabled: busy,
				title: t("skillRefreshHint"),
				onClick: () => void refreshFiles()
			}, t("skillRefresh"))), creatingDir === null ? null : (0, react.createElement)("div", { className: "dsc-skill-create" }, (0, react.createElement)("input", {
				className: "dsc-input dsc-input--sm",
				value: creatingDir,
				placeholder: t("skillNewDirPlaceholder"),
				onChange: (event) => setCreatingDir(event.target.value),
				onKeyDown: (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						createDir();
					}
				}
			}), (0, react.createElement)("div", { className: "dsc-hint" }, t("skillNewDirHint", { presets: presetDirs.join(" / ") })), (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				disabled: busy,
				onClick: () => void createDir()
			}, t("skillCreate")), (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				onClick: () => setCreatingDir(null)
			}, t("cancel")))), (0, react.createElement)("div", { className: "dsc-skill-drop-hint" }, t("skillDropHint")), buckets.map((bucket) => bucket.items.length === 0 && bucket.label !== "" ? null : bucket.label === "" ? (0, react.createElement)("div", {
				key: ".",
				className: "dsc-skill-bucket"
			}, bucket.items.map(fileButton)) : (0, react.createElement)("details", {
				key: bucket.label,
				className: "dsc-fold dsc-skill-fold",
				open: true
			}, (0, react.createElement)("summary", null, `${bucket.label}/`), (0, react.createElement)("div", { className: "dsc-skill-bucket" }, bucket.items.map(fileButton)))), creating === null ? null : (0, react.createElement)("div", { className: "dsc-skill-create" }, (0, react.createElement)("select", {
				className: "dsc-input dsc-input--sm",
				value: creating.bucket,
				onChange: (event) => setCreating({
					...creating,
					bucket: event.target.value
				})
			}, targetDirs.map((bucket) => (0, react.createElement)("option", {
				key: bucket,
				value: bucket
			}, `${bucket}/`))), (0, react.createElement)("input", {
				className: "dsc-input dsc-input--sm",
				value: creating.name,
				placeholder: t("skillNewPlaceholder"),
				onChange: (event) => setCreating({
					...creating,
					name: event.target.value
				}),
				onKeyDown: (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						createFile();
					}
				}
			}), (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				disabled: busy,
				onClick: () => void createFile()
			}, t("skillCreate")), (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				onClick: () => setCreating(null)
			}, t("cancel")))));
			const editor = (0, react.createElement)("div", { className: "dsc-skill-main" }, (0, react.createElement)("div", { className: "dsc-skill-editor-head" }, (0, react.createElement)("span", { className: "dsc-skill-path" }, active), dirty ? (0, react.createElement)("span", { className: "dsc-badge dsc-badge--warn" }, t("skillDirty")) : null), active === "SKILL.md" ? (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("skillSummary")), (0, react.createElement)("input", {
				className: "dsc-input",
				value: summary,
				placeholder: t("skillSummaryPlaceholder"),
				onChange: (event) => {
					setSummary(event.target.value);
					setDirty(true);
				}
			}), (0, react.createElement)("div", { className: "dsc-hint" }, t("skillSummaryHint"))) : null, isSkillImage(active) ? (0, react.createElement)("div", { className: "dsc-skill-preview" }, (0, react.createElement)("img", {
				src: `/comfyui/workflows/skill/raw?id=${encodeURIComponent(props.workflow.id)}&path=${encodeURIComponent(active)}`,
				alt: active
			}), (0, react.createElement)("div", { className: "dsc-hint" }, t("skillImageHint"))) : (0, react.createElement)("textarea", {
				className: "dsc-textarea dsc-textarea--skill",
				value: text,
				spellCheck: false,
				onChange: (event) => {
					setText(event.target.value);
					setDirty(true);
				},
				onKeyDown: (event) => {
					if (event.key !== "Tab") return;
					event.preventDefault();
					const area = event.target;
					const start = area.selectionStart;
					const end = area.selectionEnd;
					setText(`${text.slice(0, start)}  ${text.slice(end)}`);
					setDirty(true);
					window.requestAnimationFrame(() => {
						area.selectionStart = start + 2;
						area.selectionEnd = start + 2;
					});
				}
			}), (0, react.createElement)("div", { className: "dsc-row" }, isSkillImage(active) ? null : (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy || !dirty,
				onClick: () => void saveFile()
			}, t("skillSave")), active !== "SKILL.md" ? (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => setRenaming({
					from: active,
					to: active.includes("/") ? active.split("/")[1] ?? "" : active
				})
			}, t("skillRename")) : null, active !== "SKILL.md" ? (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => setConfirming(active)
			}, t("skillDeleteFile")) : null), confirming !== null && confirming !== "*pack*" ? (0, react.createElement)("div", { className: "dsc-dialog dsc-dialog--danger" }, (0, react.createElement)("div", { className: "dsc-dialog-head dsc-danger-text" }, `${t("skillDeleteConfirm")} ${confirming}`), (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--danger",
				disabled: busy,
				onClick: () => {
					const target = confirming;
					setConfirming(null);
					mutate({
						action: "delete",
						path: target
					}, "SKILL.md");
				}
			}, t("confirmDelete")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => setConfirming(null)
			}, t("cancel")))) : null, renaming !== null ? (0, react.createElement)("div", { className: "dsc-skill-create" }, (0, react.createElement)("input", {
				className: "dsc-input dsc-input--sm",
				value: renaming.to,
				onChange: (event) => setRenaming({
					...renaming,
					to: event.target.value
				})
			}), (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				disabled: busy,
				onClick: () => void applyRename()
			}, t("skillRename")), (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				onClick: () => setRenaming(null)
			}, t("cancel")))) : null);
			return (0, react.createElement)("div", null, head, (0, react.createElement)("div", { className: "dsc-row dsc-skill-flags" }, (0, react.createElement)("label", { className: "dsc-check" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: pack?.required === true,
				disabled: busy,
				onChange: (event) => void mutate({
					action: "require",
					required: event.target.checked
				})
			}), t("skillRequired"))), pack !== null ? (0, react.createElement)("div", {
				className: "dsc-skill-dir",
				title: pack.dir
			}, `${t("skillDir")}: ${pack.dir}`) : null, pendingOpen !== null ? (0, react.createElement)("div", { className: "dsc-dialog" }, (0, react.createElement)("div", { className: "dsc-dialog-head" }, t("skillDirtyPrompt")), (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => {
					const target = pendingOpen;
					setPendingOpen(null);
					saveFile().then((ok) => {
						if (ok) openFile(target);
					});
				}
			}, t("skillSaveAndSwitch")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => {
					const target = pendingOpen;
					setPendingOpen(null);
					setDirty(false);
					openFile(target);
				}
			}, t("skillDiscard")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => setPendingOpen(null)
			}, t("cancel")))) : null, notice !== null ? (0, react.createElement)("div", { className: "dsc-ok" }, notice) : null, error !== null ? (0, react.createElement)(ErrorNote, {
				t,
				message: error
			}) : null, (0, react.createElement)("div", { className: "dsc-skill" }, fileList, editor), (0, react.createElement)("div", { className: "dsc-skill-footer" }, (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => void mutate({ action: "disable" }).then(() => props.onBack())
			}, t("skillDetach")), (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--danger",
				disabled: busy,
				onClick: () => setConfirming("*pack*")
			}, t("skillDestroy"))), confirming === "*pack*" ? (0, react.createElement)("div", { className: "dsc-dialog dsc-dialog--danger" }, (0, react.createElement)("div", { className: "dsc-dialog-head dsc-danger-text" }, t("skillDestroyConfirm", { count: pack?.files.length ?? 0 })), (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--danger",
				disabled: busy,
				onClick: () => {
					setConfirming(null);
					mutate({ action: "destroy" }).then(() => props.onBack());
				}
			}, t("skillDestroyConfirmButton")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => setConfirming(null)
			}, t("cancel")))) : null));
		}
		function WorkflowsTab({ t }) {
			const [list, setList] = (0, react.useState)(null);
			const [comfyui, setComfyui] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [comfyuiError, setComfyuiError] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)(null);
			const [editing, setEditing] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [viewing, setViewing] = (0, react.useState)(null);
			const [extract, setExtract] = (0, react.useState)(null);
			/** Open transfer dialog: 'export' | 'import', null = closed. */
			const [transfer, setTransfer] = (0, react.useState)(null);
			const [tagFilter, setTagFilter] = (0, react.useState)(null);
			const [skillFor, setSkillFor] = (0, react.useState)(null);
			/** A delete waiting on the user's answer about the workflow's skill pack. */
			const [deleting, setDeleting] = (0, react.useState)(null);
			const load = async () => {
				try {
					setList(await getList("/comfyui/workflows", "workflows"));
					setError(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
				try {
					setComfyui(await getList("/comfyui/comfy-workflows", "workflows"));
					setComfyuiError(null);
				} catch (cause) {
					setComfyuiError(cause instanceof Error ? cause.message : String(cause));
				}
			};
			(0, react.useEffect)(() => {
				let cancelled = false;
				getList("/comfyui/workflows", "workflows").then((workflows) => {
					if (!cancelled) setList(workflows);
				}).catch((cause) => {
					if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
				});
				getList("/comfyui/comfy-workflows", "workflows").then((workflows) => {
					if (!cancelled) setComfyui(workflows);
				}).catch((cause) => {
					if (!cancelled) setComfyuiError(cause instanceof Error ? cause.message : String(cause));
				});
				return () => {
					cancelled = true;
				};
			}, []);
			/** Persist the current draft; returns the saved workflow id, or null on failure (error already set). */
			const persist = async () => {
				if (editing === null) return null;
				setBusy(true);
				setError(null);
				setNotice(null);
				let workflow;
				if (typeof editing.workflow === "string") try {
					workflow = JSON.parse(editing.workflow);
				} catch {
					setError(t("wfJsonError"));
					setBusy(false);
					return null;
				}
				else workflow = editing.workflow;
				try {
					const body = {
						name: String(editing.name ?? ""),
						description: String(editing.description ?? ""),
						workflow,
						parameters: editing.parameters ?? [],
						tags: editing.tags ?? []
					};
					if (editing.id !== void 0) body.id = editing.id;
					return (await postJson("/comfyui/workflows", body)).workflow?.id ?? (typeof editing.id === "string" ? editing.id : null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
					return null;
				} finally {
					setBusy(false);
				}
			};
			const save = async () => {
				if (await persist() === null) return;
				setEditing(null);
				await load();
			};
			/** Save the draft, then immediately queue it with the saved parameters. */
			const saveAndRun = async () => {
				const id = await persist();
				if (id === null) return;
				setEditing(null);
				await load();
				await run(id);
			};
			const run = async (id) => {
				setBusy(true);
				setError(null);
				setNotice(null);
				try {
					const result = await postJson("/comfyui/workflows/run", { id });
					setNotice(`${t("wfQueued")} ${shortId(result.promptId)}`);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			};
			/** Delete a workflow. A workflow carrying a skill pack asks first: the pack
			* holds hand-written notes that nothing else can restore. */
			const remove = async (id, deleteSkill = false) => {
				setBusy(true);
				setError(null);
				try {
					await postJson("/comfyui/workflows/delete", {
						id,
						deleteSkill
					});
					await load();
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			};
			const requestRemove = (workflow) => {
				if (workflow.skillDir !== void 0) {
					setDeleting(workflow);
					return;
				}
				remove(workflow.id);
			};
			const openExtract = (file) => {
				setError(null);
				setExtract({
					file,
					analysis: null,
					error: null,
					mode: "split"
				});
			};
			const runExtract = async (state) => {
				setBusy(true);
				try {
					const data = await postJson("/comfyui/comfy-workflows/extract", {
						file: state.file,
						mode: state.mode
					});
					if (data.ok !== true) throw new Error(data.error ?? "failed to extract");
					setNotice(`${state.file} → ${t("wfExtractedNotice")}${data.warnings.length > 0 ? `（${t("error")}: ${data.warnings.join("；")}）` : ""}`);
					setExtract(null);
					await load();
				} catch (cause) {
					setExtract({
						...state,
						error: cause instanceof Error ? cause.message : String(cause)
					});
				} finally {
					setBusy(false);
				}
			};
			const importFile = (file) => {
				const reader = new FileReader();
				reader.onload = () => {
					try {
						const parsed = JSON.parse(String(reader.result));
						setEditing({
							name: file.name.replace(/\.json$/i, ""),
							workflow: parsed
						});
						setError(null);
					} catch {
						setError(t("wfJsonError"));
					}
				};
				reader.readAsText(file);
			};
			const view = async (file) => {
				setBusy(true);
				setError(null);
				try {
					const data = await getJson(`/comfyui/comfy-workflows?file=${encodeURIComponent(file)}`);
					if (data.ok !== true || data.workflow === void 0) throw new Error(data.error ?? "failed to read workflow");
					setViewing({
						file,
						graph: data.workflow
					});
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			};
			if (skillFor !== null) return (0, react.createElement)(SkillPackEditor, {
				t,
				workflow: skillFor,
				onBack: () => {
					setSkillFor(null);
					load();
				},
				onChanged: () => {
					load();
				}
			});
			if (viewing !== null) return (0, react.createElement)(WorkflowView, {
				t,
				file: viewing.file,
				graph: viewing.graph,
				onBack: () => setViewing(null)
			});
			if (extract !== null) return (0, react.createElement)(ExtractDialog, {
				t,
				state: extract,
				onUpdate: setExtract,
				onRun: (state) => runExtract(state),
				onClose: () => setExtract(null)
			});
			if (transfer === "export") return (0, react.createElement)(ExportDialog, {
				t,
				workflows: list ?? [],
				onClose: () => setTransfer(null),
				onDone: (notice) => {
					setTransfer(null);
					setNotice(notice);
					load();
				}
			});
			if (transfer === "import") return (0, react.createElement)(ImportDialog, {
				t,
				onClose: () => setTransfer(null),
				onDone: (notice) => {
					setTransfer(null);
					setNotice(notice);
					load();
				}
			});
			if (error !== null) return (0, react.createElement)("div", null, (0, react.createElement)(ErrorNote, {
				t,
				message: error
			}));
			if (list === null) return (0, react.createElement)("div", { className: "dsc-meta" }, "…");
			if (editing !== null) return (0, react.createElement)("div", { className: "dsc-form" }, (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("wfName")), (0, react.createElement)("input", {
				className: "dsc-input",
				value: editing.name ?? "",
				onChange: (event) => setEditing({
					...editing,
					name: event.target.value
				})
			})), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("wfDesc")), (0, react.createElement)("textarea", {
				className: "dsc-textarea",
				placeholder: t("wfDescPlaceholder"),
				value: editing.description ?? "",
				onChange: (event) => setEditing({
					...editing,
					description: event.target.value
				})
			})), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("wfTags")), (0, react.createElement)(TagEditor, {
				t,
				tags: editing.tags ?? [],
				onChange: (tags) => setEditing({
					...editing,
					tags
				})
			})), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("wfParams")), (0, react.createElement)(ParameterEditor, {
				t,
				params: editing.parameters ?? [],
				workflow: parseDraftWorkflow(editing.workflow),
				onChange: (parameters) => setEditing({
					...editing,
					parameters
				})
			})), (0, react.createElement)("div", { className: "dsc-field" }, (0, react.createElement)("label", null, t("wfJson")), (0, react.createElement)("textarea", {
				className: "dsc-textarea dsc-textarea--json",
				value: typeof editing.workflow === "string" ? editing.workflow : JSON.stringify(editing.workflow ?? {}, null, 2),
				onChange: (event) => setEditing({
					...editing,
					workflow: event.target.value
				})
			})), notice !== null ? (0, react.createElement)("div", { className: "dsc-ok" }, notice) : null, error !== null ? (0, react.createElement)(ErrorNote, {
				t,
				message: error
			}) : null, (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => void save()
			}, t("wfSave")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => void saveAndRun()
			}, t("wfSaveRun")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => {
					setEditing(null);
					setError(null);
				}
			}, t("wfCancel"))));
			const comfyuiFold = (0, react.createElement)("details", { className: "dsc-fold" }, (0, react.createElement)("summary", null, `${t("wfComfyuiSection")} (${comfyui?.length ?? 0})`), (0, react.createElement)("div", { className: "dsc-fold-body" }, (0, react.createElement)("div", { className: "dsc-hint" }, t("wfComfyuiHint")), comfyuiError !== null ? (0, react.createElement)(ErrorNote, {
				t,
				message: comfyuiError
			}) : null, comfyui === null ? (0, react.createElement)("div", { className: "dsc-meta" }, "…") : comfyui.length === 0 ? (0, react.createElement)("div", { className: "dsc-meta" }, t("wfComfyuiEmpty")) : (0, react.createElement)("div", { className: "dsc-list" }, comfyui.map((workflow) => (0, react.createElement)("div", {
				key: workflow.name,
				className: "dsc-wf dsc-wf--comfyui",
				title: t("wfNameCopyHint"),
				onClick: () => {
					copyText(workflow.name).then((ok) => {
						if (ok) setNotice(`${t("wfNameCopied")}：${workflow.name}`);
					});
				}
			}, (0, react.createElement)("div", { className: "dsc-wf-col" }, (0, react.createElement)("div", {
				className: "dsc-wf-name",
				title: workflow.name
			}, workflow.name), (0, react.createElement)("div", { className: "dsc-wf-actions" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: (event) => {
					event.stopPropagation();
					view(workflow.name);
				}
			}, t("wfView")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: (event) => {
					event.stopPropagation();
					openExtract(workflow.name);
				}
			}, t("wfExtract"))), (0, react.createElement)("div", { className: "dsc-meta" }, [formatBytes(workflow.size), workflow.modified !== void 0 ? formatTs(new Date(workflow.modified).toISOString()) : ""].filter(Boolean).join(" · "))), (0, react.createElement)("span", { className: workflow.extracted ? "dsc-badge dsc-badge--ok" : "dsc-badge dsc-badge--warn" }, workflow.extracted ? `${t("wfExtracted")} ${workflow.derived.length}` : t("wfNotExtracted")))))));
			const tagCounts = /* @__PURE__ */ new Map();
			for (const workflow of list) for (const tag of workflow.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
			const visibleTags = [...tagCounts.entries()].sort((a, b) => {
				const pa = PRESET_TAGS.indexOf(a[0]);
				const pb = PRESET_TAGS.indexOf(b[0]);
				if (pa !== -1 && pb !== -1) return pa - pb;
				if (pa !== -1) return -1;
				if (pb !== -1) return 1;
				return b[1] - a[1];
			}).map(([tag]) => tag);
			const visibleList = tagFilter === null ? list : list.filter((workflow) => (workflow.tags ?? []).includes(tagFilter));
			const apiFold = (0, react.createElement)("details", {
				className: "dsc-fold",
				open: true
			}, (0, react.createElement)("summary", null, `${t("wfLibrarySection")} (${visibleList.length})`), (0, react.createElement)("div", { className: "dsc-fold-body" }, visibleTags.length > 0 || tagFilter !== null ? (0, react.createElement)("div", { className: "dsc-tag-filter" }, (0, react.createElement)("select", {
				className: "dsc-input dsc-input--inline",
				title: t("wfTags"),
				value: tagFilter ?? "",
				onChange: (event) => setTagFilter(event.target.value === "" ? null : event.target.value)
			}, (0, react.createElement)("option", { value: "" }, `${t("wfTagAll")} (${list.length})`), visibleTags.map((tag) => (0, react.createElement)("option", {
				key: tag,
				value: tag
			}, `${tag} (${tagCounts.get(tag) ?? 0})`)))) : null, visibleList.length === 0 ? (0, react.createElement)("div", { className: "dsc-meta" }, t("wfEmpty")) : (0, react.createElement)("div", { className: "dsc-list" }, visibleList.map((workflow) => (0, react.createElement)("div", {
				key: workflow.id,
				className: "dsc-wf",
				title: t("wfNameCopyHint"),
				onClick: () => {
					copyText(workflow.name).then((ok) => {
						if (ok) setNotice(`${t("wfNameCopied")}：${workflow.name}`);
					});
				}
			}, (0, react.createElement)("div", { className: "dsc-wf-top" }, (0, react.createElement)("div", {
				className: "dsc-wf-name",
				title: workflow.name
			}, workflow.name), (workflow.tags ?? []).length > 0 ? (0, react.createElement)("div", { className: "dsc-wf-tags" }, (workflow.tags ?? []).map((tag) => (0, react.createElement)("span", {
				key: tag,
				className: "dsc-tag-chip dsc-tag-chip--mini"
			}, tag))) : null, workflow.skillDir !== void 0 ? (0, react.createElement)("span", {
				className: "dsc-badge dsc-badge--ok",
				title: t("skillBadgeHint")
			}, workflow.requireSkill === true ? t("skillBadgeRequired") : t("skillBadge")) : null), workflow.description !== "" ? (0, react.createElement)("div", { className: "dsc-wf-desc" }, workflow.description) : null, (0, react.createElement)("div", { className: "dsc-wf-updated" }, `${t("wfUpdated")} ${formatTs(workflow.updatedAt)}`), (0, react.createElement)("div", { className: "dsc-wf-actions" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: (event) => {
					event.stopPropagation();
					run(workflow.id);
				}
			}, t("wfRun")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: (event) => {
					event.stopPropagation();
					setEditing({
						...workflow,
						workflow: JSON.stringify(workflow.workflow, null, 2),
						parameters: workflow.parameters ?? [],
						tags: workflow.tags ?? []
					});
					setError(null);
				}
			}, t("wfEdit")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: (event) => {
					event.stopPropagation();
					setSkillFor(workflow);
					setError(null);
				}
			}, t("skillButton")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: (event) => {
					event.stopPropagation();
					requestRemove(workflow);
				}
			}, t("wfDelete"))), deleting?.id === workflow.id ? (0, react.createElement)("div", {
				className: "dsc-dialog dsc-dialog--danger",
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("div", { className: "dsc-dialog-head dsc-danger-text" }, t("skillDeleteWithWorkflow")), (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--danger",
				disabled: busy,
				onClick: () => {
					setDeleting(null);
					remove(workflow.id, true);
				}
			}, t("skillDeleteBoth")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => {
					setDeleting(null);
					remove(workflow.id, false);
				}
			}, t("skillKeepPack")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => setDeleting(null)
			}, t("cancel")))) : null)))));
			return (0, react.createElement)("div", null, (0, react.createElement)("div", { className: "dsc-toolbar" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => {
					setEditing({
						workflow: {},
						parameters: [],
						tags: []
					});
					setError(null);
				}
			}, t("wfAdd")), (0, react.createElement)("label", { className: "dsc-btn" }, t("wfImportFile"), (0, react.createElement)("input", {
				type: "file",
				accept: ".json,application/json",
				style: { display: "none" },
				onChange: (event) => {
					const file = event.target.files?.[0];
					if (file !== void 0) importFile(file);
					event.target.value = "";
				}
			})), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => {
					setError(null);
					setTransfer("export");
				}
			}, t("exportPresets")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => {
					setError(null);
					setTransfer("import");
				}
			}, t("importPresets")), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: () => void load()
			}, t("wfRefresh"))), notice !== null ? (0, react.createElement)("div", { className: "dsc-ok" }, notice) : null, comfyuiFold, apiFold, (0, react.createElement)(LoadArea, {
				t,
				onNotice: setNotice
			}));
		}
		/** Extract-mode chooser: shows the canvas analysis and lets the user pick how
		* to extract runnable API workflows from a ComfyUI-side graph. */
		function ExtractDialog(props) {
			const { t, state, onUpdate, onRun, onClose } = props;
			(0, react.useEffect)(() => {
				if (state.analysis === null && state.error === null) {
					let cancelled = false;
					getJson(`/comfyui/comfy-workflows/analyze?file=${encodeURIComponent(state.file)}`).then((data) => {
						if (cancelled) return;
						if (data.ok !== true || data.analysis === void 0) onUpdate({
							...state,
							error: data.error ?? "failed to analyze"
						});
						else if (data.analysis.ok !== true) onUpdate({
							...state,
							error: data.analysis.error
						});
						else onUpdate({
							...state,
							analysis: data.analysis,
							mode: data.analysis.mode === "single" ? "all" : "split"
						});
					}).catch((cause) => {
						if (!cancelled) onUpdate({
							...state,
							error: cause instanceof Error ? cause.message : String(cause)
						});
					});
					return () => {
						cancelled = true;
					};
				}
			});
			const modes = [
				{
					mode: "all",
					label: t("wfExtractModeAll"),
					hint: t("wfExtractModeAllHint")
				},
				{
					mode: "split",
					label: t("wfExtractModeSplit"),
					hint: t("wfExtractModeSplitHint")
				},
				{
					mode: "main",
					label: t("wfExtractModeMain"),
					hint: t("wfExtractModeMainHint")
				}
			];
			const analysis = state.analysis;
			return (0, react.createElement)("div", { className: "dsc-dialog" }, (0, react.createElement)("div", { className: "dsc-dialog-head" }, (0, react.createElement)("span", { className: "dsc-wf-name" }, `${t("wfExtractTitle")}: ${state.file}`), (0, react.createElement)("button", {
				className: "dsc-panel-close",
				"aria-label": t("close"),
				onClick: onClose
			}, "✕")), analysis === null ? (0, react.createElement)("div", { className: "dsc-meta" }, "…") : (0, react.createElement)("div", null, (0, react.createElement)("div", { className: "dsc-hint" }, `${t("wfComponents")}: ${analysis.components.length} · ${t("wfBypassed")}: ${analysis.bypassedCount} · ${t("wfIsolated")}: ${analysis.isolated.length}`), analysis.components.length > 0 ? (0, react.createElement)("ul", { className: "dsc-node-list" }, analysis.components.map((component) => (0, react.createElement)("li", { key: String(component.index) }, `${t("wfComponentLabel")} ${component.index}（${component.size} ${t("wfNodes")}）${component.groups.length > 0 ? `[${component.groups.slice(0, 3).join("+")}]` : ""}`))) : (0, react.createElement)("div", { className: "dsc-meta" }, t("wfExtractEmpty")), (0, react.createElement)("div", { className: "dsc-extract-modes" }, modes.map((entry) => (0, react.createElement)("label", {
				key: entry.mode,
				className: "dsc-mode"
			}, (0, react.createElement)("input", {
				type: "radio",
				name: "extract-mode",
				checked: state.mode === entry.mode,
				onChange: () => onUpdate({
					...state,
					mode: entry.mode
				})
			}), (0, react.createElement)("span", { className: "dsc-mode-label" }, entry.label), (0, react.createElement)("span", { className: "dsc-hint" }, entry.hint)))), state.error !== null ? (0, react.createElement)(ErrorNote, {
				t,
				message: state.error
			}) : null, (0, react.createElement)("div", { className: "dsc-row" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: analysis.components.length === 0,
				onClick: () => void onRun(state)
			}, t("wfExtractRun")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: onClose
			}, t("wfCancel")))));
		}
		/** Shared checkbox row for the transfer dialogs: name, badges, description. */
		function TransferItem(props) {
			return (0, react.createElement)("label", { className: "dsc-transfer-item" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: props.checked,
				onChange: props.onToggle
			}), (0, react.createElement)("span", {
				className: "dsc-transfer-item-name",
				title: props.name
			}, props.name), props.paramBadge !== null ? (0, react.createElement)("span", { className: "dsc-badge" }, props.paramBadge) : null, props.skillBadge !== null ? (0, react.createElement)("span", { className: "dsc-badge dsc-badge--ok" }, props.skillBadge) : null, props.description !== "" ? (0, react.createElement)("span", {
				className: "dsc-transfer-item-desc",
				title: props.description
			}, props.description) : null, props.warnings.length > 0 ? (0, react.createElement)("span", {
				className: "dsc-transfer-item-desc dsc-danger-text",
				title: props.warnings.join("；")
			}, props.warnings.join("；")) : null);
		}
		/** While a transfer dialog is open, swallow drag events aimed at the host
		* page. The conversation shell attaches dropped files to the chat with
		* document-level bubble listeners, so dragging a preset toward the dialog
		* also dropped it into the conversation. Window-capture listeners run before
		* any document-bubble handler and shield everything OUTSIDE the dialog;
		* events landing inside the dialog pass through — the dialog box itself must
		* stopPropagation() them at React's dispatch root, or they bubble on to the
		* document and the shell attaches the file anyway. */
		function DragGuard() {
			(0, react.useEffect)(() => {
				const guard = (event) => {
					if (event.target instanceof Element && event.target.closest(".dsc-transfer") !== null) return;
					event.preventDefault();
					event.stopPropagation();
				};
				for (const type of [
					"dragenter",
					"dragover",
					"drop"
				]) window.addEventListener(type, guard, true);
				return () => {
					for (const type of [
						"dragenter",
						"dragover",
						"drop"
					]) window.removeEventListener(type, guard, true);
				};
			}, []);
			return null;
		}
		/** Export dialog: pick library workflows (checkboxes + select-all, all
		* pre-selected) and download one preset package. Packaging happens host-side;
		* the dialog lists, selects, and submits a native form download. */
		function ExportDialog(props) {
			const { t, workflows } = props;
			const [selected, setSelected] = (0, react.useState)(() => new Set(workflows.map((workflow) => workflow.id)));
			const [busy, setBusy] = (0, react.useState)(false);
			const toggle = (id) => {
				setSelected((prev) => {
					const next = new Set(prev);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
			};
			const allSelected = workflows.length > 0 && selected.size === workflows.length;
			const toggleAll = () => {
				setSelected(allSelected ? /* @__PURE__ */ new Set() : new Set(workflows.map((workflow) => workflow.id)));
			};
			/** Download natively: a hidden form GETs `/comfyui/workflows/export/<file
			* name>?ids=…` and the server answers with `content-disposition:
			* attachment`, so the browser — not JS blob plumbing (fetch → blob →
			* objectURL → revoke, which one environment turned into a 0-byte file) —
			* owns the transfer. The page never navigates because the response is an
			* attachment.
			*
			* GET with the name in the path is deliberate: this setup's download
			* manager mangles POST downloads (renames them, or re-fetches the URL on
			* its own), which is where the phantom "skills sometimes missing" zips
			* came from. A GET is the one verb every manager handles correctly — and
			* since the name rides in the URL, saved name == receipt name even under
			* interception, and a manager's own re-fetch still gets a genuine export
			* of the same ids (the route is a pure read).
			*
			* The form response is invisible to JS, so the notice is fed from
			* `export/last` — the server's record of what it ACTUALLY packaged — not
			* from the checkboxes. */
			const exportSelected = () => {
				if (busy) return;
				setBusy(true);
				(async () => {
					let previousAt = null;
					try {
						previousAt = (await getJson("/comfyui/workflows/export/last")).last?.at ?? null;
					} catch {}
					const now = /* @__PURE__ */ new Date();
					const p = (n, width = 2) => String(n).padStart(width, "0");
					const filename = `dsh-comfyui-presets-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}-${Math.random().toString(36).slice(2, 8)}.zip`;
					const form = document.createElement("form");
					form.method = "GET";
					form.action = `/comfyui/workflows/export/${filename}`;
					form.style.display = "none";
					for (const id of selected) {
						const input = document.createElement("input");
						input.type = "hidden";
						input.name = "ids";
						input.value = id;
						form.append(input);
					}
					document.body.append(form);
					form.submit();
					form.remove();
					let last = null;
					for (let attempt = 0; attempt < 10 && last === null; attempt++) {
						await new Promise((resolve) => window.setTimeout(resolve, 350));
						try {
							const payload = await getJson("/comfyui/workflows/export/last");
							if (payload.last !== null && payload.last.at !== previousAt) last = payload.last;
						} catch {}
					}
					const names = (last?.names ?? selectedNames()).join("、");
					let notice = t("transferExportDone", {
						n: last?.count ?? selected.size,
						names
					});
					if (last !== null) notice += " " + t("transferExportFile", {
						file: last.filename,
						size: Math.max(1, Math.round(last.size / 1024))
					});
					if (last !== null && last.warnings.length > 0) notice += " " + t("transferExportWarnings", { warnings: last.warnings.join("；") });
					props.onDone(notice);
				})();
			};
			/** Names behind the current selection, dialog order, with pack-bearing
			* entries annotated. Shown next to the submit button so "what will be
			* packaged — and will it carry skills" is readable at the decision point:
			* a selection that happens to exclude the one pack-bearing workflow looks
			* exactly like "skills export unreliably" from the zip alone. */
			const selectedNames = () => workflows.filter((workflow) => selected.has(workflow.id)).map((workflow) => workflow.skillDir !== void 0 ? `${workflow.name} (${t("skillBadge")})` : workflow.name);
			return (0, react.createElement)("div", {
				className: "dsc-picker-overlay",
				onClick: props.onClose
			}, (0, react.createElement)(DragGuard), (0, react.createElement)("div", {
				className: "dsc-transfer",
				onClick: (event) => event.stopPropagation(),
				onDragEnter: (event) => {
					event.preventDefault();
					event.stopPropagation();
				},
				onDragOver: (event) => {
					event.preventDefault();
					event.stopPropagation();
				},
				onDrop: (event) => {
					event.preventDefault();
					event.stopPropagation();
				}
			}, (0, react.createElement)("div", { className: "dsc-transfer-head" }, (0, react.createElement)("span", { className: "dsc-transfer-title" }, t("transferExportTitle")), (0, react.createElement)("button", {
				className: "dsc-panel-close",
				"aria-label": t("close"),
				onClick: props.onClose
			}, "✕")), workflows.length === 0 ? (0, react.createElement)("div", { className: "dsc-transfer-empty" }, t("transferExportEmpty")) : (0, react.createElement)("div", { className: "dsc-transfer-body" }, (0, react.createElement)("div", { className: "dsc-transfer-bar" }, (0, react.createElement)("span", { className: "dsc-hint" }, t("transferExportHint", {
				total: workflows.length,
				selected: selected.size
			})), (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				onClick: toggleAll
			}, allSelected ? t("transferSelectNone") : t("transferSelectAll"))), (0, react.createElement)("div", { className: "dsc-transfer-list" }, workflows.map((workflow) => (0, react.createElement)(TransferItem, {
				key: workflow.id,
				name: workflow.name,
				description: workflow.description,
				paramBadge: (workflow.parameters ?? []).length > 0 ? t("transferParamBadge", { n: (workflow.parameters ?? []).length }) : null,
				skillBadge: workflow.skillDir !== void 0 ? t("skillBadge") : null,
				warnings: [],
				checked: selected.has(workflow.id),
				onToggle: () => toggle(workflow.id)
			})))), selected.size > 0 ? (0, react.createElement)("div", { className: "dsc-transfer-note" }, (0, react.createElement)("span", {
				className: "dsc-hint",
				title: selectedNames().join("、")
			}, t("transferSelectedList", { names: selectedNames().join("、") }))) : null, (0, react.createElement)("div", { className: "dsc-transfer-actions" }, workflows.length === 0 ? null : (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--primary",
				disabled: busy || selected.size === 0,
				onClick: () => exportSelected()
			}, busy ? t("transferExporting") : t("transferExportRun", { n: selected.size })), (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: props.onClose
			}, t("cancel")))));
		}
		/** Import dialog: choose a preset package (file picker or drag-drop), see
		* what it offers, then import the selection as NEW workflows. The file is
		* POSTed twice by design — analyze and apply parse the same bytes, so the
		* host needs no temp-file staging or cleanup. */
		function ImportDialog(props) {
			const { t } = props;
			const [file, setFile] = (0, react.useState)(null);
			const [analysis, setAnalysis] = (0, react.useState)(null);
			const [selected, setSelected] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [results, setResults] = (0, react.useState)(null);
			const [imported, setImported] = (0, react.useState)(0);
			const [dragOver, setDragOver] = (0, react.useState)(false);
			/** Phase 1: upload the package for analysis (no server-side writes). */
			const analyze = async (picked) => {
				setBusy(true);
				setError(null);
				try {
					const data = await postRaw("/comfyui/workflows/import/analyze", await picked.arrayBuffer());
					if (data.ok !== true || data.analysis === void 0) throw new Error(data.error ?? "failed to analyze");
					setFile(picked);
					setAnalysis(data.analysis);
					setSelected(new Set(data.analysis.workflows.map((entry) => entry.index)));
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			};
			const toggle = (index) => {
				setSelected((prev) => {
					const next = new Set(prev);
					if (next.has(index)) next.delete(index);
					else next.add(index);
					return next;
				});
			};
			const allSelected = analysis !== null && analysis.workflows.length > 0 && selected.size === analysis.workflows.length;
			const toggleAll = () => {
				if (analysis === null) return;
				setSelected(allSelected ? /* @__PURE__ */ new Set() : new Set(analysis.workflows.map((entry) => entry.index)));
			};
			/** Phase 2: re-upload the same bytes with the selection as manifest indexes. */
			const importSelected = async () => {
				if (file === null) return;
				setBusy(true);
				setError(null);
				try {
					const bytes = await file.arrayBuffer();
					const data = await postRaw(`/comfyui/workflows/import/apply?select=${[...selected].join(",")}`, bytes);
					if (data.ok !== true || data.results === void 0) throw new Error(data.error ?? "failed to import");
					setResults(data.results);
					setImported(data.imported ?? 0);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			};
			const finish = () => {
				if (imported > 0) props.onDone(t("transferImportDone", { n: imported }));
				else props.onClose();
			};
			return (0, react.createElement)("div", {
				className: "dsc-picker-overlay",
				onClick: props.onClose
			}, (0, react.createElement)(DragGuard), (0, react.createElement)("div", {
				className: "dsc-transfer",
				onClick: (event) => event.stopPropagation(),
				onDragEnter: (event) => {
					event.preventDefault();
					event.stopPropagation();
				},
				onDragOver: (event) => {
					event.preventDefault();
					event.stopPropagation();
				},
				onDrop: (event) => {
					event.preventDefault();
					event.stopPropagation();
				}
			}, (0, react.createElement)("div", { className: "dsc-transfer-head" }, (0, react.createElement)("span", { className: "dsc-transfer-title" }, t("transferImportTitle")), (0, react.createElement)("button", {
				className: "dsc-panel-close",
				"aria-label": t("close"),
				onClick: props.onClose
			}, "✕")), (0, react.createElement)("div", { className: "dsc-transfer-body" }, results !== null ? (0, react.createElement)("div", { className: "dsc-transfer-list" }, results.map((outcome) => (0, react.createElement)("div", {
				key: outcome.index,
				className: `dsc-transfer-item dsc-transfer-item--static${outcome.ok ? " dsc-transfer-item--ok" : " dsc-transfer-item--fail"}`
			}, (0, react.createElement)("span", {
				className: "dsc-transfer-item-name",
				title: outcome.name
			}, outcome.ok ? t("transferImportedItem", {
				src: outcome.name,
				dst: outcome.newName ?? ""
			}) : t("transferImportFailedItem", {
				src: outcome.name,
				reason: outcome.error ?? ""
			})), outcome.warnings.length > 0 ? (0, react.createElement)("span", {
				className: "dsc-transfer-item-desc",
				title: outcome.warnings.join("；")
			}, outcome.warnings.join("；")) : null))) : analysis === null ? (0, react.createElement)("label", {
				className: `dsc-transfer-drop${dragOver ? " dsc-transfer-drop--over" : ""}`,
				onDragOver: (event) => {
					event.preventDefault();
					setDragOver(true);
				},
				onDragLeave: () => setDragOver(false),
				onDrop: (event) => {
					event.preventDefault();
					setDragOver(false);
					const dropped = event.dataTransfer?.files?.[0];
					if (dropped !== void 0) analyze(dropped);
				}
			}, (0, react.createElement)("input", {
				type: "file",
				accept: ".zip,application/zip,application/x-zip-compressed",
				style: { display: "none" },
				onChange: (event) => {
					const picked = event.target.files?.[0];
					if (picked !== void 0) analyze(picked);
					event.target.value = "";
				}
			}), busy ? t("transferImporting") : t("transferPickFile")) : (0, react.createElement)("div", { className: "dsc-transfer-body" }, (0, react.createElement)("div", { className: "dsc-transfer-bar" }, (0, react.createElement)("span", { className: "dsc-hint" }, t("transferPackageInfo", {
				n: analysis.workflows.length,
				date: formatTs(analysis.exportedAt)
			})), (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--sm",
				onClick: toggleAll
			}, allSelected ? t("transferSelectNone") : t("transferSelectAll"))), (0, react.createElement)("div", { className: "dsc-transfer-list" }, analysis.workflows.map((entry) => (0, react.createElement)(TransferItem, {
				key: entry.index,
				name: entry.name,
				description: entry.description,
				paramBadge: entry.paramCount > 0 ? t("transferParamBadge", { n: entry.paramCount }) : null,
				skillBadge: entry.skill !== null ? entry.skill.required ? t("transferSkillRequired", { n: entry.skill.fileCount }) : t("transferSkillBadge", { n: entry.skill.fileCount }) : null,
				warnings: entry.warnings,
				checked: selected.has(entry.index),
				onToggle: () => toggle(entry.index)
			})))), error !== null ? (0, react.createElement)(ErrorNote, {
				t,
				message: error
			}) : null, analysis !== null && results === null ? (0, react.createElement)("div", { className: "dsc-hint" }, t("transferImportNote")) : null, analysis === null && results === null ? (0, react.createElement)("div", { className: "dsc-hint" }, t("transferPickHint")) : null), (0, react.createElement)("div", { className: "dsc-transfer-actions" }, results !== null ? (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--primary",
				onClick: finish
			}, t("transferFinish")) : analysis !== null ? (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--primary",
				disabled: busy || selected.size === 0,
				onClick: () => {
					importSelected();
				}
			}, busy ? t("transferImporting") : t("transferImportRun", { n: selected.size })) : null, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: busy,
				onClick: results !== null ? finish : props.onClose
			}, t("cancel")))));
		}
		/** Read-only inspection of a ComfyUI-side saved workflow: node list + JSON. */
		function WorkflowView(props) {
			const nodes = Array.isArray(props.graph.nodes) ? props.graph.nodes.filter((node) => node.mode !== 4 && typeof node.type === "string" && node.type !== "") : [];
			const json = JSON.stringify(props.graph, null, 2);
			return (0, react.createElement)("div", { className: "dsc-view" }, (0, react.createElement)("div", { className: "dsc-view-head" }, (0, react.createElement)("span", { className: "dsc-wf-name" }, props.file), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: props.onBack
			}, props.t("wfViewBack"))), (0, react.createElement)("div", { className: "dsc-view-label" }, `${props.t("wfViewNodes")} (${nodes.length})`), nodes.length === 0 ? (0, react.createElement)("div", { className: "dsc-meta" }, props.t("wfViewEmpty")) : (0, react.createElement)("ul", { className: "dsc-node-list" }, nodes.map((node) => (0, react.createElement)("li", { key: String(node.id) }, `${String(node.id)} · ${String(node.type)}`))), (0, react.createElement)("div", { className: "dsc-view-label" }, props.t("wfViewJson")), (0, react.createElement)("textarea", {
				className: "dsc-textarea dsc-textarea--json dsc-textarea--view",
				readOnly: true,
				value: json
			}));
		}
		/** Tab 2: asset preview — thumbnails of everything the plugin generated. */
		function AssetsTab({ t, onPreview }) {
			const [assets, setAssets] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [filter, setFilter] = (0, react.useState)(() => panelStore.getAssetFilter());
			/** Asset awaiting the delete confirmation, if any. */
			const [pendingDelete, setPendingDelete] = (0, react.useState)(null);
			const [deleting, setDeleting] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)(null);
			const load = async () => {
				try {
					setAssets(await getList("/comfyui/assets", "assets"));
					setError(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			};
			(0, react.useEffect)(() => {
				let cancelled = false;
				getList("/comfyui/assets", "assets").then((items) => {
					if (!cancelled) setAssets(items);
				}).catch((cause) => {
					if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
				});
				return () => {
					cancelled = true;
				};
			}, []);
			/** Delete the record and (when the output directory is known) its files. */
			const confirmDelete = async (asset) => {
				setDeleting(true);
				try {
					const result = await postJson("/comfyui/assets/delete", { promptId: asset.promptId });
					if (result.ok !== true) throw new Error(result.error ?? "delete failed");
					setPendingDelete(null);
					setNotice(t("assetDeleteDone", { deleted: result.deleted ?? 0 }));
					if (Array.isArray(result.failures) && result.failures.length > 0) setError(result.failures.join("; "));
					await load();
				} catch (cause) {
					setError(t("assetDeleteFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
					setPendingDelete(null);
				} finally {
					setDeleting(false);
				}
			};
			if (error !== null && assets === null) return (0, react.createElement)("div", null, (0, react.createElement)(ErrorNote, {
				t,
				message: error
			}));
			if (assets === null) return (0, react.createElement)("div", { className: "dsc-meta" }, "…");
			const names = [...new Set(assets.map((asset) => asset.workflowName ?? ""))];
			const visible = filter === "" ? assets : assets.filter((asset) => (asset.workflowName ?? "") === filter);
			const previewItems = visible.flatMap((asset) => asset.media.map((item) => ({
				url: item.url,
				kind: item.kind
			})));
			const openAsset = (asset) => {
				const first = asset.media[0];
				const index = first !== void 0 ? previewItems.findIndex((item) => item.url === first.url) : 0;
				onPreview(previewItems.map((item) => item.url), previewItems.map((item) => item.kind), index < 0 ? 0 : index);
			};
			return (0, react.createElement)("div", null, (0, react.createElement)("div", { className: "dsc-toolbar" }, (0, react.createElement)("select", {
				className: "dsc-input dsc-input--inline",
				value: filter,
				onChange: (event) => setFilter(event.target.value)
			}, (0, react.createElement)("option", { value: "" }, t("assetAll")), names.map((name) => (0, react.createElement)("option", {
				key: name,
				value: name
			}, name === "" ? "—" : name))), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => void load()
			}, t("refresh"))), error !== null ? (0, react.createElement)(ErrorNote, {
				t,
				message: error
			}) : null, notice !== null ? (0, react.createElement)("div", { className: "dsc-ok" }, notice) : null, visible.length === 0 ? (0, react.createElement)("div", { className: "dsc-meta" }, t("assetEmpty")) : (0, react.createElement)("div", { className: "dsc-assets-grid" }, visible.map((asset) => (0, react.createElement)(AssetThumb, {
				key: asset.promptId,
				asset,
				t,
				onClick: () => openAsset(asset),
				onDelete: () => {
					setNotice(null);
					setPendingDelete(asset);
				}
			}))), pendingDelete !== null ? (0, react.createElement)(ConfirmDialog, {
				t,
				title: t("assetDeleteTitle"),
				body: t("assetDeleteBody", { count: pendingDelete.media.length }),
				detail: pendingDelete.media.map((item) => item.filename).join("、"),
				busy: deleting,
				onConfirm: () => {
					confirmDelete(pendingDelete);
				},
				onCancel: () => setPendingDelete(null)
			}) : null);
		}
		/** Modal confirmation for a destructive action (asset deletion). */
		function ConfirmDialog(props) {
			return (0, react.createElement)("div", {
				className: "dsc-picker-overlay",
				onClick: props.onCancel
			}, (0, react.createElement)("div", {
				className: "dsc-confirm",
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("div", { className: "dsc-confirm-title" }, props.title), (0, react.createElement)("div", { className: "dsc-confirm-body" }, props.body), props.detail !== void 0 && props.detail !== "" ? (0, react.createElement)("div", { className: "dsc-confirm-detail" }, props.detail) : null, (0, react.createElement)("div", { className: "dsc-confirm-actions" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				disabled: props.busy,
				onClick: props.onCancel
			}, props.t("cancel")), (0, react.createElement)("button", {
				className: "dsc-btn dsc-btn--danger",
				disabled: props.busy,
				onClick: props.onConfirm
			}, props.t("confirmDelete")))));
		}
		function AssetThumb(props) {
			const first = props.asset.media[0];
			const [broken, setBroken] = (0, react.useState)(false);
			const trash = (0, react.createElement)("button", {
				className: "dsc-asset-trash",
				title: props.t("assetDelete"),
				"aria-label": props.t("assetDelete"),
				onClick: (event) => {
					event.stopPropagation();
					props.onDelete();
				}
			}, "🗑");
			if (first === void 0 || broken) return (0, react.createElement)("div", {
				className: "dsc-asset dsc-asset--empty",
				onClick: props.onClick
			}, (0, react.createElement)("div", null, props.t("assetGone")), (0, react.createElement)("div", { className: "dsc-meta" }, props.asset.workflowName ?? "—"), first !== void 0 ? (0, react.createElement)("div", {
				className: "dsc-meta dsc-asset-file",
				title: first.filename
			}, first.filename) : null, trash);
			return (0, react.createElement)("div", {
				className: "dsc-asset",
				onClick: props.onClick
			}, first.kind === "video" ? (0, react.createElement)("video", {
				src: first.url,
				controls: true,
				preload: "metadata",
				onClick: (event) => event.stopPropagation()
			}) : first.kind === "audio" ? (0, react.createElement)("div", { className: "dsc-asset-audio-icon" }, (0, react.createElement)("svg", {
				className: "dsc-asset-audio-icon-wave",
				"aria-hidden": "true"
			}, (0, react.createElement)("defs", null, (0, react.createElement)("pattern", {
				id: "dsc-wave-pattern",
				width: 64,
				height: 110,
				patternUnits: "userSpaceOnUse"
			}, (0, react.createElement)("g", { fill: "rgba(255,255,255,0.15)" }, (0, react.createElement)("rect", {
				x: 0,
				y: 50,
				width: 2,
				height: 10,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 4,
				y: 44,
				width: 2,
				height: 22,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 8,
				y: 48,
				width: 2,
				height: 14,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 12,
				y: 38,
				width: 2,
				height: 34,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 16,
				y: 46,
				width: 2,
				height: 18,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 20,
				y: 52,
				width: 2,
				height: 6,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 24,
				y: 40,
				width: 2,
				height: 30,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 28,
				y: 48,
				width: 2,
				height: 14,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 32,
				y: 42,
				width: 2,
				height: 26,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 36,
				y: 36,
				width: 2,
				height: 38,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 40,
				y: 47,
				width: 2,
				height: 16,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 44,
				y: 51,
				width: 2,
				height: 8,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 48,
				y: 40,
				width: 2,
				height: 30,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 52,
				y: 45,
				width: 2,
				height: 20,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 56,
				y: 38,
				width: 2,
				height: 34,
				rx: 1
			}), (0, react.createElement)("rect", {
				x: 60,
				y: 49,
				width: 2,
				height: 12,
				rx: 1
			})))), (0, react.createElement)("rect", {
				width: "100%",
				height: "100%",
				fill: "url(#dsc-wave-pattern)"
			})), (0, react.createElement)("svg", {
				className: "dsc-asset-audio-icon-sym",
				viewBox: "0 0 24 24",
				"aria-hidden": "true",
				dangerouslySetInnerHTML: { __html: "<path fill=\"currentColor\" d=\"M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z\"/>" }
			}), (0, react.createElement)("span", {
				className: "dsc-asset-audio-icon-name",
				title: first.filename
			}, first.filename)) : (0, react.createElement)("img", {
				src: first.url,
				alt: first.filename,
				loading: "lazy",
				onError: () => setBroken(true)
			}), (0, react.createElement)("div", { className: "dsc-asset-meta" }, props.asset.workflowName ?? "—"), (0, react.createElement)("div", {
				className: "dsc-asset-meta dsc-asset-file",
				title: first.filename
			}, first.filename), trash);
		}
		/**
		* Tab 3: the task center — active tasks (pending / generating) shown as
		* cards with id, status and progress, plus history filtered by the
		* completed / failed / cancelled chips. Polled every 3 seconds.
		*/
		function QueueTab({ t, onPreview }) {
			const [filter, setFilter] = (0, react.useState)("all");
			const [active, setActive] = (0, react.useState)(null);
			const [history, setHistory] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const load = async (current) => {
				try {
					const historyStatus = current === "all" ? "completed,failed,cancelled" : current;
					const [activeData, historyData] = await Promise.all([getJson("/comfyui/jobs?status=pending,in_progress&limit=100"), getJson(`/comfyui/jobs?status=${historyStatus}&limit=100`)]);
					if (activeData.ok !== true) throw new Error(activeData.error ?? t("queueError"));
					if (historyData.ok !== true) throw new Error(historyData.error ?? t("queueError"));
					setActive([...activeData.jobs ?? []].sort((a, b) => (a.createTime ?? 0) - (b.createTime ?? 0)));
					setHistory(historyData.jobs);
					setError(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			};
			(0, react.useEffect)(() => {
				load(filter);
				const timer = setInterval(() => void load(filter), 3e3);
				return () => clearInterval(timer);
			}, [filter]);
			const act = async (payload) => {
				setBusy(true);
				try {
					const data = await postJson("/comfyui/jobs/actions", payload);
					if (data.ok !== true) throw new Error(data.error ?? "action failed");
					await load(filter);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			};
			if (error !== null) return (0, react.createElement)("div", null, (0, react.createElement)(ErrorNote, {
				t,
				message: error
			}));
			if (active === null || history === null) return (0, react.createElement)("div", { className: "dsc-meta" }, "…");
			const historyPreviewUrls = history.map(previewUrlOf);
			const previewImages = historyPreviewUrls.filter((url) => url !== null);
			const previewPrefix = [];
			{
				let acc = 0;
				for (const url of historyPreviewUrls) {
					previewPrefix.push(acc);
					if (url !== null) acc += 1;
				}
			}
			return (0, react.createElement)("div", { className: "dsc-list" }, (0, react.createElement)("div", { className: "dsc-queue-actions" }, (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => void act({ action: "clear" }),
				disabled: busy
			}, t("jobClearQueue")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => void act({ action: "clearHistory" }),
				disabled: busy
			}, t("jobClearHistory")), (0, react.createElement)("button", {
				className: "dsc-btn",
				onClick: () => void act({
					action: "free",
					unloadModels: true,
					freeMemory: true
				}),
				disabled: busy
			}, t("jobFree"))), (0, react.createElement)("div", { className: "dsc-section" }, (0, react.createElement)("div", { className: "dsc-section-head" }, (0, react.createElement)("span", { className: "dsc-section-title" }, `${t("jobActive")} (${active.length})`)), active.length === 0 ? (0, react.createElement)("div", { className: "dsc-meta" }, t("queueEmpty")) : (0, react.createElement)("div", { className: "dsc-list" }, active.map((job) => (0, react.createElement)(JobRow, {
				key: job.id,
				job,
				t,
				busy,
				act
			})))), (0, react.createElement)("div", { className: "dsc-section" }, (0, react.createElement)("div", { className: "dsc-section-head" }, (0, react.createElement)("span", { className: "dsc-section-title" }, `${t("jobFilterLabel")} (${history.length})`), (0, react.createElement)("div", { className: "dsc-queue-head" }, JOB_FILTERS.map((item) => (0, react.createElement)("button", {
				key: item.key,
				className: `dsc-chip${filter === item.key ? " dsc-chip--active" : ""}`,
				onClick: () => setFilter(item.key),
				disabled: busy
			}, t(item.label))))), history.length === 0 ? (0, react.createElement)("div", { className: "dsc-meta" }, t("queueEmpty")) : (0, react.createElement)("div", { className: "dsc-list" }, history.map((job, index) => (0, react.createElement)(JobRow, {
				key: job.id,
				job,
				t,
				busy,
				act,
				onPreview: historyPreviewUrls[index] !== null && previewImages.length > 0 ? () => onPreview(previewImages, previewImages.map(() => "image"), previewPrefix[index]) : void 0
			})))));
		}
		function jobBadge(status) {
			switch (status) {
				case "in_progress": return "dsc-badge--info";
				case "completed": return "dsc-badge--ok";
				case "failed": return "dsc-badge--danger";
				default: return "";
			}
		}
		const STATUS_LABELS = {
			pending: "jobFilterPending",
			in_progress: "jobFilterInProgress",
			completed: "jobFilterCompleted",
			failed: "jobFilterFailed",
			cancelled: "jobFilterCancelled"
		};
		/**
		* One task card: a compact row with a status badge, task name + short id,
		* duration (and error/progress for in-flight tasks), and a ⋯ menu with
		* per-state actions. Hover highlights the row. Rendered as a component
		* instance (h(JobRow, ...)) so its hooks stay per-card.
		*/
		function JobRow(props) {
			const { job, t, busy, act, onPreview } = props;
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			const menuRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!menuOpen) return;
				const onDoc = (event) => {
					if (menuRef.current !== null && !menuRef.current.contains(event.target)) setMenuOpen(false);
				};
				document.addEventListener("mousedown", onDoc);
				return () => document.removeEventListener("mousedown", onDoc);
			}, [menuOpen]);
			const running = job.status === "in_progress";
			const terminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
			const pct = job.progress !== null && job.progress !== void 0 && job.progress.max > 0 ? Math.min(100, Math.round(job.progress.value / job.progress.max * 100)) : null;
			const duration = job.executionStartTime !== null && job.executionEndTime !== null ? Math.max(0, Math.round(((job.executionEndTime ?? 0) - (job.executionStartTime ?? 0)) / 1e3)) : null;
			const errMsg = job.executionError?.exception_message ?? job.executionError?.message;
			const name = job.workflowName ?? job.workflowId;
			const preview = previewUrlOf(job);
			const close = () => setMenuOpen(false);
			const statusClass = job.status === "failed" ? " dsc-job-item--failed" : job.status === "cancelled" ? " dsc-job-item--cancelled" : "";
			return (0, react.createElement)("div", { className: `dsc-job-item${statusClass}` }, preview !== null ? (0, react.createElement)("img", {
				src: preview,
				alt: "",
				loading: "lazy",
				className: onPreview !== void 0 ? "dsc-job-preview dsc-job-preview--clickable" : "dsc-job-preview",
				onClick: onPreview
			}) : null, (0, react.createElement)("div", { className: "dsc-job-main" }, (0, react.createElement)("div", {
				className: "dsc-job-name",
				title: name ?? void 0
			}, name !== null && name !== void 0 && name !== "" ? name : "—"), (0, react.createElement)("div", { className: "dsc-job-mid" }, running && job.progress !== null && job.progress !== void 0 ? (0, react.createElement)("div", { className: "dsc-progress" }, (0, react.createElement)("div", { className: "dsc-progress-track" }, (0, react.createElement)("div", {
				className: "dsc-progress-fill",
				style: { width: `${pct ?? 0}%` }
			})), (0, react.createElement)("span", { className: "dsc-job-progress" }, `${job.progress.value}/${job.progress.max} · ${pct ?? 0}%`)) : null, (0, react.createElement)("div", { className: "dsc-job-mid-right" }, (0, react.createElement)("span", { className: `dsc-badge dsc-badge--status ${jobBadge(job.status)}` }, t(STATUS_LABELS[job.status] ?? job.status)), (0, react.createElement)("div", {
				ref: menuRef,
				className: "dsc-job-menu"
			}, (0, react.createElement)("button", {
				className: "dsc-job-menu-btn",
				"aria-label": t("jobMore"),
				onClick: () => setMenuOpen(!menuOpen)
			}, "⋯"), menuOpen ? (0, react.createElement)("div", { className: "dsc-job-menu-pop" }, job.status === "pending" ? (0, react.createElement)("button", { onClick: () => {
				act({
					action: "delete",
					ids: [job.id]
				});
				close();
			} }, t("jobDelete")) : null, running ? (0, react.createElement)("button", { onClick: () => {
				act({
					action: "interrupt",
					promptId: job.id
				});
				close();
			} }, t("jobInterrupt")) : null, terminal ? (0, react.createElement)("button", { onClick: () => {
				act({
					action: "deleteHistory",
					ids: [job.id]
				});
				close();
			} }, t("jobDelete")) : null, terminal ? (0, react.createElement)("button", { onClick: () => {
				act({
					action: "rerun",
					jobId: job.id
				});
				close();
			} }, t("jobRerun")) : null, terminal ? (0, react.createElement)("button", { onClick: () => {
				panelStore.setAssetFilter(name ?? "");
				panelStore.setTab("assets");
				close();
			} }, t("jobViewAssets")) : null) : null))), (0, react.createElement)("div", { className: "dsc-job-bottom" }, (0, react.createElement)("span", { className: "dsc-job-duration" }, `${t("jobDuration")} ${duration ?? 0}s`), errMsg !== void 0 && errMsg !== null ? (0, react.createElement)("span", {
				className: "dsc-job-error",
				title: errMsg
			}, errMsg) : null)));
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* dsh-comfyui stylesheet, injected once with plugin ownership. Colors come
		* from the host theme tokens (--dsw-alias-*), so the UI follows light/dark.
		*/
		const CSS = `
/* --- shared primitives --- */
.dsc-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsc-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.dsc-badge {
  border-radius: 999px; padding: 1px 8px; font-size: 11px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.dsc-badge--ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }
.dsc-badge--err { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }
/* Inline players inserted after video/audio links in chat replies (inline-media.ts). */
.dsc-inline-player { display: block; margin: 6px 0; }
.dsc-inline-player video { display: block; max-width: 100%; max-height: 360px; border-radius: 8px; background: transparent; }
.dsc-inline-player audio { display: block; width: min(100%, 480px); height: 40px; }
.dsc-files { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 4px; }
.dsc-file { font-size: 12px; color: var(--dsw-alias-label-secondary); text-decoration: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-file:hover { color: var(--dsw-alias-label-primary); text-decoration: underline; }
.dsc-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsc-err { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin: 4px 0; }
.dsc-ok { color: var(--dsw-alias-state-success-primary); font-size: 12px; margin: 4px 0; }
.dsc-form { display: flex; flex-direction: column; gap: 12px; max-width: 460px; }
.dsc-field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: var(--dsw-alias-label-primary); }
.dsc-input, .dsc-textarea {
  width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: inherit; font-size: 13px;
}
select.dsc-input { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); color-scheme: inherit; }
select.dsc-input option { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsc-textarea { min-height: 90px; resize: vertical; font-family: ui-monospace, monospace; }
.dsc-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.dsc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsc-btn {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: transparent; color: inherit; padding: 5px 12px; font-size: 13px; cursor: pointer;
}
.dsc-btn:disabled { opacity: 0.5; cursor: default; }
.dsc-btn--link { display: inline-block; text-decoration: none; }
/* --- header action trigger --- */
.dsc-trigger {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; font-size: 13px; padding: 3px 8px; border-radius: 6px;
  white-space: nowrap;
}
.dsc-trigger:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); }
.dsc-trigger[aria-pressed='true'] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsc-trigger-glyph { font-size: 13px; line-height: 1; }
/* --- connection reminder toast: fixed at the top of the page, mounted by the
   header trigger when the backend probe cannot reach ComfyUI. The probing
   state fades in after a short delay so a fast successful probe never paints;
   the fail state is sticky until dismissed or a later probe recovers. --- */
.dsc-conn-toast {
  position: fixed; top: 64px; left: 50%;
  -webkit-app-region: no-drag;
  pointer-events: auto;
  z-index: 980;
  display: flex; align-items: flex-start; gap: 10px;
  max-width: min(560px, 92vw);
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.3);
  color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 1.5;
  animation: dsc-conn-toast-in 0.16s ease-out both;
}
.dsc-conn-toast--probing { animation-delay: 0.45s; }
.dsc-conn-toast--ok { border-color: var(--dsw-alias-state-success-primary); }
.dsc-conn-toast--fail { border-color: var(--dsw-alias-state-error-primary); }
.dsc-conn-toast-dot { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; }
.dsc-conn-toast--probing .dsc-conn-toast-dot { background: var(--dsw-alias-state-warn-primary); animation: dsc-conn-dot 1s ease-in-out infinite; }
.dsc-conn-toast--ok .dsc-conn-toast-dot { background: var(--dsw-alias-state-success-primary); }
.dsc-conn-toast--fail .dsc-conn-toast-dot { background: var(--dsw-alias-state-error-primary); }
.dsc-conn-toast-body { min-width: 0; }
.dsc-conn-toast-title { font-weight: 600; }
.dsc-conn-toast--fail .dsc-conn-toast-title { color: var(--dsw-alias-state-error-primary); }
.dsc-conn-toast--ok .dsc-conn-toast-title { color: var(--dsw-alias-state-success-primary); }
.dsc-conn-toast-text { color: var(--dsw-alias-label-secondary); margin-top: 2px; overflow-wrap: anywhere; }
.dsc-conn-toast-close { flex: none; border: none; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 13px; padding: 2px 4px; line-height: 1; }
.dsc-conn-toast-close:hover { color: var(--dsw-alias-label-primary); }
@keyframes dsc-conn-toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes dsc-conn-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
/* --- panel shell: floating window, percentage-anchored to the page header
   (top) and the composer (bottom), draggable by the header and resizable via
   the corner handle. Follows the host light/dark theme. --- */
.dsc-panel {
  position: fixed;
  top: var(--dsc-panel-top, 64px);
  left: var(--dsc-panel-left, 12px);
  bottom: var(--dsc-panel-bottom, 12px);
  width: var(--dsc-panel-width, 380px);
  max-width: min(92vw, 560px); min-width: 300px;
  max-height: calc(100vh - 24px);
  z-index: 900;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.12);
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  user-select: none;
}
.dsc-panel--dragging { cursor: grabbing; }
.dsc-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); cursor: grab; touch-action: none; }
/* Panel settings: a compact popover anchored under the gear instead of a
   full-width row, so it never steals height from the tab body. */
.dsc-panel-settings {
  position: absolute; top: 44px; right: 10px; width: 196px; z-index: 12;
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 1px 4px rgba(0, 0, 0, 0.08);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsc-panel-settings-row { display: flex; align-items: center; justify-content: space-between; }
.dsc-panel-settings-label { flex: none; }
.dsc-panel-settings-value { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.dsc-panel-settings input[type="range"] { width: 100%; accent-color: var(--dsw-alias-brand-primary, #4f7cff); }
.dsc-panel-settings-reset { align-self: flex-end; padding: 2px 10px; font-size: 12px; }
.dsc-panel-reset--active { color: var(--dsw-alias-brand-primary, #4f7cff); }
.dsc-panel--dragging .dsc-panel-head { cursor: grabbing; }
.dsc-panel-resize {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize; touch-action: none;
  background: linear-gradient(135deg, transparent 50%, var(--dsw-alias-label-tertiary) 50%);
  border-bottom-right-radius: 14px;
  opacity: 0.55;
}
.dsc-panel-resize:hover { opacity: 1; }
.dsc-panel-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; }
.dsc-panel-head-actions { display: inline-flex; align-items: center; gap: 2px; }
.dsc-panel-reset { border: none; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 13px; padding: 4px 6px; line-height: 1; }
.dsc-panel-reset:hover { color: var(--dsw-alias-label-primary); }
.dsc-panel-close { border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 14px; padding: 4px 8px; }
.dsc-panel-close:hover { color: var(--dsw-alias-label-primary); }
.dsc-tabs { display: flex; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsc-tab {
  flex: 1; padding: 8px 4px; background: transparent; border: none;
  border-bottom: 2px solid transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; font-size: 13px;
}
.dsc-tab--active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.dsc-panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }
.dsc-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.dsc-list { display: flex; flex-direction: column; gap: 8px; }
/* --- workflows tab --- */
.dsc-wf { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1); transition: background 0.12s, border-color 0.12s; cursor: pointer; }
.dsc-wf:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dsc-wf-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dsc-wf--comfyui { display: flex; align-items: center; gap: 10px; }
.dsc-wf-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.dsc-wf-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-wf-desc { color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsc-wf-updated { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-top: 4px; }
.dsc-wf-actions { display: flex; gap: 6px; margin-top: 6px; }
.dsc-section { margin-top: 14px; }
.dsc-section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.dsc-section-title { font-weight: 600; font-size: 13px; }
.dsc-fold { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; margin-top: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.dsc-fold summary { list-style: none; display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: pointer; user-select: none; font-weight: 600; font-size: 13px; }
.dsc-fold summary::-webkit-details-marker { display: none; }
.dsc-fold summary::before { content: '▸'; font-size: 11px; color: var(--dsw-alias-label-secondary); transition: transform 0.15s; }
.dsc-fold[open] summary::before { transform: rotate(90deg); }
.dsc-fold summary:hover { background: var(--dsw-alias-bg-layer-2); }
.dsc-fold-body { padding: 0 10px 10px; }
.dsc-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; margin: 2px 0 6px; white-space: pre-line; }
.dsc-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.dsc-badge--ok { color: var(--dsw-alias-state-success-primary); border: 1px solid var(--dsw-alias-state-success-primary); }
.dsc-badge--warn { color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.dsc-view-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.dsc-view-label { font-weight: 600; font-size: 12px; margin: 8px 0 4px; }
.dsc-node-list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); max-height: 180px; overflow-y: auto; }
.dsc-node-list li { margin: 2px 0; }
.dsc-textarea--view { min-height: 220px; resize: vertical; }
.dsc-derived { margin: 6px 0; display: flex; flex-direction: column; gap: 4px; }
.dsc-derived-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
.dsc-derived-name { color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-dialog { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px; }
/* --- skill pack editor: file list beside a plain-text editor --- */
.dsc-skill { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; margin-top: 8px; }
.dsc-skill-files { flex: 0 0 190px; min-width: 160px; display: flex; flex-direction: column; gap: 6px; }
.dsc-skill-main { flex: 1 1 300px; min-width: 260px; display: flex; flex-direction: column; gap: 6px; }
.dsc-skill-bucket { display: flex; flex-direction: column; gap: 2px; }
/* Foldable pack directories: each folder renders as a <details> whose header
   stays put while its files collapse, keeping crowded packs scannable. */
.dsc-skill-fold { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; margin: 2px 0; }
.dsc-skill-fold summary { padding: 5px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); border-radius: 8px; }
.dsc-skill-fold[open] summary { color: var(--dsw-alias-label-primary); border-bottom: 1px solid var(--dsw-alias-border-l1); border-radius: 8px 8px 0 0; }
.dsc-skill-fold .dsc-skill-bucket { padding: 4px 6px 6px; }
.dsc-skill-file {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  border: 1px solid transparent; border-radius: 6px; background: transparent;
  color: inherit; font-size: 12px; padding: 4px 6px; cursor: pointer; text-align: left;
}
.dsc-skill-file:hover { background: var(--dsw-alias-bg-layer-2); }
.dsc-skill-file--active { border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dsc-skill-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-skill-file-size { color: var(--dsw-alias-label-secondary); font-size: 11px; flex: none; }
.dsc-skill-create { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.dsc-skill-editor-head { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; }
.dsc-skill-path { color: var(--dsw-alias-label-primary); }
.dsc-textarea--skill { min-height: 260px; font-size: 12px; line-height: 1.5; }
.dsc-skill-preview { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; align-items: center; }
.dsc-skill-preview img { max-width: 100%; max-height: 320px; object-fit: contain; border-radius: 6px; }
.dsc-skill-dir { font-size: 11px; color: var(--dsw-alias-label-secondary); margin: 4px 0; word-break: break-all; }
.dsc-skill-flags { margin-top: 6px; }
.dsc-skill-footer { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.dsc-skill-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dsc-skill-drop-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l1); border-radius: 6px; padding: 4px 6px; text-align: center; }
.dsc-dialog--danger { border-color: var(--dsw-alias-state-error-primary); }
.dsc-danger-text { color: var(--dsw-alias-state-error-primary); font-weight: 600; font-size: 12px; line-height: 1.5; }
.dsc-check { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.dsc-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.dsc-extract-modes { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
.dsc-mode { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.dsc-mode input { accent-color: var(--dsw-alias-brand-primary); }
.dsc-mode-label { font-size: 13px; }
/* --- assets tab --- */
.dsc-assets-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
.dsc-asset { position: relative; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; cursor: pointer; background: var(--dsw-alias-bg-layer-1); }
/* Destructive, so it only appears while the pointer is on the card. */
.dsc-asset-trash {
  position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; padding: 0; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-error-primary);
  font-size: 14px; cursor: pointer; opacity: 0; transition: opacity 0.12s;
}
.dsc-asset:hover .dsc-asset-trash, .dsc-asset-trash:focus-visible { opacity: 1; }
.dsc-asset-trash:hover { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsc-asset img, .dsc-asset video { width: 100%; height: 110px; object-fit: cover; display: block; background: #000; }
.dsc-asset-audio-icon { position: relative; width: 100%; height: 110px; box-sizing: border-box; padding: 0 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: #26702b; overflow: hidden; }
.dsc-asset-audio-icon-wave { position: absolute; inset: 0; width: 100%; height: 100%; }
.dsc-asset-audio-icon-sym { position: relative; width: 42px; height: 42px; color: #fff; }
.dsc-asset-audio-icon-name { position: relative; max-width: 100%; font-size: 11px; color: rgba(255, 255, 255, 0.9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsc-asset--empty {
  height: 110px; padding: 8px; box-sizing: border-box;
  display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px;
  font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: center;
}
.dsc-asset-meta { padding: 3px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Second meta line: the output filename, under the workflow name. */
.dsc-asset-file { padding-top: 0; font-size: 10px; opacity: 0.8; }
.dsc-asset--empty .dsc-asset-file { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
/* confirmation modal (asset deletion) */
.dsc-confirm { width: min(360px, 88vw); display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.32); }
.dsc-confirm-title { font-weight: 600; font-size: 14px; }
.dsc-confirm-body { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsc-confirm-detail { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); word-break: break-all; max-height: 96px; overflow-y: auto; }
.dsc-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
.dsc-btn--danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsc-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsc-asset-detail-media { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.dsc-asset-detail-media img, .dsc-asset-detail-media video { width: 100%; max-height: 320px; object-fit: contain; background: #000; border-radius: 8px; }
.dsc-asset-detail-file { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; }
.dsc-input--inline { width: auto; }
/* --- queue tab --- */
.dsc-queue-head { display: flex; gap: 8px; flex-wrap: wrap; }
.dsc-queue-item { display: flex; gap: 8px; align-items: center; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; font-size: 12px; flex-wrap: wrap; }
.dsc-queue-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.dsc-queue-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsc-queue-tracked { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.dsc-progress { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 90px; }
.dsc-progress-track { flex: 1; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsc-progress-fill { height: 100%; background: #3b82f6; transition: width 0.4s; }
.dsc-progress:hover .dsc-progress-fill { background: #2563eb; }
.dsc-param-upload-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.dsc-param-upload-wrap select { flex: 1; min-width: 0; }
.dsc-dropzone { flex: 1; min-width: 120px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 6px; padding: 5px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: center; cursor: pointer; transition: border-color 0.12s, color 0.12s; }
.dsc-dropzone:hover, .dsc-dropzone--over { border-color: #3b82f6; color: #3b82f6; }
.dsc-upload-select { position: relative; flex: 1; min-width: 0; }
.dsc-upload-select-btn { display: flex; align-items: center; gap: 6px; width: 100%; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; text-align: left; }
.dsc-upload-select-btn:hover { border-color: var(--dsw-alias-border-l2); }
.dsc-upload-select-thumb { width: 36px; height: 24px; object-fit: cover; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); flex: none; }
.dsc-upload-select-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dsc-upload-select-pop { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30; max-height: 220px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); padding: 4px; }
.dsc-upload-select-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsc-upload-select-item:hover { background: var(--dsw-alias-bg-layer-3); }
.dsc-upload-dock { margin-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.dsc-upload-dock-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dsc-upload-dock-title { font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsc-upload-dock-zone { min-height: 44px; display: flex; align-items: center; justify-content: center; }
.dsc-upload-list { display: flex; flex-direction: column; gap: 4px; }
.dsc-upload-item { display: flex; align-items: center; gap: 8px; }
.dsc-upload-thumb { width: 40px; height: 28px; object-fit: cover; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); flex: none; }
.dsc-upload-thumb--media { display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
.dsc-upload-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsc-upload-select-item--active { background: var(--dsw-alias-bg-layer-3); }
/* --- load area: big preview + picker dialog (ComfyUI LoadImage-like) --- */
.dsc-loadarea { margin-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.dsc-loadarea-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dsc-loadarea-title { font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-primary); }
/* load-area slots: slot 0 is the primary (big) source, the rest are thumbs.
   Each slot carries its own actions (add / clear media / delete slot). */
.dsc-loadslots { display: flex; flex-wrap: wrap; gap: 8px; }
/* One slot stretches across the panel; from two on they share a fixed width
   and wrap into rows. The × sits in the corner and appears on hover. */
.dsc-loadslot { position: relative; display: flex; flex-direction: column; gap: 4px; width: 128px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 6px; background: var(--dsw-alias-bg-layer-1); }
.dsc-loadslot--wide { width: 100%; }
.dsc-loadslot-pick { display: flex; flex-direction: column; align-items: center; gap: 4px; border: none; border-radius: 8px; padding: 0; background: transparent; color: inherit; cursor: pointer; width: 100%; }
.dsc-loadslot-media { width: 100%; height: 104px; object-fit: contain; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
.dsc-loadslot--wide .dsc-loadslot-media { height: 220px; }
.dsc-loadslot-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; width: 100%; height: 104px; border-radius: 6px; border: 1px dashed var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
.dsc-loadslot--wide .dsc-loadslot-empty { height: 120px; font-size: 13px; }
.dsc-loadslot-name { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-primary); text-align: center; }
.dsc-loadslot-index { color: var(--dsw-alias-label-tertiary); }
.dsc-loadslot-add { color: var(--dsw-alias-label-secondary); }
.dsc-loadslot-pick:hover .dsc-loadslot-add { color: var(--dsw-alias-brand-primary); }
.dsc-loadslot-x {
  position: absolute; top: 3px; right: 3px; width: 26px; height: 26px; padding: 0; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 50%;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font-size: 18px; cursor: pointer; opacity: 0; transition: opacity 0.12s;
}
.dsc-loadslot:hover .dsc-loadslot-x, .dsc-loadslot-x:focus-visible { opacity: 1; }
.dsc-loadslot-x:hover { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsc-picker-player { width: 100%; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
video.dsc-picker-player { max-height: 180px; }
.dsc-picker-player--audio { height: 34px; }
.dsc-loadslot-x:disabled { opacity: 0; cursor: default; }
.dsc-picker-card--none .dsc-picker-thumb--media { font-size: 26px; color: var(--dsw-alias-label-tertiary); }
/* picker overlay: dims the page, dialog floats in the center */
.dsc-picker-overlay { position: fixed; inset: 0; z-index: 9990; background: rgba(6, 8, 12, 0.6); display: flex; align-items: center; justify-content: center; padding: 24px; }
.dsc-picker { position: relative; display: flex; flex-direction: column; width: min(860px, 92vw); height: min(560px, 84vh); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; box-shadow: 0 16px 56px rgba(0, 0, 0, 0.5); overflow: hidden; }
.dsc-picker-toast { position: absolute; top: 54px; left: 50%; transform: translateX(-50%); z-index: 5; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); padding: 6px 14px; border-radius: 8px; font-size: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); pointer-events: none; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-picker-bar { display: flex; align-items: center; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsc-picker-tab { border: 1px solid transparent; border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-primary); }
.dsc-picker-tab--active { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.dsc-picker-tabs { display: flex; gap: 4px; }
.dsc-picker-type { flex: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 8px; font-size: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsc-picker-upload { margin: 0 auto; flex: none; max-width: 200px; min-height: 32px; display: flex; align-items: center; justify-content: center; padding: 0 12px; font-size: 12px; white-space: nowrap; }
.dsc-picker-empty { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.dsc-picker-grid { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 12px; display: flex; gap: 10px; align-items: flex-start; }
.dsc-picker-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.dsc-picker-card { display: flex; flex-direction: column; gap: 4px; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px; background: var(--dsw-alias-bg-layer-2); cursor: pointer; text-align: left; }
.dsc-picker-card:hover { border-color: #3b82f6; }
.dsc-picker-card--active { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.dsc-picker-thumb { width: 100%; height: auto; object-fit: contain; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
.dsc-picker-thumb--media { display: flex; align-items: center; justify-content: center; height: 100px; font-size: 22px; }
.dsc-picker-name { font-size: 13px; line-height: 1.5; padding: 2px 0; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-picker-card:hover .dsc-picker-name { color: var(--dsw-alias-brand-primary); }
/* --- workflow tags: filter bar, chips, editor --- */
.dsc-tag-filter { display: flex; justify-content: flex-end; padding: 6px 0 2px; }
.dsc-tag-chip { border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-primary); }
.dsc-tag-chip--active { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.dsc-tag-chip--mini { font-size: 11px; padding: 1px 8px; cursor: default; border: 1px solid var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.dsc-wf-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.dsc-wf-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; min-width: 0; }
.dsc-wf-top .dsc-wf-tags { margin-top: 0; flex: none; justify-content: flex-end; }
.dsc-tag-editor { display: flex; flex-direction: column; gap: 6px; }
.dsc-tag-row { display: flex; flex-wrap: wrap; gap: 6px; }
.dsc-tag-input { max-width: 260px; }
.dsc-chip { border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-primary); }
.dsc-chip--active { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.dsc-badge--info { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.dsc-badge--danger { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsc-queue-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsc-btn { border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-primary); }
.dsc-btn--sm { padding: 1px 6px; font-size: 11px; }
.dsc-input--sm { padding: 3px 6px; font-size: 12px; }
.dsc-btn:disabled { opacity: 0.5; cursor: default; }
.dsc-job-item { display: flex; align-items: center; gap: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 10px; background: var(--dsw-alias-bg-layer-1); transition: background 0.12s, border-color 0.12s; }
.dsc-job-item:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dsc-job-item--failed { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }
.dsc-job-item--cancelled { border-color: var(--dsw-alias-border-l2); opacity: 0.85; }
.dsc-badge--status { flex: none; font-weight: 600; }
.dsc-job-preview { width: 56px; height: 56px; flex: none; border-radius: 6px; object-fit: cover; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dsc-job-preview--clickable { cursor: zoom-in; }
/* --- lightbox: floating local panel, no full-screen dim --- */
.dsc-lightbox { position: fixed; inset: 0; z-index: 9999; background: transparent; display: flex; align-items: center; justify-content: center; }
.dsc-lightbox-body { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; width: 90vw; padding: 12px 12px 10px; background: rgba(12, 14, 18, 0.88); border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; box-shadow: 0 12px 48px rgba(0, 0, 0, 0.45); }
.dsc-lightbox-img { width: 100%; height: 80vh; object-fit: contain; border-radius: 8px; }
.dsc-lightbox-media { max-width: 100%; max-height: 80vh; border-radius: 8px; }
.dsc-lightbox-meta { display: flex; align-items: center; gap: 14px; color: rgba(255, 255, 255, 0.75); font-size: 12px; }
.dsc-lightbox-download { border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 999px; padding: 5px 16px; color: #fff; font-size: 12px; text-decoration: none; display: inline-block; }
.dsc-lightbox-download:hover { background: rgba(255, 255, 255, 0.12); }
.dsc-lightbox-close { position: absolute; top: clamp(4px, 0.6vw, 14px); right: clamp(4px, 0.6vw, 14px); z-index: 3; width: clamp(28px, 2.2vw, 48px); height: clamp(28px, 2.2vw, 48px); border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.35); background: transparent; color: #fff; font-size: clamp(13px, 1.1vw, 22px); line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.dsc-lightbox-close:hover { background: rgba(255, 255, 255, 0.12); }
.dsc-lightbox-nav { position: absolute; top: 0; bottom: 0; z-index: 2; width: clamp(64px, 7vw, 128px); display: flex; align-items: center; background: transparent; border: none; color: #fff; font-size: clamp(38px, 3.4vw, 84px); line-height: 1; cursor: pointer; opacity: 0.6; padding: 0; }
.dsc-lightbox-nav:hover { opacity: 1; color: var(--dsw-alias-brand-primary); background: rgba(255, 255, 255, 0.06); }
.dsc-lightbox-nav--prev { left: 0; justify-content: flex-start; padding-left: clamp(14px, 1.8vw, 36px); }
.dsc-lightbox-nav--next { right: 0; justify-content: flex-end; padding-right: clamp(14px, 1.8vw, 36px); }
.dsc-job-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dsc-job-name { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dsc-job-mid { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.dsc-job-mid-right { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
.dsc-job-bottom { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dsc-job-duration { flex: none; }
.dsc-job-progress { color: #3b82f6; font-variant-numeric: tabular-nums; }
.dsc-job-menu { position: relative; flex: none; }
.dsc-job-menu-btn { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 15px; line-height: 1; padding: 3px 7px; border-radius: 6px; cursor: pointer; }
.dsc-job-menu-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsc-job-menu-pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 950; min-width: 128px; padding: 4px; display: flex; flex-direction: column; gap: 2px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
.dsc-job-menu-pop button { border: none; background: transparent; color: var(--dsw-alias-label-primary); text-align: left; font-size: 13px; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
.dsc-job-menu-pop button:hover { background: var(--dsw-alias-bg-layer-3); }
.dsc-job-error { color: var(--dsw-alias-state-error-primary); font-size: 11px; margin-left: auto; flex: 1; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* --- parameter editor --- */
.dsc-params { display: flex; flex-direction: column; gap: 8px; }
.dsc-param-row { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; }
.dsc-param-fields { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dsc-param-default { min-width: 0; }
.dsc-param-meta { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.dsc-param-random { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsc-param-bool { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsc-param-advanced { display: flex; flex-direction: column; gap: 8px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px; }
/* --- workflow preset transfer dialogs (export / import) --- */
.dsc-transfer { position: relative; display: flex; flex-direction: column; width: min(580px, 92vw); max-height: min(640px, 86vh); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; box-shadow: 0 16px 56px rgba(0, 0, 0, 0.5); overflow: hidden; }
.dsc-transfer-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsc-transfer-title { font-weight: 600; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dsc-transfer-body { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; overflow-y: auto; min-height: 0; }
.dsc-transfer-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsc-transfer-list { display: flex; flex-direction: column; gap: 4px; }
.dsc-transfer-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsc-transfer-item:hover { border-color: var(--dsw-alias-brand-primary); }
.dsc-transfer-item--static, .dsc-transfer-item--static:hover { cursor: default; border-color: var(--dsw-alias-border-l1); }
.dsc-transfer-item--ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.dsc-transfer-item--fail { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.dsc-transfer-item-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
.dsc-transfer-item-desc { color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 40px; text-align: right; }
.dsc-transfer-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsc-transfer-note { padding: 6px 12px 0; }
.dsc-transfer-note .dsc-hint { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsc-transfer-drop { display: flex; align-items: center; justify-content: center; min-height: 150px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; color: var(--dsw-alias-label-secondary); font-size: 13px; cursor: pointer; text-align: center; padding: 12px; transition: border-color 0.12s, color 0.12s; }
.dsc-transfer-drop:hover, .dsc-transfer-drop--over { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsc-transfer-empty { padding: 40px 12px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.dsc-btn--primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.dsc-btn--primary:disabled { opacity: 0.5; cursor: default; }
`;
		/** Inject the stylesheet once (idempotent), owned by this plugin for HMR. */
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-comfyui-styles") !== null) return;
			const style = document.createElement("style");
			style.id = "dsh-comfyui-styles";
			style.setAttribute("data-plugin", "dsh-comfyui");
			style.textContent = CSS;
			document.head.append(style);
		}
		//#endregion
		//#region src/client/inline-media.ts
		/**
		* Inline players for generated video/audio in chat replies.
		*
		* The model shows results by pasting Markdown into its reply (CLAUDE.md
		* contract 18). Images embed natively, but dsh's chat Markdown has no video or
		* audio syntax and renders raw HTML as literal text, so a video/audio result
		* can only be a link there. This module watches the page and, after every
		* link to this plugin's own `/comfyui/media` route whose file is a video or
		* audio file, inserts a native <video>/<audio> player.
		*
		* It only ever ADDS sibling nodes next to dsh-rendered links — it never moves
		* or removes dsh's own nodes — so React's reconciliation of the message keeps
		* working. Streaming re-renders and dsh updates simply trigger a re-scan: a
		* player is added only when the link is not already followed by its player,
		* and players whose link has gone are removed. The plugin's own UI (card file
		* links, panel) is skipped. Everything is undone when the plugin unloads.
		*/
		const VIDEO_EXTENSIONS = /* @__PURE__ */ new Set([
			"mp4",
			"webm",
			"mov",
			"m4v",
			"mkv"
		]);
		const AUDIO_EXTENSIONS = /* @__PURE__ */ new Set([
			"mp3",
			"wav",
			"flac",
			"ogg",
			"oga",
			"opus",
			"m4a",
			"aac"
		]);
		const PLAYER_CLASS = "dsc-inline-player";
		/** The player kind for a /comfyui/media link, or undefined for anything else. */
		function mediaKind(href) {
			let url;
			try {
				url = new URL(href, window.location.href);
			} catch {
				return;
			}
			if (!url.pathname.endsWith("/comfyui/media")) return void 0;
			const file = url.searchParams.get("file") ?? "";
			const dot = file.lastIndexOf(".");
			if (dot < 0) return void 0;
			const ext = file.slice(dot + 1).toLowerCase();
			if (VIDEO_EXTENSIONS.has(ext)) return "video";
			if (AUDIO_EXTENSIONS.has(ext)) return "audio";
		}
		function isPlayerFor(node, href) {
			return node !== null && node.classList.contains(PLAYER_CLASS) && node.getAttribute("data-src") === href;
		}
		function makePlayer(kind, href) {
			const wrap = document.createElement("span");
			wrap.className = `${PLAYER_CLASS} ${PLAYER_CLASS}--${kind}`;
			wrap.setAttribute("data-src", href);
			const player = document.createElement(kind);
			player.src = href;
			player.controls = true;
			player.preload = "metadata";
			wrap.appendChild(player);
			return wrap;
		}
		function scan() {
			for (const player of Array.from(document.querySelectorAll(`.${PLAYER_CLASS}`))) {
				const prev = player.previousElementSibling;
				const src = player.getAttribute("data-src");
				if (!(prev instanceof HTMLAnchorElement) || src === null || prev.href !== src) player.remove();
			}
			for (const link of Array.from(document.querySelectorAll("a[href*=\"/comfyui/media\"]"))) {
				if (link.closest("[class^=\"dsc-\"], [class*=\" dsc-\"]") !== null) continue;
				const kind = mediaKind(link.href);
				if (kind === void 0) continue;
				if (isPlayerFor(link.nextElementSibling, link.href)) continue;
				link.after(makePlayer(kind, link.href));
			}
		}
		/** Start watching the page; returns the disposer that stops and cleans up. */
		function installInlineMedia() {
			let frame;
			const schedule = () => {
				if (frame !== void 0) return;
				frame = window.requestAnimationFrame(() => {
					frame = void 0;
					scan();
				});
			};
			const observer = new MutationObserver((mutations) => {
				if (mutations.some((mutation) => [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)].some((node) => !(node instanceof HTMLElement && node.classList.contains(PLAYER_CLASS))))) schedule();
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			schedule();
			return () => {
				observer.disconnect();
				if (frame !== void 0) window.cancelAnimationFrame(frame);
				for (const player of Array.from(document.querySelectorAll(`.${PLAYER_CLASS}`))) player.remove();
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* dsh-comfyui client half: registers the comfyui_run tool card and the
		* ComfyUI settings page. Registered through slots.inject so contributions
		* wait on the real slot declarations and unwind with this plugin's fiber.
		*/
		const name = "dsh-comfyui";
		const inject = ["slots"];
		function apply(ctx) {
			const t = makeT(getLang());
			ctx.effect(() => injectStyles(), "dsh-comfyui: styles");
			ctx.effect(() => installInlineMedia(), "dsh-comfyui: inline video/audio players");
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "comfyui_run"
			}, (props) => (0, react.createElement)(ComfyUICard, {
				t,
				...props ?? {}
			})));
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "comfyui_workflow"
			}, (props) => (0, react.createElement)(ComfyUICard, {
				t,
				...props ?? {}
			})));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "comfyui",
				order: 30,
				label: () => t("settingsTitle")
			}, (props) => (0, react.createElement)(ComfyUISettings, {
				t,
				...props ?? {}
			})));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "comfyui.panel",
				order: 20,
				label: () => t("panelTitle")
			}, (props) => (0, react.createElement)(ComfyUIPanel, {
				t,
				...props ?? {}
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.panelStore = panelStore;
			return module.exports;
		};
		let fandcClient = null;
		try {
			fandcClient = loadFandcClient(require);
		} catch (error) {
			console.warn("[comfyui-studio] fandc 客户端加载失败：", error);
		}

		// ── 合并两个半边：studio 的侧边栏 tab / 工作台 + fandc 的面板 / 设置 / 工具卡 ──
		const mergedInject = Array.isArray(fandcClient?.inject)
			? [...new Set([...inject, ...fandcClient.inject])]
			: inject;
		const mergedApply = (ctx) => {
			const disposers = [];
			try {
				const dispose = apply(ctx);
				if (typeof dispose === "function") disposers.push(dispose);
			} catch (error) {
				console.warn("[comfyui-studio] studio 半边 apply 失败：", error);
			}
			try {
				const dispose = fandcClient?.apply?.(ctx);
				if (typeof dispose === "function") disposers.push(dispose);
			} catch (error) {
				console.warn("[comfyui-studio] fandc 半边 apply 失败：", error);
			}
			return () => {
				for (const dispose of disposers.reverse()) {
					try { dispose(); } catch (error) { console.warn("[comfyui-studio] 卸载失败：", error); }
				}
			};
		};
		exports.apply = mergedApply;
		exports.inject = mergedInject;
		return module.exports;
	},
});