/**
 * dsh-comfyui-studio — 宿主半边（node half）。
 *
 * 职责：把本机的 ComfyUI（绘世整合包，默认 127.0.0.1:8188）接进 DSH 宿主进程 ——
 *   · 探活（/system_stats + /queue）与设备信息；
 *   · 一键启动（直接拉起整合包内嵌 python，或经绘世启动器）；
 *   · 工作流读写（ComfyUI 的 /userdata 文件族）；
 *   · 一个受白名单约束的 REST 转发口 + 一个图片/资源二进制代理口。
 *
 * 浏览器半边（./client）负责侧边栏入口与工作台界面；所有跨进程动作都走
 * /api/dsh-comfyui-studio 路由族，密钥与路径不出宿主。
 *
 * 界面与工作流库的实现来源见 README「代码来源」（dsh-imagegen / fandc520/dsh-comfyui）。
 *
 * 契约（与 dsh-plugin-wallpaper-engine 同形）：
 *   export const inject = ['webServer']
 *   export function apply(ctx) -> () => void      // 返回卸载器
 *   export default { inject, apply }
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { mountFandc } from './fandc/index.js'

/** webServer 是硬依赖：没有 HTTP 服务就不加载本插件。 */
export const inject = ['webServer']

/** 路由族前缀（浏览器半边同名常量，改这里要一起改）。 */
const BASE = '/api/dsh-comfyui-studio'

/** 插件数据目录：与 DSH 的其它插件数据同层。 */
const DATA_DIR = path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'dsh-comfyui-studio')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')

/** JSON 体上限（工作流原文可以很大，给到 32MB）。 */
const MAX_JSON_BODY = 32 * 1024 * 1024

/** 上游（ComfyUI）请求超时：长任务靠轮询历史，不靠单次长挂。 */
const UPSTREAM_TIMEOUT_MS = 120_000

/** 资源代理可放的响应头（其余一律不透传）。 */
const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag', 'accept-ranges']

/** ComfyUI 根目录候选（按顺序探测：环境变量 → 秋叶整合包默认位 → 家目录常见位）。 */
const ROOT_CANDIDATES = [
  process.env.DSH_COMFYUI_ROOT,
  'D:\\AI绘图\\秋叶comfyui整合包\\ComfyUI-aki-v2',
  path.join(homedir(), 'ComfyUI'),
  path.join(homedir(), 'Documents', 'ComfyUI'),
].filter((candidate) => typeof candidate === 'string' && candidate !== '')

/** 插件配置默认值。 */
const DEFAULT_CONFIG = {
  /** 整合包根目录（含 ComfyUI/ 与 python/ 的那一层）。 */
  comfyRoot: '',
  host: '127.0.0.1',
  port: 8188,
  /** 'python' = 直接拉起内嵌 python；'launcher' = 拉起绘世启动器。 */
  launchMode: 'python',
  /** 追加到 python 启动命令后的参数（空格分隔）。 */
  extraArgs: '',
}

/** 探测本机的整合包根目录；找不到返回空串。 */
function detectRoot() {
  for (const candidate of ROOT_CANDIDATES) {
    try {
      if (existsSync(path.join(candidate, 'ComfyUI', 'main.py'))) return candidate
    } catch {
      /* 不可读的候选直接跳过 */
    }
  }
  return ''
}

