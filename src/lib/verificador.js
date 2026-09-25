import { sincronizarTodos } from "./alertas.js";
import { prisma } from "./prisma.js";
import { STATUS_ENCERRADOS } from "./prazos.js";
import { garantirDistancias, paresDoContainer } from "./rotas.js";

// Calcula (e guarda) as distâncias que ainda faltam para os containers ativos — ex.: local
// que ganhou coordenadas depois, ou estimativa em linha reta a ser trocada pela rota real.
async function completarDistancias() {
  const ativos = await prisma.container.findMany({
    where: { status: { notIn: STATUS_ENCERRADOS } },
    select: { portoRetiradaId: true, localCarregamentoId: true, portoEntregaId: true },
  });
  await garantirDistancias(ativos.flatMap(paresDoContainer));
}

let rodando = false;

// Roda a varredura de prazos sem sobrepor execuções (se uma demorar mais que o intervalo,
// a próxima é pulada em vez de rodar em paralelo).
export async function executarVerificacao() {
  if (rodando) return null;
  rodando = true;
  const inicio = Date.now();
  try {
    await completarDistancias().catch((err) => console.error("Verificador: falha ao completar distâncias:", err.message));
    const r = await sincronizarTodos();
    if (r.abertos || r.encerrados) {
      console.log(
        `Verificador: ${r.containers} container(s), ${r.abertos} alerta(s) aberto(s), ${r.encerrados} encerrado(s) em ${Date.now() - inicio}ms.`
      );
    }
    return r;
  } catch (err) {
    console.error("Verificador: falha na varredura:", err);
    return null;
  } finally {
    rodando = false;
  }
}

export function iniciarVerificador() {
  const minutos = Number(process.env.VERIFICADOR_INTERVALO_MINUTOS) || 5;
  executarVerificacao();
  return setInterval(executarVerificacao, minutos * 60 * 1000);
}
