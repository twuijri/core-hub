/**
 * The part of the harness's shared UI library the browser half uses, written down from the
 * published declarations of `@deepseek-ai/dsh-client-ui-primitives` 0.2.2-rc.5 (MIT; its README's
 * component catalog names it "the only place a control can be shared"). The page supplies the
 * module from its shared module table: the plugin bundles none of it, so its controls are the
 * harness's own, in both themes.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type {
    ButtonHTMLAttributes,
    ForwardRefExoticComponent,
    HTMLAttributes,
    InputHTMLAttributes,
    JSX,
    ReactNode,
    ReactPortal,
    RefAttributes,
  } from 'react';

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar';
  export const Button: ForwardRefExoticComponent<
    {
      variant?: ButtonVariant;
      size?: 'md' | 'sm';
      icon?: ReactNode;
      className?: string | undefined;
      children?: ReactNode;
    } & ButtonHTMLAttributes<HTMLButtonElement> &
      RefAttributes<HTMLButtonElement>
  >;

  export function Switch(props: {
    checked: boolean;
    onChange: (next: boolean) => void;
    label: string;
    disabled?: boolean;
    title?: string | undefined;
    className?: string | undefined;
  }): JSX.Element;

  export function Checkbox(props: {
    checked: boolean;
    onChange: (next: boolean) => void;
    label: string;
    disabled?: boolean;
    title?: string | undefined;
    className?: string | undefined;
  }): JSX.Element;

  export const Input: ForwardRefExoticComponent<
    { icon?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement> &
      RefAttributes<HTMLInputElement>
  >;

  export type TagTone =
    'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger';
  export function Tag(props: {
    tone?: TagTone;
    className?: string | undefined;
    children?: ReactNode;
  }): JSX.Element;

  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle';
  export function StateDot(props: {
    state: StateDotState;
    size?: number | undefined;
    className?: string | undefined;
    appearance?: 'dot' | 'step';
  }): JSX.Element;

  export function PathLabel(
    props: { path: string } & Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'title'>,
  ): JSX.Element;

  export function CommandText(props: {
    text: string;
    label: string;
    className?: string | undefined;
  }): JSX.Element;

  export function UserMessageBubble(props: HTMLAttributes<HTMLDivElement>): JSX.Element;

  export interface MenuItem {
    id: string;
    label: ReactNode;
    disabled?: boolean;
    icon?: ReactNode;
    danger?: boolean;
  }
  export function Menu(props: {
    open: boolean;
    anchor: ReactNode;
    items?: readonly MenuItem[];
    selectedId?: string | undefined;
    onSelect?: (id: string) => void;
    onClose: () => void;
    align?: 'start' | 'end';
    portal?: boolean;
    minWidthFromAnchor?: boolean;
    autoFocus?: boolean;
    className?: string | undefined;
  }): JSX.Element;

  export function Modal(props: {
    open: boolean;
    onClose: () => void;
    title: string;
    tone?: 'warning';
    description?: string;
    children?: ReactNode;
    footer?: ReactNode;
    closeLabel: string;
  }): ReactPortal | null;

  export function Toast(props: {
    text: string;
    icon?: ReactNode;
    tone?: 'success';
    holdMs?: number;
    onDone: () => void;
  }): ReactPortal;

  export interface MarkdownLabels {
    code: {
      copyLabel: string;
      copiedLabel: string;
      toolbarLabels?: { codeLabel: string; wrapLabel: string; unwrapLabel: string } | undefined;
    };
    footnotes: string;
  }
  export const MarkdownText: (props: {
    text: string;
    streaming?: boolean;
    labels: MarkdownLabels;
    variant?: 'body' | 'compact';
    omitHtml?: boolean;
  }) => JSX.Element;

  export interface IconProps {
    size?: number | undefined;
    className?: string | undefined;
  }
  export const IconChevronDownOutlineRegular: (props: IconProps) => JSX.Element;
  export const IconFolderOpenOutlineRegular: (props: IconProps) => JSX.Element;
  export const IconRefreshOutlineRegular: (props: IconProps) => JSX.Element;
  export const IconTrashOutlineRegular: (props: IconProps) => JSX.Element;
  export const IconLinkOutlineRegular: (props: IconProps) => JSX.Element;
}
