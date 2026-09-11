// 批R：主题系统。classic = 原生亮色；command = 暗色指挥中心（强调色可切换）。
// 主题只影响指挥中心视图本身；其余页面保持原生风格。
export type ThemeMode = 'classic' | 'command';
export type ThemeAccent = 'amber' | 'green' | 'mono';

export const ACCENTS: Array<{ id: ThemeAccent; zh: string; ja: string; en: string; color: string }> = [
  { id: 'amber', zh: '琥珀金', ja: 'アンバー', en: 'Amber', color: '#e8b34b' },
  { id: 'green', zh: '终端绿', ja: 'ターミナル緑', en: 'Terminal green', color: '#35d08c' },
  { id: 'mono', zh: '极简白', ja: 'モノクロ', en: 'Mono white', color: '#e8efe9' },
];

export function loadThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'command';
  const saved = window.localStorage.getItem('enkei-theme-mode');
  return saved === 'classic' || saved === 'command' ? saved : 'command';
}

export function loadThemeAccent(): ThemeAccent {
  if (typeof window === 'undefined') return 'amber';
  const saved = window.localStorage.getItem('enkei-theme-accent');
  return saved === 'amber' || saved === 'green' || saved === 'mono' ? saved : 'amber';
}

export function accentColor(accent: ThemeAccent): string {
  return ACCENTS.find((item) => item.id === accent)?.color ?? '#e8b34b';
}
