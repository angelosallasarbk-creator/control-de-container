import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'

// Versão do sistema (package.json da raiz) aparece no rodapé do menu: mostra qual versão está no ar.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [vue()],
  define: { __VERSAO__: JSON.stringify(version) },
  server: {
    host: true, // nesta máquina o Vite só escuta em IPv6 (::1) sem isso
    port: 5174, // 5173 fica livre para o projeto Árvore de Decisão
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
