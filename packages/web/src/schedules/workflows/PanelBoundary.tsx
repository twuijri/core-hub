/**
 * A fence around one part of the workflow editor (the canvas, the side panel): an error while
 * drawing that part closes only it, says what happened, and offers to show it again — the
 * rest of the page, the drawing and its unsaved changes stay (2026-09-29: "Use the last run's
 * values" once blanked the whole page).
 *
 * It opens again by itself when `resetKey` changes (another step is selected).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useI18n } from '../../i18n/context.js';
import { Button, Notice } from '../../ui/index.js';

interface Props {
  children: ReactNode;
  /** When it changes, a closed part is tried again. */
  resetKey?: string | null | undefined;
  testId?: string;
}

interface State {
  error: Error | null;
  key: string | null | undefined;
}

class Boundary extends Component<
  Props & { failed: (error: Error, retry: () => void) => ReactNode },
  State
> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // For the person who reports it: the error and where, in the browser's console.
    console.error('workflow editor: a panel failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return this.props.failed(this.state.error, () => this.setState({ error: null }));
    }
    return this.props.children;
  }
}

export function PanelBoundary({ children, resetKey, testId = 'workflow-panel-failed' }: Props) {
  const { t } = useI18n();
  return (
    <Boundary
      resetKey={resetKey}
      failed={(error, retry) => (
        <div className="flex flex-col gap-2" data-testid={testId}>
          <Notice tone="danger">
            {t('workflows.editor.panel_failed', { message: error.message || error.name })}
          </Notice>
          <Button size="sm" variant="secondary" onClick={retry} data-testid={`${testId}-retry`}>
            {t('workflows.editor.panel_retry')}
          </Button>
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}
