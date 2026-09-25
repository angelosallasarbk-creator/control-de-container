// Testes de API contra um banco PostgreSQL SEPARADO de teste (zerado a cada execução).
// Requer o Postgres local (docker compose up -d). Nunca aponte TEST_DATABASE_URL para dado real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import bcrypt from "bcryptjs";
import request from "supertest";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://container_user:container_pass_dev@localhost:5433/controle_container_test";
if (!/_test(\?|$)/.test(TEST_DATABASE_URL)) {
  throw new Error("TEST_DATABASE_URL precisa apontar para um banco cujo nome termina em _test (o teste apaga tudo).");
}
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET ??= "segredo-apenas-para-teste";
// Testes nunca chamam o serviço de rota externo: sem chave, distância = linha reta × fator.
process.env.ORS_API_KEY = "";

let app, prisma, sincronizarTodos;
const agentes = {};

async function logar(email) {
  const agente = request.agent(app);
  const r = await agente.post("/api/auth/login").send({ email, senha: "senha-teste-123" });
  assert.equal(r.status, 200, `login de ${email} falhou`);
  return agente;
}

before(async () => {
  execSync("npx prisma migrate reset --force --skip-seed", { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: "ignore" });
  ({ prisma } = await import("./lib/prisma.js"));
  ({ sincronizarTodos } = await import("./lib/alertas.js"));
  const { criarApp } = await import("./app.js");
  app = criarApp();

  // Admin inicial por variável de ambiente: cria só com o banco vazio; depois é ignorado.
  const { criarAdminInicialSeNecessario } = await import("./lib/adminInicial.js");
  const envAdmin = { ADMIN_INICIAL_EMAIL: " Chefe@Teste.local ", ADMIN_INICIAL_SENHA: "senha-inicial-123", ADMIN_INICIAL_NOME: "Chefe" };
  assert.equal(await criarAdminInicialSeNecessario({ ...envAdmin, ADMIN_INICIAL_SENHA: "curta" }), null, "senha curta não cria");
  const inicial = await criarAdminInicialSeNecessario(envAdmin);
  assert.equal(inicial?.email, "chefe@teste.local");
  assert.equal(inicial?.perfil, "ADMIN");
  assert.equal(await criarAdminInicialSeNecessario({ ...envAdmin, ADMIN_INICIAL_EMAIL: "outro@teste.local" }), null, "com usuários, ignora");
  assert.equal(await prisma.usuario.count(), 1);

  const senhaHash = await bcrypt.hash("senha-teste-123", 4);
  for (const perfil of ["ADMIN", "SUPERVISOR", "OPERADOR", "VISUALIZACAO"]) {
    await prisma.usuario.create({ data: { email: `${perfil.toLowerCase()}@teste.local`, nome: perfil, perfil, senhaHash } });
    agentes[perfil] = await logar(`${perfil.toLowerCase()}@teste.local`);
  }
});

after(async () => {
  await prisma?.$disconnect();
});

const ids = {};

test("sem login a API responde 401; login errado não revela se o e-mail existe", async () => {
  assert.equal((await request(app).get("/api/painel")).status, 401);
  const r = await request(app).post("/api/auth/login").send({ email: "admin@teste.local", senha: "errada" });
  assert.equal(r.status, 401);
  assert.equal(r.body.erro, "E-mail ou senha inválidos.");
});

test("cadastros: supervisor cria; operador não pode", async () => {
  const negado = await agentes.OPERADOR.post("/api/grupos").send({ cliente: "X", fabrica: "Y", metaEstadiaHoras: 10 });
  assert.equal(negado.status, 403);

  const g = await agentes.SUPERVISOR.post("/api/grupos").send({ cliente: "Cliente T", fabrica: "Fábrica T", metaEstadiaHoras: 24, alertaEstadiaHoras: 4 });
  assert.equal(g.status, 201);
  ids.grupo = g.body.id;
  const a = await agentes.SUPERVISOR.post("/api/armadores").send({ nome: "Armador T", freeTimeDias: 7, valorDiaria: "120,50" });
  assert.equal(a.status, 201);
  assert.equal(a.body.valorDiaria, 120.5);
  ids.armador = a.body.id;
  const p = await agentes.SUPERVISOR.post("/api/produtos").send({ nome: "Congelado T", setpoint: -18, tempMin: -22, tempMax: -16, toleranciaMinutos: 30 });
  assert.equal(p.status, 201);
  ids.produto = p.body.id;

  const faixaInvalida = await agentes.SUPERVISOR.post("/api/produtos").send({ nome: "Ruim", setpoint: 0, tempMin: 5, tempMax: -5 });
  assert.equal(faixaInvalida.status, 400);
  const duplicado = await agentes.SUPERVISOR.post("/api/armadores").send({ nome: "Armador T", freeTimeDias: 7, valorDiaria: 1 });
  assert.equal(duplicado.status, 409);
});

test("regiões: a região é da fábrica — herda na criação, propaga na alteração, não exclui em uso", async () => {
  assert.equal((await agentes.OPERADOR.post("/api/regioes").send({ nome: "Sul" })).status, 403);
  const sul = await agentes.SUPERVISOR.post("/api/regioes").send({ nome: "Sul" });
  assert.equal(sul.status, 201);
  const norte = await agentes.SUPERVISOR.post("/api/regioes").send({ nome: "Norte" });
  assert.equal((await agentes.SUPERVISOR.post("/api/regioes").send({ nome: "Sul" })).status, 409, "nome duplicado");

  // Segundo cliente da mesma "Fábrica T", ainda sem região.
  const g2 = await agentes.SUPERVISOR.post("/api/grupos").send({ cliente: "Cliente U", fabrica: "Fábrica T", metaEstadiaHoras: 12 });
  assert.equal(g2.body.regiaoId, null);

  // Definir a região em um cliente aplica a todos os clientes da mesma fábrica.
  const alterado = await agentes.SUPERVISOR.patch(`/api/grupos/${ids.grupo}`).send({ regiaoId: sul.body.id });
  assert.equal(alterado.status, 200);
  assert.equal(alterado.body.regiao.nome, "Sul");
  assert.equal(alterado.body.propagados, 1);
  assert.equal((await prisma.grupoOperacao.findUnique({ where: { id: g2.body.id } })).regiaoId, sul.body.id);

  // Novo cliente da mesma fábrica (mesmo com maiúsculas diferentes) herda a região.
  const g3 = await agentes.SUPERVISOR.post("/api/grupos").send({ cliente: "Cliente V", fabrica: "fábrica t", metaEstadiaHoras: 12 });
  assert.equal(g3.body.regiaoId, sul.body.id);

  assert.equal((await agentes.SUPERVISOR.patch(`/api/grupos/${ids.grupo}`).send({ regiaoId: 999999 })).status, 400, "região inexistente");
  assert.equal((await agentes.SUPERVISOR.delete(`/api/regioes/${sul.body.id}`)).status, 409, "região com fábricas");
  assert.equal((await agentes.SUPERVISOR.delete(`/api/regioes/${norte.body.id}`)).status, 204);

  const regioes = await agentes.VISUALIZACAO.get("/api/regioes");
  assert.equal(regioes.body.find((r) => r.nome === "Sul").emUso, 3);
  const painel = await agentes.VISUALIZACAO.get("/api/painel");
  assert.deepEqual(painel.body.regioes.map((r) => r.nome), ["Sul"]);
  assert.equal(painel.body.grupos.find((g) => g.id === ids.grupo).regiao.nome, "Sul");
});

