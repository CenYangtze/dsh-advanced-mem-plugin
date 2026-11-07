import { createElement as h } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { KylinMemoryLocaleKey } from './locales.ts'

/** Original three-layer memory glyph; it does not use Kylin artwork or marks. */
export function BrandMark({ size = 24 }: { readonly size?: number }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    role: 'img',
    'aria-hidden': true,
    focusable: false,
  },
  h('rect', { x: 4, y: 4, width: 13, height: 4, rx: 2, fill: 'var(--dsw-static-blue-500)' }),
  h('rect', { x: 6.5, y: 10, width: 13, height: 4, rx: 2, fill: 'var(--dsw-static-blue-600)' }),
  h('rect', { x: 4, y: 16, width: 13, height: 4, rx: 2, fill: 'var(--kylin-memory)' }),
  h('circle', { cx: 19, cy: 18, r: 1.6, fill: 'var(--kylin-memory)' }))
}

/** Sidebar brand mark replacement; size is the shell's requested square edge. */
export function SidebarBrandMark({ size }: PropsRuntime<'sidebar.brand.mark'>) {
  return h('span', {
    style: { display: 'inline-grid', placeItems: 'center', width: size, height: size },
  }, h(BrandMark, { size }))
}

/** Sidebar brand name replacement; the shell supplies row geometry. */
export function SidebarBrandName(props: PropsRuntime<'sidebar.brand.name'> & { t(key: KylinMemoryLocaleKey): string }) {
  return h('span', {
    style: {
      display: 'block',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: 14,
      fontWeight: 600,
      letterSpacing: '0.04em',
    },
  }, props.t('title'))
}

/** Empty-page hero mark replacement; preserves the host className for geometry. */
export function HeroBrandMark({ size, className }: PropsRuntime<'conversation.hero.brand.mark'>) {
  return h('span', {
    className,
    style: { display: 'inline-grid', placeItems: 'center', width: size, height: size },
  }, h(BrandMark, { size }))
}
