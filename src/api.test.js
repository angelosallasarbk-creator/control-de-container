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

test("cadastro usado não pode ser excluído (só desativado)", async () => {
  assert.equal((await agentes.SUPERVISOR.delete(`/api/armadores/${ids.armador}`)).status, 409);
  const r = await agentes.SUPERVISOR.patch(`/api/armadores/${ids.armador}`).send({ ativo: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.ativo, false);
});
