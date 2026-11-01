import { Component, computed, input } from '@angular/core';
import {
  LucideBookOpen, LucideBriefcase, LucideBug, LucideCalendar, LucideCamera, LucideCode, LucideCoffee, LucideCompass,
  LucideFile, LucideFileText, LucideFlag, LucideFlame, LucideFolder, LucideGlobe, LucideGraduationCap, LucideHeart,
  LucideHouse, LucideImage, LucideKey, LucideLightbulb, LucideListChecks, LucideMap, LucideMusic, LucidePalette,
  LucidePlane, LucideRocket, LucideShoppingCart, LucideSparkles, LucideStar, LucideTarget, LucideTerminal, LucideUser,
  LucideWallet, LucideZap, LucideIconInput, LucideDynamicIcon,
} from '@lucide/angular';

/** A note's or folder's sidebar icon (a key of `STYLE_ICONS`) and color (an id of `STYLE_COLORS`); either may be unset. */
export interface ItemStyle {
  icon?: string;
  color?: string;
}

/** The icons to pick from, by the name stored in the note or `state.json`. */
export const STYLE_ICONS: Readonly<Record<string, LucideIconInput>> = {
  'file': LucideFile, 'file-text': LucideFileText, 'folder': LucideFolder, 'star': LucideStar, 'heart': LucideHeart,
  'flag': LucideFlag, 'flame': LucideFlame, 'zap': LucideZap, 'sparkles': LucideSparkles, 'lightbulb': LucideLightbulb,
  'target': LucideTarget, 'rocket': LucideRocket, 'book-open': LucideBookOpen, 'graduation-cap': LucideGraduationCap,
  'briefcase': LucideBriefcase, 'calendar': LucideCalendar, 'list-checks': LucideListChecks, 'code': LucideCode,
  'terminal': LucideTerminal, 'bug': LucideBug, 'globe': LucideGlobe, 'map': LucideMap, 'compass': LucideCompass,
  'plane': LucidePlane, 'house': LucideHouse, 'user': LucideUser, 'key': LucideKey, 'wallet': LucideWallet,
  'shopping-cart': LucideShoppingCart, 'coffee': LucideCoffee, 'music': LucideMusic, 'image': LucideImage,
  'camera': LucideCamera, 'palette': LucidePalette,
};

/** The colors to pick from: theme tokens, so each follows light and dark. */
export const STYLE_COLORS: readonly { id: string; label: string; css: string }[] = [
  { id: 'primary', label: 'Ember', css: 'var(--primary)' },
  { id: 'warning', label: 'Amber', css: 'var(--warning)' },
  { id: 'success', label: 'Green', css: 'var(--success)' },
  { id: 'code-title', label: 'Blue', css: 'var(--code-title)' },
  { id: 'code-type', label: 'Purple', css: 'var(--code-type)' },
  { id: 'destructive', label: 'Red', css: 'var(--destructive)' },
  { id: 'code-attr', label: 'Brown', css: 'var(--code-attr)' },
  { id: 'muted-foreground', label: 'Gray', css: 'var(--muted-foreground)' },
];

export function styleColorCss(color: string | undefined): string | null {
  return STYLE_COLORS.find((known) => known.id === color)?.css ?? null;
}

/** The icon of an `ItemStyle`, in its color; a color alone tints `fallback`. Renders nothing for neither. */
@Component({
  selector: 'app-item-style-icon',
  imports: [LucideDynamicIcon],
  template: `@if (icon(); as icon) {<svg [lucideIcon]="icon" [size]="12" class="shrink-0" [style.color]="css()"></svg>}`,
  host: { class: 'contents' },
})
export class ItemStyleIcon {
  readonly itemStyle = input<ItemStyle | null>(null);
  /** The icon a color alone is applied to. */
  readonly fallback = input<'file-text' | 'folder'>('file-text');

  protected readonly css = computed(() => styleColorCss(this.itemStyle()?.color));
  protected readonly icon = computed(() => {
    const style = this.itemStyle();
    const named = style?.icon ? STYLE_ICONS[style.icon] : undefined;
    return named ?? (this.css() ? STYLE_ICONS[this.fallback()] : null);
  });
}
