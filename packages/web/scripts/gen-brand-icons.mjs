#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Codegen: catalog iconSlug -> committed brand-icons.generated.tsx (increment 30.5 v2).
//
// WHY this exists: @thesvg/icons ships ~4400 brands as raw SVG-string exports
// (devDependency only — never enters the runtime tree). This script extracts
// ONLY the slugs our catalog actually uses, picks the right variant per brand
// (full-color / light+dark themed / currentColor mono — see categorize()
// below), PARSES each variant's inner SVG markup into a real JSX element tree,
// and serializes that tree as literal JSX source into a committed .tsx file.
//
// Parsed JSX (not `dangerouslySetInnerHTML`) keeps the CSP/trust posture the
// v1 icon layer established: no runtime HTML injection anywhere, ever. The
// parser only has to handle well-formed SVG XML (tags/attrs/self-closing),
// which is a MUCH smaller problem than general HTML — so a small hand-rolled
// parser here is a reasonable, low-risk choice over pulling in a parser dep
// purely for a one-shot build script.
//
// FAIL LOUD: throws (non-zero exit) if a catalog iconSlug has no @thesvg/icons
// module, or the chosen variant is empty/unparseable — this is the "converts
// a trademark-takedown-style disappearance into a caught-at-build event"
// guarantee the method file requires (docs/methods/30.5-app-lifecycle.md §4).
//
// Run: `pnpm --filter @junction/web gen:icons` (re-run only on a deliberate
// icon-set change; NOT wired into `vite build` — the output is a pinned,
// committed snapshot, not a build artifact).

import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, "..", "src", "ui", "brand-icons.generated.tsx")

// ─── 1. Which slugs does the catalog need? ─────────────────────────────────
// Import @junction/core's listApps() directly (the robust source of truth —
// reading catalog.ts as text would silently drift if the field shape changes).

/** @type {{ iconSlug?: string, id: string }[]} */
let apps
{
  const core = await import("@junction/core")
  apps = core.listApps()
}

const slugs = [...new Set(apps.map((a) => a.iconSlug).filter((s) => s !== undefined))].sort()

if (slugs.length === 0) {
  throw new Error("gen-brand-icons: no catalog app has an iconSlug — nothing to generate")
}

// ─── 2. Minimal SVG-XML -> AST parser ──────────────────────────────────────
// Handles exactly what @thesvg/icons variant strings contain: elements
// (paired or self-closing), attributes (quoted, possibly namespaced e.g.
// `xlink:href`), and text content. No DOCTYPE/comments/CDATA needed for this
// input (verified against every variant we consume — see the "verify" step
// below, which throws if parsing produces zero elements for a variant).

/**
 * @typedef {{ type: "element", tag: string, attrs: Record<string,string>, children: AstNode[] }} ElementNode
 * @typedef {{ type: "text", value: string }} TextNode
 * @typedef {ElementNode | TextNode} AstNode
 */

// Elements that carry no visual/structural meaning for a standalone inline
// icon (editor metadata, RDF, embedded-slice bookkeeping) — dropped entirely,
// including their subtrees. `title` is also dropped: the icon is always
// rendered aria-hidden (decorative, name is visible beside it — see
// brand-icon.tsx), so a nested <title> would be redundant, unannounced markup.
const DROP_TAGS = new Set([
  "metadata",
  "title",
  "sfw",
  "slices",
  "sliceSourceBounds",
  "rdf:RDF",
  "cc:Work",
  "dc:format",
  "dc:type",
])

// Void/self-closing-by-convention SVG elements with no useful children.
const VOID_TAGS = new Set(["path", "circle", "ellipse", "rect", "stop", "use", "feGaussianBlur"])

