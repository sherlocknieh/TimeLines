import { ref } from "vue";

export type ThemeId = "paper" | "ink" | "celadon" | "dusk";

export interface Theme {
  id: ThemeId;
  label: string;
  /** 预览色板：背景色与文字色，用于切换器里的两色圆点 */
  swatch: [string, string];
}

/** 主题清单：新增主题时在这里登记，并在 views.css 补一组同名变量 */
export const THEMES: Theme[] = [
  { id: "paper", label: "纸本", swatch: ["#f4efe4", "#221d17"] },
  { id: "ink", label: "墨夜", swatch: ["#14120f", "#f2ece0"] },
  { id: "celadon", label: "青瓷", swatch: ["#eef2ee", "#1b2420"] },
  { id: "dusk", label: "暮蓝", swatch: ["#101722", "#e8eef7"] },
];

/** 与 index.html 的首屏脚本共用同一个键，避免加载时闪一下默认主题 */
export const THEME_KEY = "timelines:theme";

const isTheme = (value: unknown): value is ThemeId =>
  THEMES.some((theme) => theme.id === value);

/** 未选择过主题时跟随系统深浅色，之后以用户选择为准 */
function initialTheme(): ThemeId {
  const saved = localStorage.getItem(THEME_KEY);
  if (isTheme(saved)) return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "ink"
    : "paper";
}

export const theme = ref<ThemeId>(initialTheme());

/** 主题只落在根元素的 data-theme 上，样式由 CSS 变量接管；只有用户主动选择才记住 */
export function applyTheme(id: ThemeId, persist = true) {
  theme.value = id;
  document.documentElement.dataset.theme = id;
  if (persist) localStorage.setItem(THEME_KEY, id);
}

applyTheme(theme.value, false);

/** 用户还没选过主题时，跟随系统深浅色实时切换 */
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", (event) => {
    if (localStorage.getItem(THEME_KEY)) return;
    applyTheme(event.matches ? "ink" : "paper", false);
  });