/** 读配置（每次现读：文件很小，且用户在面板里改完立刻生效）。 */
async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    return { ...DEFAULT_CONFIG, ...raw }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 写配置（合并式：只覆盖传进来的键）。 */
async function saveConfig(patch) {
  const current = await loadConfig()
  const next = { ...current }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key in DEFAULT_CONFIG) next[key] = value
  }
  mkdirSync(DATA_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/** 生效的整合包根目录：配置优先，其次自动探测。 */
function resolveRoot(config) {
  return config.comfyRoot !== '' ? config.comfyRoot : detectRoot()
}

/** 错误文本（绝不要 [object Object]）。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 上游基址。 */
function upstreamBase(config) {
  return `http://${config.host}:${config.port}`
}

/** 收一个请求体（有界）。 */
function readBody(req, maxBytes = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error(`请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/** 收一个请求体（原始 Buffer，用于二进制转发，不动编码）。 */
function readRawBody(req, maxBytes = MAX_JSON_BODY * 2) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error(`请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

/** 回一个 JSON 响应。 */
function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

/** 转发到 ComfyUI，返回 { status, json?, text }（不抛，除非网络层挂了）。 */
async function forward(config, targetPath, options = {}) {
  const { method = 'GET', body, timeoutMs = UPSTREAM_TIMEOUT_MS } = options
  const headers = {}
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const response = await fetch(`${upstreamBase(config)}${targetPath}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: response.status, json, text }
}

/** 转发失败时的统一应答（把上游状态与正文都带出去，便于面板显示）。 */
function relay(res, result) {
  sendJson(res, result.status >= 400 ? result.status : 200, result.json ?? { ok: true, text: result.text })
}

/**
 * 把工作流名规整成 userdata/workflows 下的相对路径。
 *
 * 允许子目录（"子目录/好看的.json"），因为 /workflows 是递归列出来的，
 * 过去用 path.basename(name) 会把子目录拍平、读错文件。同时挡掉绝对路径、
 * 盘符、`..` 和反斜杠越界；不合法返回空串，由调用方回 400。
 */
function workflowKey(name) {
  const raw = String(name ?? '').replace(/\\/g, '/').trim()
  if (raw === '' || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return ''
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) return ''
  return parts.join('/')
}

/** object_info 里这条输入是不是「可填值的 widget」（而不是连线口）。 */
function isWidgetInput(definition) {
  if (!Array.isArray(definition) || definition.length === 0) return false
  const type = definition[0]
  if (Array.isArray(type)) return true // 枚举（采样器名、模型名…）
  return type === 'INT' || type === 'FLOAT' || type === 'STRING' || type === 'BOOLEAN'
}

/** seed 类控件后面跟着的「生成后行为」取值。 */
const CONTROL_VALUES = new Set(['fixed', 'randomize', 'increment', 'decrement'])

/**
 * 这个 widget 后面是否还藏着一个 control_after_generate 值。
 *
 * UI 格式存盘时，seed / noise_seed 之后会多写一个 "randomize"/"fixed"…，
 * 但 object_info 里没有这一项。不跳过它，后面所有 widget 都会错位一位：
 * KSampler 的 steps 会拿到 "randomize"、sampler_name 会拿到 cfg 的数字，
 * ComfyUI 直接报 prompt_outputs_failed_validation。
 */
function hasControlAfterGenerate(name, definition, next) {
  if (!CONTROL_VALUES.has(String(next))) return false
  if (name === 'seed' || name === 'noise_seed') return true
  const config = Array.isArray(definition) ? definition[1] : undefined
  return config?.control_after_generate === true
}

/**
 * 界面格式工作流 → API 格式（ComfyUI 的 /prompt 只吃 API 格式）。
 *
 * 界面格式（UI 存盘的那种）带 nodes/links/坐标；API 格式是
 * `{ "<nodeId>": { class_type, inputs } }`。转换要处理三件事：
 *   1. 连线输入 → `inputs[name] = [上游节点, 上游槽位]`；
 *   2. widget 值 → 按 object_info 声明的顺序，从 widgets_values 里依次取
 *      （已被转成连线口的 widget 要跳过，否则后面的值会整体错位）；
 *   3. PrimitiveNode 在 API 格式里没有对应类，它的值要直接写进下游输入。
 *
 * 认不出的节点原样带上：让 ComfyUI 自己报「缺节点」比静默丢节点好排查。
 */
function uiToApi(graph, objectInfo, overrides = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []

  const linkMap = new Map()
  for (const link of graph?.links ?? []) {
    if (Array.isArray(link) && link.length >= 3) linkMap.set(link[0], { node: link[1], slot: link[2] })
  }

  // PrimitiveNode 的值：API 格式里没有这个类，得把值直接喂给下游。
  const primitives = new Map()
  for (const node of nodes) {
    if (String(node?.type ?? '') === 'PrimitiveNode') {
      primitives.set(String(node.id), (node.widgets_values ?? [])[0])
    }
  }

  const api = {}
  for (const node of nodes) {
    const mode = Number(node?.mode ?? 0)
    if (mode === 2 || mode === 4) continue // 静音 / 旁路
    const type = String(node?.type ?? '')
    if (type === '' || type === 'Note' || type === 'Reroute' || type === 'PrimitiveNode') continue

    const inputs = {}

    // 1) 连线输入
    for (const input of node?.inputs ?? []) {
      if (input?.link === null || input?.link === undefined) continue
      const source = linkMap.get(input.link)
      if (source === undefined) continue
      const sourceId = String(source.node)
      if (primitives.has(sourceId)) {
        // 值在上游的 PrimitiveNode 身上（ComfyUI 把参数「转成输入」之后就是这样）。
        // overrides 必须也认这个节点，否则参数条在这类工作流上一个字段都改不动。
        inputs[String(input.name)] =
          overrides[`${sourceId}.value`] ??
          overrides[`${sourceId}.${input.name}`] ??
          overrides[String(input.name)] ??
          primitives.get(sourceId)
        continue
      }
      inputs[String(input.name)] = [sourceId, source.slot]
    }

    // 2) widget 值
    const spec = objectInfo?.[type]?.input
    if (spec !== undefined) {
      const ordered = [...Object.entries(spec.required ?? {}), ...Object.entries(spec.optional ?? {})]
      const values = Array.isArray(node?.widgets_values) ? node.widgets_values : []
      let index = 0
      for (const [name, definition] of ordered) {
        if (!isWidgetInput(definition)) continue
        const raw = values[index]
        index += 1
        if (raw === undefined) continue
        // 被转成连线口的 widget 在 widgets_values 里可能仍有占位值，以连线为准。
        const connected = inputs[name] !== undefined
        // seed 后面还跟着 control_after_generate（"randomize"/"fixed"…），
        // object_info 里没有这一项，必须跳掉；同时按它决定这一次用哪个种子，
        // 否则每次都拿存盘时那个固定 seed，同一张图反复出。
        let value = raw
        if (hasControlAfterGenerate(name, definition, values[index])) {
          const control = values[index]
          index += 1
          if (control === 'randomize') value = Math.floor(Math.random() * 2 ** 48)
          else if (control === 'increment') value = Number(raw) + 1
        }
        if (connected) continue
        // overrides 支持 "节点ID.输入名" 精确覆盖，也支持裸输入名。
        inputs[name] = overrides[`${node.id}.${name}`] ?? overrides[name] ?? value
      }
    }

    api[String(node.id)] = { class_type: type, inputs, _meta: { title: node?.title ?? type } }
  }
  return api
}

/**
 * 认出一个界面格式工作流里的关键参数：模型、正/负提示词、采样、尺寸。
 *
 * 参数条与 Agent 工具都要把「正向提示词 / 步数 / 宽高」这类人话映射成
 * uiToApi 的 overrides（`${节点id}.${输入名}`）。所以这里不靠猜 widget 下标，
 * 而是沿连线找到真正干活的节点，再按 object_info 的顺序取值（同样跳过
 * seed 后面那位 control_after_generate）。认不出就返回 null，由调用方决定退路。
 */
function analyzeWorkflow(graph, objectInfo) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const links = new Map()
  const linkTypes = new Map()
  for (const link of graph?.links ?? []) {
    if (Array.isArray(link) && link.length >= 2) links.set(link[0], String(link[1]))
    if (Array.isArray(link) && link.length >= 6) linkTypes.set(link[0], String(link[5] ?? ''))
  }
  const byId = new Map(nodes.map((node) => [String(node?.id), node]))
  const typeOf = (node) => String(node?.type ?? '')
  const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

  /** 按 object_info 声明的顺序读一个 widget 的当前值。 */
  const widgetValue = (node, want) => {
    const values = Array.isArray(node?.widgets_values) ? node.widgets_values : []
    if (typeOf(node) === 'PrimitiveNode') return want === 'value' || want === 'text' ? values[0] : undefined
    const spec = objectInfo?.[typeOf(node)]?.input
    if (spec === undefined) return undefined
    const ordered = [...Object.entries(spec.required ?? {}), ...Object.entries(spec.optional ?? {})]
    let index = 0
    for (const [name, definition] of ordered) {
      if (!isWidgetInput(definition)) continue
      const raw = values[index]
      index += 1
      if (hasControlAfterGenerate(name, definition, values[index])) index += 1
      const connected = (node?.inputs ?? []).some(
        (input) => input?.name === name && input?.link !== null && input?.link !== undefined,
      )
      if (connected) continue
      if (name === want) return raw
    }
    return undefined
  }

  /** 沿某个输入口的连线找上游节点。 */
  const sourceOf = (node, inputName) => {
    const input = (node?.inputs ?? []).find((item) => item?.name === inputName)
    if (input?.link === null || input?.link === undefined) return undefined
    const source = links.get(input.link)
    return source === undefined ? undefined : byId.get(source)
  }

  /**
   * 一个输入口的值在谁身上、要用哪个 override 键才改得动它。
   *
   * ComfyUI 可以把任意 widget「转成输入」：值这时搬到上游节点里（多半是
   * PrimitiveNode）。所以这里同时回答两件事 —— 当前值是多少、键该写成
   * `${本节点id}.${输入名}` 还是 `${上游id}.value`。改不动时 key 为 null。
   */
  const slotOf = (node, name) => {
    if (node === undefined) return { key: null, value: undefined }
    const input = (node?.inputs ?? []).find((item) => item?.name === name)
    const linked = input?.link !== null && input?.link !== undefined
    if (!linked) {
      const value = widgetValue(node, name)
      if (value === undefined && input === undefined) return { key: null, value: undefined }
      return { key: `${node.id}.${name}`, value }
    }
    const source = sourceOf(node, name)
    if (source !== undefined && typeOf(source) === 'PrimitiveNode') {
      const values = Array.isArray(source.widgets_values) ? source.widgets_values : []
      return { key: `${source.id}.value`, value: values[0] }
    }
    return { key: null, value: undefined }
  }

  /** 这个节点自己是不是装文本的（CLIPTextEncode 系，或 widget 名里有 text/prompt 的编码器）。 */
  const looksLikeText = (node) => {
    if (/TextEncode/i.test(typeOf(node))) return true
    const spec = objectInfo?.[typeOf(node)]?.input
    if (spec === undefined) return false
    const names = [...Object.keys(spec.required ?? {}), ...Object.keys(spec.optional ?? {})]
    return names.includes('text') || names.includes('prompt')
  }

  /** 只沿 CONDITIONING 连线往上游走；类型缺失时也放行，免得漏掉老工作流。 */
  const isConditioning = (linkId) => {
    const kind = String(linkTypes.get(linkId) ?? '').toUpperCase()
    return kind === '' || kind.includes('CONDITIONING')
  }

  /**
   * 正负提示词并不总是直连 KSampler：中间可能夹着 ControlNetApply、ConditioningCombine
   * 这类节点（实测「姿势控制.json」正向是 CLIPTextEncode#6 → ControlNetApply → KSampler#3）。
   * 所以沿 conditioning 链一路向上，直到找到真正装文本的节点。
   */
  const textSourceOf = (node, inputName) => {
    const start = sourceOf(node, inputName)
    if (start === undefined) return undefined
    const seen = new Set()
    const walk = (current, depth) => {
      if (current === undefined || depth > 12) return undefined
      const id = String(current.id)
      if (seen.has(id)) return undefined
      seen.add(id)
      if (typeOf(current) === 'PrimitiveNode' || looksLikeText(current)) return current
      for (const input of current.inputs ?? []) {
        if (input?.link === null || input?.link === undefined) continue
        if (!isConditioning(input.link)) continue
        const upstream = links.get(input.link)
        const found = walk(upstream === undefined ? undefined : byId.get(upstream), depth + 1)
        if (found !== undefined) return found
      }
      return undefined
    }
    return walk(start, 0)
  }

  const sampler = nodes.find((node) => /^KSampler/.test(typeOf(node)))
  if (sampler === undefined) return null
  const positiveNode = textSourceOf(sampler, 'positive')
  const negativeNode = textSourceOf(sampler, 'negative')
  const latentNode = sourceOf(sampler, 'latent_image')
  const modelNode = sourceOf(sampler, 'model')
  const sizeNode =
    latentNode !== undefined && slotOf(latentNode, 'width').value !== undefined
      ? latentNode
      : nodes.find((node) => typeOf(node) !== 'PrimitiveNode' && slotOf(node, 'width').value !== undefined)

  const seedSlot = slotOf(sampler, 'seed')
  const seed = seedSlot.value === undefined ? slotOf(sampler, 'noise_seed') : seedSlot
  const stepsSlot = slotOf(sampler, 'steps')
  const cfgSlot = slotOf(sampler, 'cfg')
  const samplerSlot = slotOf(sampler, 'sampler_name')
  const schedulerSlot = slotOf(sampler, 'scheduler')
  const positiveSlot = slotOf(positiveNode, 'text')
  const negativeSlot = slotOf(negativeNode, 'text')
  const widthSlot = slotOf(sizeNode, 'width')
  const heightSlot = slotOf(sizeNode, 'height')
  const batchSlot = slotOf(sizeNode, 'batch_size')

  return {
    nodeCount: nodes.length,
    sampler: {
      id: String(sampler.id),
      type: typeOf(sampler),
      steps: numberOr(stepsSlot.value, null),
      cfg: numberOr(cfgSlot.value, null),
      sampler: samplerSlot.value ?? null,
      scheduler: schedulerSlot.value ?? null,
      denoise: numberOr(slotOf(sampler, 'denoise').value, null),
      seed: numberOr(seed.value, null),
      keys: {
        steps: stepsSlot.key,
        cfg: cfgSlot.key,
        sampler_name: samplerSlot.key,
        scheduler: schedulerSlot.key,
        seed: seed.key,
      },
    },
    positive:
      positiveNode === undefined
        ? null
        : { id: String(positiveNode.id), type: typeOf(positiveNode), text: String(positiveSlot.value ?? ''), key: positiveSlot.key },
    negative:
      negativeNode === undefined
        ? null
        : { id: String(negativeNode.id), type: typeOf(negativeNode), text: String(negativeSlot.value ?? ''), key: negativeSlot.key },
    size:
      sizeNode === undefined
        ? null
        : {
            id: String(sizeNode.id),
            type: typeOf(sizeNode),
            width: numberOr(widthSlot.value, null),
            height: numberOr(heightSlot.value, null),
            batch: numberOr(batchSlot.value, 1),
            keys: { width: widthSlot.key, height: heightSlot.key, batch_size: batchSlot.key },
          },
    model:
      modelNode === undefined
        ? null
        : { id: String(modelNode.id), type: typeOf(modelNode), name: widgetValue(modelNode, 'ckpt_name') ?? null },
  }
}

/**
 * 把界面上的几个字段拼成 uiToApi 的 overrides。
 *
 * 键由 analyzeWorkflow 算好（有的是节点自身的 widget，有的是上游 PrimitiveNode
 * 的 value），所以「参数被转成输入」的工作流也改得动。只覆盖确实认出来的那部分。
 */
function buildOverrides(summary, args) {
  const overrides = {}
  if (summary === null || summary === undefined) return overrides
  const put = (key, value) => {
    if (typeof key === 'string' && key !== '' && value !== undefined) overrides[key] = value
  }
  if (typeof args.prompt === 'string' && args.prompt.trim() !== '' && summary.positive !== null) {
    put(summary.positive.key, args.prompt)
  }
  if (typeof args.negative === 'string' && args.negative.trim() !== '' && summary.negative !== null) {
    put(summary.negative.key, args.negative)
  }
  if (summary.sampler !== null && summary.sampler !== undefined) {
    const keys = summary.sampler.keys ?? {}
    if (Number.isFinite(args.steps)) put(keys.steps, Math.max(1, Math.round(args.steps)))
    if (Number.isFinite(args.cfg)) put(keys.cfg, args.cfg)
    if (Number.isFinite(args.seed)) put(keys.seed, Math.round(args.seed))
    if (typeof args.sampler === 'string' && args.sampler !== '') put(keys.sampler_name, args.sampler)
    if (typeof args.scheduler === 'string' && args.scheduler !== '') put(keys.scheduler, args.scheduler)
  }
  if (summary.size !== null && summary.size !== undefined) {
    const keys = summary.size.keys ?? {}
    if (Number.isFinite(args.width)) put(keys.width, Math.round(args.width))
    if (Number.isFinite(args.height)) put(keys.height, Math.round(args.height))
    if (Number.isFinite(args.batch)) put(keys.batch_size, Math.max(1, Math.round(args.batch)))
  }
  return overrides
}

/** 从 /history 的 entry 里榨出人能看懂的执行错误（ComfyUI 把它埋在 messages 里）。 */
function executionErrorText(entry) {
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : []
  for (const message of [...messages].reverse()) {
    const payload = Array.isArray(message) ? message[1] : undefined
    if (typeof payload?.exception_message === 'string') {
      const node = payload.node_type ?? payload.node_id ?? ''
      return `${node} ${payload.exception_message}`.trim()
    }
  }
  return 'ComfyUI 报告执行失败（/history 里没有明细）'
}

/**
 * 提交一次生成并等它跑完：读工作流 → uiToApi → POST /prompt → 轮询 /history。
 *
 * /run 那条路由只管提交（界面上点一下就要立刻有回执），Agent 工具要的是成品
 * 图，所以这里补上等待。ComfyUI 排队期间 /history/<id> 返回空对象，跑完才有
 * entry；失败时 status_str === 'error'。
 */
async function runWorkflowAndWait(config, key, overrides, options = {}) {
  const workflow = await forward(config, `/userdata/workflows%2F${encodeURIComponent(key)}`)
  if (workflow.json === undefined) throw new Error(`读工作流失败：${key}（上游 ${workflow.status}）`)
  const info = await forward(config, '/object_info')
  const prompt = uiToApi(workflow.json, info.json ?? {}, overrides)
  if (Object.keys(prompt).length === 0) throw new Error(`这个工作流转出来是空的：${key}`)

  const seeds = {}
  for (const [id, node] of Object.entries(prompt)) {
    const value = node?.inputs?.seed ?? node?.inputs?.noise_seed
    if (typeof value === 'number') seeds[id] = value
  }

  const submitted = await forward(config, '/prompt', {
    method: 'POST',
    body: { prompt, client_id: String(Date.now()) },
  })
  const promptId = submitted.json?.prompt_id
  if (submitted.status >= 400 || typeof promptId !== 'string') {
    const detail = submitted.json?.error ?? submitted.text ?? `上游 ${submitted.status}`
    throw new Error(`ComfyUI 拒绝了这个任务：${String(JSON.stringify(detail)).slice(0, 1200)}`)
  }

  const deadline = Date.now() + (options.timeoutMs ?? 600_000)
  for (;;) {
    if (options.signal?.aborted === true) return { status: 'cancelled', promptId, seeds, images: [] }
    const history = await forward(config, `/history/${encodeURIComponent(promptId)}`)
    const entry = history.json?.[promptId]
    if (entry !== undefined) {
      const images = []
      for (const output of Object.values(entry.outputs ?? {})) {
        for (const image of output?.images ?? []) {
          if (image?.filename === undefined || image?.type === 'temp') continue
          images.push({
            filename: String(image.filename),
            subfolder: String(image.subfolder ?? ''),
            type: String(image.type ?? 'output'),
          })
        }
      }
      const failed = entry?.status?.status_str === 'error'
      if (images.length > 0 || failed || entry?.status?.completed === true) {
        return {
          status: images.length > 0 ? 'completed' : failed ? 'failed' : 'completed',
          promptId,
          seeds,
          images,
          detail: failed ? executionErrorText(entry) : undefined,
        }
      }
    }
    if (Date.now() >= deadline) return { status: 'timeout', promptId, seeds, images: [] }
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
}

/**
 * 把出好的图从 ComfyUI 取回来（走 /view），交给 DSH 的附件库，
 * 换回「可以贴进对话」的引用。工具结果旁边那张图就是这么来的。
 */
async function saveGeneratedImages(attachments, config, images, promptId) {
  const payloads = []
  const names = []
  for (const [index, image] of images.entries()) {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })
    const response = await fetch(`${upstreamBase(config)}/view?${query.toString()}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) continue
    const ext = path.extname(image.filename).toLowerCase()
    const mediaType =
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
    payloads.push({
      data: Buffer.from(await response.arrayBuffer()),
      mediaType,
      name: `comfyui-${promptId.slice(0, 8)}-${index + 1}${ext === '' ? '.png' : ext}`,
    })
    names.push(image.filename)
  }
  if (payloads.length === 0) return []
  const saved = await attachments.saveImages(payloads)
  return saved.map((ref) => ({
    attachment_id: String(ref.attachmentId),
    media_type: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }))
}

/**
 * 工具结果的 schema 一律是标准 JSON Schema：必填项写在 object 层的 required 数组里。
 *
 * 注意别照 parameters 那套「字段内 required: true」的方言写 —— 那是给 parameters 用的，
 * output.schema 走标准 JSON Schema 校验，写错 register 会直接抛
 * "unsupported JSON schema: ... required is not supported on type ..."。
 */
const IMAGE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachment_id: { type: 'string' },
    media_type: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachment_id', 'media_type', 'bytes', 'width', 'height'],
}

const GENERATE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string' },
    prompt_id: { type: 'string' },
    workflow: { type: 'string' },
    message: { type: 'string' },
    images: { type: 'array', items: IMAGE_REF_SCHEMA },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'prompt_id', 'workflow', 'message', 'images', 'files'],
}

