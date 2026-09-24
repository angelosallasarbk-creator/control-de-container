// Dados de EXEMPLO para desenvolvimento local. Recusa rodar se já houver containers no banco,
// para nunca misturar exemplo com dado real.
import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "./lib/prisma.js";
import { sincronizarTodos } from "./lib/alertas.js";
import { calcularDigitoVerificador } from "./lib/iso6346.js";

const HORA = 60 * 60 * 1000;
const agora = Date.now();
const atras = (horas) => new Date(agora - horas * HORA);

function numeroValido(prefixo, serie) {
  const base = `${prefixo}${String(serie).padStart(6, "0")}`;
  return base + calcularDigitoVerificador(base);
}

if ((await prisma.container.count()) > 0) {
  console.error("Seed abortado: já existem containers no banco. O seed é só para banco vazio de desenvolvimento.");
  process.exit(1);
}

const senhaHash = await bcrypt.hash("demo12345", 10);
for (const [email, nome, perfil] of [
  ["admin@demo.local", "Admin Demo", "ADMIN"],
  ["supervisor@demo.local", "Supervisor Demo", "SUPERVISOR"],
  ["operador@demo.local", "Operador Demo", "OPERADOR"],
  ["visualizacao@demo.local", "Visualização Demo", "VISUALIZACAO"],
]) {
  await prisma.usuario.upsert({ where: { email }, create: { email, nome, perfil, senhaHash }, update: {} });
}

const g1 = await prisma.grupoOperacao.create({ data: { cliente: "Cliente Alfa", fabrica: "Fábrica 1", metaEstadiaHoras: 24, alertaEstadiaHoras: 6 } });
const g2 = await prisma.grupoOperacao.create({ data: { cliente: "Cliente Beta", fabrica: "Fábrica 1", metaEstadiaHoras: 48, alertaEstadiaHoras: 8, custoEstadiaPorHora: 150 } });
const g3 = await prisma.grupoOperacao.create({ data: { cliente: "Cliente Gama", fabrica: "Fábrica 2", metaEstadiaHoras: 36, alertaEstadiaHoras: 6 } });

const a1 = await prisma.armador.create({ data: { nome: "Armador Exemplo A", freeTimeDias: 7, valorDiaria: 120, moeda: "USD", alertaDemurrageDias: 2 } });
const a2 = await prisma.armador.create({ data: { nome: "Armador Exemplo B", freeTimeDias: 10, valorDiaria: 95, moeda: "USD", alertaDemurrageDias: 3 } });

const congelado = await prisma.produto.create({ data: { nome: "Congelado (-18°C)", setpoint: -18, tempMin: -22, tempMax: -16, toleranciaMinutos: 30 } });
const resfriado = await prisma.produto.create({ data: { nome: "Resfriado (+2°C)", setpoint: 2, tempMin: 0, tempMax: 4, toleranciaMinutos: 30 } });

function prazos(grupo, armador, produto) {
  return {
    grupoId: grupo.id, armadorId: armador.id, produtoId: produto?.id ?? null,
    metaEstadiaHoras: grupo.metaEstadiaHoras, alertaEstadiaHoras: grupo.alertaEstadiaHoras, custoEstadiaPorHora: grupo.custoEstadiaPorHora,
    freeTimeDias: armador.freeTimeDias, valorDiaria: armador.valorDiaria, moeda: armador.moeda, alertaDemurrageDias: armador.alertaDemurrageDias,
    setpoint: produto?.setpoint ?? null, tempMin: produto?.tempMin ?? null, tempMax: produto?.tempMax ?? null, toleranciaMinutos: produto?.toleranciaMinutos ?? null,
    criadoPor: "seed",
  };
}

// Cenários variados para ver todos os semáforos no painel.
const cenarios = [
  { numero: numeroValido("DEMU", 100001), tipo: "REEFER_40", status: "EM_OPERACAO", ...prazos(g1, a1, congelado), posicaoPatio: "A-01",
    coletadoEm: atras(30), chegadaFabricaEm: atras(20), inicioOperacaoEm: atras(3), leituras: [[-18.5, 3], [-18.1, 2], [-17.6, 1]] },
  { numero: numeroValido("DEMU", 100002), tipo: "REEFER_40", status: "LIBERADO", ...prazos(g1, a1, congelado), posicaoPatio: "A-02",
    coletadoEm: atras(24 * 8), chegadaFabricaEm: atras(30), inicioOperacaoEm: atras(8), liberadoEm: atras(2), leituras: [[-18.2, 8], [-15.1, 1.5], [-14.8, 0.5]] },
  { numero: numeroValido("DEMU", 100003), tipo: "DRY_40", status: "NA_FABRICA", ...prazos(g2, a2, null), posicaoPatio: "B-05",
    coletadoEm: atras(60), chegadaFabricaEm: atras(42) },
  { numero: numeroValido("DEMU", 100004), tipo: "HC_40", status: "COLETADO", ...prazos(g2, a2, null), coletadoEm: atras(5) },
  { numero: numeroValido("DEMU", 100005), tipo: "REEFER_20", status: "NA_FABRICA", ...prazos(g3, a1, resfriado), posicaoPatio: "C-03",
    coletadoEm: atras(24 * 6), chegadaFabricaEm: atras(4) },
  { numero: numeroValido("DEMU", 100006), tipo: "DRY_20", status: "PROGRAMADO", ...prazos(g3, a2, null), deadline: new Date(agora + 20 * HORA) },
];

for (const { leituras = [], ...dados } of cenarios) {
  const c = await prisma.container.create({ data: dados });
  const etapas = [["COLETADO", "coletadoEm"], ["NA_FABRICA", "chegadaFabricaEm"], ["EM_OPERACAO", "inicioOperacaoEm"], ["LIBERADO", "liberadoEm"]];
  let anterior = "PROGRAMADO";
  await prisma.eventoContainer.create({ data: { containerId: c.id, statusPara: "PROGRAMADO", ocorridoEm: atras(24 * 9), usuarioEmail: "seed" } });
  for (const [status, campo] of etapas) {
    if (!dados[campo]) break;
    await prisma.eventoContainer.create({ data: { containerId: c.id, statusDe: anterior, statusPara: status, ocorridoEm: dados[campo], usuarioEmail: "seed" } });
    anterior = status;
  }
  for (const [temperatura, horasAtras] of leituras) {
    await prisma.leituraTemperatura.create({ data: { containerId: c.id, temperatura, lidaEm: atras(horasAtras), origem: "MANUAL", fonte: "seed" } });
  }
}

const r = await sincronizarTodos();
console.log(`Seed concluído: ${cenarios.length} containers de exemplo, ${r.abertos} alerta(s) aberto(s).`);
console.log("Logins de demonstração (senha demo12345): admin@demo.local, supervisor@demo.local, operador@demo.local, visualizacao@demo.local");
await prisma.$disconnect();
