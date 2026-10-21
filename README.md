# dsh-comfyui-studio

把本机 ComfyUI 接进 DSH Web GUI 的插件。不依赖任何云端 API，全部走本机 ComfyUI。

## 功能

- 侧边栏第二个入口，同源反代内嵌 ComfyUI 界面，不用另开端口
- 一键启动 ComfyUI、连接设置、最近出图
- 工作流库：标签、zip 迁移、从画布提取
- 资产页、队列页、加载区
- 任意节点参数覆盖、异步长任务、技能包

## 安装

把本目录放进 DSH 插件目录，例如 `~/.dsh/plugins/dsh-comfyui-studio`。

- `cordis.patch.yml` 负责把 `comfyui-studio` 这一行插入 web profile 的花名册；
- `package.json` 里的 `dsh.client` 声明让浏览器半边加载进 GUI。

## 结构

- `lib/index.js` — 宿主侧入口：ComfyUI 探活、启动、工作流读写、REST 代理
- `lib/client.js` — 浏览器侧入口：GUI 面板
- `lib/fandc/` — 具体模块：路由、参数、技能包、队列、转换、资源存储等

## 许可

MIT