const WORKFLOW_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    count: { type: 'integer' },
    workflows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          model: { type: 'string' },
          sampler: { type: 'string' },
          steps: { type: 'integer' },
          size: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['name'],
      },
    },
    environment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        api: { type: 'string' },
        comfyRoot: { type: 'string' },
        workflowsDir: { type: 'string' },
        outputDir: { type: 'string' },
        inputDir: { type: 'string' },
        modelsDir: { type: 'string' },
        version: { type: 'string' },
        checkpoints: { type: 'array', items: { type: 'string' } },
        loras: { type: 'array', items: { type: 'string' } },
        vaes: { type: 'array', items: { type: 'string' } },
        samplers: { type: 'array', items: { type: 'string' } },
        schedulers: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  required: ['count', 'workflows'],
}

/** comfyui_save_workflow 的结果。 */
const SAVE_WORKFLOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string' },
    name: { type: 'string' },
    path: { type: 'string' },
    bytes: { type: 'integer' },
    message: { type: 'string' },
  },
  required: ['status', 'name', 'path', 'bytes', 'message'],
}

/** 把工具结果里的图片引用还原成 DSH 的 image 内容块（贴进对话用的就是它）。 */
function imageBlocksFromMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return []
  const images = meta.images
  if (!Array.isArray(images)) return []
  return images.flatMap((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    if (typeof value.attachment_id !== 'string' || typeof value.media_type !== 'string') return []
    return [
      {
        type: 'image',
        attachment: {
          attachmentId: value.attachment_id,
          mediaType: value.media_type,
          bytes: value.bytes,
          width: value.width,
          height: value.height,
          ...(typeof value.name === 'string' ? { name: value.name } : {}),
        },
      },
    ]
  })
}