test("container: valida número, dígito verificador, reefer sem produto e duplicidade", async () => {
  const base = { tipo: "REEFER_40", grupoId: ids.grupo, armadorId: ids.armador, produtoId: ids.produto };
  assert.equal((await agentes.VISUALIZACAO.post("/api/containers").send({ ...base, numero: "CSQU3054383" })).status, 403);
  assert.equal((await agentes.OPERADOR.post("/api/containers").send({ ...base, numero: "ABC123" })).status, 400);

  const digito = await agentes.OPERADOR.post("/api/containers").send({ ...base, numero: "CSQU3054384" });
  assert.equal(digito.status, 422);
  assert.equal(digito.body.codigo, "DIGITO_INVALIDO");

  const semProduto = await agentes.OPERADOR.post("/api/containers").send({ ...base, produtoId: null, numero: "CSQU3054383" });
  assert.equal(semProduto.status, 400);

  const criado = await agentes.OPERADOR.post("/api/containers").send({ ...base, numero: "csqu 305438 3" });
  assert.equal(criado.status, 201);
  assert.equal(criado.body.numero, "CSQU3054383");
  assert.equal(criado.body.status, "PROGRAMADO");
  assert.equal(criado.body.freeTimeDias, 7, "prazo copiado do armador");
  assert.equal(criado.body.tempMax, -16, "faixa copiada do produto");
  ids.reefer = criado.body.id;

  const repetido = await agentes.OPERADOR.post("/api/containers").send({ ...base, numero: "CSQU3054383" });
  assert.equal(repetido.status, 409);
});

test("etapas: avança em sequência, rejeita data anterior à etapa anterior e etapa desatualizada", async () => {
  const url = `/api/containers/${ids.reefer}/avancar`;
  const coleta = new Date(Date.now() - 10 * 3600e3);
  let r = await agentes.OPERADOR.post(url).send({ statusPara: "COLETADO", ocorridoEm: coleta });
  assert.equal(r.status, 200);
  assert.equal(r.body.situacao.demurrage.diasRestantes >= 5, true);

  r = await agentes.OPERADOR.post(url).send({ statusPara: "NA_FABRICA", ocorridoEm: new Date(coleta.getTime() - 3600e3) });
  assert.equal(r.status, 400, "chegada antes da coleta");

  r = await agentes.OPERADOR.post(url).send({ statusPara: "EM_OPERACAO" });
  assert.equal(r.status, 409, "pular etapa");

  r = await agentes.OPERADOR.post(url).send({ statusPara: "NA_FABRICA", ocorridoEm: new Date(Date.now() - 2 * 3600e3) });
  assert.equal(r.status, 200);
  assert.equal(r.body.situacao.estadia.situacao, "OK");

  r = await agentes.OPERADOR.post(url).send({ statusPara: "EM_OPERACAO", ocorridoEm: new Date(Date.now() - 3600e3) });
  assert.equal(r.status, 200);
  assert.equal(r.body.eventos.length, 4);
});

