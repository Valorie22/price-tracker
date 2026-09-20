import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Render's free tier sleeps; the first request after a cold start can take ~50s and
      // then succeed. Two retries with a rising delay ride that out instead of showing an
      // error to someone whose backend is simply waking up.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        if (status === 404 || status === 400) return false;
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      staleTime: 20_000,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
