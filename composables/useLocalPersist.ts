export function readLocal<T>(key: string, fallback: T): T {
  if (!import.meta.client) return fallback;
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) as T : fallback;
}

/** 写盘成功返回 true；失败（如配额超限）返回 false，由调用方回滚并允许按申请编号重试。 */
export function writeLocal<T>(key: string, value: T): boolean {
  if (!import.meta.client) return true;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
