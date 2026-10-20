import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Slice Portal UI error:', error, errorInfo);
  }

  private handleReset = () => {
    sessionStorage.clear();
    window.location.href = '/';
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-red-950/60 border border-red-800/80 flex items-center justify-center text-3xl mb-4">
            ⚠️
          </div>
          <h1 className="text-xl font-bold text-slate-100 mb-2">Portal Display Error</h1>
          <div className="bg-red-950/40 border border-red-800/60 rounded-xl p-3 mb-4 max-w-md text-left">
            <div className="text-xs font-mono text-red-300 break-words">
              {this.state.error?.name || 'Error'}: {this.state.error?.message || 'Rendering error'}
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold rounded-xl border border-slate-700"
            >
              Reload Page
            </button>
            <button
              onClick={this.handleReset}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl"
            >
              Reset Session & Rejoin
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