function parseSvgFragment(svgString) {
  // Extract the outer <svg ...> tag's attrs (for viewBox) and its inner content.
  const openMatch = svgString.match(/<svg\b([^>]*)>/)
  if (!openMatch) {
    throw new Error("parseSvgFragment: no <svg> open tag found")
  }
  const outerAttrs = parseAttrs(openMatch[1])
  const innerStart = openMatch.index + openMatch[0].length
  const innerEnd = svgString.lastIndexOf("</svg>")
  if (innerEnd === -1 || innerEnd < innerStart) {
    throw new Error("parseSvgFragment: no matching </svg> close tag found")
  }
  const inner = svgString.slice(innerStart, innerEnd)
  const { nodes } = parseNodes(inner, 0)
  return { viewBox: outerAttrs.viewBox, nodes }
}

/** Parses a run of sibling nodes starting at `pos` in `src`. Stops at end-of-string
 * (top-level) — callers of a paired-tag body pass only that body's substring. */
function parseNodes(src, pos) {
  const nodes = []
  let i = pos
  while (i < src.length) {
    const lt = src.indexOf("<", i)
    if (lt === -1) {
      const text = src.slice(i)
      if (text.trim() !== "") nodes.push({ type: "text", value: text })
      break
    }
    if (lt > i) {
      const text = src.slice(i, lt)
      if (text.trim() !== "") nodes.push({ type: "text", value: text })
    }
    if (src.startsWith("</", lt)) {
      // Closing tag belongs to our caller (the paired-tag parser below) — stop here.
      return { nodes, nextIndex: lt }
    }
    const tagMatch = src.slice(lt).match(/^<([a-zA-Z][a-zA-Z0-9:._-]*)((?:\s+[^<>]*?)?)(\/?)>/)
    if (!tagMatch) {
      throw new Error(
        `parseNodes: could not parse tag at position ${lt}: ${src.slice(lt, lt + 60)}`,
      )
    }
    const [full, tag, rawAttrs, selfClosingSlash] = tagMatch
    const attrs = parseAttrs(rawAttrs)
    const tagStart = lt
    const afterOpen = lt + full.length

    if (DROP_TAGS.has(tag)) {
      if (selfClosingSlash === "/") {
        i = afterOpen
        continue
      }
      // Skip to (and past) the matching close tag, dropping the whole subtree.
      const closeIdx = findMatchingClose(src, afterOpen, tag)
      i = closeIdx === -1 ? src.length : closeIdx
      continue
    }

    if (selfClosingSlash === "/" || VOID_TAGS.has(tag)) {
      nodes.push({ type: "element", tag, attrs, children: [] })
      i = afterOpen
      continue
    }

    // Paired tag: recurse into its body, then consume its close tag.
    const { nodes: children, nextIndex: closeStart } = parseNodes(src, afterOpen)
    if (closeStart === undefined) {
      throw new Error(`parseNodes: unclosed tag <${tag}> starting at ${tagStart}`)
    }
    const closeMatch = src.slice(closeStart).match(/^<\/[a-zA-Z][a-zA-Z0-9:._-]*\s*>/)
    if (!closeMatch) {
      throw new Error(`parseNodes: malformed close tag for <${tag}> at ${closeStart}`)
    }
    nodes.push({ type: "element", tag, attrs, children })
    i = closeStart + closeMatch[0].length
  }
  return { nodes, nextIndex: undefined }
}

/** Finds the index of the matching `</tag>` for a dropped subtree (handles same-tag nesting). */
function findMatchingClose(src, pos, tag) {
  let depth = 1
  const openRe = new RegExp(`<${tag}(?=[\\s>/])`, "g")
  const closeRe = new RegExp(`</${tag}\\s*>`, "g")
  openRe.lastIndex = pos
  closeRe.lastIndex = pos
  let i = pos
  while (depth > 0) {
    openRe.lastIndex = i
    closeRe.lastIndex = i
    const nextOpen = openRe.exec(src)
    const nextClose = closeRe.exec(src)
    if (!nextClose) return -1
    if (nextOpen && nextOpen.index < nextClose.index) {
      // A nested same-tag open before the next close — but this dropped tag
      // (metadata/title/etc.) never nests itself in practice; treat simply.
      depth += 1
      i = nextOpen.index + 1
    } else {
      depth -= 1
      i = nextClose.index + nextClose[0].length
      if (depth === 0) return i
    }
  }
  return -1
}

