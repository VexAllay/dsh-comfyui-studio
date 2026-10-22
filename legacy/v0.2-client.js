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
.dcs-tab .dcs-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,rgba(127,127,127,.6));flex:none;}
.dcs-tab .dcs-dot[data-on]{background:var(--dsw-alias-status-success,#41c07a);}
.dcs-tab .dcs-dot[data-busy]{background:var(--dsw-alias-status-warning,#e0a33a);}

/* 工作台根：接管中心列，自己撑满这一格 */
.dcs-root{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;
  background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;}
.dcs-root[hidden]{display:none;}

.dcs-bar{display:flex;align-items:center;gap:8px;flex:none;padding:8px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));}
.dcs-bar .dcs-title{font-weight:600;font-size:13px;white-space:nowrap;flex:none;}
.dcs-bar .dcs-meta{opacity:.6;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw;}
.dcs-spacer{flex:1;min-width:4px;}
.dcs-lamp{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,rgba(127,127,127,.55));flex:none;}
.dcs-lamp[data-state="on"]{background:var(--dsw-alias-status-success,#41c07a);}
.dcs-lamp[data-state="busy"]{background:var(--dsw-alias-status-warning,#e0a33a);}
.dcs-lamp[data-state="off"]{background:var(--dsw-alias-status-danger,#d05252);}

.dcs-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);
  font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}
.dcs-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}
.dcs-btn:disabled{opacity:.45;cursor:default;}
.dcs-btn[data-kind="primary"]{background:var(--dsw-alias-brand-bg,rgba(90,140,255,.18));
  border-color:var(--dsw-alias-brand-border,rgba(90,140,255,.4));
  color:var(--dsw-alias-brand-text,var(--dsw-alias-label-primary,inherit));}

.dcs-body{flex:1;display:flex;min-height:0;}
.dcs-side{width:222px;flex:none;display:flex;flex-direction:column;min-height:0;
  border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.03));}
.dcs-side-head{display:flex;align-items:center;gap:6px;padding:8px 10px;font-size:12px;
  color:var(--dsw-alias-label-secondary,inherit);
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));}
.dcs-list{flex:1;overflow:auto;padding:6px;margin:0;list-style:none;}
.dcs-item{padding:6px 8px;border-radius:7px;cursor:pointer;font-size:12.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,inherit);}
.dcs-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}
.dcs-item[data-active]{background:var(--dsw-specific-sidebar-nav-item-active,rgba(127,127,127,.2));}
.dcs-empty{padding:14px 10px;font-size:12px;line-height:1.8;color:var(--dsw-alias-label-tertiary,inherit);}
.dcs-detail{border-top:1px solid var(--dsw-alias-border-l1);margin:8px 6px 6px;padding:8px 6px 2px;display:grid;grid-template-columns:52px 1fr;gap:3px 8px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-height:42%;overflow:auto;}
.dcs-detail[hidden]{display:none;}
.dcs-detail b{grid-column:1 / -1;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:3px;word-break:break-all;}
.dcs-detail i{font-style:normal;color:var(--dsw-alias-label-tertiary,inherit);}
.dcs-detail em{font-style:normal;color:var(--dsw-alias-label-secondary);word-break:break-word;white-space:pre-wrap;}

.dcs-stage{flex:1;min-width:0;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base,transparent);}
.dcs-stage iframe{flex:1;width:100%;border:0;background:#fff;}
.dcs-stage iframe[hidden]{display:none;}
.dcs-placeholder{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  padding:24px;text-align:center;color:var(--dsw-alias-label-secondary,inherit);}
.dcs-placeholder[hidden]{display:none;}
.dcs-placeholder h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}
.dcs-placeholder p{margin:0;font-size:12.5px;max-width:460px;line-height:1.8;}

.dcs-results{width:196px;flex:none;display:flex;flex-direction:column;min-height:0;
  border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.03));}
.dcs-thumbs{flex:1;overflow:auto;padding:8px;display:grid;grid-template-columns:1fr 1fr;
  gap:6px;align-content:start;}
.dcs-thumbs img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:rgba(0,0,0,.2);}

