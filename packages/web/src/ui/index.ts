// SPDX-License-Identifier: AGPL-3.0-only
// ui/ — owned primitive layer (Radix + cva + tokens).
// Import from this barrel; never from individual files outside of ui/.

export { AgentConfig } from "./agent-config.js"
export type { BadgeProps } from "./badge.js"
export { Badge, StatusBadge } from "./badge.js"
export type { ButtonProps, ButtonVariants } from "./button.js"
export { Button } from "./button.js"
export { Card, CardContent, CardHeader, CardTitle } from "./card.js"
export { Checkbox } from "./checkbox.js"
export { cn } from "./cn.js"
export type { MonoChipProps, MonoCodeProps } from "./code.js"
export { MonoChip, MonoCode } from "./code.js"
export { ComingSoon, ComingSoonAction } from "./coming-soon.js"
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./dialog.js"
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu.js"
export type { FieldProps } from "./field.js"
export { Field } from "./field.js"
export type { InputProps } from "./input.js"
export { Input } from "./input.js"
export { Kbd } from "./kbd.js"
export { PageHeader, PageHeaderSkeleton } from "./page-header.js"
export { RouteRow } from "./route-row.js"
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select.js"
export { Separator } from "./separator.js"
export type { SidebarState } from "./sidebar.js"
export { SIDEBAR_COOKIE, SIDEBAR_SCRIPT, Sidebar } from "./sidebar.js"
export type { SkeletonColumn } from "./skeleton.js"
export { Skeleton, SkeletonRow, TableSkeleton } from "./skeleton.js"
export type { EmptyStateProps, ErrorStateProps } from "./states.js"
export { EmptyState, ErrorState, LoadingState } from "./states.js"
export { Switch } from "./switch.js"
export type { SortDirection, TableHeadProps } from "./table.js"
export {
  Table,
  TableActionsCell,
  TableActionsHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.js"
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js"
export { Tooltip, TooltipContent, TooltipProvider } from "./tooltip.js"
export { Wordmark } from "./wordmark.js"
// status-rail: RETIRED in inc 24.5 — replaced by route-row as the signature element.