function parseAttrs(rawAttrs) {
  const attrs = {}
  const re =
    /([a-zA-Z_][a-zA-Z0-9:._-]*)\s*=\s*"([^"]*)"|([a-zA-Z_][a-zA-Z0-9:._-]*)\s*=\s*'([^']*)'/g
  for (const m of rawAttrs.matchAll(re)) {
    const name = m[1] ?? m[3]
    const value = m[2] ?? m[4]
    attrs[name] = value
  }
  return attrs
}

// ─── 3. AST -> JSX source serializer ────────────────────────────────────────
// SVG attr name -> React/DOM prop name. Anything not listed here that starts
// with `xmlns` or is `class`/`id`/`version` is dropped (editor/tooling noise,
// or handled specially below); everything else passes through camelCased.

const ATTR_RENAME = {
  class: "className",
  "xlink:href": "xlinkHref",
  "clip-path": "clipPath",
  "clip-rule": "clipRule",
  "fill-rule": "fillRule",
  "fill-opacity": "fillOpacity",
  "stop-color": "stopColor",
  "stop-opacity": "stopOpacity",
  "color-interpolation-filters": "colorInterpolationFilters",
  "enable-background": "enableBackground",
  "gradient-transform": "gradientTransform",
  "gradient-units": "gradientUnits",
  "clip-path-units": "clipPathUnits",
  "std-deviation": "stdDeviation",
  "preserve-aspect-ratio": "preserveAspectRatio",
  "xml:space": "xmlSpace",
}

// Attrs that are pure editor/tooling bookkeeping — safe to drop even though
// they're well-formed (ids ARE kept — gradient/clipPath url(#id) refs need them).
const DROP_ATTRS = new Set(["version"])

function jsxAttrName(name) {
  if (name.startsWith("xmlns")) return null // xmlns / xmlns:xlink / xmlns:foo — React sets these implicitly on <svg>
  if (DROP_ATTRS.has(name)) return null
  if (name in ATTR_RENAME) return ATTR_RENAME[name]
  if (name.includes(":")) return null // any other namespaced attr (rdf:*, i:*, sodipodi:* stragglers) — drop
  if (name.includes("-")) {
    // generic kebab-case fallback -> camelCase (covers any we didn't enumerate above)
    return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  }
  return name
}

function jsxStringLiteral(value) {
  return JSON.stringify(value)
}

/** Parses a CSS `style="a:b;c:d"` attribute value into a JS object literal source string. */
function styleAttrToObjectSource(styleValue) {
  const props = styleValue
    .split(";")
    .map((decl) => decl.trim())
    .filter((decl) => decl !== "")
    .map((decl) => {
      const idx = decl.indexOf(":")
      if (idx === -1) return null
      const prop = decl.slice(0, idx).trim()
      const value = decl.slice(idx + 1).trim()
      const camelProp = prop.startsWith("--")
        ? prop
        : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      return `${JSON.stringify(camelProp)}: ${JSON.stringify(value)}`
    })
    .filter((p) => p !== null)
  return `{ ${props.join(", ")} }`
}

function serializeAttrs(attrs) {
  const parts = []
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "style") {
      parts.push(`style={${styleAttrToObjectSource(value)}}`)
      continue
    }
    const reactName = jsxAttrName(name)
    if (reactName === null) continue
    parts.push(`${reactName}=${jsxStringLiteral(value)}`)
  }
  return parts
}

