import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { AuthProvider } from '@/auth/AuthProvider';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';
import { ThemeProvider } from '@/lib/theme';
import { ApiError } from '@/api/client';
import './index.css';

/**
 * Application entry point.
 *
 * QUERY CLIENT DEFAULTS ARE TUNED FOR A CONTROL-ROOM DASHBOARD, not a content site.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * Zero stale time.
       *
       * Standard advice is to set a generous stale time to avoid refetching. That advice
       * assumes data whose age does not matter. Here a two-minute-old capacity figure is
       * not merely unhelpful — it can be actively misleading during an incident. Individual
       * queries opt IN to caching where the data genuinely is slow-moving.
       */
      staleTime: 0,

      /** Keep the previous page rendered while a background refetch runs. */
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,

      retry: (failureCount, error) => {
        // Never retry a rejection the server will keep rejecting: a 401 is handled by the
        // refresh interceptor, and a 403 or 422 will not change on a second attempt.
        if (error instanceof ApiError) {
          if (error.status === 401 || error.status === 403 || error.status === 404) return false;
          if (error.status >= 400 && error.status < 500) return false;
        }
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    },

    mutations: {
      // A mutation that changes network allocation must never be retried automatically —
      // a duplicate degradation is far worse than a visible failure the operator can repeat.
      retry: false,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            {/* Inside AuthProvider: the socket needs a session token to connect. */}
            <RealtimeProvider>
              <App />
            </RealtimeProvider>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