/**
 * 两个 Agent 工具：列出工作流、按工作流出图。
 *
 * 依赖是软注入（ctx.inject），tools / attachments 任一不在时工作台照常，
 * 只是没有工具 —— 不让「助手侧的小功能」拖垮整个面板。
 */
/**
 * 工具定义直接用 DSH 的 ToolDefinition 形状，不经 @deepseek-ai/dsh-tools 的 defineTool。
 *
 * 那个包在 profile 的 node_modules 里解析不到（@deepseek-ai 下只有 cosmokit / schemastery），
 * 早先版本用动态 import 取 defineTool，解析失败被 catch 吞掉，两个工具从来没注册上。
 * tools.register() 要的就是 name / description / parameters / output / execute 这几个字段，
 * defineTool 只是类型包装，普通对象即可。
 */

// ── 环境信息：让模型不必自己摸机器 ─────────────────────────────────────────

/** 同步读配置：注册工具时是同步回调，拿不到 await。 */
function loadConfigSync() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** 整合包里的关键目录（根目录没配好时全是空串）。 */
function layoutOf(config) {
  const root = resolveRoot(config)
  if (root === '') {
    return { comfyRoot: '', uiDir: '', workflowsDir: '', outputDir: '', inputDir: '', modelsDir: '' }
  }
  const uiDir = path.join(root, 'ComfyUI')
  return {
    comfyRoot: root,
    uiDir,
    workflowsDir: path.join(uiDir, 'user', 'default', 'workflows'),
    outputDir: path.join(uiDir, 'output'),
    inputDir: path.join(uiDir, 'input'),
    modelsDir: path.join(uiDir, 'models'),
  }
}

/** 取某个节点某个下拉输入的可选值（/object_info 的约定形状）。 */
function comboOptions(objectInfo, nodeType, inputName) {
  const list = objectInfo?.[nodeType]?.input?.required?.[inputName]?.[0]
  return Array.isArray(list) ? list.map((item) => String(item)) : []
}

/** 注册时写进工具说明的一句环境描述（完整清单由工具返回，这里只给位置）。 */
function environmentHint() {
  const layout = layoutOf(loadConfigSync())
  if (layout.comfyRoot === '') return ''
  return `install root ${layout.comfyRoot}, saved workflows in ${layout.workflowsDir}, generated images in ${layout.outputDir}`
}

/**
 * 一次把「这台机器长什么样」交出去：目录 + 已装模型 + 采样器。
 *
 * 起因：另一个会话里模型为了写一个自制工作流，先花十几步猜安装路径、列模型
 * （还被沙箱挡），因为这些信息本来没有任何一个工具给过它。
 */
