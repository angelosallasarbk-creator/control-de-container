import { defineStore } from "pinia";
import { api } from "../api.js";

// Mesmas regras do backend (src/lib/auth.js → PERMISSOES). A tela só esconde botões;
// quem garante a permissão é a API.
const PODE = {
  cadastros: ["ADMIN", "SUPERVISOR"],
  operar: ["ADMIN", "SUPERVISOR", "OPERADOR"],
  administrar: ["ADMIN"],
};

// usuario: undefined = carregando, null = deslogado, objeto = logado.
export const useAuthStore = defineStore("auth", {
  state: () => ({ usuario: undefined }),
  getters: {
    pode: (state) => (acao) => Boolean(state.usuario && PODE[acao]?.includes(state.usuario.perfil)),
  },
  actions: {
    async carregar() {
      try {
        this.usuario = await api.me();
      } catch {
        this.usuario = null;
      }
    },
    async login(email, senha) {
      this.usuario = await api.login(email, senha);
    },
    async logout() {
      try {
        await api.logout();
      } catch {
        // desloga localmente mesmo com erro de rede
      }
      this.usuario = null;
    },
  },
});
