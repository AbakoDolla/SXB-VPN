import React from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

interface Props {
  children: React.ReactNode;
  resetKey?: string | number;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Erreur attrapée :", error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const isDev = import.meta.env.DEV;

    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
        <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-8 max-w-md w-full">
          <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">
            Une erreur est survenue
          </h2>
          <p className="text-gray-400 text-sm mb-6">
            Cette section a rencontré un problème inattendu. Vous pouvez réessayer ou retourner au tableau de bord.
          </p>
          {isDev && this.state.error && (
            <pre className="text-left bg-black/40 text-red-300 text-xs rounded-lg p-3 mb-6 overflow-auto max-h-40 whitespace-pre-wrap">
              {this.state.error.message}
              {"\n"}
              {this.state.error.stack?.split("\n").slice(1, 6).join("\n")}
            </pre>
          )}
          <div className="flex gap-3 justify-center">
            <button
              onClick={this.handleRetry}
              className="flex items-center gap-2 px-4 py-2 bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-lg text-sm hover:bg-cyan-500/30 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Réessayer
            </button>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.hash = "";
              }}
              className="flex items-center gap-2 px-4 py-2 bg-white/5 text-gray-300 border border-white/10 rounded-lg text-sm hover:bg-white/10 transition-colors"
            >
              <Home className="w-4 h-4" />
              Tableau de bord
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