.dcs-foot{flex:none;display:flex;gap:12px;padding:6px 12px;font-size:11.5px;
  color:var(--dsw-alias-label-tertiary,inherit);
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));}

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

		/** 界面全部状态。 */
		const state = {
			open: false,
			status: null,
			config: null,
			workflows: [],
			selected: "",
			selectedBody: null,
			images: [],
			notice: "",
			frameLoaded: false,
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
			refs.lamp = el("span", "dcs-lamp");
			refs.title = el("span", "dcs-title", "ComfyUI 工作台");
			refs.meta = el("span", "dcs-meta", "正在探测…");
			bar.append(refs.lamp, refs.title, refs.meta, el("div", "dcs-spacer"));

			refs.launch = el("button", "dcs-btn", "启动 ComfyUI");
			refs.launch.dataset.kind = "primary";
			refs.launch.addEventListener("click", () => { void doLaunch(); });
			refs.refresh = el("button", "dcs-btn", "刷新");
			refs.refresh.addEventListener("click", () => { void refreshAll(); });
			refs.popout = el("button", "dcs-btn", "新窗口");
			refs.popout.addEventListener("click", () => { openExternally(); });
			refs.settings = el("button", "dcs-btn", "设置");
			refs.settings.addEventListener("click", () => { toggleSettings(true); });
			refs.close = el("button", "dcs-btn", "返回对话");
			refs.close.addEventListener("click", () => { setOpen(false); });
			bar.append(refs.launch, refs.refresh, refs.popout, refs.settings, refs.close);

			// 主体：三栏
			const body = el("div", "dcs-body");

			const side = el("aside", "dcs-side");
			const sideHead = el("div", "dcs-side-head");
			sideHead.append(el("span", undefined, "工作流"), el("div", "dcs-spacer"));
			refs.workflowCount = el("span", undefined, "0");
			sideHead.append(refs.workflowCount);
			refs.list = el("ul", "dcs-list");
			refs.listEmpty = el("div", "dcs-empty", "还没有工作流。\n在 ComfyUI 里保存后会出现在这里。");
			refs.detail = el("div", "dcs-detail");
			refs.detail.hidden = true;
			side.append(sideHead, refs.list, refs.listEmpty, refs.detail);

			const stage = el("main", "dcs-stage");
			refs.frame = document.createElement("iframe");
			refs.frame.dataset.role = "frame";
			refs.frame.setAttribute("allow", "clipboard-read; clipboard-write");
			refs.frame.addEventListener("load", () => {
				state.frameLoaded = true;
				refs.placeholder.hidden = true;
				renderMeta();
			});
			refs.placeholder = el("div", "dcs-placeholder");
			refs.placeholder.append(el("h3", undefined, "本地 ComfyUI 未接入"));
			refs.placeholderText = el("p", undefined, "点左上角「启动 ComfyUI」拉起本机整合包；已经开着的会直接嵌进来。");
			refs.placeholder.append(refs.placeholderText);
			stage.append(refs.placeholder, refs.frame);
			refs.frame.hidden = true;

			const results = el("aside", "dcs-results");
			const resultsHead = el("div", "dcs-side-head");
			resultsHead.append(el("span", undefined, "最近出图"), el("div", "dcs-spacer"));
			refs.imagesCount = el("span", undefined, "0");
			resultsHead.append(refs.imagesCount);
			refs.thumbs = el("div", "dcs-thumbs");
			results.append(resultsHead, refs.thumbs);

			body.append(side, stage, results);

			// 底栏
			const foot = el("div", "dcs-foot");
			refs.footLeft = el("span", undefined, "");
			refs.footRight = el("span", undefined, "");
			foot.append(refs.footLeft, refs.footRight);

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
			refs.settingsCancel.addEventListener("click", () => { toggleSettings(false); });
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

			root.append(bar, body, foot, mask, lightbox);
			refs.root = root;
			return root;
		}

		/** 状态灯与顶栏文案。 */
		function renderMeta() {
			if (refs.lamp === undefined) return;
			const status = state.status;
			const reachable = status?.reachable === true;
			const busy = reachable && ((status.queueRunning ?? 0) + (status.queuePending ?? 0) > 0);
			const launching = status?.launching === true;
			refs.lamp.dataset.state = reachable ? (busy ? "busy" : "on") : (launching ? "busy" : "off");
			if (reachable) {
				refs.meta.textContent = `${status.url} · ${status.version ?? ""}${status.device === "" || status.device === undefined ? "" : ` · ${status.device}`}`;
				refs.launch.textContent = "重启 ComfyUI";
			} else if (launching) {
				refs.meta.textContent = `${status.url} · 正在启动…`;
				refs.launch.textContent = "启动中…";
			} else {
				refs.meta.textContent = `${status?.url ?? ""} · 未检测到服务`;
				refs.launch.textContent = "启动 ComfyUI";
				refs.placeholderText.textContent = status?.error === undefined
					? "点左上角「启动 ComfyUI」拉起本机整合包；已经开着的会直接嵌进来。"
					: `连接失败：${status.error}。点「启动 ComfyUI」拉起本机整合包，或先在「设置」里确认路径。`;
			}
			refs.launch.disabled = launching;
			refs.footLeft.textContent = reachable
				? `队列 运行 ${status.queueRunning ?? 0} / 等待 ${status.queuePending ?? 0}`
				: "队列 —";
			const root = status?.root ?? state.config?.comfyRoot ?? "";
			refs.footRight.textContent = `${state.notice === "" ? "" : `${state.notice} · `}${root === "" ? "未找到整合包根目录" : root}`;
			// tab 上的小圆点
			if (refs.dot !== undefined) {
				if (reachable) refs.dot.dataset.on = "";
				else delete refs.dot.dataset.on;
				if (busy || launching) refs.dot.dataset.busy = "";
				else delete refs.dot.dataset.busy;
			}
		}

		/**
		 * 内嵌 ComfyUI 的地址。
		 *
		 * 默认**直连上游**（`http://127.0.0.1:8188/`）：这样 iframe 自己的源就是
		 * 8188，前端那些 `<script type="module">` 全是同源请求，能正常加载。
		 *
		 * 走 `/comfy-ui` 反代时，HTML 虽然拿到了（还会注入 `<base>`），但前端的
		 * ES module 实际仍是从 DSH 页面的源去请求 8188 —— 跨源模块脚本需要 CORS
		 * 响应头，ComfyUI 默认不给，浏览器直接拒绝，界面就永久停在启动画面上。
		 * 所以反代只当回退用（直连被 CSP 拦掉时）。
		 */
		function embedUrl(useProxy) {
			const url = state.status?.url;
			if (useProxy === true || url === undefined || url === "") return `${BASE}/comfy-ui`;
			return url;
		}

		/** 同步 iframe。 */
		function syncFrame(forceProxy) {
			if (refs.frame === undefined) return;
			const reachable = state.status?.reachable === true;
			if (!reachable) {
				if (refs.frame.dataset.src !== "") {
					refs.frame.dataset.src = "";
					refs.frame.hidden = true;
					refs.frame.removeAttribute("src");
				}
				refs.placeholder.hidden = false;
				refs.placeholderText.textContent = "ComfyUI 没在运行。点左上角「启动 ComfyUI」拉起整合包。";
				return;
			}
			const url = embedUrl(forceProxy === true);
			if (refs.frame.dataset.src !== url) {
				refs.frame.dataset.src = url;
				refs.frame.hidden = false;
				refs.placeholder.hidden = true;
				state.frameLoaded = false;
				refs.frame.src = url;
				// 5 秒还没 load：先自动回退到同源反代试一次（直连可能被 CSP 拦），
				// 两条路都不行才提示「新窗口」兜底。
				window.setTimeout(() => {
					if (state.frameLoaded || state.open !== true) return;
					if (forceProxy !== true && refs.frame.dataset.proxyTried !== "1") {
						refs.frame.dataset.proxyTried = "1";
						syncFrame(true);
						return;
					}
					refs.placeholder.hidden = false;
					refs.placeholderText.textContent =
						"内嵌视图没加载出来（直连与同源反代都没成功）。点顶栏「新窗口」，直接在浏览器里打开 ComfyUI。";
				}, 5000);
			}
		}

		/** 渲染工作流清单。 */
		function renderWorkflows() {
			if (refs.list === undefined) return;
			refs.list.textContent = "";
			refs.workflowCount.textContent = String(state.workflows.length);
			refs.listEmpty.hidden = state.workflows.length > 0;
			for (const entry of state.workflows) {
				const item = el("li", "dcs-item", entry.name);
				item.title = `${entry.name}（单击看这个工作流的模型与参数，双击刷新内嵌界面）`;
				if (state.selected === entry.name) item.dataset.active = "";
				item.addEventListener("click", () => { void selectWorkflow(entry.name); });
				item.addEventListener("dblclick", () => { openInFrame(entry.name); });
				refs.list.append(item);
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

		/** 拉工作流清单。 */
		async function refreshWorkflows() {
			try {
				const payload = await api("/workflows");
				const names = Array.isArray(payload) ? payload : [];
				state.workflows = names
					.map((name) => (typeof name === "string" ? { name } : { name: String(name?.path ?? name?.name ?? "") }))
					.filter((entry) => entry.name !== "");
				state.notice = "";
			} catch (error) {
				state.workflows = [];
				state.notice = `工作流读取失败：${String(error).slice(0, 60)}`;
			}
			renderWorkflows();
			renderMeta();
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
				await Promise.all([refreshWorkflows(), refreshImages()]);
			}
		}

		/**
		 * 单击工作流：读出 JSON 并在左栏展开它的模型 / 采样器 / 尺寸。
		 *
		 * 不试着把它送进内嵌的 ComfyUI：这份前端（1.55.17）不支持 `?workflow=`
		 * 这类 URL 参数（432 个 chunk 里零命中），跨源 iframe 又拿不到它的 JS
		 * 上下文，所以切换工作流只能在右侧 ComfyUI 自己的工作流面板里做 ——
		 * 这里给的是这个工作流到底用什么模型、什么参数。
		 */
		async function selectWorkflow(name) {
			state.selected = name;
			state.selectedBody = null;
			state.detail = null;
			renderWorkflows();
			renderDetail();
			try {
				const payload = await api(`/workflow?name=${encodeURIComponent(name)}`);
				const text = typeof payload === "string" ? payload : payload?.text ?? "";
				let parsed = null;
				try { parsed = JSON.parse(text); } catch { parsed = null; }
				state.selectedBody = parsed;
				state.notice = describeFormat(parsed);
				state.detail = summarize(name, parsed);
			} catch (error) {
				state.notice = `读取失败：${String(error).slice(0, 60)}`;
			}
			renderWorkflows();
			renderDetail();
			renderMeta();
		}

		/** 把一个工作流 JSON 提炼成能看懂的几行。 */
		function summarize(name, parsed) {
			const rows = [["格式", describeFormat(parsed)]];
			if (parsed === null || typeof parsed !== "object") return { name, rows, prompts: [] };
			const prompts = [];
			if (Array.isArray(parsed.nodes)) {
				const models = [];
				let sampler = "", steps = "", cfg = "", size = "";
				for (const node of parsed.nodes) {
					const w = Array.isArray(node?.widgets_values) ? node.widgets_values : [];
					const title = String(node?.title ?? "");
					switch (node?.type) {
						case "CheckpointLoaderSimple": models.push(String(w[0] ?? "?")); break;
						case "LoraLoader": models.push(`LoRA ${String(w[0] ?? "?")} ×${String(w[2] ?? "?")}`); break;
						case "VAELoader": models.push(`VAE ${String(w[0] ?? "?")}`); break;
						case "KSampler":
						case "KSamplerAdvanced":
							sampler = `${String(w[4] ?? "?")} / ${String(w[5] ?? "?")}`;
							if (w[2] !== undefined) steps = String(w[2]);
							if (w[3] !== undefined) cfg = String(w[3]);
							break;
						case "EmptyLatentImage":
							if (w[0] !== undefined) size = `${String(w[0])} × ${String(w[1])}`;
							break;
						case "CLIPTextEncode": {
							const raw = String(w[0] ?? "").trim();
							if (raw === "") break;
							prompts.push({ kind: /negative|负|反向/i.test(title) ? "负向" : "正向", text: raw });
							break;
						}
					}
				}
				rows.push(["节点", `${parsed.nodes.length} 个`]);
				if (models.length > 0) rows.push(["模型", models.join("\n")]);
				if (sampler !== "") rows.push(["采样", `${sampler}${steps === "" ? "" : ` · ${steps} 步`}${cfg === "" ? "" : ` · CFG ${cfg}`}`]);
				if (size !== "") rows.push(["尺寸", size]);
				return { name, rows, prompts };
			}
			const ids = Object.keys(parsed);
			const models = [];
			let sampler = "", size = "";
			for (const id of ids) {
				const node = parsed[id];
				const inputs = node?.inputs ?? {};
				switch (node?.class_type) {
					case "CheckpointLoaderSimple": models.push(String(inputs.ckpt_name ?? "?")); break;
					case "LoraLoader": models.push(`LoRA ${String(inputs.lora_name ?? "?")}`); break;
					case "VAELoader": models.push(`VAE ${String(inputs.vae_name ?? "?")}`); break;
					case "KSampler":
						sampler = `${String(inputs.sampler_name ?? "?")} / ${String(inputs.scheduler ?? "?")} · ${String(inputs.steps ?? "?")} 步`;
						break;
					case "EmptyLatentImage":
						size = `${String(inputs.width ?? "?")} × ${String(inputs.height ?? "?")}`;
						break;
				}
			}
			rows.push(["节点", `${ids.length} 个`]);
			if (models.length > 0) rows.push(["模型", models.join("\n")]);
			if (sampler !== "") rows.push(["采样", sampler]);
			if (size !== "") rows.push(["尺寸", size]);
			return { name, rows, prompts };
		}

		/** 把选中工作流的摘要画到左栏底部。 */
		function renderDetail() {
			if (refs.detail === undefined) return;
			refs.detail.textContent = "";
			const detail = state.detail;
			if (detail === null || detail === undefined) { refs.detail.hidden = true; return; }
			refs.detail.hidden = false;
			refs.detail.append(el("b", undefined, detail.name));
			for (const pair of detail.rows) {
				refs.detail.append(el("i", undefined, pair[0]));
				const cell = el("em", undefined, "");
				cell.textContent = String(pair[1]);
				refs.detail.append(cell);
			}
			for (const prompt of detail.prompts) {
				refs.detail.append(el("i", undefined, prompt.kind));
				const cell = el("em", undefined, "");
				cell.textContent = prompt.text.length > 220 ? `${prompt.text.slice(0, 220)}…` : prompt.text;
				cell.title = prompt.text;
				refs.detail.append(cell);
			}
		}

		/** 工作流是界面格式还是 API 格式。 */
		function describeFormat(parsed) {
			if (parsed === null || typeof parsed !== "object") return "这个文件不是 JSON";
			if (Array.isArray(parsed.nodes)) return "界面格式（可直接在右侧 ComfyUI 里编辑并运行）";
			const keys = Object.keys(parsed);
			if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) return "API 格式（可被直接提交执行）";
			return "未识别的格式";
		}

		/** 双击工作流：重载内嵌界面并提示（不猜前端路由，避免 404 白屏）。 */
		function openInFrame(name) {
			if (state.status?.reachable !== true) {
				state.notice = "ComfyUI 还没就绪";
				renderMeta();
				return;
			}
			refs.frame.dataset.src = "";
			void syncFrame();
			state.notice = `已刷新界面，请在 ComfyUI 的「工作流」面板里打开 ${name}`;
			renderMeta();
		}

		/** 打开原生窗口（直连 8188，绕开反代）。 */
		function openExternally() {
			const url = state.status?.url;
			if (url === undefined) return;
			window.open(url, "_blank", "noopener");
		}

		/** 一键启动。 */
		async function doLaunch() {
			state.notice = "正在启动…";
			renderMeta();
			const payload = await api("/launch", { method: "POST", body: {} });
			if (payload.ok !== true) {
				state.notice = payload.error ?? "启动失败";
				renderMeta();
				return;
			}
			state.status = { ...(state.status ?? {}), launching: true };
			renderMeta();
			// 启动是长过程：面板开着时轮询会自己把状态刷成在线。
			for (let attempt = 0; attempt < 20; attempt += 1) {
				await new Promise((resolve) => { window.setTimeout(resolve, 4000); });
				await refreshStatus();
				if (state.status?.reachable === true) {
					state.notice = "已就绪";
					await refreshAll();
					return;
				}
			}
			state.notice = "启动超时，去 ComfyUI 窗口看看日志";
			renderMeta();
		}

		/** 设置对话框显隐与回填。 */
		function toggleSettings(open) {
			if (refs.mask === undefined) return;
			if (open) {
				const config = state.config ?? {};
				for (const key of ["comfyRoot", "host", "port", "launchMode", "extraArgs"]) {
					if (refs.inputs[key] !== undefined) refs.inputs[key].value = String(config[key] ?? "");
				}
			}
			refs.mask.hidden = !open;
		}

		/** 保存设置。 */
		async function saveSettings() {
			const patch = {};
			for (const key of ["comfyRoot", "host", "port", "launchMode", "extraArgs"]) {
				const raw = refs.inputs[key]?.value ?? "";
				patch[key] = key === "port" ? Number(raw) || 8188 : raw;
			}
			const payload = await api("/config", { method: "POST", body: patch });
			state.config = payload.config ?? patch;
			toggleSettings(false);
			state.notice = "设置已保存";
			await refreshAll();
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
			const pane = conversationPane();
			if (pane === undefined) return undefined;
			if (refs.root === undefined) buildView();
			// 插在对话列后面，作为它的兄弟
			if (refs.root.parentElement !== pane.parentElement || refs.root.previousElementSibling !== pane) {
				pane.parentElement?.insertBefore(refs.root, pane.nextSibling);
			}
			return pane;
		}

		/** 面板开合：接管 / 让出中心列。 */
		function setOpen(open) {
			state.open = open;
			const pane = attachView();
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
					if (refs.root !== undefined) refs.root.hidden = true;
				}
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
				refs.dot = existing.querySelector(".dcs-dot") ?? undefined;
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
			comfyTab.setAttribute("aria-label", "ComfyUI 工作台");
			comfyTab.setAttribute("title", "本地 ComfyUI 工作台（绘世整合包）");
			const label = el("span", undefined, "ComfyUI");
			refs.dot = el("span", "dcs-dot");
			comfyTab.append(label, refs.dot);
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

			let root;
			let tabs;
			let lastPhase = "";
			let stopped = false;   // 找到锚点或超时后停掉 observer
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

			/** 停止观察（找到 tab 后就不再需要盯着 DOM 了）。 */
			const stopObserving = () => {
				stopped = true;
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
				stopObserving();
			}, GIVE_UP_MS);

			/**
			 * 点侧边栏里的会话（或「新会话」）就退回对话视图。
			 *
			 * 用户在工作台里想切会话时不该被面板挡住：除了我们自己的两格 tab，
			 * 侧边栏里的任何点击都视为「要回对话」。捕获阶段监听，免得 shell
			 * 自己的处理器先把事件吃掉。
			 */
			const onDocumentClick = (event) => {
				if (state.open !== true) return;
				const target = event.target;
				if (!(target instanceof Element)) return;
				if (target.closest("[data-dcs-tabs]") !== null) return;        // 我们自己的 tab
				if (target.closest("[data-dcs-root]") !== null) return;        // 工作台内部
				if (target.closest(SIDEBAR_COLUMN_SELECTOR) === null) return;  // 只在侧边栏里生效
				setOpen(false);
			};
			document.addEventListener("click", onDocumentClick, true);

			observer.observe(document.body, { childList: true, subtree: true });
			ensure();

			return () => {
				stopped = true;
				observer.disconnect();
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

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});