function serializeNode(node, indent) {
  const pad = "  ".repeat(indent)
  if (node.type === "text") {
    return `${pad}{${JSON.stringify(node.value)}}`
  }
  const attrParts = serializeAttrs(node.attrs)
  const attrSrc = attrParts.length > 0 ? ` ${attrParts.join(" ")}` : ""
  if (node.children.length === 0) {
    return `${pad}<${node.tag}${attrSrc} />`
  }
  const childrenSrc = node.children.map((c) => serializeNode(c, indent + 1)).join("\n")
  return `${pad}<${node.tag}${attrSrc}>\n${childrenSrc}\n${pad}</${node.tag}>`
}

/** Serializes a list of sibling nodes as a JSX fragment (`<>...</>`) source string. */
function serializeAsFragment(nodes, indent) {
  if (nodes.length === 0) {
    throw new Error("serializeAsFragment: empty node list (would emit a blank glyph)")
  }
  const pad = "  ".repeat(indent)
  const body = nodes.map((n) => serializeNode(n, indent + 1)).join("\n")
  return `${pad}<>\n${body}\n${pad}</>`
}

// ─── 4. Category rules (per method file §4 "Approach") ─────────────────────

// A default mark whose ONLY fills are pure black (or pure white) would vanish
// against the opposite theme background if rendered as-is ("color"). If such a
// mark also ships a `mono` variant, we render THAT with fill=currentColor so it
// adapts to the theme. This generalises the notion special-case to the whole
// class (e.g. braintree's #000000 mark) rather than enumerating slugs.
const PURE_BW = new Set([
  "#000",
  "#000000",
  "#000000ff",
  "black",
  "#fff",
  "#ffffff",
  "#ffffffff",
  "white",
])

function isMonochromeBW(svgString) {
  if (svgString === undefined) return false
  const fills = [...svgString.matchAll(/fill\s*=\s*"([^"]*)"/g)].map((m) => m[1].toLowerCase())
  const colored = fills.filter((f) => f !== "none" && f !== "" && f !== "currentcolor")
  if (colored.length === 0) return false // no explicit fills — inherits/currentColor, safe as "color"
  return colored.every((f) => PURE_BW.has(f))
}

function categorize(slug, variants) {
  if (variants.light !== undefined && variants.dark !== undefined) {
    return "themed"
  }
  // mono when: no default at all, OR the default is a pure black/white mark that
  // would disappear on the opposite theme — provided a `mono` variant exists to
  // render with currentColor.
  if (
    variants.mono !== undefined &&
    (variants.default === undefined || isMonochromeBW(variants.default))
  ) {
    return "mono"
  }
  return "color"
}

// ─── 5. Build the generated module ─────────────────────────────────────────

const entries = []

for (const slug of slugs) {
  /** @type {{ variants: Record<string,string> }} */
  let mod
  try {
    mod = await import(`@thesvg/icons/${slug}`)
  } catch (err) {
    throw new Error(
      `gen-brand-icons: catalog iconSlug "${slug}" has no @thesvg/icons module — ` +
        `either the slug is wrong or the brand was removed upstream (trademark takedown-style ` +
        `event; this is the fail-loud guard the method file requires). Original error: ${err.message}`,
    )
  }
  const variants = mod.variants ?? {}
  const category = categorize(slug, variants)

  /** @type {Record<string, string>} */
  const jsxBySlot = {}
  const viewBoxBySlot = {}

  function addSlot(slotName, variantName) {
    const svgString = variantName === "svg" ? mod.svg : variants[variantName]
    if (svgString === undefined || svgString.trim() === "") {
      throw new Error(
        `gen-brand-icons: iconSlug "${slug}" chosen variant "${variantName}" (slot "${slotName}") is empty`,
      )
    }
    const { viewBox, nodes } = parseSvgFragment(svgString)
    if (nodes.length === 0) {
      throw new Error(
        `gen-brand-icons: iconSlug "${slug}" variant "${variantName}" parsed to ZERO elements — would emit a blank glyph`,
      )
    }
    if (viewBox === undefined) {
      throw new Error(`gen-brand-icons: iconSlug "${slug}" variant "${variantName}" has no viewBox`)
    }
    jsxBySlot[slotName] = serializeAsFragment(nodes, 3)
    viewBoxBySlot[slotName] = viewBox
  }

  if (category === "themed") {
    addSlot("light", "light")
    addSlot("dark", "dark")
  } else if (category === "mono") {
    addSlot("mono", "mono")
  } else {
    // "color": prefer `default`, fall back to the top-level `svg` export.
    addSlot("color", variants.default !== undefined ? "default" : "svg")
  }

  entries.push({ slug, category, jsxBySlot, viewBoxBySlot })
}

