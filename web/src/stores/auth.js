import { defineStore } from "pinia";
import { api } from "../api.js";

// usuario: undefined = carregando, null = deslogado, objeto = logado.
// usuario.permissoes vem do servidor (padrão do perfil ou personalizado pelo administrador).
// A tela só esconde botões; quem garante a permissão é a API.
export const useAuthStore = defineStore("auth", {
  state: () => ({ usuario: undefined }),
  getters: {
    pode: (state) => (chave) => Boolean(state.usuario?.permissoes?.includes(chave)),
  },
  actions: {
    async carregar() {
      try {
        this.usuario = await api.me();
      } catch {
        this.usuario = null;
      }
    },
    // Atualização silenciosa (a cada ~30s): permissão liberada/retirada pelo admin aparece sem
    // relogar; conta desativada volta para o login.
    async atualizar() {
      try {
        this.usuario = await api.me();
      } catch (e) {
        if (e.status === 401) this.usuario = null;
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