test("desfazer: supervisor volta a última etapa; operador não pode", async () => {
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${ids.reefer}/desfazer`)).status, 403);
  const r = await agentes.SUPERVISOR.post(`/api/containers/${ids.reefer}/desfazer`);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "NA_FABRICA");
  assert.equal(r.body.inicioOperacaoEm, null);
  const again = await agentes.OPERADOR.post(`/api/containers/${ids.reefer}/avancar`).send({ statusPara: "EM_OPERACAO", ocorridoEm: new Date(Date.now() - 3600e3) });
  assert.equal(again.status, 200);
});

test("temperatura manual: fora da faixa abre alerta uma única vez; voltar à faixa encerra", async () => {
  const url = `/api/containers/${ids.reefer}/leituras`;
  let r = await agentes.OPERADOR.post(url).send({ temperatura: "-14,5", lidaEm: new Date(Date.now() - 5 * 60e3) });
  assert.equal(r.status, 201);
  let abertos = await prisma.alerta.findMany({ where: { containerId: ids.reefer, tipo: "TEMPERATURA", chaveAberta: { not: null } } });
  assert.equal(abertos.length, 1);
  assert.equal(abertos[0].nivel, "ATENCAO");

  // Verificador rodando várias vezes não duplica.
  await sincronizarTodos();
  await sincronizarTodos();
  abertos = await prisma.alerta.findMany({ where: { containerId: ids.reefer, tipo: "TEMPERATURA", chaveAberta: { not: null } } });
  assert.equal(abertos.length, 1);

  const repetida = await agentes.OPERADOR.post(url).send({ temperatura: -14.5, lidaEm: r.body.leituras.at(-1).lidaEm });
  assert.equal(repetida.status, 409, "mesma leitura não duplica");

  r = await agentes.OPERADOR.post(url).send({ temperatura: -18, lidaEm: new Date() });
  assert.equal(r.status, 201);
  abertos = await prisma.alerta.findMany({ where: { containerId: ids.reefer, tipo: "TEMPERATURA", chaveAberta: { not: null } } });
  assert.equal(abertos.length, 0);
  const historico = await prisma.alerta.findMany({ where: { containerId: ids.reefer, tipo: "TEMPERATURA" } });
  assert.equal(historico.length, 1);
  assert.notEqual(historico[0].encerradoEm, null);
});

test("integração: exige token, grava, ignora reenvio e rejeita container desconhecido", async () => {
  assert.equal((await request(app).post("/api/integracao/temperaturas").send({ leituras: [] })).status, 401);
  assert.equal((await agentes.SUPERVISOR.post("/api/tokens").send({ nome: "Sensor" })).status, 403);

  const t = await agentes.ADMIN.post("/api/tokens").send({ nome: "Sensor pátio" });
  assert.equal(t.status, 201);
  const auth = { Authorization: `Bearer ${t.body.token}` };
  const lidaEm = new Date(Date.now() - 60e3).toISOString();
  const corpo = {
    leituras: [
      { container: "CSQU3054383", temperatura: -17.9, lidaEm },
      { container: "ABCU0000000", temperatura: -18, lidaEm },
      { container: "CSQU3054383", temperatura: "x", lidaEm },
    ],
  };
  let r = await request(app).post("/api/integracao/temperaturas").set(auth).send(corpo);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.gravadas, r.body.duplicadas, r.body.rejeitadas], [1, 0, 2]);

  r = await request(app).post("/api/integracao/temperaturas").set(auth).send(corpo);
  assert.deepEqual([r.body.gravadas, r.body.duplicadas], [0, 1]);

  await agentes.ADMIN.post(`/api/tokens/${t.body.id}/revogar`);
  assert.equal((await request(app).post("/api/integracao/temperaturas").set(auth).send(corpo)).status, 401);
});

test("alertas: reconhecer exige ação tomada e só acontece uma vez", async () => {
  // Estoura a meta de estadia (24h) ajustando a meta do container para 1h (só supervisor pode).
  assert.equal((await agentes.OPERADOR.patch(`/api/containers/${ids.reefer}`).send({ metaEstadiaHoras: 1 })).status, 403);
  const r = await agentes.SUPERVISOR.patch(`/api/containers/${ids.reefer}`).send({ metaEstadiaHoras: 1 });
  assert.equal(r.status, 200);
  const alerta = await prisma.alerta.findFirst({ where: { containerId: ids.reefer, tipo: "ESTADIA", chaveAberta: { not: null } } });
  assert.equal(alerta.nivel, "CRITICO");

  assert.equal((await agentes.OPERADOR.post(`/api/alertas/${alerta.id}/reconhecer`).send({})).status, 400);
  assert.equal((await agentes.OPERADOR.post(`/api/alertas/${alerta.id}/reconhecer`).send({ acaoTomada: "Liguei para a doca" })).status, 200);
  assert.equal((await agentes.OPERADOR.post(`/api/alertas/${alerta.id}/reconhecer`).send({ acaoTomada: "de novo" })).status, 409);

  const resumo = await agentes.VISUALIZACAO.get("/api/alertas/resumo");
  assert.equal(resumo.status, 200);
  assert.equal(resumo.body.criticosNaoReconhecidos.some((a) => a.id === alerta.id), false);
});

test("painel agrupa por Cliente / Fábrica e a entrega no porto encerra todos os alertas", async () => {
  const painel = await agentes.VISUALIZACAO.get("/api/painel");
  assert.equal(painel.status, 200);
  const grupo = painel.body.grupos.find((g) => g.id === ids.grupo);
  assert.equal(grupo.containers.length, 1);
  assert.equal(grupo.containers[0].semaforo, "VERMELHO");

  for (const statusPara of ["LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO"]) {
    const r = await agentes.OPERADOR.post(`/api/containers/${ids.reefer}/avancar`).send({ statusPara });
    assert.equal(r.status, 200, statusPara);
  }
  const abertos = await prisma.alerta.count({ where: { containerId: ids.reefer, chaveAberta: { not: null } } });
  assert.equal(abertos, 0);
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${ids.reefer}/avancar`).send({})).status, 409);

  // Com a passagem encerrada, o mesmo número pode ser cadastrado de novo (nova exportação).
  const novo = await agentes.OPERADOR.post("/api/containers").send({ numero: "CSQU3054383", tipo: "DRY_40", grupoId: ids.grupo, armadorId: ids.armador });
  assert.equal(novo.status, 201);
});

test("custo estimado: estadia excedida aparece por dia e no detalhamento; valida período; cotação", async () => {
  // O reefer do teste ficou com meta de 1h e passou ~1h na fábrica antes de ser entregue.
  const r = await agentes.VISUALIZACAO.get("/api/custos");
  assert.equal(r.status, 200);
  const det = r.body.containers.find((c) => c.id === ids.reefer);
  assert.ok(det, "container com estadia excedida entra no detalhamento");
  assert.ok(det.estadiaHoras > 0);
  assert.equal(det.semCustoHora, true, "grupo sem custo/h → horas sem valor");
  assert.equal(det.estadiaValor, 0);
  assert.ok(r.body.dias.some((d) => d.grupoId === ids.grupo && d.estadiaHoras > 0));
  assert.equal(r.body.grupos.find((g) => g.id === ids.grupo).regiao.nome, "Sul");
  assert.equal(r.body.cotacoes.USD, null);

  // Custo/h cadastrado depois: supervisor ajusta no container e o custo passa a ter valor.
  assert.equal((await agentes.OPERADOR.patch(`/api/containers/${ids.reefer}`).send({ custoEstadiaPorHora: 100 })).status, 403);
  assert.equal((await agentes.SUPERVISOR.patch(`/api/containers/${ids.reefer}`).send({ custoEstadiaPorHora: "100,00" })).status, 200);
  const comValor = (await agentes.VISUALIZACAO.get("/api/custos")).body.containers.find((c) => c.id === ids.reefer);
  assert.equal(comValor.semCustoHora, false);
  assert.ok(comValor.estadiaValor > 0);

  assert.equal((await agentes.VISUALIZACAO.get("/api/custos?de=2026-13-01")).status, 400);
  assert.equal((await agentes.VISUALIZACAO.get("/api/custos?de=2026-09-10&ate=2026-09-01")).status, 400);
  assert.equal((await agentes.VISUALIZACAO.get("/api/custos?de=2020-01-01&ate=2026-09-01")).status, 400, "período máximo");
  const antigo = await agentes.VISUALIZACAO.get("/api/custos?de=2020-01-01&ate=2020-01-31");
  assert.equal(antigo.body.containers.length, 0, "período sem operação");

  assert.equal((await agentes.SUPERVISOR.put("/api/configuracao").send({ intervaloLeituraMinutos: 240, cotacaoUSD: 5.4 })).status, 403);
  const cfg = await agentes.ADMIN.put("/api/configuracao").send({ intervaloLeituraMinutos: 240, cotacaoUSD: "5,40" });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.cotacaoUSD, 5.4);
  assert.equal((await agentes.VISUALIZACAO.get("/api/custos")).body.cotacoes.USD, 5.4);
});