async function environmentBlock(config, objectInfo) {
  const layout = layoutOf(config)
  let version = ''
  try {
    const stats = await forward(config, '/system_stats')
    version = String(stats.json?.system?.comfyui_version ?? '')
  } catch {
    version = ''
  }
  return {
    api: upstreamBase(config),
    comfyRoot: layout.comfyRoot,
    workflowsDir: layout.workflowsDir,
    outputDir: layout.outputDir,
    inputDir: layout.inputDir,
    modelsDir: layout.modelsDir,
    ...(version === '' ? {} : { version }),
    checkpoints: comboOptions(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name'),
    loras: comboOptions(objectInfo, 'LoraLoader', 'lora_name'),
    vaes: comboOptions(objectInfo, 'VAELoader', 'vae_name'),
    samplers: comboOptions(objectInfo, 'KSampler', 'sampler_name'),
    schedulers: comboOptions(objectInfo, 'KSampler', 'scheduler'),
  }
}

/** /history 里的图片条目 → 磁盘绝对路径（省掉模型自己去 output 目录捞文件）。 */
function imageDiskPaths(config, images) {
  const layout = layoutOf(config)
  if (layout.comfyRoot === '') return []
  const byType = {
    output: layout.outputDir,
    input: layout.inputDir,
    temp: path.join(layout.comfyRoot, 'ComfyUI', 'temp'),
  }
  const out = []
  for (const image of images ?? []) {
    const base = byType[String(image?.type ?? 'output')] ?? layout.outputDir
    const sub = String(image?.subfolder ?? '')
      .split(/[\\/]/)
      .filter((part) => part !== '')
    const name = String(image?.filename ?? '')
    if (name === '') continue
    out.push(path.join(base, ...sub, name))
  }
  return out
}

/** 列出用户存的工作流，并带上每个工作流当前的关键参数，供模型挑一个来改。 */
function makeWorkflowListTool(envText) {
  return {
    name: 'comfyui_workflows',
    description:
      "List the ComfyUI workflows saved on this machine, with the model, prompt, sampler, steps and size each one currently uses. Call this before comfyui_generate to pick a workflow and see which parameters are worth changing. The result also carries an environment block: the local ComfyUI root, the on-disk workflows/output directories, the API base, and the full lists of installed checkpoints, LoRAs, VAEs, samplers and schedulers — read that block instead of probing the machine. Never guess install paths, never hunt for the model folders by hand, and never write into the ComfyUI folder directly (comfyui_save_workflow does that for you)." +
      (envText === '' ? '' : ` This machine right now: ${envText}.`),
    parameters: {},
    output: { schema: WORKFLOW_LIST_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() {
      const config = await loadConfig()
      const listed = await forward(config, '/userdata?dir=workflows&recurse=true&split=false')
      const names = Array.isArray(listed.json) ? listed.json.map((item) => String(item)) : []
      const info = await forward(config, '/object_info')
      const workflows = []
      for (const name of names) {
        const key = workflowKey(name)
        if (key === '') continue
        let summary = null
        try {
          const workflow = await forward(config, `/userdata/workflows%2F${encodeURIComponent(key)}`)
          summary = workflow.json === undefined ? null : analyzeWorkflow(workflow.json, info.json ?? {})
        } catch {
          summary = null
        }
        workflows.push({
          name: key,
          ...(summary?.model?.name == null ? {} : { model: String(summary.model.name) }),
          ...(summary?.sampler?.sampler == null
            ? {}
            : { sampler: `${summary.sampler.sampler} / ${summary.sampler.scheduler ?? '?'}` }),
          ...(summary?.sampler?.steps == null ? {} : { steps: summary.sampler.steps }),
          ...(summary?.size?.width == null ? {} : { size: `${summary.size.width}x${summary.size.height}` }),
          ...(summary?.positive === null || summary?.positive === undefined
            ? {}
            : { prompt: summary.positive.text.slice(0, 200) }),
        })
      }
      let environment = null
      try {
        environment = await environmentBlock(config, info.json ?? {})
      } catch {
        environment = null
      }
      return { count: workflows.length, workflows, ...(environment === null ? {} : { environment }) }
    },
  }
}

/** 按某个工作流出图：模型给参数，插件负责转换、排队、等图、把图挂回对话。 */
function makeGenerateTool(tctx) {
  return {
    name: 'comfyui_generate',
    description:
      "Generate images with the user's local ComfyUI — the same engine as the ComfyUI panel in this app — by running one of their saved workflows. Returns the finished images as attachments shown beside this tool call. Call comfyui_workflows first to see the available workflow file names and their current parameters. Only pass the parameters you want to change; everything else keeps the value saved in the workflow. Generation runs locally on the user's GPU and usually takes 10-120 seconds.",
    parameters: {
      workflow: {
        type: 'string',
        required: true,
        description: 'Workflow file name as listed by comfyui_workflows, for example "好看的.json".',
      },
      prompt: { type: 'string', description: 'Positive prompt. Replaces the workflow\'s positive prompt when given.' },
      positive: { type: 'string', description: 'Alias of prompt — either name works. Use one of them, not both.' },
      negative: {
        type: 'string',
        description: 'Negative prompt. Replaces the workflow\'s negative prompt when given.',
      },
      width: { type: 'integer', description: 'Image width in pixels.' },
      height: { type: 'integer', description: 'Image height in pixels.' },
      steps: { type: 'integer', description: 'Sampling steps.' },
      cfg: { type: 'number', description: 'CFG scale.' },
      batch: { type: 'integer', description: 'How many images in one batch.' },
      seed: { type: 'integer', description: 'Fixed seed. Omit to keep random generation.' },
      sampler: { type: 'string', description: 'Sampler name, for example euler or dpmpp_2m.' },
      scheduler: { type: 'string', description: 'Scheduler name, for example normal or karras.' },
      timeout_seconds: { type: 'integer', description: 'How long to wait for the result. Defaults to 600.' },
    },
    output: {
      schema: GENERATE_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ images: value.images }),
    },
    presentResult: (_args, result) => {
      const content = result.isError ? [] : imageBlocksFromMeta(result.meta)
      return content.length === 0 ? undefined : { card: 'generic', content }
    },
    async execute(args, exec) {
      const requested = String(args.workflow ?? '')
      const key = workflowKey(requested)
      if (key === '') {
        return {
          status: 'failed',
          prompt_id: '',
          workflow: requested,
          message: '工作流名不合法：给的是相对于 ComfyUI/workflows 的文件名，例如 "好看的.json"。',
          images: [],
          files: [],
        }
      }
      try {
        const config = await loadConfig()
        const info = await forward(config, '/object_info')
        const workflow = await forward(config, `/userdata/workflows%2F${encodeURIComponent(key)}`)
        if (workflow.json === undefined) {
          return {
            status: 'failed',
            prompt_id: '',
            workflow: key,
            message: `读不到工作流 ${key}（上游 ${workflow.status}）。先用 comfyui_workflows 看可选的文件名。`,
            images: [],
            files: [],
          }
        }
        const summary = analyzeWorkflow(workflow.json, info.json ?? {})
        // 参数别名：另一个会话里的模型传的是 positive，而这里的参数名是 prompt，
        // 未知参数被静默丢掉 —— 提示词没生效也没人知道。两个名字都认。
        const wanted = args.positive === undefined ? args : { ...args, prompt: args.prompt ?? args.positive }
        const overrides = buildOverrides(summary, wanted)
        const outcome = await runWorkflowAndWait(config, key, overrides, {
          timeoutMs: (Number.isFinite(args.timeout_seconds) ? Math.max(30, args.timeout_seconds) : 600) * 1000,
          signal: exec?.signal,
        })
        const images =
          outcome.status === 'completed' && outcome.images.length > 0
            ? await saveGeneratedImages(tctx.attachments, config, outcome.images, outcome.promptId)
            : []
        const files =
          outcome.status === 'completed' && outcome.images.length > 0 ? imageDiskPaths(config, outcome.images) : []
        const seedText = Object.values(outcome.seeds ?? {}).join(', ')
        const message =
          outcome.status === 'completed'
            ? `出图完成：工作流 ${key}，共 ${images.length} 张${seedText === '' ? '' : `，seed ${seedText}`}。图片就在这次工具调用旁边，可以直接给用户看；磁盘路径见 files 字段。`
            : outcome.status === 'timeout'
              ? `等超时了：工作流 ${key} 还在跑或排队（prompt_id ${outcome.promptId}）。可以稍后再试一次。`
              : outcome.status === 'cancelled'
                ? '任务已取消。'
                : `出图失败：${outcome.detail ?? 'ComfyUI 没有给出明细'}`
        const applied = Object.keys(overrides).join(', ')
        const finalMessage = applied === '' ? message : `${message}（本次改写了：${applied}）`
        return { status: outcome.status, prompt_id: outcome.promptId, workflow: key, message: finalMessage, images, files }
      } catch (error) {
        return {
          status: 'failed',
          prompt_id: '',
          workflow: key,
          message: `出图失败：${messageOf(error)}`,
          images: [],
          files: [],
        }
      }
    },
  }
}
/**
 * 把一份工作流写进 ComfyUI 的工作流目录。
 *
 * 走 ComfyUI 自己的 /userdata 写（和面板里保存工作流同一条路），所以不受 agent
 * 沙箱限制 —— 另一个会话里模型往 D 盘写工作流是被沙箱挡住的（写入 0 字节）。
 */
