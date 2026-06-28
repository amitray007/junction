// SPDX-License-Identifier: AGPL-3.0-only
// DropdownMenu — thin token-styled wrapper around Radix DropdownMenu.

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
          "rounded-[var(--radius-md)] border border-[var(--border)]",
          "bg-[var(--surface)]",
          "p-1",
          "text-[var(--text-body)] text-[var(--fg)]",
          "transition-opacity duration-[var(--motion-short)]",
          "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
          className,
        )}
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
        "rounded-[var(--radius-sm)] px-2 py-1.5",
        "text-[var(--text-body)] text-[var(--fg)] outline-none",
        "transition-colors duration-[var(--motion-micro)]",
        "focus:bg-[var(--surface-2)] focus:text-[var(--fg)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-8",
        className,
      )}
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
        "relative flex cursor-default select-none items-center rounded-[var(--radius-sm)]",
        "py-1.5 pl-8 pr-2",
        "text-[var(--text-body)] text-[var(--fg)] outline-none",
        "transition-colors duration-[var(--motion-micro)]",
        "focus:bg-[var(--surface-2)] focus:text-[var(--fg)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
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
      className={cn(
        "px-2 py-1.5",
        "text-[var(--text-eyebrow)] font-medium uppercase tracking-[0.08em] text-[var(--muted)]",
        inset && "pl-8",
        className,
      )}
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
      className={cn("-mx-1 my-1 h-px bg-[var(--border)]", className)}
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
      className={cn(
        "ml-auto text-[var(--text-eyebrow)] text-[var(--muted)] tracking-widest",
        className,
      )}
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
        "flex cursor-default select-none items-center gap-2 rounded-[var(--radius-sm)]",
        "px-2 py-1.5",
        "text-[var(--text-body)] text-[var(--fg)] outline-none",
        "focus:bg-[var(--surface-2)] data-[state=open]:bg-[var(--surface-2)]",
        inset && "pl-8",
        className,
      )}
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
        "rounded-[var(--radius-md)] border border-[var(--border)]",
        "bg-[var(--surface)]",
        "p-1",
        "transition-opacity duration-[var(--motion-short)]",
        "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
        className,
      )}
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
        "relative flex cursor-default select-none items-center rounded-[var(--radius-sm)]",
        "py-1.5 pl-8 pr-2",
        "text-[var(--text-body)] text-[var(--fg)] outline-none",
        "transition-colors duration-[var(--motion-micro)]",
        "focus:bg-[var(--surface-2)] focus:text-[var(--fg)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
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
