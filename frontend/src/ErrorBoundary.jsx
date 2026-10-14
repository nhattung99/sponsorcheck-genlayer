import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="crash-screen">
          <div className="crash-card">
            <div className="crash-icon">
              <AlertTriangle size={28} />
            </div>
            <h2>Something broke in the UI</h2>
            <p>SponsorCheck caught the error so the page does not go blank. Reload to continue.</p>
            {this.state.error && (
              <pre className="crash-detail">{String(this.state.error)}</pre>
            )}
            <button className="btn-primary" onClick={this.handleReset}>
              <RefreshCw size={16} /> Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
