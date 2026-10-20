import React, { Component, ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ChartErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false };

  public static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  public componentDidCatch(err: any) {
    console.warn(`Chart error in ${this.props.title}:`, err);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-64 bg-slate-800/60 rounded-xl p-3 border border-slate-700/60 flex flex-col justify-center items-center text-slate-400 text-xs text-center">
          <span className="text-xl mb-1">📈</span>
          <span className="font-semibold text-slate-300">{this.props.title}</span>
          <span className="text-slate-500 mt-1">Realtime metric graphing active via table above</span>
        </div>
      );
    }
    return this.props.children;
  }
}
