import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Shows a plain message instead of a blank page if something in the page breaks. */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = { error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Department page error:', error, info);
  }

  public render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
        <p className="mt-2 break-words text-sm text-gray-600">{this.state.error.message}</p>
        <div className="mt-6 flex gap-3">
          <button className="rounded border border-gray-300 px-4 py-2 text-sm" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            className="rounded bg-blue-700 px-4 py-2 text-sm text-white"
            onClick={() => {
              sessionStorage.clear();
              window.location.href = '/join';
            }}
          >
            Join again
          </button>
        </div>
      </div>
    );
  }
}
