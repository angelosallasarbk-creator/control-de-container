import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true, // nesta máquina o Vite só escuta em IPv6 (::1) sem isso
    port: 5174, // 5173 fica livre para o projeto Árvore de Decisão
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
