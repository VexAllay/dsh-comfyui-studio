/**
 * fandc520/dsh-comfyui 的宿主配置解析（并入 dsh-comfyui-studio 后简化版）。
 *
 * 原版用一个 schemastery schema 同时驱动 Loader 条目配置与设置页；
 * 并入 studio 后不再需要 schema —— 设置页由 studio 自己的 config 页负责，
 * 这里只保留「Loader 条目配置 → 插件实际读取的普通对象」这一步。
 *
 * 字段是 volatile 引用（dsh 0.1.7+）时用 .get() 取当前值，否则直接读。
 */

/** The volatile-reference protocol shared across cosmokit copies (Symbol.for). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 读一个可能是 volatile 引用（dsh 0.1.7+）、也可能是普通值的配置项。 */
function current(value) {
  if (typeof value === 'object' && value !== null && VOLATILE_WRITE in value) {
    return value.get();
  }
  return value;
}

/**
 * 把 Loader 的解析后条目配置规范成插件读取的普通对象。
 * `loader/volatile-update` 之后可再调一次：引用是同一批对象，此时持有新值。
 * @param raw 解析后的条目配置；字段可能是 volatile 引用
 * @param defaultDataDir dataDir 为空时使用的数据目录
 * @returns 完整填充的普通配置
 */
export function resolveConfig(raw, defaultDataDir) {
  const str = (value, fallback) => (typeof value === 'string' ? value : fallback);
  const num = (value, fallback) => (typeof value === 'number' ? value : fallback);
  const dataDir = str(current(raw.dataDir), '');
  const dirs = current(raw.comfyuiDirs);
  return {
    baseUrl: str(current(raw.baseUrl), 'http://127.0.0.1:8188'),
    apiKeyEnv: str(current(raw.apiKeyEnv), 'COMFYUI_API_KEY'),
    connectTimeoutMs: num(current(raw.connectTimeoutMs), 10_000),
    timeoutMs: num(current(raw.timeoutMs), 900_000),
    pollIntervalMs: num(current(raw.pollIntervalMs), 1_000),
    maxMediaItems: num(current(raw.maxMediaItems), 12),
    maxMediaBytes: num(current(raw.maxMediaBytes), 64 * 1024 * 1024),
    dataDir: dataDir !== '' ? dataDir : defaultDataDir,
    maxAssets: num(current(raw.maxAssets), 200),
    skillsDir: str(current(raw.skillsDir), ''),
    mediaHost: str(current(raw.mediaHost), ''),
    outputDir: str(current(raw.outputDir), ''),
    comfyuiDirs: Array.isArray(dirs)
      ? dirs.filter((dir) => typeof dir === 'string' && dir.trim() !== '')
      : [],
  };
}