test("editar cadastro: aplicar aos containers em andamento é opcional e nunca mexe em entregues", async () => {
  const lista = await agentes.SUPERVISOR.get("/api/armadores");
  assert.equal(lista.body.find((a) => a.id === ids.armador).emAndamento, 1, "só o container novo está em andamento");
  const ativo = await prisma.container.findFirst({ where: { armadorId: ids.armador, status: { notIn: ["ENTREGUE_PORTO", "CANCELADO"] } } });

  // Sem marcar a opção: container em andamento mantém o valor antigo.
  let r = await agentes.SUPERVISOR.patch(`/api/armadores/${ids.armador}`).send({ freeTimeDias: 12 });
  assert.equal(r.body.containersAtualizados, 0);
  assert.equal((await prisma.container.findUnique({ where: { id: ativo.id } })).freeTimeDias, 7);

  // Marcando: aplica os valores ATUAIS do cadastro (mesmo que já tivessem sido alterados antes).
  r = await agentes.SUPERVISOR.patch(`/api/armadores/${ids.armador}`).send({ valorDiaria: 200, aplicarEmAndamento: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.containersAtualizados, 1);
  const depois = await prisma.container.findUnique({ where: { id: ativo.id } });
  assert.equal(depois.freeTimeDias, 12);
  assert.equal(Number(depois.valorDiaria), 200);
  const entregue = await prisma.container.findUnique({ where: { id: ids.reefer } });
  assert.equal(entregue.freeTimeDias, 7, "entregue preserva o histórico");
  assert.equal(Number(entregue.valorDiaria), 120.5);
});

test("cadastro usado não pode ser excluído (só desativado)", async () => {
  assert.equal((await agentes.SUPERVISOR.delete(`/api/armadores/${ids.armador}`)).status, 409);
  const r = await agentes.SUPERVISOR.patch(`/api/armadores/${ids.armador}`).send({ ativo: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.ativo, false);
});

test("etiquetas QR: gerar, ligar ao container, ler, substituir, encerrar e ZPL", async () => {
  // Gerar lote: só supervisor/admin.
  assert.equal((await agentes.VISUALIZACAO.post("/api/etiquetas/lotes").send({ quantidade: 2 })).status, 403);
  assert.equal((await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 0 })).status, 400);
  const lote = await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 3 });
  assert.equal(lote.status, 201);
  assert.equal(lote.body.etiquetas.length, 3);
  const [e1, e2, e3] = lote.body.etiquetas;
  assert.match(e1.codigo, /^CC-[2-9A-HJKMNP-Z]{6}$/);
  assert.equal(e1.estado, "LIVRE");

  assert.equal((await agentes.OPERADOR.get("/api/qr/token-invalido")).status, 404);
  assert.equal((await agentes.OPERADOR.get(`/api/qr/${"x".repeat(22)}`)).status, 404);
  assert.equal((await request(app).get(`/api/qr/${e1.token}`)).status, 401, "exige login");
  const aberta = await agentes.OPERADOR.get(`/api/qr/${e1.token}`);
  assert.equal(aberta.body.etiqueta.estado, "LIVRE");
  assert.equal(aberta.body.podeRegistrar, true);
  assert.equal((await agentes.VISUALIZACAO.get(`/api/qr/${e1.token}`)).body.podeRegistrar, false);

  // Container reefer ativo para ligar.
  const armador = await agentes.SUPERVISOR.post("/api/armadores").send({ nome: "Armador QR", freeTimeDias: 10, valorDiaria: 100 });
  const coleta = new Date(Date.now() - 6 * 3600e3);
  const cont = await agentes.OPERADOR.post("/api/containers").send({
    numero: "TGHU9876543", confirmarDigito: true, tipo: "REEFER_40", grupoId: ids.grupo, armadorId: armador.body.id, produtoId: ids.produto, coletadoEm: coleta,
  });
  assert.equal(cont.status, 201);

  assert.equal((await agentes.VISUALIZACAO.post(`/api/qr/${e1.token}/vincular`).send({ numero: "TGHU9876543", temperatura: -18 })).status, 403);
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e1.token}/vincular`).send({ numero: "ABCU1234567", temperatura: -18 })).status, 404, "container não ativo");
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e1.token}/vincular`).send({ numero: "TGHU9876543" })).status, 400, "reefer exige temperatura");
  const ligada = await agentes.OPERADOR.post(`/api/qr/${e1.token}/vincular`).send({ numero: "tghu 987654 3", temperatura: "-18,2", latitude: -23.95, longitude: -46.31, precisaoM: 12 });
  assert.equal(ligada.status, 201);
  assert.equal(ligada.body.etiqueta.estado, "VINCULADA");
  assert.equal(ligada.body.container.numero, "TGHU9876543");
  assert.equal(ligada.body.resultado, "OK");
  const leitura = await prisma.leituraTemperatura.findFirst({ where: { containerId: cont.body.id }, orderBy: { id: "desc" } });
  assert.equal(leitura.origem, "QRCODE");
  assert.equal(leitura.fonte, "operador@teste.local");
  assert.equal(leitura.etiquetaId, e1.id);
  assert.equal(Number(leitura.latitude), -23.95);
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e1.token}/vincular`).send({ numero: "TGHU9876543", temperatura: -18 })).status, 409, "já ligada");

  // Leituras seguintes pela etiqueta. (Temperatura só é monitorada a partir da chegada na
  // fábrica — antes o reefer está vazio —, então registra a chegada primeiro.)
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${cont.body.id}/avancar`).send({ statusPara: "NA_FABRICA", ocorridoEm: new Date(Date.now() - 4 * 3600e3) })).status, 200);
  const url = `/api/qr/${e1.token}/leituras`;
  assert.equal((await agentes.OPERADOR.post(url).send({ temperatura: -18, lidaEm: new Date(Date.now() + 3600e3) })).status, 400, "futuro");
  assert.equal((await agentes.OPERADOR.post(url).send({ temperatura: -18, lidaEm: new Date(coleta.getTime() - 3600e3) })).status, 400, "antes da coleta");
  const fora = await agentes.OPERADOR.post(url).send({ temperatura: -10 });
  assert.equal(fora.status, 201);
  assert.equal(fora.body.resultado, "ACIMA");
  assert.ok(await prisma.alerta.findFirst({ where: { containerId: cont.body.id, tipo: "TEMPERATURA", chaveAberta: { not: null } } }), "alerta de temperatura aberto");
  const atrasada = new Date(Date.now() - 3 * 3600e3);
  assert.equal((await agentes.OPERADOR.post(url).send({ temperatura: -18, lidaEm: atrasada })).status, 201);
  assert.equal((await agentes.OPERADOR.post(url).send({ temperatura: -18, lidaEm: atrasada })).status, 409, "mesma leitura não duplica");
  const ficha = await agentes.OPERADOR.get(`/api/containers/${cont.body.id}`);
  const lAtrasada = ficha.body.leituras.find((l) => new Date(l.lidaEm).getTime() === atrasada.getTime());
  assert.equal(lAtrasada.lancadaComAtraso, true, "lançada 3h depois fica sinalizada");
  assert.equal(lAtrasada.etiqueta.codigo, e1.codigo);
  assert.deepEqual(ficha.body.etiquetas.map((x) => x.codigo), [e1.codigo]);

  // Substituição: container já tem etiqueta → pede confirmação; confirmando, a antiga é cancelada.
  const sem = await agentes.OPERADOR.post(`/api/qr/${e2.token}/vincular`).send({ numero: "TGHU9876543", temperatura: -18, lidaEm: new Date(Date.now() - 60e3) });
  assert.equal(sem.status, 409);
  assert.equal(sem.body.codigo, "ETIQUETA_EXISTENTE");
  assert.equal(sem.body.etiquetaAnterior, e1.codigo);
  const troca = await agentes.OPERADOR.post(`/api/qr/${e2.token}/vincular`).send({ numero: "TGHU9876543", temperatura: -18, lidaEm: new Date(Date.now() - 60e3), substituir: true });
  assert.equal(troca.status, 201);
  assert.equal((await agentes.OPERADOR.get(`/api/qr/${e1.token}`)).body.etiqueta.estado, "CANCELADA");
  assert.equal((await agentes.OPERADOR.post(url).send({ temperatura: -18 })).status, 409, "etiqueta substituída não recebe leitura");

  // Cancelar etiqueta livre (só supervisor) impede o uso.
  assert.equal((await agentes.OPERADOR.post(`/api/etiquetas/${e3.id}/cancelar`).send({ motivo: "rasgou" })).status, 403);
  assert.equal((await agentes.SUPERVISOR.post(`/api/etiquetas/${e3.id}/cancelar`).send({ motivo: "rasgou" })).status, 200);
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e3.token}/vincular`).send({ numero: "TGHU9876543", temperatura: -18 })).status, 409);

  // Entregue no porto: etiqueta passa a "encerrada" e não recebe leitura.
  for (const statusPara of ["EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO"]) {
    assert.equal((await agentes.OPERADOR.post(`/api/containers/${cont.body.id}/avancar`).send({ statusPara })).status, 200, statusPara);
  }
  assert.equal((await agentes.OPERADOR.get(`/api/qr/${e2.token}`)).body.etiqueta.estado, "ENCERRADA");
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e2.token}/leituras`).send({ temperatura: -18 })).status, 409);
  const lista = await agentes.SUPERVISOR.get("/api/etiquetas?estado=ENCERRADA");
  assert.deepEqual(lista.body.map((x) => x.codigo), [e2.codigo]);

  // ZPL e endereço do QR: sempre o de Configurações; sem ele, não imprime.
  const pedido = { ids: [e1.id, e2.id], larguraMm: 50, alturaMm: 30, dpi: 203 };
  assert.equal((await agentes.OPERADOR.post("/api/etiquetas/zpl").send(pedido)).status, 403, "operador sem 'Gerar e imprimir etiquetas'");
  const semEndereco = await agentes.SUPERVISOR.post("/api/etiquetas/zpl").send(pedido);
  assert.equal(semEndereco.status, 400);
  assert.match(semEndereco.body.erro, /Configurações → Etiquetas QR/);
  assert.equal((await agentes.ADMIN.put("/api/configuracao").send({ intervaloLeituraMinutos: 240, urlPublica: "192.168.0.10:5174" })).status, 400);
  const cfg = await agentes.ADMIN.put("/api/configuracao").send({ intervaloLeituraMinutos: 240, urlPublica: "http://192.168.0.10:5174/" });
  assert.equal(cfg.body.urlPublica, "http://192.168.0.10:5174");
  const imp = await agentes.OPERADOR.get("/api/etiquetas/impressao");
  assert.equal(imp.body.urlPublica, "http://192.168.0.10:5174");
  assert.ok(imp.body.modelos.some((m) => m.chave === "50x30"));
  // Quem gerou (supervisor) imprime; e1 está cancelada (substituída) e fica fora do ZPL.
  // Um endereço mandado pelo navegador (ex.: lembrado de antes) é ignorado.
  const zpl = await agentes.SUPERVISOR.post("/api/etiquetas/zpl").send({ ...pedido, baseUrl: "http://10.0.0.99:5174" });
  assert.equal(zpl.status, 200);
  assert.equal(zpl.text.match(/\^XA/g).length, 1);
  assert.ok(zpl.text.includes(`http://192.168.0.10:5174/q/${e2.token}`));
  assert.ok(!zpl.text.includes("10.0.0.99"), "endereço do navegador não entra no QR");
});

