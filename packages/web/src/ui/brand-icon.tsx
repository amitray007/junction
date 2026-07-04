// SPDX-License-Identifier: AGPL-3.0-only
// BrandIcon — a per-app brand glyph for the Apps surface (increment 30.5 v2).
//
// Renders REAL full-color brand logos from the generated @thesvg/icons snapshot
// (brand-icons.generated.tsx), picked per-category (see BRAND_ICONS docs there):
//   "color"  -> one full-color <svg>, rendered as-is (looks right on both themes).
//   "themed" -> TWO <svg> (light + dark), CSS-swapped by [data-theme] — a pure
//               display toggle, no JS, no flash (see brand-icon.css classes below).
//   "mono"   -> one fill="currentColor" <svg> (adapts to theme automatically).
// Unknown/undefined slug -> LetterTile (unchanged from v1).
//
// Never `dangerouslySetInnerHTML`: every glyph is real parsed JSX, emitted at
// codegen time from build-time-trusted @thesvg/icons markup (see
// packages/web/scripts/gen-brand-icons.mjs) — no runtime HTML injection.

import { BRAND_ICONS } from "./brand-icons.generated.js"
import { cn } from "./cn.js"

export interface BrandIconProps {
  /** @thesvg/icons slug (AppDefinition.iconSlug). Undefined/unknown -> LetterTile. */
  readonly slug?: string
  /** Used for the LetterTile initial. */
  readonly displayName: string
  readonly className?: string
}

const SIZE = 20

// Both render sites (the /app cards, the /app/:id header) place the glyph
// immediately beside the visible app name, so the glyph is DECORATIVE — its
// accessible name would duplicate the adjacent text ("GitHub" announced twice).
// It is therefore aria-hidden at both the svg and the tile. If a future caller
// renders BrandIcon WITHOUT adjacent visible text, give it its own label there.
export function BrandIcon({ slug, displayName, className }: BrandIconProps) {
  const entry = slug !== undefined ? BRAND_ICONS[slug] : undefined
  if (entry === undefined) {
    return <LetterTile displayName={displayName} className={className} />
  }

  if (entry.category === "themed") {
    const light = entry.render.light
    const dark = entry.render.dark
    const lightViewBox = entry.viewBox.light
    const darkViewBox = entry.viewBox.dark
    if (
      light === undefined ||
      dark === undefined ||
      lightViewBox === undefined ||
      darkViewBox === undefined
    ) {
      return <LetterTile displayName={displayName} className={className} />
    }
    return (
      <>
        <svg
          aria-hidden="true"
          viewBox={lightViewBox}
          width={SIZE}
          height={SIZE}
          className={cn("brand-icon-light shrink-0", className)}
        >
          {light()}
        </svg>
        <svg
          aria-hidden="true"
          viewBox={darkViewBox}
          width={SIZE}
          height={SIZE}
          className={cn("brand-icon-dark shrink-0", className)}
        >
          {dark()}
        </svg>
      </>
    )
  }

  if (entry.category === "mono") {
    const mono = entry.render.mono
    const viewBox = entry.viewBox.mono
    if (mono === undefined || viewBox === undefined) {
      return <LetterTile displayName={displayName} className={className} />
    }
    return (
      <svg
        aria-hidden="true"
        viewBox={viewBox}
        width={SIZE}
        height={SIZE}
        fill="currentColor"
        className={cn("shrink-0", className)}
        style={{ color: "var(--gray-900)" }}
      >
        {mono()}
      </svg>
    )
  }

  // category === "color"
  const color = entry.render.color
  const viewBox = entry.viewBox.color
  if (color === undefined || viewBox === undefined) {
    return <LetterTile displayName={displayName} className={className} />
  }
  return (
    <svg
      aria-hidden="true"
      viewBox={viewBox}
      width={SIZE}
      height={SIZE}
      className={cn("shrink-0", className)}
    >
      {color()}
    </svg>
  )
}

/** Neutral tinted first-letter tile — the mandatory fallback for apps with no verified brand icon. */
function LetterTile({
  displayName,
  className,
}: {
  readonly displayName: string
  readonly className?: string
}) {
  const letter = displayName.trim().charAt(0).toUpperCase() || "?"
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex items-center justify-center shrink-0 font-medium", className)}
      style={{
        width: SIZE,
        height: SIZE,
        borderRadius: "var(--radius-6)",
        backgroundColor: "var(--gray-100)",
        color: "var(--gray-700)",
        fontSize: "11px",
        lineHeight: 1,
      }}
    >
      {letter}
    </span>
  )
}
