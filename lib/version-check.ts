// 批F：轻量新版本检查。开源发布后读取 GitHub Releases 最新 tag，
// 与本地 APP_VERSION 比较。只提示、不自动下载、不自动执行；任何失败都静默。
export const RELEASES_API_URL = 'https://api.github.com/repos/OWNER/enkei-fx/releases/latest';
export const RELEASES_PAGE_URL = 'https://github.com/OWNER/enkei-fx/releases/latest';

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = await response.json() as { tag_name?: unknown };
    const tag = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/i, '').trim() : '';
    return tag || null;
  } catch {
    return null; // 离线/限流/仓库未创建：静默降级
  }
}

/** 简化 semver 比较：主.次.补丁 三段数字，逐段比较；格式非法返回 false。 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10));
  const a = parse(latest);
  const b = parse(current);
  if (a.length !== 3 || b.length !== 3 || a.some((n) => !Number.isFinite(n)) || b.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
