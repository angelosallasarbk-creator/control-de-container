// Registro de leitura de temperatura — um só caminho para a ficha (manual) e o celular (QR),
// para as validações serem as mesmas nos dois.
import { prisma } from "./prisma.js";
import { erroHttp } from "./asyncHandler.js";
import { registrarLog } from "./auditoria.js";
import { sincronizarAlertas } from "./alertas.js";
import { ehReefer, STATUS_ENCERRADOS } from "./prazos.js";

const FOLGA_FUTURO_MS = 5 * 60 * 1000;
// Leitura digitada com horário mais de 2h antes do momento em que chegou ao sistema: fica
// sinalizada como "lançada com atraso" (o dado vale, mas quem audita vê que não foi na hora).
export const LIMITE_ATRASO_MIN = 120;

export function minutosDeAtraso(leitura) {
  return Math.round((new Date(leitura.registradaEm) - new Date(leitura.lidaEm)) / 60000);
}

/**
 * container: registro do banco. Lança erro 4xx com mensagem para o usuário se algo não bate.
 * extras: { etiquetaId, latitude, longitude, precisaoM } (leitura pelo QR).
 */
export async function registrarLeitura({ container, temperatura, lidaEm, origem, usuarioEmail, extras = {} }, cliente = prisma) {
  if (!ehReefer(container.tipo)) throw erroHttp(400, "Leitura de temperatura só se aplica a container reefer.");
  if (STATUS_ENCERRADOS.includes(container.status)) throw erroHttp(409, "Container encerrado não recebe novas leituras.");
  if (lidaEm.getTime() > Date.now() + FOLGA_FUTURO_MS) throw erroHttp(400, "O horário da leitura não pode estar no futuro.");
  const inicio = container.coletadoEm ?? container.criadoEm;
  if (inicio && lidaEm < new Date(inicio)) {
    throw erroHttp(400, `O horário da leitura é anterior à ${container.coletadoEm ? "coleta" : "criação"} do container (${new Date(inicio).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}).`);
  }
  try {
    const leitura = await cliente.leituraTemperatura.create({
      data: {
        containerId: container.id,
        temperatura,
        lidaEm,
        origem,
        fonte: usuarioEmail,
        etiquetaId: extras.etiquetaId ?? null,
        latitude: extras.latitude ?? null,
        longitude: extras.longitude ?? null,
        precisaoM: extras.precisaoM ?? null,
      },
    });
    await registrarLog(
      {
        usuarioEmail,
        acao: "LEITURA",
        entidade: "Container",
        entidadeId: container.id,
        descricao: `Container ${container.numero}: leitura ${origem === "QRCODE" ? "pelo QR" : "manual"} ${Number(temperatura).toFixed(1)}°C`,
      },
      cliente
    );
    return leitura;
  } catch (err) {
    if (err.code === "P2002") throw erroHttp(409, "Já existe uma leitura registrada nesse mesmo horário para este container.");
    throw err;
  }
}

export { sincronizarAlertas };
