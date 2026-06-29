// SPDX-License-Identifier: AGPL-3.0-only
// Select — Radix UI Select wrapped in tokens.
// Radix handles keyboard nav, screen reader announcements, portal placement.

import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp } from "lucide-react"
import type { ComponentPropsWithoutRef } from "react"
import { cn } from "./cn.js"

export const Select = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group
export const SelectValue = SelectPrimitive.Value

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex w-full items-center justify-between",
        "h-[var(--control-height)] px-[var(--cell-padding-x)]",
        "rounded-[var(--radius-6)] border border-[var(--alpha-400)]",
        "transition-colors duration-[var(--motion-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[placeholder]:text-[var(--gray-600)]",
        className,
      )}
      style={{
        backgroundColor: "var(--bg-100)",
        color: "var(--gray-1000)",
        fontSize: "var(--text-body)",
      }}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectScrollUpButton({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronUp className="h-4 w-4" aria-hidden="true" />
    </SelectPrimitive.ScrollUpButton>
  )
}

export function SelectScrollDownButton({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronDown className="h-4 w-4" aria-hidden="true" />
    </SelectPrimitive.ScrollDownButton>
  )
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        className={cn(
          "relative z-[var(--z-overlay)] overflow-hidden",
          "rounded-[var(--radius-12)] border border-[var(--alpha-400)]",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        style={{
          backgroundColor: "var(--bg-100)",
          color: "var(--gray-1000)",
          boxShadow: "var(--shadow-md)",
        }}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("px-[var(--cell-padding-x)] py-1.5 font-medium", className)}
      style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}
      {...props}
    />
  )
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default select-none items-center",
        "rounded-[var(--radius-6)]",
        "py-1.5 pl-8 pr-[var(--cell-padding-x)]",
        "outline-none",
        "focus:bg-[var(--gray-100)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      style={{ fontSize: "var(--text-body)", color: "var(--gray-1000)" }}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4" aria-hidden="true" style={{ color: "var(--blue-700)" }} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

export function SelectSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-[var(--alpha-200)]", className)}
      {...props}
    />
  )
}
