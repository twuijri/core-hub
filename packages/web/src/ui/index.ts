/**
 * The component kit — one import for every interactive surface in the client.
 *
 * docs/clients/DESIGN.md §UI policy: a screen never imports a primitive and never uses the
 * browser's own furniture. This barrel is what a screen imports instead. The code lives
 * here, in our repository, in the shadcn/ui manner: we own the files, we style them with
 * our tokens alone, and the behaviour underneath is Radix's, because a focus trap and a
 * roving tabindex are not things to write twice.
 *
 * Adding a control means adding it here, once, with its states and both themes — never
 * inline in a screen. `tests/ui-kit.test.tsx` holds the kit to that: every component is
 * exported from this file and used by at least one screen.
 */
export { AlertDialog } from './AlertDialog.js';
export { Avatar, initialOf, type AvatarSize } from './Avatar.js';
export { agentMark } from './brand/marks.js';
export { CoreHubMark } from './brand/CoreHubMark.js';
export { Badge, type BadgeTone } from './Badge.js';
export { Breadcrumb, type Crumb } from './Breadcrumb.js';
export {
  Button,
  buttonClass,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from './Button.js';
export {
  Card,
  CardFooter,
  CardHeader,
  cardClass,
  type CardPadding,
  type CardTone,
} from './Card.js';
export {
  ShareBars,
  StackedBarChart,
  type ChartBar,
  type ChartSeries,
  type ChartTone,
  type ShareRow,
} from './Chart.js';
export { Checkbox } from './Checkbox.js';
export { Combobox, type ComboboxOption } from './Combobox.js';
export { useConfirm, type ConfirmRequest } from './ConfirmDialog.js';
export { ContextMenu, ContextMenuItem, ContextMenuSeparator } from './ContextMenu.js';
export { Dialog, Sheet, type DialogSize } from './Dialog.js';
export { UiDirection } from './Direction.js';
export { EmptyState } from './EmptyState.js';
export { Input, Textarea, type InputProps, type InputSize, type TextareaProps } from './Input.js';
export { Field, Label } from './Label.js';
export { Menu, MenuChoice, MenuItem, MenuNote, MenuSeparator } from './Menu.js';
export { Notice, Spinner } from './Notice.js';
export { Popover } from './Popover.js';
export { usePrompt, type PromptRequest } from './PromptDialog.js';
export { Radio, type RadioOption } from './Radio.js';
export { ScrollArea } from './ScrollArea.js';
export { Segmented, SegmentedItem, SegmentedTrack } from './Segmented.js';
export { Select, type SelectOption } from './Select.js';
export { Separator } from './Separator.js';
export {
  SidebarBody,
  SidebarBrand,
  SidebarFooter,
  SidebarFrame,
  SidebarGroup,
  SidebarRow,
} from './SidebarShell.js';
export { Skeleton, SkeletonGroup, SkeletonText } from './Skeleton.js';
export { Switch } from './Switch.js';
export { Table, type Column } from './Table.js';
export { TabList, TabPanel, Tabs, TabsFrame, type TabItem } from './Tabs.js';
export { ToastProvider, useToast, type ToastRequest, type ToastTone } from './Toast.js';
export { Tooltip } from './Tooltip.js';
