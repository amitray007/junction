// SPDX-License-Identifier: AGPL-3.0-only
// ui/ — owned primitive layer (shadcn pattern: Radix + cva + tokens).
// Import from this barrel; never from individual files outside of ui/.

export type { BadgeProps } from "./badge.js"
export { Badge, StatusBadge } from "./badge.js"
export type { ButtonProps, ButtonVariants } from "./button.js"
export { Button } from "./button.js"
export { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./card.js"
export { cn } from "./cn.js"
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
export { Kbd } from "./kbd.js"
export { Separator } from "./separator.js"
export { Skeleton, SkeletonRow } from "./skeleton.js"
export type { EmptyStateProps, ErrorStateProps } from "./states.js"
export { EmptyState, ErrorState, LoadingState } from "./states.js"
export type { RailSegment, RailSegmentState } from "./status-rail.js"
export { StatusRail } from "./status-rail.js"
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.js"
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js"
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
} from "./tooltip.js"
export { Wordmark } from "./wordmark.js"
