/**
 * Keeps one broken page from taking the whole app down.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * so without this a single bad value renders as a blank white screen with no
 * navigation and no clue — which is exactly what an object arriving where a
 * version string was expected did to the dashboard.
 *
 * It wraps the routed content *inside* the layout, so the sidebar survives and
 * the reader can simply go somewhere else. Remounting on a route change means
 * navigating away is enough to clear it; there is nothing to "recover" from a
 * render that cannot succeed with the data it has.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "./ui.js";

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack is the only record of this — there is no server round-trip to
    // find it in afterwards.
    // eslint-disable-next-line no-console
    console.error("[TorHQ] render failed:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Card title="This page failed to render" icon="alert">
        <div className="stack">
          <p className="muted small">
            Something in the data this page received was not what it expected. The rest of TorHQ is
            unaffected — pick another page from the sidebar, or reload once the cause is fixed.
          </p>
          <pre className="mono small break">{error.message}</pre>
          <div className="row">
            <Button icon="refresh" onClick={() => this.setState({ error: null })}>Try again</Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>Reload TorHQ</Button>
          </div>
        </div>
      </Card>
    );
  }
}