test("etiquetas QR: cada usuário vê, imprime e cancela só as que gerou; controle de impressão", async () => {
  // Segundo supervisor (outra fábrica).
  const outro = await agentes.ADMIN.post("/api/usuarios").send({ email: "supervisor2@teste.local", nome: "Supervisor Fábrica 2", perfil: "SUPERVISOR", senha: "senha-teste-123" });
  assert.equal(outro.status, 201);
  const sup2 = await logar("supervisor2@teste.local");

  const meu = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 2 })).body.etiquetas;
  const deOutro = (await sup2.post("/api/etiquetas/lotes").send({ quantidade: 2 })).body.etiquetas;
  assert.equal(meu[0].geradaPor, "supervisor@teste.local");

  // Lista: cada um só vê as suas.
  const listaSup = (await agentes.SUPERVISOR.get("/api/etiquetas")).body.map((e) => e.id);
  const listaSup2 = (await sup2.get("/api/etiquetas")).body.map((e) => e.id);
  assert.ok(meu.every((e) => listaSup.includes(e.id)) && !deOutro.some((e) => listaSup.includes(e.id)), "supervisor 1 não vê as do 2");
  assert.deepEqual(listaSup2.sort(), deOutro.map((e) => e.id).sort(), "supervisor 2 vê só as dele");
  // Pedir por id as de outro (folha de impressão com URL editada) não traz nada.
  assert.equal((await agentes.SUPERVISOR.get(`/api/etiquetas?ids=${deOutro.map((e) => e.id).join(",")}`)).body.length, 0);
  // Mesmo "todos=1" só vale para admin.
  assert.equal((await agentes.SUPERVISOR.get("/api/etiquetas?todos=1")).body.some((e) => e.geradaPor === "supervisor2@teste.local"), false);
  assert.equal((await agentes.ADMIN.get("/api/etiquetas")).body.some((e) => e.geradaPor === "supervisor2@teste.local"), false, "admin: por padrão só as dele");
  assert.equal((await agentes.ADMIN.get("/api/etiquetas?todos=1")).body.some((e) => e.geradaPor === "supervisor2@teste.local"), true, "admin com 'todos' vê tudo");
  assert.ok((await sup2.get("/api/etiquetas/lotes")).body.every((l) => l.criadoPor === "supervisor2@teste.local"));

  // ZPL / marcar impressa / cancelar etiquetas de outro: recusado.
  const zplOutro = await agentes.SUPERVISOR.post("/api/etiquetas/zpl").send({ ids: [meu[0].id, deOutro[0].id], larguraMm: 50, alturaMm: 30, dpi: 203 });
  assert.equal(zplOutro.status, 403);
  assert.equal((await agentes.SUPERVISOR.post("/api/etiquetas/impressas").send({ ids: [deOutro[0].id] })).status, 403);
  assert.equal((await agentes.SUPERVISOR.post(`/api/etiquetas/${deOutro[0].id}/cancelar`).send({ motivo: "teste" })).status, 403);

  // Controle de impressão: ZPL e navegador contam; filtro "não impressas".
  const zpl = await agentes.SUPERVISOR.post("/api/etiquetas/zpl").send({ ids: [meu[0].id], larguraMm: 50, alturaMm: 30, dpi: 203 });
  assert.equal(zpl.status, 200);
  assert.equal((await agentes.SUPERVISOR.post("/api/etiquetas/impressas").send({ ids: [meu[0].id] })).status, 204);
  const depois = (await agentes.SUPERVISOR.get(`/api/etiquetas?ids=${meu[0].id}`)).body[0];
  assert.equal(depois.vezesImpressa, 2);
  assert.equal(depois.impressaPor, "supervisor@teste.local");
  const naoImpressas = (await agentes.SUPERVISOR.get("/api/etiquetas?impressao=nao")).body.map((e) => e.id);
  assert.ok(naoImpressas.includes(meu[1].id) && !naoImpressas.includes(meu[0].id));

  // Ler o QR continua aberto a qualquer operador (a etiqueta está no container).
  assert.equal((await agentes.OPERADOR.get(`/api/qr/${deOutro[0].token}`)).status, 200);

  // Reserva pelo código curto digitado (com/sem "CC-", minúsculas).
  const semPrefixo = deOutro[0].codigo.replace("CC-", "").toLowerCase();
  const porCodigo = await agentes.OPERADOR.get(`/api/qr/codigo/${semPrefixo}`);
  assert.equal(porCodigo.status, 200);
  assert.equal(porCodigo.body.token, deOutro[0].token);
  assert.equal((await agentes.OPERADOR.get("/api/qr/codigo/CC-ZZZZZZ")).status, 404);
  assert.equal((await agentes.OPERADOR.get("/api/qr/codigo/abc")).status, 400);
  assert.equal((await request(app).get(`/api/qr/codigo/${semPrefixo}`)).status, 401, "exige login");
});