function makeSaveWorkflowTool() {
  return {
    name: 'comfyui_save_workflow',
    description:
      'Save a workflow file into the local ComfyUI installation, so it shows up in ComfyUI and in comfyui_workflows. Use this instead of writing into the ComfyUI folder yourself: the plugin runs inside the app and writes the file through ComfyUI itself, so it works even where the agent sandbox cannot touch that drive. Pass the JSON object itself, not a string. Both the UI graph format (nodes + links) and the API prompt format (class_type) are accepted. Afterwards the file can be run with comfyui_generate.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'File name relative to the workflows folder, for example "狸花猫.json". Subfolders are allowed.',
      },
      workflow: {
        type: 'object',
        required: true,
        description: 'The workflow JSON object: either UI graph (nodes + links) or API prompt format (class_type).',
      },
      overwrite: {
        type: 'boolean',
        description:
          'Set true to replace an existing file. Defaults to false, and then an existing file is left untouched.',
      },
    },
    output: { schema: SAVE_WORKFLOW_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const requested = String(args.name ?? '')
      const key = workflowKey(requested)
      const failed = (message) => ({ status: 'failed', name: key === '' ? requested : key, path: '', bytes: 0, message })
      if (key === '') {
        return failed('文件名不合法：给的是相对于 ComfyUI/workflows 的名字，例如 "狸花猫.json"。')
      }
      const payload = args.workflow
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return failed('workflow 要传 JSON 对象本身（界面格式的 nodes+links，或 API 格式的 class_type），不是字符串。')
      }
      const isUiGraph = Array.isArray(payload.nodes) && Array.isArray(payload.links)
      const isApiPrompt = Object.values(payload).some(
        (node) => node !== null && typeof node === 'object' && typeof node.class_type === 'string',
      )
      if (!isUiGraph && !isApiPrompt) {
        return failed('这份 JSON 既不像界面格式（缺 nodes/links），也不像 API 格式（没有任何 class_type）：确认传的是工作流本体。')
      }
      try {
        const config = await loadConfig()
        const existing = await forward(config, `/userdata/workflows%2F${encodeURIComponent(key)}`)
        if (args.overwrite !== true && existing.status < 400 && existing.json !== undefined) {
          return {
            status: 'exists',
            name: key,
            path: '',
            bytes: 0,
            message: `工作流 ${key} 已存在，没有覆盖。要替换就带 overwrite: true 再调一次。`,
          }
        }
        const body = JSON.stringify(payload)
        const written = await forward(config, `/userdata/workflows%2F${encodeURIComponent(key)}`, {
          method: 'POST',
          body,
        })
        if (written.status >= 400) {
          return failed(`写入失败（上游 ${written.status}）：${written.text.slice(0, 300)}`)
        }
        const layout = layoutOf(config)
        const disk = layout.workflowsDir === '' ? '' : path.join(layout.workflowsDir, ...key.split('/'))
        const bytes = Buffer.byteLength(body, 'utf8')
        return {
          status: 'saved',
          name: key,
          path: disk,
          bytes,
          message: `已保存工作流 ${key}（${bytes} 字节）。可以直接用 comfyui_generate 跑它。`,
        }
      } catch (error) {
        return failed(`写入失败：${messageOf(error)}`)
      }
    },
  }
}

/**
 * 清掉 webserver 上本插件前缀的残留路由。
 *
 * webserver 的 exact 表按 path 唯一：热加载重新 apply 时若不清旧条目，
 * 注册会一路 duplicate 报错，改过的 handler 也不会生效。
 */
function clearStaleRoutes(webServer) {
  const table = webServer?.exact
  if (table === null || table === undefined) return 0
  let removed = 0
  if (typeof table.keys === 'function' && typeof table.delete === 'function') {
    for (const key of [...table.keys()]) {
      if (String(key).startsWith(BASE)) { table.delete(key); removed += 1 }
    }
    return removed
  }
  if (typeof table === 'object') {
    for (const key of Object.keys(table)) {
      if (key.startsWith(BASE)) { delete table[key]; removed += 1 }
    }
  }
  return removed
}

// ── 启动 / 状态 ───────────────────────────────────────────────────────────────

/** 启动中标记（探测到可达即清）。 */
let launching = false
let launchStartedAt = 0
let lastLaunchError = ''

/** 浏览器半边最近一次自检上报（确认 client half 有没有在页面里跑起来）。 */
let clientReport = null

/**
 * 兼容 Map / Set / 数组 / 普通对象的键枚举 —— webserver 的 exact/prefixes
 * 是 Map，Object.keys 只会拿到空数组。
 * @param table - webServer.exact 或 webServer.prefixes。
 */
function dumpKeys(table) {
  try {
    if (table === undefined || table === null) return null
    if (typeof table.keys === 'function') return Array.from(table.keys()).slice(0, 200).map(String)
    if (Array.isArray(table)) return table.slice(0, 200).map(String)
    if (typeof table === 'object') return Object.keys(table).slice(0, 200)
    return null
  } catch (error) {
    return { error: String(error) }
  }
}

/**
 * 摘要式 dump 注入器数组：只取能安全序列化的信息（函数名、源码片段、对象键）。
 * 目的是看清 DSH 往首页注入了什么、客户端脚本走哪个 URL，而不是把整个对象搬进 JSON。
 * @param taps - webServer.indexTaps。
 */
function dumpTaps(taps) {
  try {
    if (taps === undefined || taps === null) return null
    const arr = Array.isArray(taps) ? taps : Object.values(taps)
    return arr.slice(0, 30).map((t) => {
      if (typeof t === 'function') {
        return { kind: 'function', name: t.name || '(匿名)', src: String(t).slice(0, 300) }
      }
      if (t !== null && typeof t === 'object') {
        const keys = Object.keys(t).slice(0, 15)
        const out = { kind: 'object', keys }
        for (const k of keys) {
          const v = t[k]
          if (typeof v === 'function') out[k] = `[fn ${v.name || '匿名'}] ${String(v).slice(0, 200)}`
          else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
        }
        return out
      }
      return { kind: typeof t, value: String(t).slice(0, 200) }
    })
  } catch (error) {
    return { error: String(error) }
  }
}