// ─── 6. Emit brand-icons.generated.tsx ─────────────────────────────────────

const header = `// SPDX-License-Identifier: AGPL-3.0-only
// AUTO-GENERATED by packages/web/scripts/gen-brand-icons.mjs — DO NOT EDIT BY HAND.
// Regenerate with \`pnpm --filter @junction/web gen:icons\` after changing which
// catalog apps have an iconSlug (packages/core/src/apps/catalog.ts).
//
// This is a PINNED, COMMITTED snapshot (increment 30.5 v2 — see
// docs/methods/30.5-app-lifecycle.md §4): each entry below is real full-color
// brand mark markup extracted from the installed @thesvg/icons devDependency
// at codegen time, parsed into literal JSX (never \`dangerouslySetInnerHTML\`),
// so it ships fully offline with no runtime dependency on @thesvg/icons.
//
// LICENSE: brand logo data via @thesvg/icons (github.com/glincker/thesvg, MIT
// code), each mark under its upstream license (mostly CC0-1.0) — see
// README.md "Third-party notices". Brand ownership is unaffected.
//
// Category meaning (consumed by brand-icon.tsx):
//   "color"  -> one full-color mark, rendered as-is on both themes (\`color\`).
//   "themed" -> two pure black/white marks, CSS-swapped by data-theme
//               (\`light\` visible in light theme, \`dark\` visible in dark theme).
//   "mono"   -> one currentColor-adapting mark (\`mono\`).

export type BrandIconCategory = "color" | "themed" | "mono"

export interface BrandIconEntry {
  readonly category: BrandIconCategory
  readonly viewBox: Readonly<Record<string, string>>
  readonly render: Readonly<Record<string, () => React.ReactNode>>
}
`

const entrySources = entries.map((e) => {
  const slotFns = Object.entries(e.jsxBySlot)
    .map(([slot, jsx]) => `      ${slot}: () => (\n${jsx}\n      ),`)
    .join("\n")
  const viewBoxes = Object.entries(e.viewBoxBySlot)
    .map(([slot, vb]) => `      ${slot}: ${JSON.stringify(vb)},`)
    .join("\n")
  return `  ${JSON.stringify(e.slug)}: {
    category: ${JSON.stringify(e.category)},
    viewBox: {
${viewBoxes}
    },
    render: {
${slotFns}
    },
  },`
})

const body = `
export const BRAND_ICONS: Readonly<Record<string, BrandIconEntry>> = {
${entrySources.join("\n")}
}
`

writeFileSync(OUT_PATH, header + body, "utf8")

// Format with the project's own formatter (Biome) so the committed output
// matches `pnpm verify`'s formatting gate — the generator emits correct but
// not necessarily Biome-styled whitespace (e.g. it never adds trailing commas
// or wraps long JSX attribute lists the way Biome would).
try {
  execFileSync("pnpm", ["exec", "biome", "format", "--write", OUT_PATH], {
    cwd: join(__dirname, ".."),
    stdio: "inherit",
  })
} catch (err) {
  throw new Error(
    `gen-brand-icons: biome format --write failed on the generated file: ${err.message}`,
  )
}

console.log(`gen-brand-icons: wrote ${entries.length} icon(s) -> ${OUT_PATH}`)
for (const e of entries) {
  console.log(
    `  ${e.slug.padEnd(16)} ${e.category.padEnd(7)} slots=${Object.keys(e.jsxBySlot).join(",")}`,
  )
}