test("excluir etiquetas selecionadas: uma requisição, só nunca usadas, só do dono, tudo ou nada na conferência", async () => {
  const sup2 = await logar("supervisor2@teste.local");
  const lote = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 4 })).body.etiquetas;
  const [livre, impressa, usada, cancelada] = lote;
  // "impressa": só impressa, nunca colada/lida → pode excluir.
  await agentes.SUPERVISOR.post("/api/etiquetas/impressas").send({ ids: [impressa.id] });
  // "usada": ligada a um container ativo pelo celular → não pode excluir.
  const armador = await agentes.SUPERVISOR.post("/api/armadores").send({ nome: "Armador Exclusão", freeTimeDias: 10, valorDiaria: 1 });
  await agentes.OPERADOR.post("/api/containers").send({ numero: "TCLU1111111", confirmarDigito: true, tipo: "DRY_40", grupoId: ids.grupo, armadorId: armador.body.id });
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${usada.token}/vincular`).send({ numero: "TCLU1111111" })).status, 201);
  // "cancelada" sem uso → pode excluir.
  await agentes.SUPERVISOR.post(`/api/etiquetas/${cancelada.id}/cancelar`).send({ motivo: "rasgou" });
  const deOutro = (await sup2.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas[0];

  // Validações.
  assert.equal((await agentes.VISUALIZACAO.post("/api/etiquetas/excluir").send({ ids: [livre.id] })).status, 403, "sem permissão");
  assert.equal((await agentes.SUPERVISOR.post("/api/etiquetas/excluir").send({ ids: [] })).status, 400);
  assert.equal((await agentes.SUPERVISOR.post("/api/etiquetas/excluir").send({ ids: Array.from({ length: 501 }, (_, i) => i + 1) })).status, 400);
  assert.equal((await agentes.SUPERVISOR.post("/api/etiquetas/excluir").send({ ids: [livre.id, 999999] })).status, 404);
  // Misturar etiqueta de outro usuário: recusa TUDO (nada sai).
  const misto = await agentes.SUPERVISOR.post("/api/etiquetas/excluir").send({ ids: [livre.id, deOutro.id] });
  assert.equal(misto.status, 403);
  assert.ok(await prisma.etiquetaQR.findUnique({ where: { id: livre.id } }), "nada foi excluído");

  // Uma requisição com as 4: exclui as 3 nunca usadas, recusa a ligada ao container (com motivo).
  const r = await agentes.SUPERVISOR.post("/api/etiquetas/excluir").send({ ids: [livre.id, impressa.id, usada.id, cancelada.id, livre.id] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.excluidas.sort(), [livre.codigo, impressa.codigo, cancelada.codigo].sort());
  assert.equal(r.body.bloqueadas.length, 1);
  assert.equal(r.body.bloqueadas[0].codigo, usada.codigo);
  assert.match(r.body.bloqueadas[0].motivo, /ligada ao container TCLU1111111/);
  assert.equal(await prisma.etiquetaQR.count({ where: { id: { in: [livre.id, impressa.id, cancelada.id] } } }), 0);
  assert.ok(await prisma.etiquetaQR.findUnique({ where: { id: usada.id } }), "a usada continua");
  assert.ok(await prisma.etiquetaQR.findUnique({ where: { id: deOutro.id } }), "a do outro usuário continua");
  // Leitura/container da etiqueta usada intactos; log registrou os códigos.
  assert.equal((await agentes.OPERADOR.get(`/api/qr/${usada.token}`)).body.etiqueta.estado, "VINCULADA");
  const log = (await agentes.ADMIN.get("/api/logs?entidade=EtiquetaQR")).body.find((l) => l.acao === "EXCLUIR");
  assert.match(log.descricao, /3 etiqueta\(s\) QR excluída\(s\).*1 já impressa/);

  // Admin pode excluir etiqueta de qualquer usuário (suporte).
  const adm = await agentes.ADMIN.post("/api/etiquetas/excluir").send({ ids: [deOutro.id] });
  assert.deepEqual(adm.body.excluidas, [deOutro.codigo]);
});

test("permissões por usuário: padrão do perfil, personalizar, valer na hora, desativar bloqueia", async () => {
  // /me traz as permissões efetivas.
  const me = await agentes.OPERADOR.get("/api/auth/me");
  assert.deepEqual(me.body.permissoes, ["containers.operar", "qr.registrar"]);
  assert.ok((await agentes.ADMIN.get("/api/auth/me")).body.permissoes.includes("administrar"));

  // Catálogo e lista (só admin).
  assert.equal((await agentes.SUPERVISOR.get("/api/usuarios/permissoes/catalogo")).status, 403);
  const cat = await agentes.ADMIN.get("/api/usuarios/permissoes/catalogo");
  assert.ok(cat.body.catalogo.some((p) => p.chave === "etiquetas.emitir"));
  const usuarios = (await agentes.ADMIN.get("/api/usuarios")).body;
  const op = usuarios.find((u) => u.email === "operador@teste.local");
  assert.equal(op.personalizado, false);

  // Operador sem a permissão não gera etiqueta; admin libera → passa a gerar NA HORA (sem relogar).
  assert.equal((await agentes.OPERADOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).status, 403);
  assert.equal((await agentes.SUPERVISOR.put(`/api/usuarios/${op.id}/permissoes`).send({ permissoes: [] })).status, 403, "só admin configura");
  assert.equal((await agentes.ADMIN.put(`/api/usuarios/${op.id}/permissoes`).send({ permissoes: ["inventada"] })).status, 400);
  const lib = await agentes.ADMIN.put(`/api/usuarios/${op.id}/permissoes`).send({ permissoes: ["containers.operar", "qr.registrar", "etiquetas.emitir"] });
  assert.equal(lib.status, 200);
  assert.equal(lib.body.personalizado, true);
  const loteOp = await agentes.OPERADOR.post("/api/etiquetas/lotes").send({ quantidade: 1 });
  assert.equal(loteOp.status, 201, "liberado sem precisar sair e entrar");
  assert.equal(loteOp.body.etiquetas[0].geradaPor, "operador@teste.local");
  assert.equal((await agentes.OPERADOR.post("/api/etiquetas/zpl").send({ ids: [loteOp.body.etiquetas[0].id], larguraMm: 50, alturaMm: 30, dpi: 203 })).status, 200);
  assert.equal((await agentes.OPERADOR.post(`/api/etiquetas/${loteOp.body.etiquetas[0].id}/cancelar`).send({ motivo: "x" })).status, 403, "cancelar é outra permissão");

  // Retirar "Operar containers": não cadastra mais container nem reconhece alerta.
  await agentes.ADMIN.put(`/api/usuarios/${op.id}/permissoes`).send({ permissoes: ["qr.registrar"] });
  assert.equal((await agentes.OPERADOR.post("/api/containers").send({ numero: "MSCU1111110", tipo: "DRY_40", grupoId: ids.grupo, armadorId: ids.armador })).status, 403);
  assert.deepEqual((await agentes.OPERADOR.get("/api/auth/me")).body.permissoes, ["qr.registrar"]);

  // Supervisor sem "Alterar prazos": edita dados do container, mas não o prazo.
  const sup = usuarios.find((u) => u.email === "supervisor@teste.local");
  const semPrazos = cat.body.padroes.SUPERVISOR.filter((c) => c !== "containers.prazos");
  await agentes.ADMIN.put(`/api/usuarios/${sup.id}/permissoes`).send({ permissoes: semPrazos });
  const algum = (await agentes.SUPERVISOR.get("/api/containers")).body[0];
  assert.equal((await agentes.SUPERVISOR.patch(`/api/containers/${algum.id}`).send({ observacao: "ok" })).status, 200);
  assert.equal((await agentes.SUPERVISOR.patch(`/api/containers/${algum.id}`).send({ freeTimeDias: 30 })).status, 403);

  // Mandar a mesma lista do padrão = volta a "padrão"; null também.
  const volta = await agentes.ADMIN.put(`/api/usuarios/${sup.id}/permissoes`).send({ permissoes: cat.body.padroes.SUPERVISOR });
  assert.equal(volta.body.personalizado, false);
  assert.equal((await agentes.ADMIN.put(`/api/usuarios/${op.id}/permissoes`).send({ permissoes: null })).body.personalizado, false);

  // Trocar o perfil descarta a personalização.
  await agentes.ADMIN.put(`/api/usuarios/${op.id}/permissoes`).send({ permissoes: ["qr.registrar"] });
  const promovido = await agentes.ADMIN.patch(`/api/usuarios/${op.id}`).send({ perfil: "SUPERVISOR" });
  assert.equal(promovido.body.personalizado, false);
  assert.ok(promovido.body.permissoes.includes("cadastros.editar"));
  await agentes.ADMIN.patch(`/api/usuarios/${op.id}`).send({ perfil: "OPERADOR" });

  // Administrador não é configurável.
  const adm = usuarios.find((u) => u.email === "admin@teste.local");
  assert.equal((await agentes.ADMIN.put(`/api/usuarios/${adm.id}/permissoes`).send({ permissoes: [] })).status, 400);

  // Desativar a conta bloqueia na hora (antes, a sessão de 12h continuava valendo).
  const vis = usuarios.find((u) => u.email === "visualizacao@teste.local");
  await agentes.ADMIN.patch(`/api/usuarios/${vis.id}`).send({ ativo: false });
  assert.equal((await agentes.VISUALIZACAO.get("/api/painel")).status, 401);
  await agentes.ADMIN.patch(`/api/usuarios/${vis.id}`).send({ ativo: true });
  assert.equal((await agentes.VISUALIZACAO.get("/api/painel")).status, 200);

  // A troca de permissões fica no log.
  const log = (await agentes.ADMIN.get("/api/logs?entidade=Usuario")).body;
  assert.ok(log.some((l) => l.acao === "PERMISSOES" && l.descricao.includes("liberou: Gerar e imprimir etiquetas")));
});

test("locais: tipos, coordenadas validadas e busca de endereço sem chave", async () => {
  assert.equal((await agentes.OPERADOR.post("/api/locais").send({ nome: "X", tipo: "PORTO" })).status, 403);
  // Coordenadas trocadas (lat/lon invertidas) caem fora do Brasil.
  assert.equal((await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Santos", tipo: "PORTO", latitude: -46.31, longitude: -23.95 })).status, 400);
  assert.equal((await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Santos", tipo: "PORTO", latitude: -23.95 })).status, 400, "lat sem lon");

  const santos = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Porto de Santos", tipo: "PORTO", cidade: "Santos", uf: "sp", latitude: -23.9566, longitude: -46.3136, filaHoras: 6 });
  assert.equal(santos.status, 201);
  assert.equal(santos.body.uf, "SP");
  assert.equal(santos.body.filaHoras, 6);
  // Fábrica a ~1.000 km em linha reta (Rio Verde/GO).
  const rioVerde = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Fábrica Rio Verde", tipo: "FABRICA", latitude: -17.7923, longitude: -50.9281 });
  const perto = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Armazém Cubatão", tipo: "ARMAZEM", latitude: -23.8953, longitude: -46.4253 });
  ids.santos = santos.body.id;
  ids.rioVerde = rioVerde.body.id;
  ids.cubatao = perto.body.id;

  assert.equal((await agentes.SUPERVISOR.get("/api/locais/geocodificar?q=Santos")).status, 503, "sem ORS_API_KEY");
  const soPortos = await agentes.VISUALIZACAO.get("/api/locais?tipo=PORTO");
  assert.deepEqual(soPortos.body.map((l) => l.nome), ["Porto de Santos"]);
});

test("previsão de rota: trajeto longo com free time curto gera RISCO_DEMURRAGE; perto não", async () => {
  const grupo = await agentes.SUPERVISOR.post("/api/grupos").send({ cliente: "Cliente Rota", fabrica: "Fábrica Rio Verde", metaEstadiaHoras: 24 });
  assert.equal((await agentes.SUPERVISOR.patch(`/api/grupos/${grupo.body.id}`).send({ localId: ids.santos })).status, 400, "porto não é fábrica");
  const comLocal = await agentes.SUPERVISOR.patch(`/api/grupos/${grupo.body.id}`).send({ localId: ids.rioVerde });
  assert.equal(comLocal.body.local.nome, "Fábrica Rio Verde");
  const armador = await agentes.SUPERVISOR.post("/api/armadores").send({ nome: "Armador Rota", freeTimeDias: 3, valorDiaria: 100 });

  const base = { tipo: "DRY_40", grupoId: grupo.body.id, armadorId: armador.body.id, portoEntregaId: ids.santos };
  assert.equal((await agentes.OPERADOR.post("/api/containers").send({ ...base, numero: "MSCU1234566", confirmarDigito: true, portoRetiradaId: ids.rioVerde })).status, 400, "retirada precisa ser porto");

  // Sem localCarregamentoId: herda a fábrica do Cliente/Fábrica. Coletado agora em Santos.
  const longe = await agentes.OPERADOR.post("/api/containers").send({ ...base, numero: "MSCU1234566", confirmarDigito: true, portoRetiradaId: ids.santos, coletadoEm: new Date() });
  assert.equal(longe.status, 201);
  assert.equal(longe.body.localCarregamento.nome, "Fábrica Rio Verde");
  const p = longe.body.situacao.previsao;
  assert.equal(p.disponivel, true);
  assert.equal(p.trechos[0].fonte, "ESTIMADA");
  assert.ok(p.trechos[0].km > 1000, `~1.000 km × 1,3 (deu ${p.trechos[0].km})`);
  assert.equal(p.riscoDemurrage, "CRITICO");
  assert.ok(p.diasDemurragePrevistos > 0);
  assert.equal(p.trechos[3].horas, 6, "fila do porto de entrega vem do cadastro do porto");
  const alerta = await prisma.alerta.findFirst({ where: { containerId: longe.body.id, tipo: "RISCO_DEMURRAGE", chaveAberta: { not: null } } });
  assert.equal(alerta?.nivel, "CRITICO");
  assert.equal(await prisma.distanciaRota.count(), 1, "ida e volta Santos↔Rio Verde reaproveitam a mesma distância");

  // Mesmo porto, carregamento no armazém ao lado e free time folgado: sem risco. (Com free time
  // de 3 dias o risco depende da hora da coleta — coletar às 23h "gasta" o dia 1 —, por isso
  // este caso usa um armador de 10 dias para o teste não depender do relógio.)
  const folgado = await agentes.SUPERVISOR.post("/api/armadores").send({ nome: "Armador Folgado", freeTimeDias: 10, valorDiaria: 100 });
  const pertoC = await agentes.OPERADOR.post("/api/containers").send({ ...base, armadorId: folgado.body.id, numero: "MSCU7654321", confirmarDigito: true, portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, coletadoEm: new Date() });
  assert.equal(pertoC.body.situacao.previsao.riscoDemurrage, "OK");
  assert.equal(await prisma.alerta.count({ where: { containerId: pertoC.body.id, tipo: "RISCO_DEMURRAGE" } }), 0);

  // Simulação da tela de cadastro.
  const sim = await agentes.OPERADOR.get(`/api/rotas/estimar?portoRetiradaId=${ids.santos}&localCarregamentoId=${ids.rioVerde}&portoEntregaId=${ids.santos}&grupoId=${grupo.body.id}&armadorId=${armador.body.id}`);
  assert.equal(sim.status, 200);
  assert.equal(sim.body.hipotetico, true);
  assert.equal(sim.body.servicoRota, "ESTIMADA");
  assert.ok(sim.body.cicloHoras > 72);

  // Mudar a coordenada invalida a distância guardada e recalcula.
  const kmAntes = p.trechos[0].km;
  await agentes.SUPERVISOR.patch(`/api/locais/${ids.rioVerde}`).send({ latitude: -21.0, longitude: -48.0 });
  const depois = await agentes.OPERADOR.get(`/api/containers/${longe.body.id}`);
  assert.ok(depois.body.situacao.previsao.trechos[0].km < kmAntes, "fábrica mais perto → distância menor");

  // Local em uso não é excluído; mudar o tipo também não.
  assert.equal((await agentes.SUPERVISOR.delete(`/api/locais/${ids.santos}`)).status, 409);
  assert.equal((await agentes.SUPERVISOR.patch(`/api/locais/${ids.santos}`).send({ tipo: "FABRICA" })).status, 409);

  // Janela de rodagem configurável e validada.
  assert.equal((await agentes.ADMIN.put("/api/configuracao").send({ intervaloLeituraMinutos: 240, rodagemInicioMin: 1200, rodagemFimMin: 1210 })).status, 400);
  const cfg = await agentes.ADMIN.put("/api/configuracao").send({ intervaloLeituraMinutos: 240, rodagemInicioMin: 360, rodagemFimMin: 1080, kmPorDia: 400 });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.kmPorDia, 400);
});
