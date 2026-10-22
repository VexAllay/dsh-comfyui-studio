# dsh-comfyui-studio

把本机 ComfyUI（秋叶整合包等）接进 DSH Web GUI 的原生插件：一个「ComfyUI 工作台」标签页，
加上一块「面板」浮层，人和 agent 共用同一个 ComfyUI 实例。不需要任何云端 API。

## 能力

**工作台**
- 侧栏 / 顶栏入口：工作台 | ComfyUI | 面板，三态切换
- 参数条：工作流选择、正/负向提示词、比例、尺寸、采样（步数 / CFG / 采样器 / 调度器 / 随机种子）、生成
- 内嵌 ComfyUI 画布（同源反代，可交互）
- 最近出图（窄屏自动隐藏）

**面板**（独立浮层，顶栏「面板」按钮手动开合）
- 工作流：列表（标签 / 搜索 / 展开详情）、新建、导入 JSON、导出/导入预设、从画布提取、zip 迁移
- 资产：管理 `output/`、`input/`、`models/` 一类目录
- 队列：运行中 / 待执行 / 已完成，可取消
- 加载区：把素材、工作流拖进面板
- 技能：`comfyui_skill` 技能包（list / read / write / append / mkdir / rename / delete / enable / require）

**agent 工具**（7 个，DSH 对话里直接调用）
- `comfyui_workflows`：列工作流（带 environment：版本 / 路径 / 模型清单）
- `comfyui_generate`：按工作流 + 参数出图（支持 `positive` 别名）
- `comfyui_save_workflow`：把工作流写回 ComfyUI 的工作流目录
- `comfyui_workflow`：按 id 跑一条已保存工作流
- `comfyui_run`：跑手写 API 工作流（sync / async）
- `comfyui_object_info`：查节点定义与可用模型名
- `comfyui_skill`：读写技能包

**技能**：插件注册 `dsh-comfyui-workflows` 技能，教 agent 区分「图工作流 / API 工作流」、
识别画布里的多个独立流程、图→API 提取规则，以及本机 ComfyUI 目录与音色库的查询方案。

## 安装

1. 把本目录复制到 `~/.dsh/plugins/dsh-comfyui-studio`。
2. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加
   `"dsh-comfyui-studio": "link:C:/Users/<you>/.dsh/plugins/dsh-comfyui-studio"`，
   并把 `dsh-comfyui-studio` 加进 `dsh.profile.bundles`。
3. 重启 DSH（客户端半边开机打包加载，不热更）。

ComfyUI 侧可选装桥（让「点工作流 → 画布载入」生效）：

```
<ComfyUI>/custom_nodes/dsh_comfy_bridge/
├── __init__.py          # WEB_DIRECTORY = "./web"
└── web/bridge.js        # 广播 hello、接收 dcs-open-workflow → app.loadGraphData
```

不装桥也能用工作台与面板，只是点列表里的工作流不会自动载入画布。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边：HTTP 路由、探测/启动 ComfyUI、同源反代、工具注册、挂载 fandc |
| `lib/client.js` | 客户端半边：工作台 DOM、面板、iframe、状态轮询、技能面板 |
| `lib/fandc/` | 工作流库 / 资产 / 队列 / 技能包 / 传输等模块（移植自 fandc520/dsh-comfyui，MIT） |
| `bridge/` | ComfyUI 侧桥（复制到 `custom_nodes/dsh_comfy_bridge`） |
| `cordis.patch.yml` | bundle 补丁 |

客户端半边必须是 `window.__ModuleLoader__.load({ id, factory })` 形态，改成 IIFE 会让整个
web boot 失败。

## 路由

宿主路由（`/api/dsh-comfyui-studio`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 是否可达 + 版本/设备/显存/队列 + 当前配置 |
| GET | `/alive` | 客户端上报（`phase`/`frameLoaded`/`bridgeReady`/`csp`），排查用 |
| GET | `/config` | 读 `~/.dsh/dsh-comfyui-studio/config.json` |
| POST | `/settings` | 写配置（校验 host/port/路径） |
| POST | `/launch` | 按 `launchMode` 拉起整合包（`python` 或 `绘世启动器.exe`） |
| GET | `/workflows` · `/workflow?name=` | 读工作流目录 / 单个工作流 |
| POST | `/run` | 界面格式 → API 格式 → 提交 `/prompt` |
| GET | `/view?filename=` | 代理出图二进制 |
| GET | `/inspect` | 诊断信息（路由、客户端上报、工具） |
| POST | `/skill/*` | 技能包读写 |
| GET | `/comfyui/*` | fandc 移植的白名单转发（workflows、assets、queue、object_info、userdata 等） |
| * | `/comfy-ui/*` | 同源反代到 ComfyUI（文档根注入 `<base>`，其余原样转发） |

## 为什么必须反代（不能直接 iframe 8188）

DSH 桌面版跑在 `dsh-app://app/`，是 secure 上下文；ComfyUI 是明文 `http://127.0.0.1:8188`。
secure 页面嵌 http 子框架属于 blockable mixed content，Chromium 会静默丢弃——iframe 会
触发 load，但里面是空文档。绕法是在插件自己的 origin 上做同源反代，并注入
`<base href="/api/dsh-comfyui-studio/comfy-ui/">`，ComfyUI 前端据此推导 API 前缀。
代价：ComfyUI 自己的 WebSocket（执行进度推送）过不了 HTTP 反代，进度靠轮询。

## 配置

`~/.dsh/dsh-comfyui-studio/config.json`（不存在则用默认值）：

```json
{
  "comfyRoot": "",
  "host": "127.0.0.1",
  "port": 8188,
  "launchMode": "python",
  "extraArgs": "",
  "defaultWorkflow": ""
}
```

`comfyRoot` 留空时探测常见安装位置；`launchMode` 为 `launcher` 时改用绘世启动器；
`defaultWorkflow` 可选，留空则工作台打开时自动选列表里的第一个工作流。

## 开发

```powershell
node --check lib/index.js
node --check lib/client.js
```

改完 `lib/` 后复制到运行副本（工作区外，需提权）并重启 DSH。

## 已知限制

- 执行进度、实时预览、队列进度条：ComfyUI 自身 WebSocket 过不了反代。
- 工作流引用未安装的模型时，ComfyUI 会在画布上自己弹提示，插件不做拦截。
- 与 `dsh-comfyui-agent` 工具名重叠（`comfyui_workflows`、`comfyui_run`），不建议同时启用。

## 代码来源

界面形态与部分实现来自另外两个插件：

- **[@dickpy/dsh-imagegen](https://www.npmjs.com/package/@dickpy/dsh-imagegen)**（@dickpy）：
  侧边栏双段 tab、接管中心列、三栏工作台、参数条的交互形态。
- **[fandc520/dsh-comfyui](https://github.com/fandc520/dsh-comfyui)**（MIT）：
  `lib/fandc/` 下的工作流库、资产页、队列页、技能包、传输等模块，仅改挂载方式（`mountFandc(ctx)`）与依赖内联（`fflate`）。

另：客户端模块的加载形态参考 `dsh-plugin-wallpaper-engine` 的产物结构（`window.__ModuleLoader__.load({ id, factory })`）。

## 许可

MIT。`lib/fandc/` 移植自 [fandc520/dsh-comfyui](https://github.com/fandc520/dsh-comfyui)（MIT）。