/** 拉起 ComfyUI（或绘世启动器）。返回 { started, mode, root }。 */
function launchComfy(config) {
  const root = resolveRoot(config)
  if (root === '') throw new Error('没找到 ComfyUI 根目录，请在面板的「设置」里填写整合包路径')
  if (launching) return { started: false, mode: config.launchMode, root, reason: '正在启动中' }

  const mode = config.launchMode === 'launcher' ? 'launcher' : 'python'
  if (mode === 'launcher') {
    const exe = path.join(root, '绘世启动器.exe')
    if (!existsSync(exe)) throw new Error(`找不到绘世启动器：${exe}`)
    const child = spawn(exe, [], { cwd: root, detached: true, stdio: 'ignore' })
    child.unref()
  } else {
    const python = path.join(root, 'python', 'python.exe')
    if (!existsSync(python)) throw new Error(`找不到整合包内嵌 python：${python}`)
    const cwd = path.join(root, 'ComfyUI')
    const args = [
      '-s', 'main.py',
      '--windows-standalone-build',
      '--listen', config.host,
      '--port', String(config.port),
      ...String(config.extraArgs ?? '').split(/\s+/).filter((part) => part !== ''),
    ]
    const child = spawn(python, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  }

  launching = true
  launchStartedAt = Date.now()
  lastLaunchError = ''
  return { started: true, mode, root }
}

/** 探活 + 设备/队列信息。 */
async function probe(config) {
  const root = resolveRoot(config)
  const base = { url: upstreamBase(config), root, config }
  try {
    const stats = await fetch(`${upstreamBase(config)}/system_stats`, { signal: AbortSignal.timeout(2500) })
    if (!stats.ok) {
      return { reachable: false, ...base, launching, launchStartedAt, error: `HTTP ${stats.status}` }
    }
    const payload = await stats.json()
    launching = false
    let running = 0
    let pending = 0
    try {
      const queue = await fetch(`${upstreamBase(config)}/queue`, { signal: AbortSignal.timeout(2500) })
      if (queue.ok) {
        const snapshot = await queue.json()
        running = snapshot.queue_running?.length ?? 0
        pending = snapshot.queue_pending?.length ?? 0
      }
    } catch {
      /* 队列读不到不算离线 */
    }
    return {
      reachable: true,
      ...base,
      version: payload.system?.comfyui_version ?? '',
      python: payload.system?.python_version ?? '',
      device: payload.devices?.[0]?.name ?? '',
      vram: payload.system?.total_vram ?? 0,
      queueRunning: running,
      queuePending: pending,
      launching: false,
      launchStartedAt,
    }
  } catch (error) {
    if (launching && Date.now() - launchStartedAt > 6 * 60 * 1000) {
      launching = false
      lastLaunchError = '启动超过 6 分钟仍未就绪'
    }
    return { reachable: false, ...base, launching, launchStartedAt, error: messageOf(error) }
  }
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

/**
 * 注册整个路由族。
 * @param ctx - 宿主 context（已 inject webServer）。
 * @returns 卸载器。
 */
export function apply(ctx) {
  const disposers = []

  // 加载自检：把「有没有被加载、webServer 长什么样、路由注册成没成」写进一个文件。
  // 排查期这个文件比翻日志快得多。
  const diag = { at: new Date().toISOString(), pid: process.pid, base: BASE }
  const writeDiag = () => {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      diag.clientReport = clientReport
      writeFileSync(path.join(DATA_DIR, 'loaded.json'), `${JSON.stringify(diag, null, 2)}\n`, 'utf8')
    } catch {
      /* 标记写不进去不影响功能 */
    }
  }
  try {
    const ws = ctx.webServer
    diag.wsKeys = Object.keys(ws ?? {})
    diag.registerType = typeof ws?.register
    // 侦查客户端加载机制：DSH 往首页注入脚本靠 indexTaps，
    // 而已注册的路由表能直接暴露客户端 bundle 的真实 URL 形态。
    diag.exactPaths = dumpKeys(ws?.exact)
    diag.prefixPaths = dumpKeys(ws?.prefixes)
    diag.indexTaps = dumpTaps(ws?.indexTaps)
  } catch (error) {
    diag.wsError = messageOf(error)
  }
  diag.staleCleared = clearStaleRoutes(ctx.webServer)
  writeDiag()

  /**
   * 注册一条精确路径路由，方法在 handler 内分发。
   * webserver 的 exact 表按 path 唯一，所以「一个 path 一条路由」。
   * @param routePath - 前缀之后的路径（如 '/status'）。
   * @param handlers - { GET?, POST?, ... }。
   */
  const route = (routePath, handlers) => {
    const fullPath = `${BASE}${routePath}`
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: fullPath,
        handler: (req, res) => {
          void (async () => {
            try {
              const method = (req.method ?? 'GET').toUpperCase()
              const handler = handlers[method] ?? handlers.ANY
              if (handler === undefined) {
                res.statusCode = 405
                res.setHeader('Allow', Object.keys(handlers).join(', '))
                res.end()
                return
              }
              await handler(req, res)
            } catch (error) {
              sendJson(res, 500, { ok: false, error: messageOf(error) })
            }
          })()
        },
      }))
    } catch (error) {
      diag.routeErrors = diag.routeErrors ?? []
      diag.routeErrors.push(`${routePath}: ${messageOf(error)}`)
    }
  }

  // 配置：读 / 写
  route('/config', {
    GET: async (_req, res) => {
      const config = await loadConfig()
      sendJson(res, 200, { ok: true, config, detectedRoot: detectRoot() })
    },
    POST: async (req, res) => {
      const patch = JSON.parse((await readBody(req)) || '{}')
      const config = await saveConfig(patch)
      sendJson(res, 200, { ok: true, config, detectedRoot: detectRoot() })
    },
  })

  // 状态
  route('/status', {
    GET: async (_req, res) => {
      sendJson(res, 200, { ok: true, ...(await probe(await loadConfig())) })
    },
  })

  // 浏览器半边由 DSH 的 client-modules 自行加载（package.json 的 dsh.client
  // 声明 + exports["./client"]），宿主这边不需要自己 serve 或注入首页。
  // 早前那套 tapIndex 注入是误判（我以为它没被加载），反而会重复执行脚本，已移除。

  // 浏览器半边的自检上报：client half 只要在页面里跑起来就回一条，
  // 用来确认「客户端插件到底有没有被加载」「侧边栏锚点找到没有」。
  route('/alive', {
    GET: async (_req, res) => {
      sendJson(res, 200, { ok: true, report: clientReport })
    },
    POST: async (req, res) => {
      let parsed
      try {
        parsed = JSON.parse((await readBody(req, 256 * 1024)) || '{}')
      } catch {
        parsed = { unparsable: true }
      }
      clientReport = { at: new Date().toISOString(), ...parsed }
      writeDiag()
      sendJson(res, 200, { ok: true })
    },
  })

  // 一键启动
  route('/launch', {
    POST: async (_req, res) => {
      const config = await loadConfig()
      try {
        const result = launchComfy(config)
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        lastLaunchError = messageOf(error)
        sendJson(res, 200, { ok: false, error: lastLaunchError, launching })
      }
    },
  })

  // 工作流清单（ComfyUI 的 userdata 目录列举）
  route('/workflows', {
    GET: async (_req, res) => {
      const config = await loadConfig()
      const result = await forward(config, '/userdata?dir=workflows&recurse=true&split=false')
      relay(res, result)
    },
  })

  // 工作流原文：?name=好看的.json（GET 读 / POST 覆盖写）
  route('/workflow', {
    GET: async (req, res) => {
      const config = await loadConfig()
      const key = workflowKey(new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? '')
      if (key === '') {
        sendJson(res, 400, { ok: false, error: '缺少合法的 name 参数' })
        return
      }
      const result = await forward(config, `/userdata/workflows%2F${encodeURIComponent(key)}`)
      relay(res, result)
    },
    POST: async (req, res) => {
      const config = await loadConfig()
      const key = workflowKey(new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? '')
      if (key === '') {
        sendJson(res, 400, { ok: false, error: '缺少合法的 name 参数' })
        return
      }
      const body = await readBody(req)
      const result = await forward(config, `/userdata/workflows%2F${encodeURIComponent(key)}`, {
        method: 'POST',
        body: body === '' ? '{}' : body,
      })
      relay(res, result)
    },
  })

  // 通用转发口：{ path, method?, body? } → ComfyUI 同名路径。
  // 只放行 ComfyUI 自有的 API 前缀，且挡住路径穿越。
  route('/comfy', {
    POST: async (req, res) => {
      const config = await loadConfig()
      const request = JSON.parse((await readBody(req)) || '{}')
      const target = String(request.path ?? '')
      const allowed = /^\/(prompt|queue|history|view|object_info|embeddings|extensions|models|userdata|system_stats|interrupt|free)(\/|\?|$)/
      if (!allowed.test(target) || target.includes('..')) {
        sendJson(res, 400, { ok: false, error: `不允许转发的路径：${target}` })
        return
      }
      const result = await forward(config, target, {
        method: String(request.method ?? 'GET').toUpperCase(),
        body: request.body,
      })
      relay(res, result)
    },
  })

  // 二进制代理：把 ComfyUI 的图片/资源按原样交给浏览器（同源，省掉跨端口取图）。
  route('/view', {
    GET: async (req, res) => {
      const config = await loadConfig()
      const query = new URL(req.url ?? '/', 'http://x').search
      const upstream = await fetch(`${upstreamBase(config)}/view${query}`, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      if (!upstream.ok) {
        sendJson(res, upstream.status, { ok: false, error: `上游 ${upstream.status}` })
        return
      }
      for (const name of PASS_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name)
        if (value !== null) res.setHeader(name, value)
      }
      res.statusCode = 200
      res.end(Buffer.from(await upstream.arrayBuffer()))
    },
  })

  // ── ComfyUI 原生界面：同源反代内嵌 ──────────────────────────────────────────
  // 直连 http://127.0.0.1:8188 放进 dsh-app://（secure 上下文）的 iframe 里会被
  // 当成混合内容整块拦掉：白板、不触发任何 CSP 事件、load 事件照常触发，所以从
  // 外面完全看不出原因。改成同源反代 —— iframe 的源就是 DSH 自己：
  //   · HTML 里注入同源的 <base>，相对资源回本路由；
  //   · ComfyUI 前端 1.55 用 `location.pathname.split('/').slice(0,-1)` 推 api_base，
  //     所以 /api/*、/view、/extensions/* 都会自动带上这个前缀回到这里；
  //   · 这里把前缀之后的路径原样转给上游。
  // 唯一代价：ComfyUI 的 WebSocket（进度推送）过不了 http 反代，画布照常可用。
  const proxyPrefix = `${BASE}/comfy-ui`
  const proxyBaseHref = `${proxyPrefix}/`

  /** 把前缀之后的原文（含 query）转发给上游，HTML 文档注入同源 base。 */
  async function proxyComfy(req, res, prefix) {
    const config = await loadConfig()
    const raw = req.url ?? '/'
    const cut = raw.indexOf('?')
    const pathPart = cut === -1 ? raw : raw.slice(0, cut)
    // webserver 的 prefix handler 可能拿到完整 URL，也可能只拿到前缀之后的片段，
    // 两种都兼容。
    const rest0 = pathPart.startsWith(prefix) ? pathPart.slice(prefix.length) : pathPart
    let rest = rest0 === '' ? '/' : rest0
    const query = cut === -1 ? '' : raw.slice(cut)
    const method = (req.method ?? 'GET').toUpperCase()

    // 文档根：取上游 HTML，注入同源 base（不注入的话 `./assets/*` 会解析到 DSH 根）。
    if (rest === '/' && (method === 'GET' || method === 'HEAD')) {
      const response = await fetch(`${upstreamBase(config)}/`, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
      let html = await response.text()
      const tag = `<base href="${proxyBaseHref}">`
      html = html.includes('<head>') ? html.replace('<head>', `<head>${tag}`) : tag + html
      res.statusCode = response.ok ? 200 : response.status
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(method === 'HEAD' ? undefined : html)
      return
    }

    const headers = {}
    const range = req.headers?.range
    if (typeof range === 'string' && range !== '') headers.range = range
    let body
    if (method !== 'GET' && method !== 'HEAD') {
      body = await readRawBody(req)
      const type = req.headers?.['content-type']
      if (typeof type === 'string') headers['content-type'] = type
    }
    const response = await fetch(`${upstreamBase(config)}${rest}${query}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    res.statusCode = response.status
    for (const name of PASS_RESPONSE_HEADERS) {
      const value = response.headers.get(name)
      if (value !== null && name !== 'content-length') res.setHeader(name, value)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    res.setHeader('content-length', String(buffer.length))
    res.end(buffer)
  }

  try {
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: proxyPrefix,
      handler: (req, res) => {
        void (async () => {
          try {
            await proxyComfy(req, res, proxyPrefix)
          } catch (error) {
            res.statusCode = 502
            res.setHeader('content-type', 'text/html; charset=utf-8')
            res.end(
              '<body style="font:13px/1.8 system-ui;padding:28px;color:#888">' +
                `ComfyUI 没在运行或反代失败：${messageOf(error)}<br>点面板右上角的「启动 ComfyUI」，` +
                '或在绘世启动器里启动后点「在浏览器打开」。</body>',
            )
          }
        })()
      },
    }))
  } catch (error) {
    diag.routeErrors = diag.routeErrors ?? []
    diag.routeErrors.push(`/comfy-ui: ${messageOf(error)}`)
  }

  // ── 提交生成：界面格式 → API 格式 → POST /prompt ────────────────────────────
  route('/run', {
    POST: async (req, res) => {
      try {
        const config = await loadConfig()
        const body = JSON.parse((await readBody(req)) || '{}')
        const key = workflowKey(body.name)
        if (key === '') {
          sendJson(res, 400, { ok: false, error: '缺少工作流名' })
          return
        }

        const workflow = await forward(config, `/userdata/workflows%2F${encodeURIComponent(key)}`)
        if (workflow.json === undefined) {
          sendJson(res, 502, { ok: false, error: `读工作流失败（上游 ${workflow.status}）` })
          return
        }

        const info = await forward(config, '/object_info')
        const prompt = uiToApi(workflow.json, info.json ?? {}, body.overrides ?? {})
        if (Object.keys(prompt).length === 0) {
          sendJson(res, 400, { ok: false, error: '这个工作流转出来是空的（可能全是注释/静音节点）' })
          return
        }

        // 把这一次真正用上的种子带回界面：不然「随机」到底有没有生效，用户
        // 只能靠出图去猜。多个采样器就都列出来，id → 值。
        const seeds = {}
        for (const [id, node] of Object.entries(prompt)) {
          const value = node?.inputs?.seed ?? node?.inputs?.noise_seed
          if (typeof value === 'number') seeds[id] = value
        }

        const submitted = await forward(config, '/prompt', {
          method: 'POST',
          body: { prompt, client_id: String(Date.now()) },
        })
        sendJson(res, submitted.status >= 400 ? submitted.status : 200, {
          ok: submitted.status < 400,
          nodeCount: Object.keys(prompt).length,
          seeds,
          result: submitted.json ?? submitted.text,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: messageOf(error) })
      }
    },
  })

// ── 工作流体检：模型 / 正负提示词 / 采样 / 尺寸 ─────────────────────────────
  // 参数条与 Agent 工具都要这份映射，所以宿主算一次、两边共用，免得两套识别逻辑走偏。
  route('/inspect', {
    GET: async (req, res) => {
      const config = await loadConfig()
      const key = workflowKey(new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? '')
      if (key === '') {
        sendJson(res, 400, { ok: false, error: '缺少合法的 name 参数' })
        return
      }
      const workflow = await forward(config, `/userdata/workflows%2F${encodeURIComponent(key)}`)
      if (workflow.json === undefined) {
        sendJson(res, 502, { ok: false, error: `读工作流失败（上游 ${workflow.status}）` })
        return
      }
      const info = await forward(config, '/object_info')
      sendJson(res, 200, { ok: true, name: key, summary: analyzeWorkflow(workflow.json, info.json ?? {}) })
    },
  })

  // ── Agent 工具：让对话里的模型自己出图 ──────────────────────────────────────
  // 软注入：tools / attachments 有一个不在，工作台照常工作，只是没有工具。
  ctx.inject(['tools', 'attachments'], (tctx) => {
    tctx.effect(() => {
      const toolDisposers = []
      const toolNames = ['comfyui_workflows', 'comfyui_generate', 'comfyui_save_workflow']
      try {
        toolDisposers.push(tctx.tools.register(makeWorkflowListTool(environmentHint())))
        toolDisposers.push(tctx.tools.register(makeGenerateTool(tctx)))
        toolDisposers.push(tctx.tools.register(makeSaveWorkflowTool()))
        diag.agentTools = toolNames.length
        diag.agentToolsNames = toolNames
        // 权威判据：注册完能不能从服务里查回来。
        diag.agentToolsVisible = tctx.tools.get('comfyui_generate') !== undefined
        delete diag.agentToolsError
      } catch (error) {
        diag.agentToolsError = messageOf(error)
      }
      writeDiag()
      return () => {
        for (const dispose of toolDisposers) {
          if (typeof dispose === 'function') dispose()
        }
      }
    }, 'dsh-comfyui-studio: agent tools')
  })

  // ── fandc520/dsh-comfyui 并入的功能 ────────────────────────────────────────
  // 工作流库（标签 / zip 整库迁移 / 从画布提取）、资产页、队列页、加载区，
  // 任意节点参数覆盖（键名写错直接拒绝）、异步长任务（后台跑 + 唤醒会话收结果）、
  // 技能包（SKILL.md 按需披露 + 踩坑回写）。数据落在 <studio>/fandc 下。
  // 软注入：宿主没有 tools 时整块跳过，studio 原有功能不受影响。
  ctx.inject(['tools'], (fctx) => {
    fctx.effect(() => {
      let disposed = false
      let disposeFandc
      const cfg = loadConfigSync()
      const root = (cfg.comfyRoot || '').trim() || detectRoot()
      const entryConfig = {
        baseUrl: `http://${cfg.host || '127.0.0.1'}:${cfg.port || 8188}`,
        comfyuiDirs: root ? [root] : [],
        dataDir: path.join(DATA_DIR, 'fandc'),
      }
      Promise.resolve()
        .then(() => mountFandc(fctx, entryConfig))
        .then((dispose) => {
          if (disposed) {
            if (typeof dispose === 'function') dispose()
            return
          }
          disposeFandc = dispose
          diag.fandcMounted = true
          diag.fandcDataDir = entryConfig.dataDir
          writeDiag()
        })
        .catch((error) => {
          diag.fandcError = messageOf(error)
          writeDiag()
          console.warn('[comfyui-studio] fandc 功能挂载失败：', messageOf(error))
        })
      return () => {
        disposed = true
        if (typeof disposeFandc === 'function') disposeFandc()
      }
    }, 'dsh-comfyui-studio: fandc features')
  })

  diag.registered = disposers.length
  diag.detectedRoot = detectRoot()
  diag.routes = Object.keys(diag.routeErrors ?? {}).length === 0 ? 'ok' : diag.routeErrors

  console.log(`[comfyui-studio] 路由族已挂载：${BASE}（${disposers.length} 条，根目录 ${diag.detectedRoot || '未找到'}，清理旧路由 ${diag.staleCleared}）`)
  writeDiag()

  return () => {
    for (const dispose of disposers) dispose()
  }
}

export default { inject, apply }