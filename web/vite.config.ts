import { defineConfig } from 'vite';

/**
 * Configuração do frontend.
 *
 * O proxy de `/api` para o backend é o que torna tudo **same-origin** do ponto de
 * vista do navegador: o cookie de sessão viaja normalmente e não é preciso
 * configurar CORS no Fastify — uma dependência e uma superfície de erro a menos.
 *
 * `rewrite` remove o prefixo porque o backend serve as rotas na raiz (`/accounts`,
 * não `/api/accounts`).
 */
export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3333',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    // O Fastify serve daqui em produção.
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
