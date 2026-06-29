// SPDX-License-Identifier: AGPL-3.0-only
// DropdownMenu — thin token-styled wrapper around Radix DropdownMenu.
// shadow-md for menu elevation (DESIGN.md §Elevation).

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"
import { Check, ChevronRight, Circle } from "lucide-react"
import type { ComponentPropsWithoutRef } from "react"
import { cn } from "./cn.js"

export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuGroup = DropdownMenuPrimitive.Group
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal
export const DropdownMenuSub = DropdownMenuPrimitive.Sub
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

type ContentProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>

export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ContentProps) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-32 overflow-hidden",
          "rounded-[var(--radius-12)] border border-[var(--alpha-400)]",
          "p-1",
          "transition-opacity duration-[var(--motion-fast)]",
          "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
          className,
        )}
        style={{
          backgroundColor: "var(--bg-100)",
          color: "var(--gray-1000)",
          fontSize: "var(--text-body)",
          boxShadow: "var(--shadow-md)",
        }}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

type ItemProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
  readonly inset?: boolean
}

export function DropdownMenuItem({ className, inset, ...props }: ItemProps) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2",
        "rounded-[var(--radius-6)] px-2 py-1.5",
        "outline-none",
        "transition-colors duration-[var(--motion-fast)]",
        "focus:bg-[var(--gray-100)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-8",
        className,
      )}
      style={{ fontSize: "var(--text-body)", color: "var(--gray-1000)" }}
      {...props}
    />
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      className={cn(
        "relative flex cursor-default select-none items-center rounded-[var(--radius-6)]",
        "py-1.5 pl-8 pr-2",
        "outline-none",
        "transition-colors duration-[var(--motion-fast)]",
        "focus:bg-[var(--gray-100)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      style={{ fontSize: "var(--text-body)", color: "var(--gray-1000)" }}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

export function DropdownMenuLabel({
  className,
  inset,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { readonly inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn("px-2 py-1.5 font-medium", inset && "pl-8", className)}
      style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-[var(--alpha-200)]", className)}
      {...props}
    />
  )
}

export function DropdownMenuShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("ml-auto tracking-widest", className)}
      style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}
      {...props}
    />
  )
}

export function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
  readonly inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-[var(--radius-6)]",
        "px-2 py-1.5",
        "outline-none",
        "focus:bg-[var(--gray-100)] data-[state=open]:bg-[var(--gray-100)]",
        inset && "pl-8",
        className,
      )}
      style={{ fontSize: "var(--text-body)", color: "var(--gray-1000)" }}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto h-4 w-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      className={cn(
        "z-50 min-w-32 overflow-hidden",
        "rounded-[var(--radius-12)] border border-[var(--alpha-400)]",
        "p-1",
        "transition-opacity duration-[var(--motion-fast)]",
        "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
        className,
      )}
      style={{
        backgroundColor: "var(--bg-100)",
        color: "var(--gray-1000)",
        boxShadow: "var(--shadow-md)",
      }}
      {...props}
    />
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={cn(
        "relative flex cursor-default select-none items-center rounded-[var(--radius-6)]",
        "py-1.5 pl-8 pr-2",
        "outline-none",
        "transition-colors duration-[var(--motion-fast)]",
        "focus:bg-[var(--gray-100)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      style={{ fontSize: "var(--text-body)", color: "var(--gray-1000)" }}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className="h-2 w-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}
