// Темы экрана. base — светлая или тёмная подложка (от неё зависят карта и общие цвета), остальное задаёт data-skin в стилях.
export interface ThemeDef {
  id: string;
  name: string;
  hint: string;
  base: 'light' | 'dark';
  swatch: [bg: string, panel: string, text: string, accent: string, hot: string];
}

export const THEMES: ThemeDef[] = [
  { id: 'light', name: 'Светлая', hint: 'для дневной смены', base: 'light', swatch: ['#eef1f6', '#ffffff', '#121722', '#6b4cf0', '#e3142d'] },
  { id: 'dark', name: 'Тёмная', hint: 'классическая ночная', base: 'dark', swatch: ['#07090d', '#0e1219', '#e9edf4', '#a78bff', '#ff3150'] },
  { id: 'night', name: 'Ночная смена', hint: 'тёплые приглушённые цвета, меньше синего', base: 'dark', swatch: ['#120e0a', '#1b1510', '#efe3d2', '#e0a46b', '#ff6b4a'] },
  { id: 'ocean', name: 'Океан', hint: 'тёмно-синяя, спокойная', base: 'dark', swatch: ['#06121f', '#0b1c2e', '#e2edf8', '#4cc3ff', '#ff4d6d'] },
  { id: 'red', name: 'Красная', hint: 'светлая с красным акцентом', base: 'light', swatch: ['#f6f2f2', '#ffffff', '#1c1414', '#e30611', '#c4001a'] },
  { id: 'contrast', name: 'Высокий контраст', hint: 'крупные границы, максимум читаемости', base: 'light', swatch: ['#ffffff', '#ffffff', '#000000', '#0033cc', '#c00000'] },
];

export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];
