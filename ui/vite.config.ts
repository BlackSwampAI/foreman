import { defineConfig } from 'vite';

const backend = 'http://127.0.0.1:4399';

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        // changeOrigin rewrites Host only; the backend also requires Origin to match Host on writes.
        // Rewrite it only for requests that are same-origin with this dev server, so other sites cannot borrow the proxy to pass the backend's CSRF guard.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const host = [req.headers.host].flat()[0], origin = [req.headers.origin].flat()[0], site = [req.headers['sec-fetch-site']].flat()[0];
            let sameOrigin = false;
            try { sameOrigin = !!host && !!origin && new URL(origin).protocol === 'http:' && new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { /* malformed Origin: leave it for the backend to reject */ }
            if (sameOrigin && (!site || site === 'same-origin')) proxyReq.setHeader('origin', backend);
          });
        },
      },
    },
  },
});
