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
// Multi-tenant: as consultas DIRETAS deste arquivo (fora de uma requisição) rodam na organização da
// migração (AS TECH LOG, id 1) por meio de naOrg/naOrgPrisma. O código do sistema não tem atalho de
// teste: rota sem contexto de organização falha aqui também.
const ORG_TESTE = 1;
let comOrganizacao;
const naOrg = (fn) => (...args) => comOrganizacao(ORG_TESTE, () => fn(...args));
const naOrgPrisma = (cliente) => new Proxy(cliente, {
  get(alvo, prop) {
    const v = alvo[prop];
    if (typeof prop === "string" && !prop.startsWith("$") && v && typeof v === "object") {
      return new Proxy(v, { get: (m, metodo) => (typeof m[metodo] === "function" ? naOrg(m[metodo].bind(m)) : m[metodo]) });
    }
    return v;
  },
});
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
  // RLS de verdade: o sistema conecta com o usuário restrito ccs_app (criado/atualizado aqui).
  process.env.APP_DB_ROLE_PASSWORD ??= "senha-teste-app-rls-123456";
  const { prepararBanco } = await import("../scripts/preparar-banco.js");
  await prepararBanco({ url: TEST_DATABASE_URL, senha: process.env.APP_DB_ROLE_PASSWORD });
  ({ comOrganizacao } = await import("./lib/tenant.js"));
  prisma = naOrgPrisma((await import("./lib/prisma.js")).prisma);
  sincronizarTodos = naOrg((await import("./lib/alertas.js")).sincronizarTodos);
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
  assert.match(e1.codigo, /^CC-[2-9A-HJKMNP-Z]{8}$/);
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

test("tipos de local: padrões da migração, cadastro, rótulos por função e travas", async () => {
  const padrao = (await agentes.VISUALIZACAO.get("/api/tipos-local")).body;
  const tipo = (nome) => padrao.find((t) => t.nome === nome);
  assert.deepEqual(padrao.map((t) => t.nome).sort(), ["Armazém", "Fábrica", "Ponto Fiscal", "Porto / Terminal", "Terminal Ferroviário"]);
  assert.equal(tipo("Ponto Fiscal").funcao, "PARADA", "v1.2: Ponto Fiscal = parada no trajeto");
  assert.equal(tipo("Terminal Ferroviário").funcao, "RETIRADA_ENTREGA");
  assert.equal(tipo("Terminal Ferroviário").rotuloColeta, "Coleta ferroviária");
  assert.equal(tipo("Armazém").rotuloChegada, "Chegada no armazém");
  ids.tipo = Object.fromEntries(padrao.map((t) => [t.nome, t.id]));

  const novo = { nome: "Terminal Fluvial", funcao: "RETIRADA_ENTREGA", rotuloColeta: "Coleta no terminal fluvial", rotuloEntrega: "Entrega no terminal fluvial" };
  assert.equal((await agentes.OPERADOR.post("/api/tipos-local").send(novo)).status, 403, "operador não cadastra");
  assert.equal((await agentes.SUPERVISOR.post("/api/tipos-local").send({ ...novo, rotuloEntrega: "" })).status, 400, "rótulo da função é obrigatório");
  assert.equal((await agentes.SUPERVISOR.post("/api/tipos-local").send({ ...novo, funcao: "OUTRA" })).status, 400);
  const criado = await agentes.SUPERVISOR.post("/api/tipos-local").send({ ...novo, rotuloChegada: "ignorado" });
  assert.equal(criado.status, 201);
  assert.equal(criado.body.rotuloChegada, null, "rótulo de outra função não é gravado");
  assert.equal((await agentes.SUPERVISOR.post("/api/tipos-local").send(novo)).status, 409, "nome repetido");

  // Com local cadastrado: função travada e exclusão bloqueada; mudar só o rótulo pode.
  const local = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Terminal Rio Madeira", tipoId: criado.body.id });
  assert.equal(local.status, 201);
  assert.equal(local.body.tipo.nome, "Terminal Fluvial");
  const mudaFuncao = await agentes.SUPERVISOR.patch(`/api/tipos-local/${criado.body.id}`).send({ funcao: "CARREGAMENTO", rotuloChegada: "a", rotuloSaida: "b" });
  assert.equal(mudaFuncao.status, 409);
  assert.equal((await agentes.SUPERVISOR.delete(`/api/tipos-local/${criado.body.id}`)).status, 409);
  const renomeia = await agentes.SUPERVISOR.patch(`/api/tipos-local/${criado.body.id}`).send({ rotuloColeta: "Coleta fluvial" });
  assert.equal(renomeia.body.rotuloColeta, "Coleta fluvial");
  assert.equal(renomeia.body.rotuloEntrega, "Entrega no terminal fluvial", "o outro rótulo não muda");

  // Tipo inativo não aceita local novo; sem locais, pode excluir.
  await agentes.SUPERVISOR.patch(`/api/tipos-local/${criado.body.id}`).send({ ativo: false });
  assert.equal((await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Outro fluvial", tipoId: criado.body.id })).status, 400);
  assert.equal((await agentes.SUPERVISOR.delete(`/api/locais/${local.body.id}`)).status, 204);
  assert.equal((await agentes.SUPERVISOR.delete(`/api/tipos-local/${criado.body.id}`)).status, 204);
  const log = (await agentes.ADMIN.get("/api/logs?entidade=TipoLocal")).body;
  assert.ok(log.some((l) => l.acao === "CRIAR" && l.descricao.includes("Terminal Fluvial")));
});

test("locais: tipos, coordenadas validadas e busca de endereço sem chave", async () => {
  const PORTO = ids.tipo["Porto / Terminal"];
  assert.equal((await agentes.OPERADOR.post("/api/locais").send({ nome: "X", tipoId: PORTO })).status, 403);
  assert.equal((await agentes.SUPERVISOR.post("/api/locais").send({ nome: "X", tipoId: 99999 })).status, 400, "tipo inexistente");
  // Coordenadas trocadas (lat/lon invertidas) caem fora do Brasil.
  assert.equal((await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Santos", tipoId: PORTO, latitude: -46.31, longitude: -23.95 })).status, 400);
  assert.equal((await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Santos", tipoId: PORTO, latitude: -23.95 })).status, 400, "lat sem lon");

  const santos = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Porto de Santos", tipoId: PORTO, cidade: "Santos", uf: "sp", latitude: -23.9566, longitude: -46.3136, filaHoras: 6 });
  assert.equal(santos.status, 201);
  assert.equal(santos.body.uf, "SP");
  assert.equal(santos.body.filaHoras, 6);
  // Fábrica a ~1.000 km em linha reta (Rio Verde/GO).
  const rioVerde = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Fábrica Rio Verde", tipoId: ids.tipo["Fábrica"], latitude: -17.7923, longitude: -50.9281, filaHoras: 3 });
  assert.equal(rioVerde.body.filaHoras, null, "fila/gate só vale para local de retirada/entrega");
  const perto = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Armazém Cubatão", tipoId: ids.tipo["Armazém"], latitude: -23.8953, longitude: -46.4253 });
  const ferro = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Terminal Ferroviário Paulínia", tipoId: ids.tipo["Terminal Ferroviário"], latitude: -22.76, longitude: -47.15 });
  ids.ferro = ferro.body.id;
  ids.santos = santos.body.id;
  ids.rioVerde = rioVerde.body.id;
  ids.cubatao = perto.body.id;

  assert.equal((await agentes.SUPERVISOR.get("/api/locais/geocodificar?q=Santos")).status, 503, "sem ORS_API_KEY");
  const retiradaEntrega = await agentes.VISUALIZACAO.get("/api/locais?funcao=RETIRADA_ENTREGA");
  assert.deepEqual(retiradaEntrega.body.map((l) => l.nome).sort(), ["Porto de Santos", "Terminal Ferroviário Paulínia"]);
});

test("previsão de rota: trajeto longo com free time curto gera RISCO_DEMURRAGE; perto não", async () => {
  const grupo = await agentes.SUPERVISOR.post("/api/grupos").send({ cliente: "Cliente Rota", fabrica: "Fábrica Rio Verde", metaEstadiaHoras: 24 });
  assert.equal((await agentes.SUPERVISOR.patch(`/api/grupos/${grupo.body.id}`).send({ localId: ids.santos })).status, 400, "porto não é fábrica");
  const comLocal = await agentes.SUPERVISOR.patch(`/api/grupos/${grupo.body.id}`).send({ localId: ids.rioVerde });
  assert.equal(comLocal.body.local.nome, "Fábrica Rio Verde");
  const armador = await agentes.SUPERVISOR.post("/api/armadores").send({ nome: "Armador Rota", freeTimeDias: 3, valorDiaria: 100 });

  const base = { tipo: "DRY_40", grupoId: grupo.body.id, armadorId: armador.body.id, portoEntregaId: ids.santos };
  assert.equal((await agentes.OPERADOR.post("/api/containers").send({ ...base, numero: "MSCU1234566", confirmarDigito: true, portoRetiradaId: ids.rioVerde })).status, 400, "retirada precisa ser local de retirada/entrega");

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

  // Local em uso não é excluído; mudar para um tipo de outra função também não (mesma função pode).
  assert.equal((await agentes.SUPERVISOR.delete(`/api/locais/${ids.santos}`)).status, 409);
  assert.equal((await agentes.SUPERVISOR.patch(`/api/locais/${ids.santos}`).send({ tipoId: ids.tipo["Fábrica"] })).status, 409);
  assert.equal((await agentes.SUPERVISOR.patch(`/api/locais/${ids.cubatao}`).send({ tipoId: ids.tipo["Fábrica"] })).status, 200);
  await agentes.SUPERVISOR.patch(`/api/locais/${ids.cubatao}`).send({ tipoId: ids.tipo["Armazém"] });

  // Etapas com o nome do tipo do local: coleta em terminal ferroviário, carregamento em armazém.
  const ferroviario = await agentes.OPERADOR.post("/api/containers").send({
    ...base, armadorId: folgado.body.id, numero: "TGHU1234565", confirmarDigito: true,
    portoRetiradaId: ids.ferro, localCarregamentoId: ids.cubatao,
  });
  assert.equal(ferroviario.status, 201, JSON.stringify(ferroviario.body));
  assert.deepEqual(ferroviario.body.rotulosEtapa, {
    COLETADO: "Coleta ferroviária", NA_FABRICA: "Chegada no armazém", SAIU_FABRICA: "Saída do armazém", ENTREGUE_PORTO: "Entrega no porto",
  });
  const naLista = (await agentes.VISUALIZACAO.get("/api/containers")).body.find((c) => c.id === ferroviario.body.id);
  assert.equal(naLista.rotulosEtapa.COLETADO, "Coleta ferroviária", "lista também leva os nomes");
  const noPatio = (await agentes.VISUALIZACAO.get("/api/painel")).body;
  assert.ok(JSON.stringify(noPatio).includes("Coleta ferroviária"), "pátio também leva os nomes");
  // O log da etapa usa o nome do tipo.
  await agentes.OPERADOR.post(`/api/containers/${ferroviario.body.id}/avancar`).send({ statusPara: "COLETADO" });
  const logEtapa = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${ferroviario.body.id}`)).body;
  assert.ok(logEtapa.some((l) => l.descricao.includes("Programado → Coleta ferroviária")), JSON.stringify(logEtapa.map((l) => l.descricao)));
  await agentes.SUPERVISOR.post(`/api/containers/${ferroviario.body.id}/cancelar`).send({ motivo: "teste de rótulos" });

  // Janela de rodagem configurável e validada.
  assert.equal((await agentes.ADMIN.put("/api/configuracao").send({ intervaloLeituraMinutos: 240, rodagemInicioMin: 1200, rodagemFimMin: 1210 })).status, 400);
  const cfg = await agentes.ADMIN.put("/api/configuracao").send({ intervaloLeituraMinutos: 240, rodagemInicioMin: 360, rodagemFimMin: 1080, kmPorDia: 400 });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.kmPorDia, 400);
});

test("transportador: só acessa o QR; coleta com Tipo > Local de retirada; cadastra container novo", async () => {
  const criado = await agentes.ADMIN.post("/api/usuarios").send({ email: "transportador@teste.local", nome: "Transportadora X", perfil: "TRANSPORTADOR", senha: "senha-teste-123" });
  assert.equal(criado.status, 201);
  assert.deepEqual(criado.body.permissoes, ["qr.registrar"]);
  const tr = await logar("transportador@teste.local");

  // Resto do sistema fechado.
  for (const rota of ["/api/painel", "/api/containers", "/api/locais", "/api/etiquetas", "/api/alertas/resumo"]) {
    assert.equal((await tr.get(rota)).status, 403, rota);
  }
  assert.equal((await tr.get("/api/auth/me")).status, 200);

  // Opções: só tipos/locais de retirada (porto, ferrovia) — armazém/fábrica não.
  const op = (await tr.get("/api/qr/opcoes/coleta")).body;
  assert.deepEqual(op.tipos.map((t) => t.nome).sort(), ["Porto / Terminal", "Terminal Ferroviário"]);
  const nomesLocais = op.locais.map((l) => l.nome);
  assert.ok(nomesLocais.includes("Terminal Ferroviário Paulínia") && nomesLocais.includes("Porto de Santos"));
  assert.ok(!nomesLocais.includes("Armazém Cubatão") && !nomesLocais.includes("Fábrica Rio Verde"));
  assert.ok(op.grupos.length && op.armadores.length && op.tiposContainer.includes("REEFER_40"));

  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores"), produtoId: await ativo("produtos") };
  const etiquetas = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 3 })).body.etiquetas;
  const [e1, e2, e3] = etiquetas;
  assert.equal((await tr.get(`/api/qr/${e1.token}`)).body.modoTransportador, true);
  assert.equal((await agentes.OPERADOR.get(`/api/qr/${e1.token}`)).body.modoTransportador, false);

  // A) Container programado pela operação: a leitura registra a coleta no terminal ferroviário.
  const prog = await agentes.ADMIN.post("/api/containers").send({ numero: "TRLU1000001", confirmarDigito: true, tipo: "DRY_40", grupoId: cad.grupoId, armadorId: cad.armadorId, portoRetiradaId: ids.santos });
  assert.equal(prog.status, 201, JSON.stringify(prog.body));
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e1.token}/coleta`).send({ numero: "TRLU1000001", portoRetiradaId: ids.ferro })).status, 403, "só transportador");
  assert.equal((await tr.post(`/api/qr/${e1.token}/coleta`).send({ numero: "TRLU1000001", portoRetiradaId: ids.cubatao })).status, 400, "armazém não é retirada");
  const coleta = await tr.post(`/api/qr/${e1.token}/coleta`).send({ numero: "trlu 100000 1", portoRetiradaId: ids.ferro });
  assert.equal(coleta.status, 201, JSON.stringify(coleta.body));
  assert.equal(coleta.body.coleta, "REGISTRADA");
  assert.equal(coleta.body.container.retirada, "Terminal Ferroviário Paulínia");
  const ficha = (await agentes.ADMIN.get(`/api/containers/${prog.body.id}`)).body;
  assert.equal(ficha.status, "COLETADO");
  assert.equal(ficha.portoRetiradaId, ids.ferro, "local de retirada real substitui o previsto");
  assert.equal(ficha.rotulosEtapa.COLETADO, "Coleta ferroviária");
  assert.ok(ficha.eventos.some((ev) => ev.statusPara === "COLETADO" && ev.observacao.includes("Terminal Ferroviário Paulínia")));
  // Outra etiqueta no mesmo container: pede confirmação de substituição.
  const outra = await tr.post(`/api/qr/${e3.token}/coleta`).send({ numero: "TRLU1000001", portoRetiradaId: ids.ferro });
  assert.equal(outra.status, 409);
  assert.equal(outra.body.codigo, "ETIQUETA_EXISTENTE");

  // B) Container sem cadastro: pede os dados; reefer exige temperatura; cadastra já coletado.
  const semCadastro = await tr.post(`/api/qr/${e2.token}/coleta`).send({ numero: "TRLU2000002", portoRetiradaId: ids.santos });
  assert.equal(semCadastro.status, 404);
  assert.equal(semCadastro.body.codigo, "CONTAINER_NAO_CADASTRADO");
  const novo = { tipo: "REEFER_40", ...cad };
  assert.equal((await tr.post(`/api/qr/${e2.token}/coleta`).send({ numero: "TRLU2000002", confirmarDigito: true, portoRetiradaId: ids.santos, novo })).status, 400, "reefer sem temperatura");
  const cadastrou = await tr.post(`/api/qr/${e2.token}/coleta`).send({ numero: "TRLU2000002", confirmarDigito: true, portoRetiradaId: ids.santos, novo, temperatura: "-18,5".replace(",", ".") });
  assert.equal(cadastrou.status, 201, JSON.stringify(cadastrou.body));
  assert.equal(cadastrou.body.cadastrado, true);
  const novoC = (await agentes.ADMIN.get("/api/containers")).body.find((c) => c.numero === "TRLU2000002");
  assert.equal(novoC.status, "COLETADO");
  assert.equal(novoC.portoRetiradaId, ids.santos);
  assert.equal(novoC.criadoPor, "transportador@teste.local");
  const fichaNovo = (await agentes.ADMIN.get(`/api/containers/${novoC.id}`)).body;
  assert.equal(fichaNovo.leituras.length, 1);
  assert.equal(fichaNovo.leituras[0].temperatura, -18.5);
  const log = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${novoC.id}`)).body;
  assert.ok(log.some((l) => l.descricao.includes("cadastrado pelo transportador na coleta em Porto de Santos")));

  // Depois da coleta, leitura de temperatura segue o fluxo normal.
  assert.equal((await tr.post(`/api/qr/${e2.token}/leituras`).send({ temperatura: -18 })).status, 201);
  for (const c of [prog.body.id, novoC.id]) await agentes.ADMIN.post(`/api/containers/${c}/cancelar`).send({ motivo: "fim do teste do transportador" });
});

test("portaria: QR + Pátio; entrada/saída pelo QR completando etapas pendentes", async () => {
  const criado = await agentes.ADMIN.post("/api/usuarios").send({ email: "portaria@teste.local", nome: "Portaria Fábrica", perfil: "PORTARIA", senha: "senha-teste-123" });
  assert.equal(criado.status, 201);
  const po = await logar("portaria@teste.local");

  // Acesso: Pátio e resumo de alertas sim; resto não; nada de gravar fora do QR.
  assert.equal((await po.get("/api/painel")).status, 200);
  assert.equal((await po.get("/api/alertas/resumo")).status, 200);
  for (const rota of ["/api/containers", "/api/alertas", "/api/locais", "/api/custos", "/api/painelx"]) {
    assert.equal((await po.get(rota)).status, 403, rota);
  }
  assert.equal((await po.post("/api/alertas/1/reconhecer").send({ acaoTomada: "x" })).status, 403);

  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores"), produtoId: await ativo("produtos") };
  const [e1, e2] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 2 })).body.etiquetas;
  assert.equal((await po.get(`/api/qr/${e1.token}`)).body.modoPortaria, true);

  // Container ainda "Programado" (coleta não registrada), reefer.
  const c = await agentes.ADMIN.post("/api/containers").send({ numero: "PRTU3000003", confirmarDigito: true, tipo: "REEFER_40", ...cad });
  assert.equal(c.status, 201);
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e1.token}/portaria`).send({ numero: "PRTU3000003", movimento: "ENTRADA", temperatura: -18 })).status, 403, "só portaria");
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ placa: "ABC1D23", numero: "PRTU3000003", movimento: "X", temperatura: -18 })).status, 400);
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ placa: "ABC1D23", numero: "PRTU9999999", movimento: "ENTRADA", temperatura: -18 })).status, 404, "precisa estar cadastrado");
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ placa: "ABC1D23", numero: "PRTU3000003", movimento: "SAIDA", temperatura: -18 })).status, 409, "saída sem entrada");
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ placa: "ABC1D23", numero: "PRTU3000003", movimento: "ENTRADA" })).status, 400, "reefer exige temperatura");

  const entrada = await po.post(`/api/qr/${e1.token}/portaria`).send({ placa: "ABC1D23", numero: "PRTU3000003", movimento: "ENTRADA", temperatura: -18 });
  assert.equal(entrada.status, 201, JSON.stringify(entrada.body));
  assert.equal(entrada.body.movimento, "ENTRADA");
  assert.deepEqual(entrada.body.completadas, ["Coletado no porto"], "coleta pendente completada");
  let ficha = (await agentes.ADMIN.get(`/api/containers/${c.body.id}`)).body;
  assert.equal(ficha.status, "NA_FABRICA");
  assert.equal(ficha.coletadoEm, ficha.chegadaFabricaEm, "coleta completada com o mesmo horário");
  assert.ok(ficha.eventos.some((ev) => ev.statusPara === "COLETADO" && ev.observacao.includes("completada pela portaria")));
  assert.ok(ficha.eventos.some((ev) => ev.statusPara === "NA_FABRICA" && ev.observacao === "Entrada registrada pela portaria · placa ABC1D23"));
  assert.equal(ficha.leituras.length, 1);
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ placa: "ABC1D23", movimento: "ENTRADA", temperatura: -18 })).status, 409, "entrada repetida");

  // v1.4: placa obrigatória na portaria; placa diferente da vinculada exige motivo.
  assert.equal((await agentes.ADMIN.get(`/api/containers/${c.body.id}`)).body.placa, "ABC1D23", "placa da entrada gravada no container");
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ movimento: "SAIDA", temperatura: -17.5 })).status, 400, "sem placa");
  const semMotivo = await po.post(`/api/qr/${e1.token}/portaria`).send({ placa: "XYZ9A88", movimento: "SAIDA", temperatura: -17.5 });
  assert.equal(semMotivo.status, 400);
  assert.equal(semMotivo.body.codigo, "MOTIVO_TROCA_PLACA");
  assert.equal(semMotivo.body.placaAnterior, "ABC1D23");
  // Saída sem ovação/liberação registradas: completa as duas (com troca de placa justificada).
  const saida = await po.post(`/api/qr/${e1.token}/portaria`).send({ placa: "xyz-9a88", motivoTrocaPlaca: "Troca de cavalo mecânico", movimento: "SAIDA", temperatura: -17.5 });
  assert.equal(saida.status, 201, JSON.stringify(saida.body));
  assert.deepEqual(saida.body.completadas, ["Em ovação", "Liberado"]);
  ficha = (await agentes.ADMIN.get(`/api/containers/${c.body.id}`)).body;
  assert.equal(ficha.status, "SAIU_FABRICA");
  assert.ok(ficha.saidaFabricaEm && ficha.liberadoEm === ficha.saidaFabricaEm && ficha.inicioOperacaoEm === ficha.saidaFabricaEm);
  assert.equal(ficha.situacao.estadia.encerrada, true, "estadia fecha na saída");
  const log = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${c.body.id}`)).body;
  assert.ok(log.some((l) => l.descricao.includes("saída pela portaria") && l.descricao.includes("etapas completadas: Em ovação, Liberado")));
  assert.ok(log.some((l) => l.descricao.includes("placa ABC1D23 → XYZ9A88 (motivo: Troca de cavalo mecânico)")), "troca de placa com motivo no log");
  assert.equal((await agentes.ADMIN.get(`/api/containers/${c.body.id}`)).body.placa, "XYZ9A88");
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ placa: "ABC1D23", movimento: "SAIDA", temperatura: -17 })).status, 409, "saída repetida");

  // Etiqueta nova + container dry já com etiqueta: pede confirmação de substituição.
  const dry = await agentes.ADMIN.post("/api/containers").send({ numero: "PRTU4000004", confirmarDigito: true, tipo: "DRY_40", ...cad, coletadoEm: new Date(Date.now() - 3600e3) });
  const [e3] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  assert.equal((await po.post(`/api/qr/${e2.token}/portaria`).send({ placa: "ABC1D23", numero: "PRTU4000004", movimento: "ENTRADA" })).status, 201, "dry não pede temperatura");
  const outra = await po.post(`/api/qr/${e3.token}/portaria`).send({ placa: "ABC1D23", numero: "PRTU4000004", movimento: "SAIDA" });
  assert.equal(outra.body.codigo, "ETIQUETA_EXISTENTE");
  assert.equal((await po.post(`/api/qr/${e3.token}/portaria`).send({ placa: "ABC1D23", numero: "PRTU4000004", movimento: "SAIDA", substituir: true })).status, 201);
  for (const id of [c.body.id, dry.body.id]) await agentes.ADMIN.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste da portaria" });
});

test("atraso na coleta programada: alerta abre, escala para crítico e encerra na coleta", async () => {
  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  const HORA_MS = 3600e3;
  const noPrazo = await agentes.ADMIN.post("/api/containers").send({ numero: "ATRU5000005", confirmarDigito: true, tipo: "DRY_40", ...cad, coletaProgramadaEm: new Date(Date.now() + 5 * HORA_MS) });
  assert.equal(noPrazo.status, 201);
  assert.equal(noPrazo.body.situacao.atrasoColeta.atrasada, false);
  assert.equal(await prisma.alerta.count({ where: { containerId: noPrazo.body.id, tipo: "ATRASO_COLETA" } }), 0);

  const atrasado = await agentes.ADMIN.post("/api/containers").send({ numero: "ATRU6000006", confirmarDigito: true, tipo: "DRY_40", ...cad, coletaProgramadaEm: new Date(Date.now() - 2 * HORA_MS) });
  assert.equal(atrasado.status, 201);
  assert.equal(atrasado.body.situacao.atrasoColeta.situacao, "ATENCAO");
  const aberto = () => prisma.alerta.findFirst({ where: { containerId: atrasado.body.id, tipo: "ATRASO_COLETA", chaveAberta: { not: null } } });
  assert.equal((await aberto())?.nivel, "ATENCAO");
  assert.match((await aberto()).mensagem, /atrasada há 2h/);
  const noPatio = (await agentes.VISUALIZACAO.get("/api/painel")).body.grupos.flatMap((g) => g.containers).find((c) => c.id === atrasado.body.id);
  assert.equal(noPatio.atrasoColeta.situacao, "ATENCAO");
  assert.equal((await agentes.VISUALIZACAO.get("/api/alertas?tipo=ATRASO_COLETA")).body.some((a) => a.containerId === atrasado.body.id), true);

  // Reprogramar para mais cedo (6h atrás) → crítico (limite padrão 4h).
  const repro = await agentes.OPERADOR.patch(`/api/containers/${atrasado.body.id}`).send({ coletaProgramadaEm: new Date(Date.now() - 6 * HORA_MS) });
  assert.equal(repro.status, 200);
  assert.equal((await aberto())?.nivel, "CRITICO");
  // Limite configurável: com 10h, volta a ser só atenção.
  const cfgAtual = (await agentes.ADMIN.get("/api/configuracao")).body;
  assert.equal(cfgAtual.atrasoColetaCriticoHoras, 4);
  await agentes.ADMIN.put("/api/configuracao").send({ ...cfgAtual, atrasoColetaCriticoHoras: 10 });
  const sincronizarAlertas = naOrg((await import("./lib/alertas.js")).sincronizarAlertas);
  await sincronizarAlertas(atrasado.body.id);
  assert.equal((await aberto())?.nivel, "ATENCAO");
  await agentes.ADMIN.put("/api/configuracao").send({ ...cfgAtual });

  // Coleta registrada → alerta encerra.
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${atrasado.body.id}/avancar`).send({ statusPara: "COLETADO" })).status, 200);
  assert.equal(await aberto(), null);
  const historico = await prisma.alerta.findMany({ where: { containerId: atrasado.body.id, tipo: "ATRASO_COLETA" } });
  assert.ok(historico.length >= 1 && historico.every((a) => a.encerradoEm), "fica no histórico, encerrado");
  for (const c of [noPrazo.body.id, atrasado.body.id]) await agentes.ADMIN.post(`/api/containers/${c}/cancelar`).send({ motivo: "fim do teste de atraso" });
});

test("mensagem do alerta aberto acompanha o tempo (não fica congelada no texto de abertura)", async () => {
  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  // Ids buscados ANTES do .post(): o supertest abre o servidor no .post() e requisições no meio dos argumentos o derrubam.
  const g = await ativo("grupos");
  const a = await ativo("armadores");
  const c = await agentes.ADMIN.post("/api/containers").send({
    numero: "MSGU7000007", confirmarDigito: true, tipo: "DRY_40", grupoId: g, armadorId: a,
    coletaProgramadaEm: new Date(Date.now() - 2 * 3600e3),
  });
  assert.equal(c.status, 201);
  const aberto = () => prisma.alerta.findFirst({ where: { containerId: c.body.id, tipo: "ATRASO_COLETA", chaveAberta: { not: null } } });
  const antes = await aberto();
  await prisma.alerta.update({ where: { id: antes.id }, data: { mensagem: "texto antigo: atrasada há 6 min" } });
  const sincronizarAlertas = naOrg((await import("./lib/alertas.js")).sincronizarAlertas);
  await sincronizarAlertas(c.body.id);
  const depois = await aberto();
  assert.equal(depois.id, antes.id, "mesmo alerta (não reabre)");
  assert.match(depois.mensagem, /atrasada há 2h/);
  await agentes.ADMIN.post(`/api/containers/${c.body.id}/cancelar`).send({ motivo: "fim do teste" });
});

test("plano congelado: gravado na primeira previsão completa e nunca alterado", async () => {
  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  const g = await ativo("grupos");
  const a = await ativo("armadores");
  // +30h: bem longe de "agora", para a janela de rodagem (5h–22h) não igualar as previsões.
  const programada = new Date(Date.now() + 30 * 3600e3);
  // Sem trajeto: ainda não há previsão, então não há plano.
  const semRota = await agentes.ADMIN.post("/api/containers").send({ numero: "PLNU8000008", confirmarDigito: true, tipo: "DRY_40", grupoId: g, armadorId: a, coletaProgramadaEm: programada });
  assert.equal(semRota.status, 201);
  assert.equal(semRota.body.planejamento, null);
  // Trajeto completado depois (ainda programado): o plano nasce aí.
  const comRota = await agentes.OPERADOR.patch(`/api/containers/${semRota.body.id}`).send({ portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.santos });
  assert.equal(comRota.status, 200);
  const plano = comRota.body.planejamento;
  assert.ok(plano?.geradoEm, "plano gerado ao completar o trajeto");
  assert.equal(new Date(plano.COLETADO).getTime(), programada.getTime(), "coleta planejada = coleta programada");
  assert.ok(new Date(plano.NA_FABRICA) > new Date(plano.COLETADO) && new Date(plano.SAIU_FABRICA) > new Date(plano.NA_FABRICA) && new Date(plano.ENTREGUE_PORTO) > new Date(plano.SAIU_FABRICA));
  assert.equal(new Date(comRota.body.situacao.previsao.previsaoEntrega).getTime(), new Date(plano.ENTREGUE_PORTO).getTime(), "no início, ETA = plano");

  // Mudanças depois (reprogramar a coleta, registrar etapas) não mexem no plano; o ETA muda.
  await agentes.OPERADOR.patch(`/api/containers/${semRota.body.id}`).send({ coletaProgramadaEm: new Date(Date.now() + 10 * 3600e3) });
  const coletou = await agentes.OPERADOR.post(`/api/containers/${semRota.body.id}/avancar`).send({ statusPara: "COLETADO" });
  assert.equal(coletou.status, 200);
  assert.deepEqual(coletou.body.planejamento, plano, "plano não muda");
  assert.notEqual(new Date(coletou.body.situacao.previsao.previsaoChegadaFabrica).getTime(), new Date(plano.NA_FABRICA).getTime(), "ETA atualizado com a coleta real");
  await agentes.ADMIN.post(`/api/containers/${semRota.body.id}/cancelar`).send({ motivo: "fim do teste do plano" });
});

test("plano com coleta programada já vencida: todo o plano parte dela (chegada planejada < ETA)", async () => {
  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  const g = await ativo("grupos");
  const a = await ativo("armadores");
  const programada = new Date(Date.now() - 30 * 3600e3);
  const c = await agentes.ADMIN.post("/api/containers").send({
    numero: "PLNU9000009", confirmarDigito: true, tipo: "DRY_40", grupoId: g, armadorId: a, coletaProgramadaEm: programada,
    portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.santos,
  });
  assert.equal(c.status, 201);
  const plano = c.body.planejamento;
  assert.equal(new Date(plano.COLETADO).getTime(), programada.getTime());
  assert.ok(new Date(plano.NA_FABRICA) < new Date(c.body.situacao.previsao.previsaoChegadaFabrica), "chegada planejada antes do ETA (a coleta atrasou)");
  assert.ok(new Date(plano.NA_FABRICA) > programada, "chegada planejada depois da coleta planejada");
  await agentes.ADMIN.post(`/api/containers/${c.body.id}/cancelar`).send({ motivo: "fim do teste" });
});

test("tolerância do planejado: configurável em Configurações e enviada com o container", async () => {
  const cfg = (await agentes.ADMIN.get("/api/configuracao")).body;
  assert.equal(cfg.toleranciaPlanejadoMinutos, 60, "padrão 60 min");
  const algum = (await agentes.ADMIN.get("/api/containers?situacao=todos")).body[0];
  assert.equal((await agentes.ADMIN.get(`/api/containers/${algum.id}`)).body.toleranciaPlanejadoMinutos, 60);
  assert.equal((await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, toleranciaPlanejadoMinutos: -5 })).status, 400);
  assert.equal((await agentes.SUPERVISOR.put("/api/configuracao").send({ ...cfg, toleranciaPlanejadoMinutos: 90 })).status, 403, "só administrador");
  assert.equal((await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, toleranciaPlanejadoMinutos: 180 })).body.toleranciaPlanejadoMinutos, 180);
  assert.equal((await agentes.ADMIN.get(`/api/containers/${algum.id}`)).body.toleranciaPlanejadoMinutos, 180);
  await agentes.ADMIN.put("/api/configuracao").send(cfg);
});

test("login: 'lembrar' = cookie persistente de 30 dias; sem lembrar = cookie de sessão; senha nunca volta", async () => {
  const criado = await agentes.ADMIN.post("/api/usuarios").send({ email: "lembrar@teste.local", nome: "Lembrar", perfil: "OPERADOR", senha: "senha-teste-123" });
  assert.equal(criado.status, 201);
  assert.ok(!JSON.stringify(criado.body).includes("senha"), "cadastro não devolve senha/hash");

  const normal = await request(app).post("/api/auth/login").send({ email: "lembrar@teste.local", senha: "senha-teste-123" });
  assert.equal(normal.status, 200);
  const cNormal = normal.headers["set-cookie"].find((c) => c.startsWith("token_container="));
  assert.match(cNormal, /HttpOnly/i);
  assert.doesNotMatch(cNormal, /Max-Age|Expires/i, "sem lembrar: cookie some ao fechar o navegador");
  assert.ok(!JSON.stringify(normal.body).toLowerCase().includes("senha"), "resposta do login não traz senha");

  const lembrado = request.agent(app);
  const rLembrar = await lembrado.post("/api/auth/login").send({ email: "lembrar@teste.local", senha: "senha-teste-123", lembrar: true });
  assert.equal(rLembrar.status, 200, JSON.stringify(rLembrar.body));
  const cLembrar = rLembrar.headers["set-cookie"].find((c) => c.startsWith("token_container="));
  assert.match(cLembrar, /HttpOnly/i);
  assert.match(cLembrar, /Max-Age=2592000/, "lembrar: 30 dias");
  assert.equal((await lembrado.get("/api/auth/me")).status, 200);

  // Admin redefine a senha: a sessão lembrada cai na hora; novo login com a senha nova funciona.
  const u = (await agentes.ADMIN.get("/api/usuarios")).body.find((x) => x.email === "lembrar@teste.local");
  assert.equal((await agentes.ADMIN.patch(`/api/usuarios/${u.id}`).send({ senha: "senha-nova-456" })).status, 200);
  const caiu = await lembrado.get("/api/auth/me");
  assert.equal(caiu.status, 401);
  assert.match(caiu.body.erro, /senha foi alterada/);
  assert.equal((await request(app).post("/api/auth/login").send({ email: "lembrar@teste.local", senha: "senha-teste-123" })).status, 401);
  const novo = request.agent(app);
  assert.equal((await novo.post("/api/auth/login").send({ email: "lembrar@teste.local", senha: "senha-nova-456", lembrar: true })).status, 200);
  assert.equal((await novo.get("/api/auth/me")).status, 200, "sessão nova vale");

  // Quem troca a própria senha continua logado nesta sessão.
  const proprio = request.agent(app);
  await proprio.post("/api/auth/login").send({ email: "chefe@teste.local", senha: "senha-inicial-123" });
  const eu = (await proprio.get("/api/usuarios")).body.find((x) => x.email === "chefe@teste.local");
  assert.equal((await proprio.patch(`/api/usuarios/${eu.id}`).send({ senha: "senha-inicial-456" })).status, 200);
  assert.equal((await proprio.get("/api/auth/me")).status, 200, "a própria sessão foi renovada");
});

test("esqueci minha senha: link por e-mail, uso único, expira, resposta não revela a conta", async () => {
  const { aguardarEnviosDeRedefinicao } = await import("./routes/auth.js");
  const { caixaDeSaida } = await import("./lib/email.js");
  const db = prisma;
  await agentes.ADMIN.post("/api/usuarios").send({ email: "reset@teste.local", nome: "Pessoa Reset", perfil: "OPERADOR", senha: "senha-antiga-123" });
  const sessaoAntiga = request.agent(app);
  assert.equal((await sessaoAntiga.post("/api/auth/login").send({ email: "reset@teste.local", senha: "senha-antiga-123", lembrar: true })).status, 200);

  // Mesma resposta para e-mail existente e inexistente; só o existente recebe e-mail.
  const antes = caixaDeSaida.length;
  const inexistente = await request(app).post("/api/auth/esqueci-senha").send({ email: "ninguem@teste.local" });
  await aguardarEnviosDeRedefinicao();
  const existente = await request(app).post("/api/auth/esqueci-senha").send({ email: "RESET@teste.local " });
  await aguardarEnviosDeRedefinicao();
  assert.equal(inexistente.status, 200);
  assert.deepEqual(inexistente.body, existente.body, "resposta idêntica");
  assert.equal(caixaDeSaida.length, antes + 1);
  const email = caixaDeSaida.at(-1);
  assert.equal(email.para, "reset@teste.local");
  assert.match(email.assunto, /Redefinição de senha/);
  const codigo = email.texto.match(/\/redefinir-senha\/([A-Za-z0-9_-]+)/)[1];
  assert.ok(codigo.length >= 40, "código longo e aleatório");
  const noBanco = await db.usuario.findUnique({ where: { email: "reset@teste.local" } });
  assert.notEqual(noBanco.resetTokenHash, codigo, "banco guarda só o hash");
  assert.ok(!/resetTokenHash|resetExpiraEm|senhaHash|sessoesValidasApos/.test(JSON.stringify((await agentes.ADMIN.get("/api/usuarios")).body)), "lista de usuários não expõe campos sensíveis");

  // Pedido repetido em menos de 1 min não gera outro e-mail (mesma resposta).
  await request(app).post("/api/auth/esqueci-senha").send({ email: "reset@teste.local" });
  await aguardarEnviosDeRedefinicao();
  assert.equal(caixaDeSaida.length, antes + 1);

  // Conferir e redefinir.
  assert.deepEqual((await request(app).get("/api/auth/redefinir-senha/codigo-falso")).body, { valido: false });
  assert.equal((await request(app).get(`/api/auth/redefinir-senha/${codigo}`)).body.valido, true);
  assert.equal((await request(app).post("/api/auth/redefinir-senha").send({ codigo, senha: "curta" })).status, 400, "senha curta");
  const ok = await request(app).post("/api/auth/redefinir-senha").send({ codigo, senha: "senha-nova-789" });
  assert.equal(ok.status, 200);
  assert.equal((await request(app).post("/api/auth/redefinir-senha").send({ codigo, senha: "outra-senha-000" })).status, 400, "uso único");
  assert.equal((await sessaoAntiga.get("/api/auth/me")).status, 401, "sessões antigas (inclusive lembradas) caem");
  assert.equal((await request(app).post("/api/auth/login").send({ email: "reset@teste.local", senha: "senha-nova-789" })).status, 200);
  const log = (await agentes.ADMIN.get("/api/logs?entidade=Usuario")).body;
  assert.ok(log.some((l) => l.acao === "RESET_SENHA_SOLICITADO") && log.some((l) => l.acao === "RESET_SENHA"));

  // Link expirado não vale.
  await db.usuario.update({ where: { email: "reset@teste.local" }, data: { resetSolicitadoEm: new Date(Date.now() - 120e3) } });
  await request(app).post("/api/auth/esqueci-senha").send({ email: "reset@teste.local" });
  await aguardarEnviosDeRedefinicao();
  const codigo2 = caixaDeSaida.at(-1).texto.match(/\/redefinir-senha\/([A-Za-z0-9_-]+)/)[1];
  await db.usuario.update({ where: { email: "reset@teste.local" }, data: { resetExpiraEm: new Date(Date.now() - 1000) } });
  assert.equal((await request(app).get(`/api/auth/redefinir-senha/${codigo2}`)).body.valido, false, "expirado");

  // Administrador envia o link; conta desativada não recebe.
  const u = (await agentes.ADMIN.get("/api/usuarios")).body.find((x) => x.email === "reset@teste.local");
  await db.usuario.update({ where: { id: u.id }, data: { resetSolicitadoEm: null } });
  const pelaAdmin = await agentes.ADMIN.post(`/api/usuarios/${u.id}/enviar-redefinicao`);
  assert.equal(pelaAdmin.status, 200);
  assert.equal(pelaAdmin.body.simulado, true, "sem BREVO_API_KEY nos testes: envio simulado");
  assert.equal((await agentes.SUPERVISOR.post(`/api/usuarios/${u.id}/enviar-redefinicao`)).status, 403);
  await agentes.ADMIN.patch(`/api/usuarios/${u.id}`).send({ ativo: false });
  const n = caixaDeSaida.length;
  await db.usuario.update({ where: { id: u.id }, data: { resetSolicitadoEm: null } });
  await request(app).post("/api/auth/esqueci-senha").send({ email: "reset@teste.local" });
  await aguardarEnviosDeRedefinicao();
  assert.equal(caixaDeSaida.length, n, "conta desativada não recebe link");
});

test("reset de senha: log diz quando o envio é simulado e registra falha do Brevo (e libera novo pedido)", async () => {
  const { aguardarEnviosDeRedefinicao } = await import("./routes/auth.js");
  const db = prisma;
  await agentes.ADMIN.post("/api/usuarios").send({ email: "falha-envio@teste.local", nome: "Falha Envio", perfil: "OPERADOR", senha: "senha-teste-123" });

  // IP próprio para este cenário: o limite de 5 pedidos/15 min por IP já foi usado nos testes anteriores.
  const IP = "203.0.113.77";
  // Sem chave: log deixa claro que foi simulado.
  const r1 = await request(app).post("/api/auth/esqueci-senha").set("X-Forwarded-For", IP).send({ email: "falha-envio@teste.local" });
  await aguardarEnviosDeRedefinicao();
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  let log = (await agentes.ADMIN.get("/api/logs?entidade=Usuario")).body;
  assert.ok(log.some((l) => l.acao === "RESET_SENHA_SOLICITADO" && /falha-envio@teste\.local.*envio simulado/.test(l.descricao)), "log indica envio simulado");

  // Com chave, Brevo recusa (IP não autorizado): resposta genérica ao público, falha no log, link desfeito.
  const fetchOriginal = globalThis.fetch;
  process.env.BREVO_API_KEY = "chave-falsa-de-teste";
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "We have detected you are using an unrecognised IP address", code: "unauthorized" }), { status: 401 });
  try {
    await db.usuario.update({ where: { email: "falha-envio@teste.local" }, data: { resetSolicitadoEm: null } });
    const publico = await request(app).post("/api/auth/esqueci-senha").set("X-Forwarded-For", IP).send({ email: "falha-envio@teste.local" });
    await aguardarEnviosDeRedefinicao();
    assert.equal(publico.status, 200, "tela de login continua com a resposta genérica");
    assert.match(publico.body.mensagem, /Se o e-mail estiver cadastrado/);
    log = (await agentes.ADMIN.get("/api/logs?entidade=Usuario")).body;
    const falha = log.find((l) => l.acao === "RESET_SENHA_FALHA_ENVIO");
    assert.ok(falha && /Brevo respondeu 401/.test(falha.descricao) && /unrecognised IP/.test(falha.descricao), "motivo da falha no log");
    assert.ok(!falha.descricao.includes("chave-falsa-de-teste"), "log não expõe a chave");
    const u = await db.usuario.findUnique({ where: { email: "falha-envio@teste.local" } });
    assert.equal(u.resetTokenHash, null, "link desfeito");
    assert.equal(u.resetSolicitadoEm, null, "pode pedir de novo na hora");
    const pelaAdmin = await agentes.ADMIN.post(`/api/usuarios/${u.id}/enviar-redefinicao`);
    assert.equal(pelaAdmin.status, 502);
    assert.match(pelaAdmin.body.erro, /unrecognised IP/);
  } finally {
    globalThis.fetch = fetchOriginal;
    delete process.env.BREVO_API_KEY;
  }
});

test("planilha de containers: modelo com listas, prévia sem gravar, confirma só as válidas", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const { calcularDigitoVerificador } = await import("./lib/iso6346.js");
  const num = (base) => `${base}${calcularDigitoVerificador(base)}`;
  const binario = (res, cb) => { const partes = []; res.on("data", (c) => partes.push(c)); res.on("end", () => cb(null, Buffer.concat(partes))); };

  const g = await agentes.SUPERVISOR.post("/api/grupos").send({ cliente: "Planilha SA", fabrica: "Fábrica Upload", metaEstadiaHoras: 20 });
  assert.equal(g.status, 201);
  assert.equal((await agentes.SUPERVISOR.post("/api/armadores").send({ nome: "Armador Planilha", freeTimeDias: 9, valorDiaria: 100 })).status, 201);
  assert.equal((await agentes.SUPERVISOR.post("/api/produtos").send({ nome: "Resfriado Planilha", setpoint: 2, tempMin: 0, tempMax: 4, toleranciaMinutos: 30 })).status, 201);

  // Modelo: só quem opera containers; listas suspensas com os cadastros ativos.
  assert.equal((await agentes.VISUALIZACAO.get("/api/containers/modelo")).status, 403);
  const modelo = await agentes.OPERADOR.get("/api/containers/modelo").buffer(true).parse(binario);
  assert.equal(modelo.status, 200);
  assert.match(modelo.headers["content-disposition"], /modelo-containers\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(modelo.body);
  const ws = wb.getWorksheet("Containers");
  const cab = ws.getRow(1).values.slice(1);
  assert.equal(cab[0], "Número do container *");
  const listas = wb.getWorksheet("Listas");
  const valoresDe = (nome) => listas.getColumn(listas.getRow(1).values.indexOf(nome)).values.slice(2);
  assert.ok(valoresDe("grupos").includes("Planilha SA / Fábrica Upload"));
  assert.ok(valoresDe("retirada").includes("Porto de Santos") && !valoresDe("retirada").includes("Armazém Cubatão"));
  assert.ok(valoresDe("carregamento").includes("Armazém Cubatão"));

  // Preenche: cabeçalho pelo nome (ordem livre não importa); várias situações.
  const col = (titulo) => cab.findIndex((t) => t.replace(" *", "") === titulo) + 1;
  const linha = (n, v) => { for (const [t, x] of Object.entries(v)) ws.getRow(n).getCell(col(t)).value = x; };
  const ok1 = num("PLNU100001"), ok2 = num("PLNU100002"), ativo = num("PLNU100003");
  // Obrigatórios: número, tipo, ponto, armador, produto, retirada, carregamento, entrega e coleta programada.
  const base = {
    Tipo: "40' Dry", "Ponto de Carregamento": "planilha sa / fabrica upload", Armador: "Armador Planilha", Produto: "Resfriado Planilha",
    "Local de retirada": "Porto de Santos", "Local de carregamento": "Armazém Cubatão", "Local de entrega": "Porto de Santos", "Coleta programada": "07/10/2026 10:00",
  };
  linha(2, { "Número do container": ok1, ...base, "Local de retirada": "Porto de Santos", "Local de carregamento": "Armazém Cubatão", "Coleta programada": "05/10/2026 08:30", Booking: "BK-PL-1" });
  linha(3, { "Número do container": ok2, ...base, Tipo: "20' Reefer", Produto: "Resfriado Planilha", "Coleta programada": new Date(Date.UTC(2026, 9, 6, 14, 0)) });
  linha(4, { "Número do container": ok1, ...base }); // repetido na planilha
  linha(5, { "Número do container": num("PLNU100004"), ...base, Tipo: "40' Reefer", Produto: null }); // sem produto
  linha(6, { "Número do container": "PLNU1000050", ...base }); // dígito errado
  linha(7, { "Número do container": "PLNU1000060", ...base, "Dígito conferido": "sim" }); // dígito errado, confirmado
  linha(8, { "Número do container": num("PLNU100007"), ...base, Armador: "Armador Inexistente" });
  linha(9, { "Número do container": num("PLNU100008"), ...base, "Local de retirada": "Armazém Cubatão" }); // local da função errada
  linha(10, { "Número do container": ativo, ...base });
  linha(12, { "Número do container": num("PLNU100009"), ...base, "Coleta programada": "31/13/2026" }); // (linha 11 vazia é ignorada)
  linha(13, { "Número do container": num("PLNU100010"), ...base, "Local de entrega": null, "Coleta programada": null }); // obrigatórios em branco
  const arquivo = Buffer.from(await wb.xlsx.writeBuffer());
  // Número já ativo no sistema.
  const cad = { grupoId: g.body.id, armadorId: (await agentes.ADMIN.get("/api/armadores")).body.find((a) => a.nome === "Armador Planilha").id };
  assert.equal((await agentes.ADMIN.post("/api/containers").send({ numero: ativo, tipo: "DRY_40", ...cad })).status, 201);

  const enviar = (agente, conf) => agente.post(`/api/containers/importar${conf ? "?confirmar=1" : ""}`).set("Content-Type", "application/octet-stream").send(arquivo);
  assert.equal((await enviar(agentes.VISUALIZACAO)).status, 403);
  assert.equal((await agentes.OPERADOR.post("/api/containers/importar").set("Content-Type", "application/octet-stream").send(Buffer.from("não é excel"))).status, 400);

  const antes = await prisma.container.count();
  const previa = await enviar(agentes.OPERADOR);
  assert.equal(previa.status, 200, JSON.stringify(previa.body));
  assert.equal(await prisma.container.count(), antes, "prévia não grava");
  assert.equal(previa.body.total, 11);
  const erroDa = (n) => previa.body.linhas.find((l) => l.linha === n).erro;
  assert.equal(erroDa(2), null);
  assert.equal(erroDa(3), null);
  assert.equal(erroDa(7), null, "dígito errado aceito com SIM");
  assert.match(erroDa(4), /repetido na planilha \(também na linha 2\)/);
  assert.equal(erroDa(5), "Obrigatório(s) em branco: Produto.");
  assert.equal(erroDa(13), "Obrigatório(s) em branco: Local de entrega, Coleta programada.");
  assert.match(erroDa(6), /Dígito conferido/);
  assert.match(erroDa(8), /Armador: "Armador Inexistente" não encontrado/);
  assert.match(erroDa(9), /não é um local de retirada/);
  assert.match(erroDa(10), /Já está ativo/);
  assert.match(erroDa(12), /Coleta programada: data inválida/);
  assert.deepEqual([previa.body.validos, previa.body.comErro], [3, 8]);

  const conf = await enviar(agentes.OPERADOR, true);
  assert.equal(conf.status, 200);
  assert.equal(conf.body.importados, 3);
  assert.equal(await prisma.container.count(), antes + 3);
  const c1 = await prisma.container.findFirst({ where: { numero: ok1 }, include: { portoRetirada: true, localCarregamento: true } });
  assert.equal(c1.portoRetirada.nome, "Porto de Santos");
  assert.equal(c1.localCarregamento.nome, "Armazém Cubatão");
  assert.equal(c1.booking, "BK-PL-1");
  assert.equal(c1.coletaProgramadaEm.toISOString(), "2026-10-05T11:30:00.000Z", "texto dd/mm/aaaa hh:mm = horário de Brasília");
  assert.equal(c1.criadoPor, "operador@teste.local");
  // Gravação em lote mantém o mesmo registro do cadastro um a um: etapa inicial e log por container.
  assert.equal(await prisma.eventoContainer.count({ where: { containerId: c1.id, statusPara: "PROGRAMADO" } }), 1);
  assert.equal(await prisma.logAuditoria.count({ where: { entidade: "Container", entidadeId: String(c1.id), acao: "CRIAR" } }), 1);
  const c2 = await prisma.container.findFirst({ where: { numero: ok2 } });
  assert.equal(c2.coletaProgramadaEm.toISOString(), "2026-10-06T17:00:00.000Z", "data do Excel = horário de Brasília");
  assert.equal(Number(c2.tempMax), 4, "faixa copiada do produto");
  const log = (await agentes.ADMIN.get("/api/logs?entidade=Container")).body;
  assert.ok(log.some((l) => l.acao === "IMPORTAR" && l.descricao.includes("3 container(s) cadastrado(s), 8 linha(s) recusada(s)")));
  // Reenviar o mesmo arquivo: nada duplica.
  const de_novo = await enviar(agentes.OPERADOR, true);
  assert.equal(de_novo.body.importados, 0);
  assert.equal(await prisma.container.count(), antes + 3);

  const ids = (await prisma.container.findMany({ where: { numero: { in: [ok1, ok2, "PLNU1000060", ativo] } }, select: { id: true } })).map((x) => x.id);
  for (const id of ids) await agentes.ADMIN.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste da planilha" });
});

test("rastreamento por SMS: QR → Container → Usuário → Celular; troca de responsável, intervalos, link de posição", async () => {
  const executarRastreamento = naOrg((await import("./lib/rastreamento.js")).executarRastreamento);
  const { caixaDeSaidaSms } = await import("./lib/sms.js");
  const MIN = 60e3;
  const smsPara = (tel) => caixaDeSaidaSms.filter((s) => s.para === tel);
  const codigoDoSms = (s) => /\/p\/([A-Za-z0-9_-]+)$/.exec(s.texto)?.[1];

  // Celular no cadastro do usuário: validado e gravado em +55…
  const u1 = await agentes.ADMIN.post("/api/usuarios").send({ email: "rastreio1@teste.local", nome: "Motorista Um", perfil: "OPERADOR", senha: "senha-teste-123", celular: "(11) 98765-4321" });
  assert.equal(u1.status, 201, JSON.stringify(u1.body));
  assert.equal(u1.body.celular, "+5511987654321");
  assert.equal((await agentes.ADMIN.post("/api/usuarios").send({ email: "rastreiox@teste.local", nome: "X", perfil: "OPERADOR", senha: "senha-teste-123", celular: "123" })).status, 400);
  const u2 = await agentes.ADMIN.post("/api/usuarios").send({ email: "rastreio2@teste.local", nome: "Motorista Dois", perfil: "OPERADOR", senha: "senha-teste-123" });
  assert.equal(u2.body.celular, null);
  assert.equal((await agentes.ADMIN.patch(`/api/usuarios/${u2.body.id}`).send({ celular: "21 99876-5432" })).body.celular, "+5521998765432");
  const m1 = await logar("rastreio1@teste.local");
  const m2 = await logar("rastreio2@teste.local");

  const cfg = (await agentes.ADMIN.get("/api/configuracao")).body;
  assert.equal(cfg.rastreioSmsAtivo, 0, "desligado por padrão");
  assert.equal(cfg.rastreioIntervaloMin, 30);
  assert.equal(cfg.rastreioIntervaloCarregamentoMin, 240);
  assert.equal((await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioIntervaloMin: 2 })).status, 400);
  assert.equal((await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: true, rastreioPersonalizado: 1 })).body.rastreioSmsAtivo, 1);

  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores"), produtoId: await ativo("produtos") };
  const c = await agentes.ADMIN.post("/api/containers").send({ numero: "RSTU5000005", confirmarDigito: true, tipo: "REEFER_40", ...cad, coletadoEm: new Date(Date.now() - 3600e3) });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const [e] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;

  // 1) Motorista Um lê o QR (vínculo): vira o responsável, recebe o SMS de vínculo, posição gravada.
  assert.equal((await m1.post(`/api/qr/${e.token}/vincular`).send({ numero: "RSTU5000005", temperatura: -18, latitude: -23.9, longitude: -46.3, precisaoM: 8 })).status, 201);
  let db = await prisma.container.findUnique({ where: { id: c.body.id } });
  assert.equal(db.rastreioResponsavelId, u1.body.id);
  assert.ok(smsPara("+5511987654321").some((s) => s.texto.includes("RSTU5000005") && s.texto.includes("vinculado")));
  const t0 = db.rastreioUltimoEnvioEm.getTime();
  // Listas marcam o container com QR vinculado (ícone na Home, Grid e Tabela).
  const naLista = (await agentes.ADMIN.get("/api/containers")).body;
  assert.equal(naLista.find((x) => x.id === c.body.id).qrVinculado, true);
  assert.ok(naLista.some((x) => x.qrVinculado === false), "sem etiqueta = false");
  const noPainel = (await agentes.ADMIN.get("/api/painel")).body.grupos.flatMap((g) => g.containers);
  assert.equal(noPainel.find((x) => x.id === c.body.id).qrVinculado, true);
  assert.equal((await agentes.ADMIN.get(`/api/containers/${c.body.id}`)).body.qrVinculado, true);

  // 2) Agendador: antes do intervalo nada; depois de 30 min um pedido — e só um, mesmo rodando 2x.
  const antes = smsPara("+5511987654321").length;
  await executarRastreamento(new Date(t0 + 10 * MIN));
  assert.equal(smsPara("+5511987654321").length, antes);
  await executarRastreamento(new Date(t0 + 31 * MIN));
  await executarRastreamento(new Date(t0 + 31 * MIN));
  const pedidos1 = smsPara("+5511987654321").slice(antes);
  assert.equal(pedidos1.length, 1, "sem duplicidade");
  assert.ok(pedidos1[0].texto.length <= 160, "cabe em 1 SMS");
  const codigo1 = codigoDoSms(pedidos1[0]);
  assert.ok(codigo1);
  assert.equal(await prisma.solicitacaoPosicao.count({ where: { tokenHash: codigo1 } }), 0, "código não fica no banco, só o hash");

  // 3) Link do SMS (sem login): mostra o container, grava a posição uma vez só.
  const conf = await request(app).get(`/api/posicao/${codigo1}`);
  assert.equal(conf.body.valido, true);
  assert.equal(conf.body.numero, "RSTU5000005");
  assert.equal((await request(app).post(`/api/posicao/${codigo1}`).send({ latitude: 95, longitude: 0 })).status, 400);
  assert.equal((await request(app).post(`/api/posicao/${codigo1}`).send({ latitude: -22.5, longitude: -47.1, precisaoM: 5.4 })).status, 201);
  assert.equal((await request(app).post(`/api/posicao/${codigo1}`).send({ latitude: -22.5, longitude: -47.1 })).status, 409, "uso único");
  assert.equal((await request(app).get("/api/posicao/codigo-que-nao-existe-123")).body.valido, false);

  // Mais um pedido para o Motorista Um (fica pendente).
  await executarRastreamento(new Date(t0 + 62 * MIN));
  const codigoAntigo = codigoDoSms(smsPara("+5511987654321").at(-1));
  assert.equal((await request(app).get(`/api/posicao/${codigoAntigo}`)).body.valido, true);

  // 4) Motorista Dois registra temperatura pelo QR: assume; o Um para de receber e o link dele cai.
  assert.equal((await m2.post(`/api/qr/${e.token}/leituras`).send({ temperatura: -18 })).status, 201);
  db = await prisma.container.findUnique({ where: { id: c.body.id } });
  assert.equal(db.rastreioResponsavelId, u2.body.id);
  assert.ok(smsPara("+5521998765432").some((s) => s.texto.includes("vinculado")));
  const velho = (await request(app).get(`/api/posicao/${codigoAntigo}`)).body;
  assert.equal(velho.valido, false);
  assert.match(velho.mensagem, /outra pessoa/);
  assert.equal((await request(app).post(`/api/posicao/${codigoAntigo}`).send({ latitude: -22, longitude: -47 })).status, 409);
  const log = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${c.body.id}`)).body;
  assert.ok(log.some((l) => l.acao === "RASTREIO" && l.descricao.includes("rastreio2@teste.local") && l.descricao.includes("antes: rastreio1@teste.local")));
  // Mesmo responsável lendo de novo: não repete o SMS de vínculo.
  const vinculos2 = smsPara("+5521998765432").length;
  await m2.post(`/api/qr/${e.token}/leituras`).send({ temperatura: -18.1 });
  assert.equal(smsPara("+5521998765432").length, vinculos2);

  const t1 = db.rastreioUltimoEnvioEm.getTime();
  const doUm = smsPara("+5511987654321").length;
  await executarRastreamento(new Date(t1 + 31 * MIN));
  assert.equal(smsPara("+5511987654321").length, doUm, "antigo não recebe mais");
  assert.equal(smsPara("+5521998765432").length, vinculos2 + 1, "novo recebe");

  // 5) No ponto de carregamento: intervalo de 4 h.
  await prisma.container.update({ where: { id: c.body.id }, data: { status: "NA_FABRICA", chegadaFabricaEm: new Date() } });
  const t2 = t1 + 31 * MIN;
  await executarRastreamento(new Date(t2 + 60 * MIN));
  assert.equal(smsPara("+5521998765432").length, vinculos2 + 1, "1 h depois ainda não");
  await executarRastreamento(new Date(t2 + 241 * MIN));
  assert.equal(smsPara("+5521998765432").length, vinculos2 + 2, "4 h depois pede");

  // 6) Sem celular: registra SEM_CELULAR e não cria link.
  await agentes.ADMIN.patch(`/api/usuarios/${u2.body.id}`).send({ celular: "" });
  const links = await prisma.solicitacaoPosicao.count({ where: { containerId: c.body.id } });
  await executarRastreamento(new Date(t2 + 482 * MIN));
  assert.equal(await prisma.solicitacaoPosicao.count({ where: { containerId: c.body.id } }), links);
  assert.ok(await prisma.mensagemSms.findFirst({ where: { containerId: c.body.id, status: "SEM_CELULAR" } }));

  // 6b) Celular cadastrado depois (responsável ficou "Sem celular"): aviso de vínculo sai na hora.
  await agentes.ADMIN.patch(`/api/usuarios/${u2.body.id}`).send({ celular: "21 99876-1111" });
  assert.ok(smsPara("+5521998761111").some((s) => s.texto.includes("RSTU5000005") && s.texto.includes("vinculado")), "vínculo reenviado ao novo celular");
  const semAviso = smsPara("+5521998761111").length;
  await agentes.ADMIN.patch(`/api/usuarios/${u2.body.id}`).send({ nome: "Motorista Dois" });
  assert.equal(smsPara("+5521998761111").length, semAviso, "salvar sem mudar o celular não reenvia");
  await agentes.ADMIN.patch(`/api/usuarios/${u2.body.id}`).send({ celular: "" });

  // 7) Aba Rastreamento da ficha: celular mascarado, posições (QR + link) e SMS.
  const r = (await agentes.OPERADOR.get(`/api/containers/${c.body.id}/rastreamento`)).body;
  assert.equal(r.responsavel.nome, "Motorista Dois");
  assert.equal(r.responsavel.temCelular, false);
  assert.equal(r.intervaloMin, 240);
  assert.deepEqual(r.posicoes.map((p) => p.origem).sort(), ["LINK_SMS", "QR"]);
  const doLink = r.posicoes.find((p) => p.origem === "LINK_SMS");
  assert.equal(doLink.latitude, -22.5);
  assert.equal(doLink.precisaoM, 5);
  assert.ok(r.mensagens.some((m) => m.telefone === "(••) •••••-4321"));
  assert.ok(!JSON.stringify(r).includes("98765-4321") && !JSON.stringify(r).includes("5511987654321"), "celular completo não vaza");

  // 8) Rastreamento desligado: nada sai; container encerrado: nada sai.
  await agentes.ADMIN.patch(`/api/usuarios/${u2.body.id}`).send({ celular: "21998765432" });
  await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: 0 });
  const total = caixaDeSaidaSms.length;
  assert.equal((await executarRastreamento(new Date(t2 + 2000 * MIN))).enviados, 0);
  await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: 1 });
  await agentes.ADMIN.post(`/api/containers/${c.body.id}/cancelar`).send({ motivo: "fim do teste de rastreamento" });
  await executarRastreamento(new Date(t2 + 3000 * MIN));
  assert.ok(!caixaDeSaidaSms.slice(total).some((s) => s.texto.includes("RSTU5000005")));
  assert.equal((await request(app).get(`/api/posicao/${codigo1}`)).body.valido, false);
  await agentes.ADMIN.put("/api/configuracao").send(cfg);
});

test("rastreamento em trechos críticos: previsão estourada, risco de prazo, parado, sem posição e pedido manual", async () => {
  const executarRastreamento = naOrg((await import("./lib/rastreamento.js")).executarRastreamento);
  const MIN = 60e3, H = 60 * MIN;
  const T = new Date();
  const at = (ms) => new Date(T.getTime() + ms);

  const u = await agentes.ADMIN.post("/api/usuarios").send({ email: "critico@teste.local", nome: "Motorista Crítico", perfil: "OPERADOR", senha: "senha-teste-123", celular: "11 97777-0000" });
  assert.equal(u.status, 201);
  const cfg = (await agentes.ADMIN.get("/api/configuracao")).body;
  assert.equal(cfg.rastreioPersonalizado, 0, "padrão = trechos críticos");
  assert.deepEqual([cfg.rastreioCriticoIntervaloMin, cfg.rastreioParadoHoras, cfg.rastreioSemPosicaoHoras], [60, 3, 12]);
  assert.equal((await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioCriticoIntervaloMin: 5 })).status, 400);
  await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: 1, toleranciaPlanejadoMinutos: 60 });

  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  let n = 0;
  async function container(status, extra = {}) {
    n++;
    const numero = `CRTU${String(700000 + n).padStart(6, "0")}0`;
    const r = await agentes.ADMIN.post("/api/containers").send({ numero, confirmarDigito: true, tipo: "DRY_40", ...cad });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await prisma.container.update({
      where: { id: r.body.id },
      data: { status, rastreioResponsavelId: u.body.id, rastreioDesde: at(-1 * H), rastreioUltimoEnvioEm: at(-1 * H), ...extra },
    });
    return r.body.id;
  }
  const posicao = (containerId, lat, lon, quando) =>
    prisma.posicaoContainer.create({ data: { containerId, usuarioId: u.body.id, latitude: lat, longitude: lon, origem: "QR", etapa: "COLETADO", registradaEm: quando } });
  const pedidos = (id) => prisma.mensagemSms.findMany({ where: { containerId: id, tipo: "POSICAO" }, orderBy: { id: "asc" } });

  // A) Previsão estourada: chegada planejada T+1h, tolerância 60 min → só depois de T+2h.
  const A = await container("COLETADO", { coletadoEm: at(-2 * H), rastreioUltimoEnvioEm: T, planejamento: { NA_FABRICA: at(1 * H).toISOString() } });
  await posicao(A, -23.5, -46.6, T);
  // B) Risco de prazo no ponto de carregamento (alerta aberto).
  const B = await container("NA_FABRICA", { chegadaFabricaEm: at(-3 * H) });
  // C) No carregamento, sem alerta e sem posição há muito tempo: parado lá é o esperado → nada.
  const C = await container("NA_FABRICA", { chegadaFabricaEm: at(-3 * H), rastreioDesde: at(-20 * H), rastreioUltimoEnvioEm: at(-20 * H) });
  // D) Parado: 2 posições a ~100 m uma da outra com 4 h entre elas. E) Andando: 5 km → nada.
  const D = await container("COLETADO", { coletadoEm: at(-5 * H), rastreioUltimoEnvioEm: at(-2 * H) });
  await posicao(D, -23.5, -46.6, at(-4 * H));
  await posicao(D, -23.5009, -46.6, at(-10 * MIN));
  const E = await container("COLETADO", { coletadoEm: at(-5 * H), rastreioUltimoEnvioEm: at(-2 * H) });
  await posicao(E, -23.5, -46.6, at(-4 * H));
  await posicao(E, -23.545, -46.6, at(-10 * MIN));
  // F) Em trânsito sem nenhuma posição há 13 h.
  const F = await container("SAIU_FABRICA", { saidaFabricaEm: at(-14 * H), rastreioDesde: at(-13 * H), rastreioUltimoEnvioEm: at(-13 * H) });
  await prisma.alerta.create({ data: { containerId: B, tipo: "RISCO_DEMURRAGE", nivel: "ATENCAO", mensagem: "teste", chaveAberta: `${B}:RISCO_DEMURRAGE:ATENCAO` } });

  await executarRastreamento(at(90 * MIN));
  assert.equal((await pedidos(A)).length, 0, "A: ainda dentro da tolerância");
  const b1 = await pedidos(B);
  assert.equal(b1.length, 1);
  assert.equal(b1[0].motivo, "Risco de demurrage");
  assert.equal((await pedidos(C)).length, 0, "C: carregamento sem risco não pede");
  const d1 = await pedidos(D);
  assert.equal(d1.length, 1);
  assert.match(d1[0].motivo, /^Parado há 5h/);
  assert.equal((await pedidos(E)).length, 0, "E: em movimento, com posição recente");
  const f1 = await pedidos(F);
  assert.equal(f1.length, 1);
  assert.match(f1[0].motivo, /Sem posição há 14h30/);
  assert.ok((await prisma.solicitacaoPosicao.findFirst({ where: { containerId: F } })).motivo.startsWith("Sem posição"));

  await executarRastreamento(at(2 * H + 10 * MIN));
  const a1 = await pedidos(A);
  assert.equal(a1.length, 1);
  assert.match(a1[0].motivo, /^Previsão estourada: chegada ao carregamento planejada para/);
  assert.equal((await pedidos(B)).length, 1, "B: 40 min depois, ainda não repete (60 min)");
  await executarRastreamento(at(2 * H + 40 * MIN));
  assert.equal((await pedidos(B)).length, 2, "B: repete depois de 60 min enquanto houver risco");
  assert.equal((await pedidos(F)).length, 1, "F: 'sem posição' só repete a cada 12 h");

  // Resumo da aba: modo e motivos atuais.
  const rD = (await agentes.OPERADOR.get(`/api/containers/${D}/rastreamento`)).body;
  assert.equal(rD.modo, "CRITICO");
  assert.ok(rD.motivos.some((m) => m.startsWith("Parado há")));
  const rC = (await agentes.OPERADOR.get(`/api/containers/${C}/rastreamento`)).body;
  assert.deepEqual(rC.motivos, []);
  assert.equal(rC.proximoPedidoEm, null, "carregamento sem risco: nenhum pedido previsto");
  const rE = (await agentes.OPERADOR.get(`/api/containers/${E}/rastreamento`)).body;
  assert.ok(new Date(rE.proximoPedidoEm) > T, "em trânsito sem motivo: próxima checagem 'sem posição'");

  // Botão "Solicitar posição".
  assert.equal((await agentes.VISUALIZACAO.post(`/api/containers/${C}/solicitar-posicao`)).status, 403);
  const manual = await agentes.OPERADOR.post(`/api/containers/${C}/solicitar-posicao`);
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  assert.equal(manual.body.para, "Motorista Crítico");
  assert.equal((await pedidos(C))[0].motivo, "Pedido manual por OPERADOR");
  const repetido = await agentes.OPERADOR.post(`/api/containers/${C}/solicitar-posicao`);
  assert.equal(repetido.status, 429, "no máximo 1 a cada 5 min");
  assert.match(repetido.body.erro, /há menos de 5 min/);
  const log = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${C}`)).body;
  assert.ok(log.some((l) => l.descricao.includes("posição solicitada manualmente a critico@teste.local")));
  const semResp = await agentes.ADMIN.post("/api/containers").send({ numero: "CRTU7999990", confirmarDigito: true, tipo: "DRY_40", ...cad });
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${semResp.body.id}/solicitar-posicao`)).status, 409, "sem responsável");
  await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: 0 });
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${D}/solicitar-posicao`)).status, 409, "SMS desligado");

  await agentes.ADMIN.put("/api/configuracao").send(cfg);
  for (const id of [A, B, C, D, E, F, semResp.body.id]) await agentes.ADMIN.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste de trechos críticos" });
});

test("v3.1 acompanhamento pela página do link (reforço do SMS): regras, até a entrega, 1/min, parado, limites e SMS intocado", async () => {
  const { caixaDeSaidaSms } = await import("./lib/sms.js");
  const MIN = 60e3, H = 60 * MIN;
  const codigoDoSms = (s) => /\/p\/([A-Za-z0-9_-]+)$/.exec(s.texto)?.[1];
  const u = await agentes.ADMIN.post("/api/usuarios").send({ email: "acomp@teste.local", nome: "Motorista Acomp", perfil: "OPERADOR", senha: "senha-teste-123", celular: "11 96666-0000" });
  assert.equal(u.status, 201);
  const cfg = (await agentes.ADMIN.get("/api/configuracao")).body;
  await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: 1 });
  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  const c = await agentes.ADMIN.post("/api/containers").send({ numero: "ACPU9000000", confirmarDigito: true, tipo: "DRY_40", ...cad });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const envioAntes = new Date(Date.now() - 2 * H);
  await prisma.container.update({ where: { id: c.body.id }, data: { status: "COLETADO", coletadoEm: new Date(Date.now() - 3 * H), rastreioResponsavelId: u.body.id, rastreioDesde: new Date(Date.now() - 3 * H) } });
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${c.body.id}/solicitar-posicao`)).status, 201);
  const codigo = codigoDoSms(caixaDeSaidaSms.filter((s) => s.para === "+5511966660000").at(-1));
  assert.ok(codigo);
  const pos = { latitude: -23.5, longitude: -46.6, precisaoM: 12 };

  // Antes de responder o link: acompanhamento recusado; o link segue normal.
  assert.equal((await request(app).post(`/api/posicao/${codigo}/acompanhar`).send(pos)).status, 409);
  assert.equal((await request(app).get(`/api/posicao/${codigo}`)).body.podeAcompanhar, undefined, "link ainda não respondido: resposta de sempre");
  assert.equal((await request(app).post(`/api/posicao/${codigo}`).send(pos)).status, 201);
  await prisma.container.update({ where: { id: c.body.id }, data: { rastreioUltimoEnvioEm: envioAntes } });

  // Depois de responder: a página oferece o acompanhamento.
  const conf = (await request(app).get(`/api/posicao/${codigo}`)).body;
  assert.equal(conf.valido, false);
  assert.equal(conf.respondida, true);
  assert.equal(conf.podeAcompanhar, true);
  assert.equal(conf.numero, "ACPU9000000");

  // Posições: validadas, no máximo 1 por minuto.
  assert.equal((await request(app).post(`/api/posicao/${codigo}/acompanhar`).send({ latitude: 91, longitude: 0 })).status, 400);
  assert.equal((await request(app).post(`/api/posicao/${codigo}/acompanhar`).send({ ...pos, latitude: -23.51 })).status, 201);
  const cedo = await request(app).post(`/api/posicao/${codigo}/acompanhar`).send(pos);
  assert.equal(cedo.status, 429);
  await prisma.posicaoContainer.updateMany({ where: { containerId: c.body.id, origem: "ACOMPANHAMENTO" }, data: { registradaEm: new Date(Date.now() - 2 * MIN) } });
  assert.equal((await request(app).post(`/api/posicao/${codigo}/acompanhar`).send({ ...pos, latitude: -23.52 })).status, 201);
  const gravadas = await prisma.posicaoContainer.findMany({ where: { containerId: c.body.id, origem: "ACOMPANHAMENTO" } });
  assert.equal(gravadas.length, 2);
  assert.ok(gravadas.every((p) => p.usuarioId === u.body.id && p.etapa === "COLETADO"));

  // O SMS continua o principal: acompanhamento não mexe no controle de envios do agendador.
  const db = await prisma.container.findUnique({ where: { id: c.body.id } });
  assert.equal(db.rastreioUltimoEnvioEm.getTime(), envioAntes.getTime());

  // Ficha: acompanhamento ativo e posições com a origem.
  const r = (await agentes.OPERADOR.get(`/api/containers/${c.body.id}/rastreamento`)).body;
  assert.equal(r.acompanhamento.estado, "ATIVO");
  assert.equal(r.posicoes.filter((p) => p.origem === "ACOMPANHAMENTO").length, 2);
  const situacao = async () => (await agentes.OPERADOR.get(`/api/containers/${c.body.id}/rastreamento`)).body.acompanhamento;
  const estado = (e) => request(app).post(`/api/posicao/${codigo}/acompanhar/estado`).send({ estado: e });
  // Parou sem avisar (fechou, sem internet): sem sinal há mais de 7 min → "SEM_SINAL".
  await prisma.container.update({ where: { id: c.body.id }, data: { acompanhamentoSinalEm: new Date(Date.now() - 8 * MIN) } });
  const semSinal = await situacao();
  assert.equal(semSinal.estado, "SEM_SINAL");
  assert.equal(new Date(semSinal.desde).getTime() > Date.now() - 9 * MIN, true);
  // Avisos da página: minimizada → PAUSADO; voltou → ATIVO; Parar → ENCERRADO; inválido → 400.
  assert.equal((await estado("QUALQUER")).status, 400);
  assert.equal((await estado("PAUSADO")).status, 200);
  assert.equal((await situacao()).estado, "PAUSADO");
  assert.equal((await estado("ATIVO")).status, 200);
  assert.equal((await situacao()).estado, "ATIVO");
  assert.equal((await estado("ENCERRADO")).status, 200);
  assert.equal((await situacao()).estado, "ENCERRADO");
  // Uma posição nova reativa (o motorista recomeçou).
  await prisma.posicaoContainer.updateMany({ where: { containerId: c.body.id, origem: "ACOMPANHAMENTO" }, data: { registradaEm: new Date(Date.now() - 20 * MIN) } });
  assert.equal((await request(app).post(`/api/posicao/${codigo}/acompanhar`).send({ ...pos, latitude: -23.53 })).status, 201);
  assert.equal((await situacao()).estado, "ATIVO");
  await prisma.posicaoContainer.updateMany({ where: { containerId: c.body.id, origem: "ACOMPANHAMENTO" }, data: { registradaEm: new Date(Date.now() - 20 * MIN) } });

  // Responsável mudou: link não vale mais para acompanhar (nem para avisar a situação).
  await prisma.container.update({ where: { id: c.body.id }, data: { rastreioResponsavelId: null } });
  assert.equal((await request(app).post(`/api/posicao/${codigo}/acompanhar`).send(pos)).status, 409);
  assert.equal((await estado("ATIVO")).status, 409);
  await prisma.container.update({ where: { id: c.body.id }, data: { rastreioResponsavelId: u.body.id } });
  assert.equal((await request(app).post(`/api/posicao/${codigo}/acompanhar`).send(pos)).status, 201);

  // Sem prazo fixo: link respondido há 2 dias continua valendo (vai até a entrega).
  await prisma.solicitacaoPosicao.updateMany({ where: { containerId: c.body.id }, data: { respondidaEm: new Date(Date.now() - 48 * H) } });
  const contar = () => prisma.posicaoContainer.count({ where: { containerId: c.body.id, origem: "ACOMPANHAMENTO" } });
  const recuar = (min) => prisma.posicaoContainer.updateMany({ where: { containerId: c.body.id, origem: "ACOMPANHAMENTO" }, data: { registradaEm: new Date(Date.now() - min * MIN) } });
  await recuar(5);
  const antesParado = await contar();
  const parado = await request(app).post(`/api/posicao/${codigo}/acompanhar`).send({ ...pos, latitude: -23.5005 }); // ~55 m da última
  assert.equal(parado.status, 201);
  assert.equal(parado.body.gravada, false, "parado no mesmo lugar: recebida, não grava de novo antes de 15 min");
  assert.equal(await contar(), antesParado);
  await recuar(16);
  assert.equal((await request(app).post(`/api/posicao/${codigo}/acompanhar`).send({ ...pos, latitude: -23.5005 })).body.gravada, true, "parado: grava 1 a cada 15 min");
  assert.equal(await contar(), antesParado + 1);

  // Leitura de entrega no destino: o acompanhamento termina.
  await recuar(5);
  await prisma.container.update({ where: { id: c.body.id }, data: { status: "ENTREGUE_PORTO", entreguePortoEm: new Date() } });
  const fim = await request(app).post(`/api/posicao/${codigo}/acompanhar`).send(pos);
  assert.equal(fim.status, 409);
  assert.match(fim.body.erro, /encerrado/);
  assert.equal((await request(app).get(`/api/posicao/${codigo}`)).body.podeAcompanhar, false, "container entregue");

  // Limite por link (laço/defeito): passa de 15 em 5 min → "Muitas tentativas".
  let limitado = null;
  for (let i = 0; i < 20 && !limitado; i++) {
    const x = await request(app).post(`/api/posicao/${codigo}/acompanhar`).send(pos);
    if (x.status === 429) limitado = x.body.erro;
  }
  assert.match(limitado ?? "", /Muitas tentativas/);
  // ... e o limite do acompanhamento não consome o do link do SMS (o principal).
  assert.equal((await request(app).get(`/api/posicao/${codigo}`)).status, 200);

  await agentes.ADMIN.put("/api/configuracao").send(cfg);
});

test("v3.1 parado com posições densas (acompanhamento a cada 5 min): bloco contínuo no mesmo lugar", async () => {
  const executarRastreamento = naOrg((await import("./lib/rastreamento.js")).executarRastreamento);
  const MIN = 60e3, H = 60 * MIN;
  const T = new Date();
  const at = (ms) => new Date(T.getTime() + ms);
  const u = await agentes.ADMIN.post("/api/usuarios").send({ email: "denso@teste.local", nome: "Motorista Denso", perfil: "OPERADOR", senha: "senha-teste-123", celular: "11 95555-0000" });
  const cfg = (await agentes.ADMIN.get("/api/configuracao")).body;
  await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: 1, rastreioPersonalizado: 0 });
  const ativo = async (r) => (await agentes.ADMIN.get(`/api/${r}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  async function container(numero) {
    const r = await agentes.ADMIN.post("/api/containers").send({ numero, confirmarDigito: true, tipo: "DRY_40", ...cad });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await prisma.container.update({ where: { id: r.body.id }, data: { status: "COLETADO", coletadoEm: at(-6 * H), rastreioResponsavelId: u.body.id, rastreioDesde: at(-6 * H), rastreioUltimoEnvioEm: at(-2 * H) } });
    return r.body.id;
  }
  const serie = (id, pontos) => prisma.posicaoContainer.createMany({ data: pontos.map(([lat, lon, quando]) => ({ containerId: id, usuarioId: u.body.id, latitude: lat, longitude: lon, origem: "ACOMPANHAMENTO", etapa: "COLETADO", registradaEm: quando })) });
  const pedidos = (id) => prisma.mensagemSms.findMany({ where: { containerId: id, tipo: "POSICAO" } });

  // P) Andou até 5 h atrás e ficou 4 h parado, com posição a cada 5 min (pequenas variações do GPS).
  const P = await container("DNSU1000000");
  const pontosP = [[-23.3, -46.6, at(-5 * H)]];
  for (let m = 240; m >= 5; m -= 5) pontosP.push([-23.5 + (m % 3) * 0.0002, -46.6, at(-m * MIN)]);
  await serie(P, pontosP);
  // M) Andando: posição a cada 5 min, ~1 km entre elas.
  const M = await container("DNSU2000000");
  const pontosM = [];
  for (let m = 240; m >= 5; m -= 5) pontosM.push([-23.5 + m * 0.002, -46.6, at(-m * MIN)]);
  await serie(M, pontosM);

  const rP = (await agentes.OPERADOR.get(`/api/containers/${P}/rastreamento`)).body;
  assert.ok(rP.motivos.some((m) => /^Parado há 4h/.test(m)), JSON.stringify(rP.motivos));
  assert.deepEqual((await agentes.OPERADOR.get(`/api/containers/${M}/rastreamento`)).body.motivos, []);

  await executarRastreamento(at(1 * MIN));
  const pP = await pedidos(P);
  assert.equal(pP.length, 1);
  assert.match(pP[0].motivo, /^Parado há 4h/);
  assert.equal((await pedidos(M)).length, 0, "em movimento: nada");

  await agentes.ADMIN.put("/api/configuracao").send(cfg);
  for (const id of [P, M]) await agentes.ADMIN.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste parado denso" });
});

test("motoristas: acesso pelo celular com código SMS, QR, rastreamento, gestor da transportadora e retenção", async () => {
  const { caixaDeSaidaSms } = await import("./lib/sms.js");
  const { purgarDadosAntigos } = await import("./lib/rastreamento.js");
  const executarRastreamento = naOrg((await import("./lib/rastreamento.js")).executarRastreamento);
  const XFF = { "X-Forwarded-For": "198.51.100.20" };
  const codigoDe = (tel) => /codigo de acesso e (\d{6})/.exec(caixaDeSaidaSms.filter((s) => s.para === tel).at(-1)?.texto ?? "")?.[1];
  // v3.3: o pedido de código exige a etiqueta lida (define o cliente do teto de SMS).
  const [etqLogin] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  const pedir = (ag, celular) => ag.post("/api/motorista/codigo").set(XFF).send({ celular, etiqueta: etqLogin.token });
  const verificar = (ag, celular, codigo) => ag.post("/api/motorista/verificar").set(XFF).send({ celular, codigo });
  const liberarNovoPedido = (celular) => prisma.codigoAcessoMotorista.updateMany({ where: { celular }, data: { criadoEm: new Date(Date.now() - 2 * 60e3) } });

  // Transportadoras (cadastro).
  const alfa = await agentes.SUPERVISOR.post("/api/transportadoras").send({ nome: "Transp Alfa", cnpj: "11.444.777/0001-61" });
  assert.equal(alfa.status, 201, JSON.stringify(alfa.body));
  const beta = (await agentes.SUPERVISOR.post("/api/transportadoras").send({ nome: "Transp Beta" })).body;
  assert.equal((await agentes.SUPERVISOR.post("/api/transportadoras").send({ nome: "X", cnpj: "123" })).status, 400);

  // ---- Código por SMS ----
  const m1 = request.agent(app);
  assert.equal((await pedir(m1, "123")).status, 400);
  const TEL = "+5511955550001";
  const p1 = await pedir(m1, "(11) 95555-0001");
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.simulado, true);
  const cod1 = codigoDe(TEL);
  assert.match(cod1, /^\d{6}$/);
  const salvo = await prisma.codigoAcessoMotorista.findFirst({ where: { celular: TEL }, orderBy: { id: "desc" } });
  assert.notEqual(salvo.codigoHash, cod1, "só o hash fica no banco");
  assert.equal(Math.round((salvo.expiraEm - salvo.criadoEm) / 60e3), 15, "vale 15 min");
  assert.equal((await pedir(m1, TEL)).status, 429, "1 pedido por minuto");
  // Novo pedido encerra o anterior.
  await liberarNovoPedido(TEL);
  assert.equal((await pedir(m1, TEL)).status, 200);
  const cod2 = codigoDe(TEL);
  if (cod1 !== cod2) assert.equal((await verificar(m1, TEL, cod1)).status, 400, "código antigo não vale mais");
  // Expirado.
  await prisma.codigoAcessoMotorista.updateMany({ where: { celular: TEL, encerradoEm: null }, data: { expiraEm: new Date(Date.now() - 1000) } });
  assert.match((await verificar(m1, TEL, cod2)).body.erro, /expirado/);
  // Tentativas: 5 erradas encerram o código.
  const TEL2 = "+5511955550002";
  const m2 = request.agent(app);
  await pedir(m2, TEL2);
  const certo2 = codigoDe(TEL2);
  const errado = certo2 === "000000" ? "111111" : "000000";
  for (let i = 1; i <= 4; i++) assert.match((await verificar(m2, TEL2, errado)).body.erro, new RegExp(`Restam ${5 - i}`));
  assert.match((await verificar(m2, TEL2, errado)).body.erro, /Limite de tentativas/);
  assert.equal((await verificar(m2, TEL2, certo2)).status, 400, "depois do limite nem o certo vale");

  // ---- Primeiro acesso: código certo → cadastro ----
  await liberarNovoPedido(TEL);
  await pedir(m1, TEL);
  const v = await verificar(m1, TEL, codigoDe(TEL));
  assert.equal(v.status, 200);
  assert.equal(v.body.precisaCadastro, true);
  assert.ok(v.body.transportadoras.some((t) => t.nome === "Transp Alfa"));
  assert.equal((await verificar(m1, TEL, codigoDe(TEL))).status, 400, "código de uso único");
  const cad = (extra) => m1.post("/api/motorista/cadastro").set(XFF).send({ comprovante: v.body.comprovante, nome: "João da Silva", transportadoraId: alfa.body.id, placa: "abc1d23", aceite: true, ...extra });
  assert.equal((await cad({ aceite: false })).status, 400, "precisa aceitar o termo");
  assert.equal((await cad({ cpf: "111.111.111-11" })).status, 400, "CPF inválido");
  assert.equal((await m1.post("/api/motorista/cadastro").set(XFF).send({ comprovante: "forjado", nome: "X Y Z", transportadoraId: alfa.body.id, aceite: true })).status, 401);
  const feito = await cad({});
  assert.equal(feito.status, 201, JSON.stringify(feito.body));
  assert.equal(feito.body.motorista.placa, "ABC1D23");
  const cookie = feito.headers["set-cookie"].find((x) => x.startsWith("cc_motorista="));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Path=\/api\/motorista/);
  const token = cookie.split(";")[0].split("=")[1];
  assert.equal(await prisma.sessaoMotorista.count({ where: { tokenHash: token } }), 0, "só o hash da sessão fica no banco");
  const motorista = await prisma.motorista.findUnique({ where: { celular: TEL } });
  assert.ok(motorista.consentimentoEm);
  assert.equal((await m1.get("/api/motorista/eu")).body.motorista.nome, "João da Silva");
  assert.equal((await m1.get("/api/containers")).status, 401, "motorista não é usuário: resto do sistema fechado");
  assert.equal((await request(app).get("/api/motorista/eu")).status, 401, "sem cookie, sem acesso");

  // ---- QR pelo motorista (papel de Transportador) + rastreamento ----
  const cfg = (await agentes.ADMIN.get("/api/configuracao")).body;
  await agentes.ADMIN.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: 1, rastreioPersonalizado: 1 });
  const ativo = async (rec) => (await agentes.ADMIN.get(`/api/${rec}?ativos=1`)).body[0].id;
  const base = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores"), produtoId: await ativo("produtos") };
  const c = await agentes.ADMIN.post("/api/containers").send({ numero: "MOTU8000008", confirmarDigito: true, tipo: "REEFER_40", ...base });
  assert.equal(c.status, 201);
  const [e] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  assert.equal((await m1.get(`/api/motorista/qr/${e.token}`)).body.modoTransportador, true);
  assert.equal((await m1.post(`/api/motorista/qr/${e.token}/portaria`).send({ numero: "MOTU8000008", movimento: "ENTRADA", temperatura: -18 })).status, 403);
  const col = await m1.post(`/api/motorista/qr/${e.token}/coleta`).send({ numero: "MOTU8000008", portoRetiradaId: ids.santos, temperatura: -18, latitude: -23.95, longitude: -46.33 });
  assert.equal(col.status, 201, JSON.stringify(col.body));
  let db = await prisma.container.findUnique({ where: { id: c.body.id } });
  assert.equal(db.status, "COLETADO");
  assert.equal(db.rastreioMotoristaId, motorista.id);
  assert.equal(db.rastreioResponsavelId, null);
  assert.ok(caixaDeSaidaSms.some((s) => s.para === TEL && s.texto.includes("MOTU8000008") && s.texto.includes("vinculado")));
  const ev = (await agentes.ADMIN.get(`/api/containers/${c.body.id}`)).body.eventos.find((x) => x.statusPara === "COLETADO");
  assert.equal(ev.usuarioEmail, "João da Silva (motorista · Transp Alfa)");
  const r = (await agentes.OPERADOR.get(`/api/containers/${c.body.id}/rastreamento`)).body;
  assert.equal(r.responsavel.tipo, "MOTORISTA");
  assert.equal(r.responsavel.transportadora, "Transp Alfa");
  assert.equal(r.posicoes[0].usuario, "João da Silva");
  // Pedido de posição para o motorista e resposta pelo link.
  await executarRastreamento(new Date(Date.now() + 31 * 60e3));
  const linkMot = /\/p\/([A-Za-z0-9_-]+)$/.exec(caixaDeSaidaSms.filter((s) => s.para === TEL).at(-1).texto)?.[1];
  assert.ok(linkMot, "pedido de posição chegou ao motorista");
  assert.equal((await request(app).get(`/api/posicao/${linkMot}`)).body.valido, true);
  // Operador registra pelo QR: responsável passa a ser o usuário e o link do motorista cai.
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e.token}/leituras`).send({ temperatura: -18 })).status, 201);
  db = await prisma.container.findUnique({ where: { id: c.body.id } });
  assert.equal(db.rastreioMotoristaId, null);
  assert.ok(db.rastreioResponsavelId);
  assert.equal((await request(app).get(`/api/posicao/${linkMot}`)).body.valido, false);
  // Motorista registra de novo: volta para ele.
  assert.equal((await m1.post(`/api/motorista/qr/${e.token}/leituras`).send({ temperatura: -18.2 })).status, 201);
  db = await prisma.container.findUnique({ where: { id: c.body.id } });
  assert.deepEqual([db.rastreioMotoristaId, db.rastreioResponsavelId], [motorista.id, null]);

  // ---- Gestor da transportadora ----
  assert.equal((await agentes.ADMIN.post("/api/usuarios").send({ email: "gestor@teste.local", nome: "Gestor Alfa", perfil: "GESTOR_TRANSPORTADORA", senha: "senha-teste-123" })).status, 400, "gestor precisa de transportadora");
  const g = await agentes.ADMIN.post("/api/usuarios").send({ email: "gestor@teste.local", nome: "Gestor Alfa", perfil: "GESTOR_TRANSPORTADORA", senha: "senha-teste-123", transportadoraId: alfa.body.id });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const gestor = await logar("gestor@teste.local");
  assert.equal((await gestor.get("/api/containers")).status, 403, "gestor só vê motoristas");
  assert.equal((await gestor.get("/api/usuarios")).status, 403);
  // Motorista da outra transportadora (pré-cadastro pela administração).
  const mb = await agentes.SUPERVISOR.post("/api/motoristas").send({ nome: "Maria Beta", celular: "11955550009", transportadoraId: beta.id });
  assert.equal(mb.status, 201, JSON.stringify(mb.body));
  assert.equal(mb.body.consentimentoEm, null, "pré-cadastro: termo aceito só no 1º acesso");
  assert.equal((await agentes.SUPERVISOR.post("/api/motoristas").send({ nome: "Outro Nome", celular: "11955550009", transportadoraId: beta.id })).status, 409);
  const lista = (await gestor.get("/api/motoristas")).body;
  assert.deepEqual(lista.map((x) => x.nome), ["João da Silva"], "gestor vê só os da própria transportadora");
  assert.equal(lista[0].sessoesAtivas, 1);
  assert.equal((await gestor.patch(`/api/motoristas/${mb.body.id}`).send({ bloqueado: true })).status, 404, "não mexe em motorista de outra");
  assert.equal((await agentes.VISUALIZACAO.get("/api/motoristas")).status, 403);
  assert.ok((await agentes.SUPERVISOR.get("/api/motoristas")).body.length >= 2, "administração vê todos");
  // Pré-cadastro pelo gestor: transportadora é sempre a dele.
  const pre = await gestor.post("/api/motoristas").send({ nome: "Pedro Pré", celular: "11955550010", transportadoraId: beta.id, placa: "XYZ9A88" });
  assert.equal(pre.status, 201);
  assert.equal(pre.body.transportadora.nome, "Transp Alfa");
  // Pré-cadastrado entra: confirma o celular, vê os dados preenchidos e aceita o termo (mesmo registro).
  const m3 = request.agent(app);
  await pedir(m3, "11955550010");
  const v3 = await verificar(m3, "11955550010", codigoDe("+5511955550010"));
  assert.equal(v3.body.precisaCadastro, true);
  assert.equal(v3.body.preenchido.nome, "Pedro Pré");
  const c3 = await m3.post("/api/motorista/cadastro").set(XFF).send({ comprovante: v3.body.comprovante, nome: "Pedro Pré", transportadoraId: alfa.body.id, placa: "XYZ9A88", aceite: true });
  assert.equal(c3.status, 201);
  assert.equal(c3.body.motorista.id, pre.body.id);

  // Bloqueio do gestor (v3.5): vale só neste cliente — o acesso dele segue, mas o QR e o código deste cliente recusam.
  const bl = await gestor.patch(`/api/motoristas/${motorista.id}`).send({ bloqueado: true });
  assert.equal(bl.status, 200);
  assert.equal(bl.body.bloqueado, true);
  assert.equal((await m1.get("/api/motorista/eu")).status, 200, "não derruba o acesso nos outros clientes");
  const qrBloq = await m1.get(`/api/motorista/qr/${e.token}`);
  assert.deepEqual([qrBloq.status, qrBloq.body.codigo], [403, "BLOQUEADO_NO_CLIENTE"]);
  assert.equal((await prisma.motorista.findUnique({ where: { id: motorista.id } })).bloqueado, false, "não grava o bloqueio global");
  await liberarNovoPedido(TEL);
  assert.equal((await pedir(m1, TEL)).status, 403);
  const logB = (await agentes.ADMIN.get(`/api/logs?entidade=Motorista&entidadeId=${motorista.id}`)).body;
  assert.ok(logB.some((l) => l.acao === "BLOQUEAR" && l.usuarioEmail === "gestor@teste.local"));
  // SMS para motorista bloqueado não sai (registra a falha).
  await prisma.container.update({ where: { id: c.body.id }, data: { rastreioUltimoEnvioEm: new Date(Date.now() - 60 * 60e3) } });
  await executarRastreamento();
  const ultimo = await prisma.mensagemSms.findFirst({ where: { containerId: c.body.id }, orderBy: { id: "desc" } });
  assert.deepEqual([ultimo.status, ultimo.erro], ["FALHA", "Motorista bloqueado por este cliente."]);
  // Desbloquear: volta a poder entrar (já cadastrado: entra direto).
  await gestor.patch(`/api/motoristas/${motorista.id}`).send({ bloqueado: false });
  await liberarNovoPedido(TEL);
  assert.equal((await pedir(m1, TEL)).status, 200);
  assert.equal((await verificar(m1, TEL, codigoDe(TEL))).body.motorista.nome, "João da Silva");
  assert.equal((await m1.get("/api/motorista/eu")).status, 200);
  // Encerrar acessos (celular perdido).
  assert.ok((await gestor.post(`/api/motoristas/${motorista.id}/encerrar-sessoes`)).body.encerradas >= 1);
  assert.equal((await m1.get("/api/motorista/eu")).status, 401);

  // ---- Planilha de motoristas (gestor) ----
  const ExcelJS = (await import("exceljs")).default;
  const binario = (res, cb) => { const partes = []; res.on("data", (x) => partes.push(x)); res.on("end", () => cb(null, Buffer.concat(partes))); };
  const modelo = await gestor.get("/api/motoristas/modelo").buffer(true).parse(binario);
  assert.equal(modelo.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(modelo.body);
  const ws = wb.getWorksheet("Motoristas");
  assert.deepEqual(ws.getRow(1).values.slice(1), ["Nome *", "Celular *", "Placa", "CPF"], "gestor: sem coluna de transportadora");
  ws.addRow(["Ana Planilha", "11955550011", "QWE1234", "529.982.247-25"]);
  ws.addRow(["Celular Ruim", "123"]);
  ws.addRow(["Repetido Aqui", "11955550010"]);
  const arq = Buffer.from(await wb.xlsx.writeBuffer());
  const prev = await gestor.post("/api/motoristas/importar").set("Content-Type", "application/octet-stream").send(arq);
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.deepEqual([prev.body.validos, prev.body.comErro], [1, 2]);
  assert.equal(await prisma.motorista.count({ where: { celular: "+5511955550011" } }), 0, "prévia não grava");
  const conf = await gestor.post("/api/motoristas/importar?confirmar=1").set("Content-Type", "application/octet-stream").send(arq);
  assert.equal(conf.body.importados, 1);
  const ana = await prisma.motorista.findUnique({ where: { celular: "+5511955550011" }, include: { transportadora: true } });
  assert.deepEqual([ana.transportadora.nome, ana.cpf, ana.consentimentoEm], ["Transp Alfa", "52998224725", null]);

  // ---- Retenção (LGPD): posição com mais de 90 dias é apagada; recente fica ----
  const velha = await prisma.posicaoContainer.create({ data: { containerId: c.body.id, latitude: -23, longitude: -46, origem: "QR", etapa: "COLETADO", registradaEm: new Date(Date.now() - 91 * 24 * 3600e3) } });
  const recentes = await prisma.posicaoContainer.count({ where: { containerId: c.body.id, id: { not: velha.id } } });
  await purgarDadosAntigos();
  assert.equal(await prisma.posicaoContainer.count({ where: { id: velha.id } }), 0);
  assert.equal(await prisma.posicaoContainer.count({ where: { containerId: c.body.id } }), recentes);

  await agentes.ADMIN.put("/api/configuracao").send(cfg);
  await agentes.ADMIN.post(`/api/containers/${c.body.id}/cancelar`).send({ motivo: "fim do teste de motoristas" });
});

test("QR da coleta: trajeto programado vem preenchido; quem lê confirma ou corrige carregamento e entrega", async () => {
  const tr = await logar("transportador@teste.local");
  const ativo = async (rec) => (await agentes.ADMIN.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  const c = await agentes.ADMIN.post("/api/containers").send({
    numero: "TRJU5500551", confirmarDigito: true, tipo: "DRY_40", ...cad,
    portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.santos,
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));

  // Opções da coleta trazem também os locais de carregamento.
  const op = (await tr.get("/api/qr/opcoes/coleta")).body;
  assert.ok(op.locaisCarregamento.some((l) => l.id === ids.cubatao));
  assert.ok(!op.locaisCarregamento.some((l) => l.id === ids.santos), "porto não é local de carregamento");

  // Etiqueta nova: ao digitar o número, a tela busca a programação.
  const prog = (await tr.get("/api/qr/opcoes/container/trju 550055 1")).body;
  assert.equal(prog.cadastrado, true);
  assert.deepEqual(prog.trajeto, { portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.santos });
  assert.equal((await tr.get("/api/qr/opcoes/container/ZZZU0000000")).body.cadastrado, false);
  assert.equal((await agentes.VISUALIZACAO.get("/api/qr/opcoes/container/TRJU5500551")).status, 403);

  // Coleta confirmando a retirada e corrigindo a entrega (Santos → Terminal Ferroviário).
  const [e] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  assert.equal((await tr.post(`/api/qr/${e.token}/coleta`).send({ numero: "TRJU5500551", portoRetiradaId: ids.santos, localCarregamentoId: ids.santos })).status, 400, "carregamento precisa ser fábrica/armazém");
  const col = await tr.post(`/api/qr/${e.token}/coleta`).send({ numero: "TRJU5500551", portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.ferro });
  assert.equal(col.status, 201, JSON.stringify(col.body));
  assert.deepEqual(col.body.container.trajeto, { portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.ferro }, "leitura do QR devolve o trajeto (tela preenchida)");
  const db = await prisma.container.findUnique({ where: { id: c.body.id } });
  assert.deepEqual([db.status, db.portoEntregaId, db.localCarregamentoId], ["COLETADO", ids.ferro, ids.cubatao]);
  const log = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${c.body.id}`)).body;
  assert.ok(log.some((l) => l.descricao.includes("local de entrega alterado na leitura")));
  assert.ok(!log.some((l) => l.descricao.includes("local de carregamento alterado")), "carregamento só confirmado");
  await agentes.ADMIN.post(`/api/containers/${c.body.id}/cancelar`).send({ motivo: "fim do teste do trajeto" });
});

test("v1.2 trajeto com Ponto Fiscal: cadastro, editar trajeto, recálculo, Planejado e passagem (ficha e QR)", async () => {
  const PF = ids.tipo["Ponto Fiscal"];
  // Cadastro: posição no trajeto é obrigatória; tempo de parada vazio = 1 h; fila não se aplica.
  assert.equal((await agentes.SUPERVISOR.post("/api/locais").send({ nome: "PF Sem Posição", tipoId: PF })).status, 400);
  const pf1 = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Posto Fiscal Cubatão", tipoId: PF, posicaoParada: "ANTES_CARREGAMENTO", tempoParadaHoras: 2, filaHoras: 5, latitude: -23.91, longitude: -46.40 });
  assert.equal(pf1.status, 201, JSON.stringify(pf1.body));
  assert.deepEqual([pf1.body.posicaoParada, pf1.body.tempoParadaHoras, pf1.body.filaHoras], ["ANTES_CARREGAMENTO", 2, null]);
  const pf2 = (await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Posto Fiscal Santos", tipoId: PF, posicaoParada: "APOS_CARREGAMENTO", latitude: -23.93, longitude: -46.35 })).body;
  assert.equal(pf2.tempoParadaHoras, 1, "tempo padrão 1 h");
  const paradas = (await agentes.OPERADOR.get("/api/locais?funcao=PARADA")).body.map((l) => l.nome);
  assert.ok(paradas.includes("Posto Fiscal Cubatão") && paradas.includes("Posto Fiscal Santos"));

  const ativo = async (rec) => (await agentes.ADMIN.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  // Ponto fiscal não serve como retirada.
  assert.equal((await agentes.ADMIN.post("/api/containers").send({ numero: "PFTU1000000", confirmarDigito: true, tipo: "DRY_40", ...cad, portoRetiradaId: pf1.body.id })).status, 400);
  const c = await agentes.ADMIN.post("/api/containers").send({
    numero: "PFTU1000001", confirmarDigito: true, tipo: "DRY_40", ...cad,
    portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.santos,
    coletaProgramadaEm: new Date(Date.now() + 48 * 3600e3).toISOString(),
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = c.body.id;
  const antes = (await agentes.ADMIN.get(`/api/containers/${id}`)).body;
  assert.equal(antes.situacao.previsao.disponivel, true);
  assert.deepEqual(antes.paradas, []);
  const planoAntes = antes.planejamento;
  assert.ok(planoAntes?.NA_FABRICA, "Planejado gravado");

  // Validações do Editar trajeto.
  const P = (papel, localId, paradaId) => ({ papel, localId, ...(paradaId ? { paradaId } : {}) });
  const put = (ag, pontos) => ag.put(`/api/containers/${id}/trajeto`).send({ pontos });
  assert.equal((await put(agentes.VISUALIZACAO, [P("RETIRADA", ids.santos), P("CARREGAMENTO", ids.cubatao), P("ENTREGA", ids.santos)])).status, 403);
  assert.equal((await put(agentes.OPERADOR, [P("CARREGAMENTO", ids.cubatao), P("RETIRADA", ids.santos), P("ENTREGA", ids.santos)])).status, 400, "começa na retirada");
  assert.equal((await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("CARREGAMENTO", pf1.body.id), P("ENTREGA", ids.santos)])).status, 400, "ponto fiscal não é carregamento");
  assert.equal((await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("PARADA", ids.cubatao), P("CARREGAMENTO", ids.cubatao), P("ENTREGA", ids.santos)])).status, 400, "armazém não é parada");
  assert.equal((await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("PARADA", pf1.body.id), P("PARADA", pf1.body.id), P("CARREGAMENTO", ids.cubatao), P("ENTREGA", ids.santos)])).status, 400, "parada repetida");
  assert.equal((await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("CARREGAMENTO", ids.cubatao)])).status, 400, "sem entrega");

  // Adiciona o ponto fiscal antes do carregamento: trechos, tempo parado, ciclo e Planejado recalculados.
  const r1 = await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("PARADA", pf1.body.id), P("CARREGAMENTO", ids.cubatao), P("ENTREGA", ids.santos)]);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.paradas.length, 1);
  assert.deepEqual([r1.body.paradas[0].nome, r1.body.paradas[0].fase, r1.body.paradas[0].tempoParadaHoras], ["Posto Fiscal Cubatão", "ANTES_CARREGAMENTO", 2]);
  const prev = r1.body.situacao.previsao;
  const etapas = prev.trechos.map((t) => t.etapa);
  assert.deepEqual(etapas.slice(0, 3), ["Retirada → Posto Fiscal Cubatão (vazio)", "Parada: Posto Fiscal Cubatão", "Posto Fiscal Cubatão → carregamento (vazio)"]);
  assert.equal(prev.trechos[1].horas, 2);
  assert.ok(prev.cicloHoras >= antes.situacao.previsao.cicloHoras + 1.9, `ciclo soma a parada (${antes.situacao.previsao.cicloHoras} → ${prev.cicloHoras})`);
  assert.equal(prev.paradas[0].nome, "Posto Fiscal Cubatão");
  assert.ok(prev.paradas[0].previsao, "passagem prevista");
  const paradaId = r1.body.paradas[0].id;
  assert.ok(r1.body.planejamento.PARADAS?.[paradaId], "Programado: Planejado refeito com a parada");
  assert.notDeepEqual(r1.body.planejamento, planoAntes);
  const log = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${id}`)).body;
  assert.ok(log.some((l) => l.acao === "TRAJETO" && l.descricao.includes("agora: Porto de Santos → Posto Fiscal Cubatão → Armazém Cubatão → Porto de Santos")));

  // Arrastar para depois do carregamento: mesma parada (id), fase muda; segunda parada entra.
  const r2 = await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("CARREGAMENTO", ids.cubatao), P("PARADA", pf2.id), P("PARADA", pf1.body.id, paradaId), P("ENTREGA", ids.santos)]);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.deepEqual(r2.body.paradas.map((p) => [p.nome, p.fase, p.ordem]), [["Posto Fiscal Santos", "APOS_CARREGAMENTO", 0], ["Posto Fiscal Cubatão", "APOS_CARREGAMENTO", 1]]);
  assert.equal(r2.body.paradas[1].id, paradaId, "parada mantida (mesmo id)");
  // Passagem antes da coleta / depois do carregamento sem saída: recusadas.
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${id}/paradas/${paradaId}/passagem`).send({})).status, 409);

  // Volta o ponto para antes do carregamento e coleta o container: depois da coleta o Planejado não muda.
  await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("PARADA", pf1.body.id, paradaId), P("CARREGAMENTO", ids.cubatao), P("ENTREGA", ids.santos)]);
  const coletadoEm = new Date(Date.now() - 5 * 3600e3);
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${id}/avancar`).send({ ocorridoEm: coletadoEm.toISOString() })).status, 200);
  const coletado = (await agentes.ADMIN.get(`/api/containers/${id}`)).body;
  const planoColetado = coletado.planejamento;
  const r3 = await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("PARADA", pf1.body.id, paradaId), P("CARREGAMENTO", ids.cubatao), P("PARADA", pf2.id), P("ENTREGA", ids.santos)]);
  assert.deepEqual(r3.body.planejamento, planoColetado, "coletado: Planejado mantido");
  assert.equal(r3.body.situacao.previsao.paradas.length, 2, "ETA com as duas paradas");

  // Passagem pela ficha: horário real vira base do trecho seguinte.
  const passouEm = new Date(Date.now() - 2 * 3600e3);
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${id}/paradas/${paradaId}/passagem`).send({ passouEm: new Date(coletadoEm.getTime() - 60e3).toISOString() })).status, 400, "antes da coleta");
  const pass = await agentes.OPERADOR.post(`/api/containers/${id}/paradas/${paradaId}/passagem`).send({ passouEm: passouEm.toISOString() });
  assert.equal(pass.status, 201, JSON.stringify(pass.body));
  const pp = pass.body.paradas.find((p) => p.id === paradaId);
  assert.deepEqual([new Date(pp.passouEm).getTime(), pp.origemRegistro, pp.registradoPor], [passouEm.getTime(), "FICHA", "operador@teste.local"]);
  const marco = pass.body.situacao.previsao.paradas.find((m) => m.paradaId === paradaId);
  assert.equal(new Date(marco.realizado).getTime(), passouEm.getTime());
  const trechoSeguinte = pass.body.situacao.previsao.trechos.find((t) => t.etapa === "Posto Fiscal Cubatão → carregamento (vazio)");
  assert.equal(new Date(trechoSeguinte.inicio).getTime(), passouEm.getTime(), "trecho seguinte parte do horário real");
  assert.equal(pass.body.status, "COLETADO", "passagem não muda o status");
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${id}/paradas/${paradaId}/passagem`).send({})).status, 409, "já registrada");
  // Parada com passagem: não pode sair do trajeto nem trocar de lado.
  assert.equal((await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("CARREGAMENTO", ids.cubatao), P("ENTREGA", ids.santos)])).status, 409);
  assert.equal((await put(agentes.OPERADOR, [P("RETIRADA", ids.santos), P("CARREGAMENTO", ids.cubatao), P("PARADA", pf1.body.id, paradaId), P("ENTREGA", ids.santos)])).status, 409);
  // Desfazer: só quem corrige.
  assert.equal((await agentes.OPERADOR.delete(`/api/containers/${id}/paradas/${paradaId}/passagem`)).status, 403);
  assert.equal((await agentes.SUPERVISOR.delete(`/api/containers/${id}/paradas/${paradaId}/passagem`)).status, 200);

  // Passagem pelo QR (no próprio ponto): o QR oferece a próxima parada pendente da etapa.
  const [e] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e.token}/vincular`).send({ numero: "PFTU1000001" })).status, 201);
  const leitura = (await agentes.OPERADOR.get(`/api/qr/${e.token}`)).body;
  assert.deepEqual(leitura.container.proximaParada, { id: paradaId, nome: "Posto Fiscal Cubatão", fase: "ANTES_CARREGAMENTO" });
  const qr = await agentes.OPERADOR.post(`/api/qr/${e.token}/passagem`).send({ latitude: -23.91, longitude: -46.4, precisaoM: 10 });
  assert.equal(qr.status, 201, JSON.stringify(qr.body));
  assert.equal(qr.body.passagem, "Posto Fiscal Cubatão");
  assert.equal(qr.body.container.proximaParada, null, "depois do carregamento vem a outra (só após a saída)");
  const db = await prisma.paradaContainer.findUnique({ where: { id: paradaId } });
  assert.deepEqual([db.origemRegistro, Number(db.latitude)], ["QR", -23.91]);
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e.token}/passagem`).send({})).status, 409, "nada pendente nesta etapa");
  const log2 = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${id}`)).body;
  assert.ok(log2.some((l) => l.acao === "PASSAGEM" && l.descricao.includes("pelo QR")));
  assert.ok(log2.some((l) => l.acao === "DESFAZER" && l.descricao.includes("passagem por Posto Fiscal Cubatão desfeita")));

  // Local de parada usado não pode mudar de função.
  assert.equal((await agentes.SUPERVISOR.patch(`/api/locais/${pf1.body.id}`).send({ tipoId: ids.tipo["Armazém"] })).status, 409);
  await agentes.ADMIN.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste de paradas" });
});

test("v1.3: Ponto de Carregamento como parada (checkbox) e motorista/placa do QR no container", async () => {
  const assumirRastreio = naOrg((await import("./lib/rastreamento.js")).assumirRastreio);
  // Ponto de Carregamento marcado como possível ponto de parada.
  const g = await agentes.SUPERVISOR.post("/api/grupos").send({ cliente: "Parada SA", fabrica: "Fábrica Parada", metaEstadiaHoras: 12 });
  assert.equal(g.status, 201);
  assert.equal(g.body.podeSerParada, false, "padrão: não é parada");
  assert.equal((await agentes.SUPERVISOR.patch(`/api/grupos/${g.body.id}`).send({ podeSerParada: true, posicaoParada: "ANTES_CARREGAMENTO" })).status, 400, "precisa do local (endereço)");
  assert.equal((await agentes.SUPERVISOR.patch(`/api/grupos/${g.body.id}`).send({ localId: ids.rioVerde, podeSerParada: true })).status, 400, "precisa da posição");
  const marcado = await agentes.SUPERVISOR.patch(`/api/grupos/${g.body.id}`).send({ localId: ids.rioVerde, podeSerParada: true, posicaoParada: "ANTES_CARREGAMENTO", tempoParadaHoras: 3 });
  assert.equal(marcado.status, 200, JSON.stringify(marcado.body));
  assert.deepEqual([marcado.body.podeSerParada, marcado.body.posicaoParada, marcado.body.tempoParadaHoras], [true, "ANTES_CARREGAMENTO", 3]);

  const ativo = async (rec) => (await agentes.ADMIN.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  const c = await agentes.ADMIN.post("/api/containers").send({
    numero: "PCPU1300001", confirmarDigito: true, tipo: "DRY_40", ...cad,
    portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.santos,
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const P = (papel, localId) => ({ papel, localId });
  const put = (pontos) => agentes.OPERADOR.put(`/api/containers/${c.body.id}/trajeto`).send({ pontos });
  // Local de fábrica NÃO marcado não serve como parada; marcado serve.
  const naoMarcado = await put([P("RETIRADA", ids.santos), P("PARADA", ids.cubatao), P("CARREGAMENTO", ids.rioVerde), P("ENTREGA", ids.santos)]);
  assert.equal(naoMarcado.status, 400);
  assert.match(naoMarcado.body.erro, /Pode ser ponto de parada/);
  const r = await put([P("RETIRADA", ids.santos), P("PARADA", ids.rioVerde), P("CARREGAMENTO", ids.cubatao), P("ENTREGA", ids.santos)]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.paradas[0].nome, r.body.paradas[0].tipo, r.body.paradas[0].tempoParadaHoras], ["Fábrica Rio Verde", "Ponto de Carregamento", 3]);
  const trechoParada = r.body.situacao.previsao.trechos.find((t) => t.etapa === "Parada: Fábrica Rio Verde");
  assert.equal(trechoParada?.horas, 3, "tempo de parada do Ponto de Carregamento");
  // O próprio local de carregamento não pode ser parada.
  assert.equal((await put([P("RETIRADA", ids.santos), P("PARADA", ids.rioVerde), P("CARREGAMENTO", ids.rioVerde), P("ENTREGA", ids.santos)])).status, 400);
  // Desmarcar limpa posição e tempo.
  const desmarcado = await agentes.SUPERVISOR.patch(`/api/grupos/${g.body.id}`).send({ podeSerParada: false });
  assert.deepEqual([desmarcado.body.posicaoParada, desmarcado.body.tempoParadaHoras], [null, null]);

  // Motorista e placa do motorista que registrou pelo QR vão para o container (e atualizam).
  const t = (await prisma.transportadora.findFirst({ where: { ativo: true } })) ?? (await prisma.transportadora.create({ data: { nome: "Transp V13" } }));
  const m = await prisma.motorista.create({ data: { nome: "Carlos Placa", celular: "+5511955551300", placa: "ABC1D23", transportadoraId: t.id, consentimentoEm: new Date() } });
  await assumirRastreio({ containerId: c.body.id, motoristaId: m.id });
  let db = await prisma.container.findUnique({ where: { id: c.body.id } });
  assert.deepEqual([db.motorista, db.placa], ["Carlos Placa", "ABC1D23"]);
  await prisma.motorista.update({ where: { id: m.id }, data: { placa: "XYZ9A88" } });
  await assumirRastreio({ containerId: c.body.id, motoristaId: m.id });
  db = await prisma.container.findUnique({ where: { id: c.body.id } });
  assert.equal(db.placa, "XYZ9A88", "placa trocada numa nova leitura atualiza o container");
  const log = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${c.body.id}`)).body;
  assert.ok(log.some((l) => l.descricao.includes("motorista/placa pela leitura do QR — Carlos Placa · XYZ9A88 (antes: Carlos Placa · ABC1D23)")));
  const lista = (await agentes.ADMIN.get("/api/containers")).body.find((x) => x.id === c.body.id);
  assert.deepEqual([lista.motorista, lista.placa], ["Carlos Placa", "XYZ9A88"], "aparece na lista de containers");
  await agentes.ADMIN.post(`/api/containers/${c.body.id}/cancelar`).send({ motivo: "fim do teste v1.3" });
});

test("v1.4: categoria do produto — Carga Seca sem temperatura (cadastro, ficha, QR, leitura)", async () => {
  // Cadastro: categoria válida; Congelado/Refrigerado exigem faixa; Carga Seca não tem faixa.
  assert.equal((await agentes.SUPERVISOR.post("/api/produtos").send({ nome: "Inválido", categoria: "OUTRA" })).status, 400);
  assert.equal((await agentes.SUPERVISOR.post("/api/produtos").send({ nome: "Congelado sem faixa", categoria: "CONGELADO" })).status, 400);
  const seca = await agentes.SUPERVISOR.post("/api/produtos").send({ nome: "Carga Seca V14", categoria: "CARGA_SECA", setpoint: -18, tempMin: -20, tempMax: -16 });
  assert.equal(seca.status, 201, JSON.stringify(seca.body));
  assert.deepEqual([seca.body.categoria, seca.body.setpoint, seca.body.tempMin, seca.body.tempMax], ["CARGA_SECA", null, null, null], "faixa ignorada na Carga Seca");
  const refri = await agentes.SUPERVISOR.post("/api/produtos").send({ nome: "Refrigerado V14", categoria: "REFRIGERADO", setpoint: 2, tempMin: 0, tempMax: 4 });
  assert.equal(refri.body.categoria, "REFRIGERADO");
  const semCategoria = await agentes.SUPERVISOR.post("/api/produtos").send({ nome: "Legado V14", setpoint: -18, tempMin: -22, tempMax: -16 });
  assert.equal(semCategoria.body.categoria, "CONGELADO", "sem categoria (API antiga): deduz pela faixa");

  const ativo = async (rec) => (await agentes.ADMIN.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  // Reefer com Carga Seca: sem controle de temperatura.
  const c = await agentes.ADMIN.post("/api/containers").send({ numero: "SECU1400001", confirmarDigito: true, tipo: "REEFER_40", ...cad, produtoId: seca.body.id });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.reefer, false, "sem controle de temperatura");
  assert.deepEqual([c.body.tempMin, c.body.tempMax, c.body.setpoint], [null, null, null]);
  assert.equal((await agentes.OPERADOR.post(`/api/containers/${c.body.id}/leituras`).send({ temperatura: -18 })).status, 400, "leitura manual recusada");
  // QR: vincular sem temperatura; busca pelo número informa que não controla temperatura.
  const [e] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  const prog = (await agentes.OPERADOR.get("/api/qr/opcoes/container/SECU1400001")).body;
  assert.equal(prog.controlaTemperatura, false);
  const v = await agentes.OPERADOR.post(`/api/qr/${e.token}/vincular`).send({ numero: "SECU1400001" });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(v.body.container.reefer, false);
  assert.equal(await prisma.leituraTemperatura.count({ where: { containerId: c.body.id } }), 0);
  // Reefer com Refrigerado: controle normal (QR exige temperatura).
  const r = await agentes.ADMIN.post("/api/containers").send({ numero: "SECU1400002", confirmarDigito: true, tipo: "REEFER_40", ...cad, produtoId: refri.body.id });
  assert.equal(r.body.reefer, true);
  assert.equal((await agentes.OPERADOR.get("/api/qr/opcoes/container/SECU1400002")).body.controlaTemperatura, true);
  const [e2] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e2.token}/vincular`).send({ numero: "SECU1400002" })).status, 400, "refrigerado exige temperatura");
  for (const id of [c.body.id, r.body.id]) await agentes.ADMIN.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste v1.4" });
});

test("tipos de operação (v2.0): padrões da migração, cadastro do fluxo e travas", async () => {
  const lista = (await agentes.VISUALIZACAO.get("/api/tipos-operacao")).body;
  assert.deepEqual(lista.map((t) => t.nome), ["Exportação padrão", "Coleta de cheio", "Importação", "Transferência"], "padrão primeiro, depois por nome");
  const tipo = (nome) => lista.find((t) => t.nome === nome);
  assert.equal(tipo("Exportação padrão").padrao, true);
  assert.deepEqual(tipo("Exportação padrão").etapas.map((e) => e.acao), ["COLETA", "CHEGADA", "INICIO_OPERACAO", "LIBERACAO", "SAIDA", "ENTREGA"]);
  assert.deepEqual(tipo("Coleta de cheio").etapas.map((e) => [e.acao, e.funcaoLocal]), [["COLETA", "CARREGAMENTO"], ["ENTREGA", "RETIRADA_ENTREGA"]]);
  assert.equal(tipo("Importação").etapas.at(-1).nome, "Devolução do vazio");
  ids.tipoOp = Object.fromEntries(lista.map((t) => [t.nome, t.id]));

  // Containers criados antes (sem informar o tipo) ficaram na Exportação padrão, fluxo completo.
  const antigo = (await agentes.ADMIN.get(`/api/containers/${ids.reefer}`)).body;
  assert.equal(antigo.tipoOperacao?.nome, "Exportação padrão");
  assert.deepEqual(antigo.fluxo, ["PROGRAMADO", "COLETADO", "NA_FABRICA", "EM_OPERACAO", "LIBERADO", "SAIU_FABRICA", "ENTREGUE_PORTO"]);
  assert.equal(antigo.temOperacao, true);

  const coleta = { acao: "COLETA", funcaoLocal: "RETIRADA_ENTREGA" };
  const entrega = { acao: "ENTREGA", funcaoLocal: "RETIRADA_ENTREGA" };
  const novo = (etapas, extra = {}) => agentes.SUPERVISOR.post("/api/tipos-operacao").send({ nome: "Cross-docking", etapas, ...extra });
  assert.equal((await agentes.OPERADOR.post("/api/tipos-operacao").send({ nome: "X", etapas: [coleta, entrega] })).status, 403, "operador não cadastra");
  assert.equal((await novo([entrega, coleta])).status, 400, "começa pela coleta");
  assert.equal((await novo([coleta, { acao: "CHEGADA" }, entrega])).status, 400, "chegada sem saída");
  assert.equal((await novo([coleta, { acao: "SAIDA" }, { acao: "CHEGADA" }, entrega])).status, 400, "fora de ordem");
  assert.equal((await novo([coleta, { acao: "CHEGADA" }, { acao: "PASSAGEM" }, { acao: "SAIDA" }, entrega])).status, 400, "passagem dentro do local de operação");
  assert.equal((await novo([coleta, entrega], { freeTimeInicio: "ENTREGUE_PORTO", freeTimeFim: "COLETADO" })).status, 400, "free time invertido");
  assert.equal((await novo([coleta, entrega], { freeTimeInicio: "NA_FABRICA" })).status, 400, "free time em etapa fora do fluxo");
  assert.equal((await novo([coleta, { ...entrega, localSugeridoId: ids.rioVerde }])).status, 400, "local sugerido do tipo errado");
  assert.equal((await agentes.SUPERVISOR.post("/api/tipos-operacao").send({ nome: "Importação", etapas: [coleta, entrega] })).status, 409, "nome repetido");

  // Cross-docking: sem ovação/desova (chegada → saída), free time só a partir da chegada.
  const cross = await novo(
    [{ ...coleta, localSugeridoId: ids.santos }, { acao: "CHEGADA", nome: "Chegada no CD", tipoLocalId: ids.tipo["Armazém"], localSugeridoId: ids.cubatao }, { acao: "SAIDA", nome: "Saída do CD" }, { ...entrega, tipoLocalId: ids.tipo["Terminal Ferroviário"] }],
    { freeTimeInicio: "NA_FABRICA", freeTimeFim: "ENTREGUE_PORTO" }
  );
  assert.equal(cross.status, 201, JSON.stringify(cross.body));
  assert.equal(cross.body.etapas[1].funcaoLocal, "CARREGAMENTO", "tipo específico define a função");
  ids.tipoOp.cross = cross.body.id;

  // Padrão: não desmarca nem desativa direto; trocar o padrão desmarca o anterior.
  assert.equal((await agentes.SUPERVISOR.patch(`/api/tipos-operacao/${ids.tipoOp["Exportação padrão"]}`).send({ padrao: false })).status, 409);
  assert.equal((await agentes.SUPERVISOR.patch(`/api/tipos-operacao/${ids.tipoOp["Exportação padrão"]}`).send({ ativo: false })).status, 409);
  assert.equal((await agentes.SUPERVISOR.delete(`/api/tipos-operacao/${ids.tipoOp["Exportação padrão"]}`)).status, 409);
  const troca = await agentes.SUPERVISOR.patch(`/api/tipos-operacao/${ids.tipoOp.cross}`).send({ padrao: true });
  assert.equal(troca.body.padrao, true);
  assert.equal((await agentes.VISUALIZACAO.get("/api/tipos-operacao")).body.filter((t) => t.padrao).length, 1, "um padrão só");
  await agentes.SUPERVISOR.patch(`/api/tipos-operacao/${ids.tipoOp["Exportação padrão"]}`).send({ padrao: true });

  // Excluir: só sem containers.
  const sobra = await agentes.SUPERVISOR.post("/api/tipos-operacao").send({ nome: "Sem uso", etapas: [coleta, entrega] });
  assert.equal((await agentes.SUPERVISOR.delete(`/api/tipos-operacao/${sobra.body.id}`)).status, 204);
});

test("tipos de operação (v2.0): container segue o fluxo do tipo (etapas, locais, estadia, free time, paradas)", async () => {
  const ativo = async (rec) => (await agentes.ADMIN.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { tipo: "DRY_40", grupoId: await ativo("grupos"), armadorId: await ativo("armadores"), confirmarDigito: true };
  const criar = (corpo) => agentes.OPERADOR.post("/api/containers").send({ ...cad, ...corpo });
  const avancar = async (id) => {
    const r = await agentes.OPERADOR.post(`/api/containers/${id}/avancar`).send({});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const criados = [];

  // Coleta de cheio: coleta na fábrica/armazém, entrega no porto; sem local de carregamento.
  assert.equal((await criar({ numero: "COLU2000001", tipoOperacaoId: ids.tipoOp["Coleta de cheio"], portoRetiradaId: ids.santos })).status, 400, "retirada precisa ser fábrica/armazém");
  assert.equal((await criar({ numero: "COLU2000001", tipoOperacaoId: ids.tipoOp["Coleta de cheio"], portoRetiradaId: ids.rioVerde, localCarregamentoId: ids.cubatao })).status, 400, "não usa local de carregamento");
  const cheio = await criar({ numero: "COLU2000001", tipoOperacaoId: ids.tipoOp["Coleta de cheio"], portoRetiradaId: ids.rioVerde, portoEntregaId: ids.santos });
  assert.equal(cheio.status, 201, JSON.stringify(cheio.body));
  criados.push(cheio.body.id);
  assert.deepEqual(cheio.body.fluxo, ["PROGRAMADO", "COLETADO", "ENTREGUE_PORTO"]);
  assert.equal(cheio.body.temOperacao, false);
  assert.equal(cheio.body.localCarregamentoId, null, "Ponto de Carregamento não vira local de carregamento");
  assert.equal(cheio.body.rotulosEtapa.COLETADO, "Coleta do cheio");
  assert.equal(cheio.body.situacao.previsao.disponivel, true, JSON.stringify(cheio.body.situacao.previsao));
  assert.equal(cheio.body.situacao.previsao.previsaoChegadaFabrica, null, "sem tempo de fábrica");
  assert.ok(cheio.body.situacao.previsao.trechos.every((t) => !t.etapa.includes("carregamento")), "uma perna só, retirada → entrega");
  const coletado = await avancar(cheio.body.id);
  assert.equal(coletado.status, "COLETADO");
  assert.ok(coletado.situacao.demurrage, "free time conta da coleta");
  assert.equal(coletado.situacao.estadia, null);
  assert.equal((await avancar(cheio.body.id)).status, "ENTREGUE_PORTO", "coletado → entrega direto");
  // Trajeto sem carregamento.
  const transf = await criar({ numero: "TRFU2000002", tipoOperacaoId: ids.tipoOp["Transferência"], portoRetiradaId: ids.cubatao, portoEntregaId: ids.ferro });
  assert.equal(transf.status, 201, "transferência aceita qualquer local");
  criados.push(transf.body.id);
  const pontos = (extra = []) => [{ papel: "RETIRADA", localId: ids.cubatao }, ...extra, { papel: "ENTREGA", localId: ids.santos }];
  assert.equal((await agentes.OPERADOR.put(`/api/containers/${transf.body.id}/trajeto`).send({ pontos: pontos([{ papel: "CARREGAMENTO", localId: ids.rioVerde }]) })).status, 400, "sem carregamento neste tipo");
  const rota = await agentes.OPERADOR.put(`/api/containers/${transf.body.id}/trajeto`).send({ pontos: pontos() });
  assert.equal(rota.status, 200, JSON.stringify(rota.body));
  assert.equal(rota.body.portoEntregaId, ids.santos);

  // Cross-docking: locais sugeridos, avanço pula ovação/liberação, free time a partir da chegada.
  const cd = await criar({ numero: "CRSU2000003", tipoOperacaoId: ids.tipoOp.cross, portoEntregaId: ids.ferro });
  assert.equal(cd.status, 201, JSON.stringify(cd.body));
  criados.push(cd.body.id);
  assert.equal(cd.body.portoRetiradaId, ids.santos, "retirada sugerida no fluxo");
  assert.equal(cd.body.localCarregamentoId, ids.cubatao, "carregamento: o sugerido no fluxo");
  assert.equal((await criar({ numero: "CRSU2000004", tipoOperacaoId: ids.tipoOp.cross, portoEntregaId: ids.santos })).status, 400, "entrega precisa ser Terminal Ferroviário");
  assert.deepEqual(cd.body.fluxo, ["PROGRAMADO", "COLETADO", "NA_FABRICA", "SAIU_FABRICA", "ENTREGUE_PORTO"]);
  assert.equal(cd.body.rotulosEtapa.NA_FABRICA, "Chegada no CD");
  assert.equal((await avancar(cd.body.id)).situacao.demurrage, null, "free time ainda não começou (só na chegada)");
  const noCd = await avancar(cd.body.id);
  assert.equal(noCd.status, "NA_FABRICA");
  assert.ok(noCd.situacao.demurrage && noCd.situacao.estadia, "chegada abre free time e estadia");
  assert.equal((await avancar(cd.body.id)).status, "SAIU_FABRICA", "sem ovação/liberação no fluxo");
  assert.equal((await agentes.SUPERVISOR.delete(`/api/tipos-operacao/${ids.tipoOp.cross}`)).status, 409, "tipo com containers não é excluído");

  // Passagem do fluxo com local sugerido vira parada do trajeto.
  const pf = await agentes.SUPERVISOR.post("/api/locais").send({ nome: "Posto Fiscal V20", tipoId: ids.tipo["Ponto Fiscal"], latitude: -23.5, longitude: -46.9, tempoParadaHoras: 1, posicaoParada: "ANTES_CARREGAMENTO" });
  assert.equal(pf.status, 201, JSON.stringify(pf.body));
  const comParada = await agentes.SUPERVISOR.post("/api/tipos-operacao").send({
    nome: "Coleta com fiscal",
    etapas: [{ acao: "COLETA", funcaoLocal: "CARREGAMENTO" }, { acao: "PASSAGEM", localSugeridoId: pf.body.id }, { acao: "ENTREGA", funcaoLocal: "RETIRADA_ENTREGA" }],
  });
  assert.equal(comParada.status, 201, JSON.stringify(comParada.body));
  const cp = await criar({ numero: "FSCU2000005", tipoOperacaoId: comParada.body.id, portoRetiradaId: ids.rioVerde, portoEntregaId: ids.santos });
  assert.equal(cp.status, 201, JSON.stringify(cp.body));
  criados.push(cp.body.id);
  assert.deepEqual(cp.body.paradas.map((p) => [p.nome, p.fase]), [["Posto Fiscal V20", "ANTES_CARREGAMENTO"]]);
  assert.ok(cp.body.situacao.previsao.paradas.some((m) => m.nome === "Posto Fiscal V20"), "parada entra na previsão");

  // Importação: nomes do fluxo nas etapas.
  const imp = await criar({ numero: "IMPU2000006", tipoOperacaoId: ids.tipoOp["Importação"], portoRetiradaId: ids.santos, portoEntregaId: ids.santos });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  criados.push(imp.body.id);
  assert.equal(imp.body.tipoOperacao.nome, "Importação");
  assert.equal(imp.body.rotulosEtapa.ENTREGUE_PORTO, "Devolução do vazio");
  assert.equal(imp.body.rotulosEtapa.EM_OPERACAO, "Em desova");
  assert.equal((await criar({ numero: "IMPU2000007", tipoOperacaoId: 99999 })).status, 400, "tipo inexistente");

  // Mudar o fluxo do tipo não altera containers já criados.
  await agentes.SUPERVISOR.patch(`/api/tipos-operacao/${ids.tipoOp["Importação"]}`).send({ etapas: [{ acao: "COLETA" }, { acao: "ENTREGA", nome: "Outro nome" }] });
  assert.equal((await agentes.ADMIN.get(`/api/containers/${imp.body.id}`)).body.rotulosEtapa.ENTREGUE_PORTO, "Devolução do vazio");

  for (const id of criados) await agentes.ADMIN.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste v2.0" });
});

test("tipos de operação (v2.0-B): QR do transportador, portaria e Home seguem o fluxo", async () => {
  const ativo = async (rec) => (await agentes.ADMIN.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { tipo: "DRY_40", grupoId: await ativo("grupos"), armadorId: await ativo("armadores"), confirmarDigito: true };
  const tr = await logar("transportador@teste.local");
  const po = await logar("portaria@teste.local");
  const cheioId = ids.tipoOp["Coleta de cheio"];
  const criados = [];

  // Opções do QR: listas completas + tipos de operação (a tela filtra pela regra do fluxo).
  const op = (await tr.get("/api/qr/opcoes/coleta")).body;
  assert.ok(op.todosLocais.some((l) => l.id === ids.rioVerde && l.tipo.funcao === "CARREGAMENTO"));
  assert.ok(!op.todosLocais.some((l) => l.tipo.funcao === "PARADA"), "sem pontos de parada");
  assert.ok(op.tiposOperacao.find((t) => t.nome === "Coleta de cheio").etapas.some((e) => e.acao === "COLETA" && e.funcaoLocal === "CARREGAMENTO"));

  // Container Coleta de cheio programado: coleta pelo QR na fábrica, não no porto.
  const c = await agentes.ADMIN.post("/api/containers").send({ ...cad, numero: "QRCU2100001", tipoOperacaoId: cheioId, portoRetiradaId: ids.rioVerde, portoEntregaId: ids.santos });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  criados.push(c.body.id);
  const prog = (await tr.get("/api/qr/opcoes/container/QRCU2100001")).body;
  assert.equal(prog.tipoOperacao, "Coleta de cheio");
  assert.equal(prog.temOperacao, false);
  assert.equal(prog.regrasLocal.localCarregamentoId, null);
  assert.equal(prog.regrasLocal.portoRetiradaId.funcao, "CARREGAMENTO");
  const [e1, e2, e3] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 3 })).body.etiquetas;
  const porto = await tr.post(`/api/qr/${e1.token}/coleta`).send({ numero: "QRCU2100001", portoRetiradaId: ids.santos });
  assert.equal(porto.status, 400, "coleta de cheio é na fábrica/armazém");
  assert.match(porto.body.erro, /fábrica ou armazém/);
  assert.equal((await tr.post(`/api/qr/${e1.token}/coleta`).send({ numero: "QRCU2100001", portoRetiradaId: ids.rioVerde, localCarregamentoId: ids.cubatao })).status, 400, "tipo sem local de carregamento");
  const col = await tr.post(`/api/qr/${e1.token}/coleta`).send({ numero: "QRCU2100001", portoRetiradaId: ids.rioVerde, portoEntregaId: ids.ferro });
  assert.equal(col.status, 201, JSON.stringify(col.body));
  assert.equal(col.body.container.status, "COLETADO");
  assert.equal(col.body.container.temOperacao, false);
  assert.deepEqual(col.body.container.trajeto, { portoRetiradaId: ids.rioVerde, localCarregamentoId: null, portoEntregaId: ids.ferro });

  // Cadastro pelo QR escolhendo o tipo de operação.
  const novo = { tipo: "DRY_40", grupoId: cad.grupoId, armadorId: cad.armadorId, tipoOperacaoId: cheioId };
  assert.equal((await tr.post(`/api/qr/${e2.token}/coleta`).send({ numero: "QRCU2100002", confirmarDigito: true, portoRetiradaId: ids.santos, novo })).status, 400, "regra do tipo escolhido");
  const cadastrou = await tr.post(`/api/qr/${e2.token}/coleta`).send({ numero: "QRCU2100002", confirmarDigito: true, portoRetiradaId: ids.rioVerde, novo });
  assert.equal(cadastrou.status, 201, JSON.stringify(cadastrou.body));
  assert.equal(cadastrou.body.container.tipoOperacao, "Coleta de cheio");
  criados.push(cadastrou.body.container.id);

  // Portaria: tipo sem local de operação não tem entrada/saída.
  const transf = await agentes.ADMIN.post("/api/containers").send({ ...cad, numero: "QRCU2100003", tipoOperacaoId: ids.tipoOp["Transferência"] });
  criados.push(transf.body.id);
  const recusa = await po.post(`/api/qr/${e3.token}/portaria`).send({ placa: "ABC1D23", numero: "QRCU2100003", movimento: "ENTRADA" });
  assert.equal(recusa.status, 409);
  assert.match(recusa.body.erro, /sem entrada\/saída/);

  // Home: seção pela etapa + tipo de operação no card.
  const painel = (await agentes.ADMIN.get("/api/painel")).body;
  const noPainel = painel.grupos.flatMap((g) => g.containers).find((x) => x.numero === "QRCU2100001");
  assert.equal(noPainel.temOperacao, false);
  assert.equal(noPainel.tipoOperacao, "Coleta de cheio");
  assert.equal(painel.grupos.flatMap((g) => g.containers).find((x) => x.id === ids.reefer)?.tipoOperacao ?? null, null, "tipo padrão não aparece no card");

  for (const id of criados) await agentes.ADMIN.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste v2.0-B" });
});

test("tipos de operação (v2.0-B): planilha com a coluna Tipo de Operação", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const { calcularDigitoVerificador } = await import("./lib/iso6346.js");
  const num = (base) => `${base}${calcularDigitoVerificador(base)}`;
  const binario = (res, cb) => { const partes = []; res.on("data", (x) => partes.push(x)); res.on("end", () => cb(null, Buffer.concat(partes))); };
  const modelo = await agentes.OPERADOR.get("/api/containers/modelo").buffer(true).parse(binario);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(modelo.body);
  const ws = wb.getWorksheet("Containers");
  const cab = ws.getRow(1).values.slice(1);
  assert.ok(cab.includes("Tipo de Operação"), "coluna nova, opcional");
  assert.ok(cab.includes("Local de carregamento"), "carregamento sem * (depende do tipo)");
  const listas = wb.getWorksheet("Listas");
  const valoresDe = (nome) => listas.getColumn(listas.getRow(1).values.indexOf(nome)).values.slice(2);
  assert.ok(valoresDe("tiposOperacao").includes("Coleta de cheio"));
  assert.ok(valoresDe("locais").includes("Fábrica Rio Verde") && valoresDe("locais").includes("Porto de Santos"));

  const col = (titulo) => cab.findIndex((t) => t.replace(" *", "") === titulo) + 1;
  const linha = (n, v) => { for (const [t, x] of Object.entries(v)) ws.getRow(n).getCell(col(t)).value = x; };
  const base = {
    Tipo: "40' Dry", "Ponto de Carregamento": "Planilha SA / Fábrica Upload", Armador: "Armador Planilha", Produto: "Resfriado Planilha",
    "Local de entrega": "Porto de Santos", "Coleta programada": "10/10/2026 09:00",
  };
  const ok = num("PLCU210001");
  linha(2, { "Número do container": ok, ...base, "Tipo de Operação": "coleta de cheio", "Local de retirada": "Fábrica Rio Verde" });
  linha(3, { "Número do container": num("PLCU210002"), ...base, "Tipo de Operação": "Coleta de cheio", "Local de retirada": "Fábrica Rio Verde", "Local de carregamento": "Armazém Cubatão" });
  linha(4, { "Número do container": num("PLCU210003"), ...base, "Tipo de Operação": "Coleta de cheio", "Local de retirada": "Porto de Santos" });
  linha(5, { "Número do container": num("PLCU210004"), ...base, "Local de retirada": "Porto de Santos" }); // padrão sem carregamento
  linha(6, { "Número do container": num("PLCU210005"), ...base, "Tipo de Operação": "Tipo Que Não Existe", "Local de retirada": "Porto de Santos" });
  const arquivo = Buffer.from(await wb.xlsx.writeBuffer());
  const enviar = (conf) => agentes.OPERADOR.post(`/api/containers/importar${conf ? "?confirmar=1" : ""}`).set("Content-Type", "application/octet-stream").send(arquivo);
  const previa = await enviar(false);
  assert.equal(previa.status, 200, JSON.stringify(previa.body));
  const erroDa = (n) => previa.body.linhas.find((l) => l.linha === n).erro;
  assert.equal(erroDa(2), null, "coleta de cheio sem carregamento");
  assert.match(erroDa(3), /Local de carregamento: o tipo de operação "Coleta de cheio" não usa este local/);
  assert.match(erroDa(4), /Local de retirada: "Porto de Santos" não é um local de carregamento \(fábrica\/armazém\) \(tipo de operação Coleta de cheio\)/);
  assert.equal(erroDa(5), "Obrigatório(s) em branco: Local de carregamento.");
  assert.match(erroDa(6), /Tipo de Operação: "Tipo Que Não Existe" não encontrado/);
  const conf = await enviar(true);
  assert.equal(conf.body.importados, 1);
  const c = await prisma.container.findFirst({ where: { numero: ok }, include: { tipoOperacao: true } });
  assert.equal(c.tipoOperacao.nome, "Coleta de cheio");
  assert.equal(c.localCarregamentoId, null);
  assert.deepEqual(c.fluxo.etapas, ["COLETADO", "ENTREGUE_PORTO"]);
  await agentes.ADMIN.post(`/api/containers/${c.id}/cancelar`).send({ motivo: "fim do teste v2.0-B" });
});

test("v2.1: mudanças no trajeto ficam no Histórico (antes/depois, após o planejado) e posições para o mapa", async () => {
  const ativo = async (rec) => (await agentes.ADMIN.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { tipo: "DRY_40", grupoId: await ativo("grupos"), armadorId: await ativo("armadores"), confirmarDigito: true };
  // Com trajeto completo e coordenadas: o Planejado é gravado na criação.
  const c = await agentes.OPERADOR.post("/api/containers").send({ ...cad, numero: "HSTU2200001", portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.santos });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.ok(c.body.planejamento, "Planejado gravado");
  assert.deepEqual(c.body.mudancasTrajeto, []);

  // Edição dos dados trocando a entrega → registro com antes/depois e "após o planejado".
  await agentes.OPERADOR.post(`/api/containers/${c.body.id}/avancar`).send({});
  const ed = await agentes.OPERADOR.patch(`/api/containers/${c.body.id}`).send({ portoEntregaId: ids.ferro, booking: "BK-HIST" });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  const [m1] = ed.body.mudancasTrajeto;
  assert.equal(m1.origem, "FICHA");
  assert.equal(m1.aposPlanejado, true);
  assert.deepEqual(m1.detalhes, ["Entrega: Porto de Santos → Terminal Ferroviário Paulínia"]);
  assert.match(m1.antes, /Porto de Santos → Armazém Cubatão → Porto de Santos/);
  assert.match(m1.depois, /→ Terminal Ferroviário Paulínia$/);
  // Só booking: não é mudança de trajeto.
  assert.equal((await agentes.OPERADOR.patch(`/api/containers/${c.body.id}`).send({ booking: "BK-2" })).body.mudancasTrajeto.length, 1);

  // Editar trajeto: acrescenta uma parada.
  const pf = (await agentes.ADMIN.get("/api/locais?ativos=1")).body.find((l) => l.tipo.funcao === "PARADA");
  const r = await agentes.OPERADOR.put(`/api/containers/${c.body.id}/trajeto`).send({ pontos: [
    { papel: "RETIRADA", localId: ids.santos }, { papel: "PARADA", localId: pf.id }, { papel: "CARREGAMENTO", localId: ids.cubatao }, { papel: "ENTREGA", localId: ids.ferro },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m2 = r.body.mudancasTrajeto.at(-1);
  assert.equal(m2.origem, "TRAJETO");
  assert.deepEqual(m2.detalhes, [`+ parada: ${pf.nome}`]);
  // Salvar sem mudar nada não registra.
  const igual = await agentes.OPERADOR.put(`/api/containers/${c.body.id}/trajeto`).send({ pontos: [
    { papel: "RETIRADA", localId: ids.santos }, { papel: "PARADA", localId: pf.id, paradaId: r.body.paradas[0].id }, { papel: "CARREGAMENTO", localId: ids.cubatao }, { papel: "ENTREGA", localId: ids.ferro },
  ] });
  assert.equal(igual.body.mudancasTrajeto.length, 2);
  // Paradas com coordenadas (mapa).
  assert.equal(typeof r.body.paradas[0].latitude, "number");

  // Rastreamento devolve as posições para o mapa (mais de 50).
  await prisma.posicaoContainer.createMany({ data: Array.from({ length: 60 }, (_, i) => ({ containerId: c.body.id, latitude: -23.9 + i / 1000, longitude: -46.3, origem: "QR", etapa: "COLETADO", registradaEm: new Date(Date.now() - (60 - i) * 60e3) })) });
  const rast = (await agentes.OPERADOR.get(`/api/containers/${c.body.id}/rastreamento`)).body;
  assert.equal(rast.posicoes.length, 60);
  assert.ok(new Date(rast.posicoes[0].registradaEm) > new Date(rast.posicoes[1].registradaEm), "mais recente primeiro (destacada no mapa)");
  await agentes.ADMIN.post(`/api/containers/${c.body.id}/cancelar`).send({ motivo: "fim do teste v2.1" });
});

test("v2.1: celular do motorista só com os 4 últimos dígitos; completo ao criar/editar", async () => {
  const t = (await agentes.ADMIN.get("/api/transportadoras?ativos=1")).body[0];
  const criado = await agentes.SUPERVISOR.post("/api/motoristas").send({ nome: "Privacidade V21", celular: "(11) 91234-5678", transportadoraId: t.id });
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  assert.equal(criado.body.celular, "+5511912345678", "criação devolve o número completo");
  const lista = (await agentes.SUPERVISOR.get("/api/motoristas")).body;
  const m = lista.find((x) => x.id === criado.body.id);
  assert.equal(m.celular, "(••) •••••-5678");
  assert.equal(m.celularFinal, "5678");
  assert.ok(!JSON.stringify(lista).includes("912345678"), "lista não expõe nenhum número completo");
  const det = await agentes.SUPERVISOR.get(`/api/motoristas/${m.id}`);
  assert.equal(det.body.celular, "+5511912345678", `editar mostra completo: ${det.status} ${JSON.stringify(det.body)}`);
  const ed = await agentes.SUPERVISOR.patch(`/api/motoristas/${m.id}`).send({ celular: "11 98888-7777" });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.celular, "(••) •••••-7777");
  assert.equal((await prisma.motorista.findUnique({ where: { id: m.id } })).celular, "+5511988887777");
  assert.equal((await agentes.OPERADOR.get(`/api/motoristas/${m.id}`)).status, 403, "sem permissão de cadastro não vê");
});

test("v3.0 multi-tenant: usuário da organização B não enxerga nem altera dados da A", async () => {
  const { comoSistema } = await import("./lib/tenant.js");
  const { prisma: bruto } = await import("./lib/prisma.js");
  const orgB = await comoSistema(() => bruto.organizacao.create({ data: { nome: "Cliente B Teste" } }));
  const senhaHash = await bcrypt.hash("senha-teste-123", 4);
  await comOrganizacao(orgB.id, () => bruto.usuario.create({ data: { email: "admin@clienteb.local", nome: "Admin B", perfil: "ADMIN", senhaHash } }));
  const b = await logar("admin@clienteb.local");
  const a = agentes.ADMIN;

  // Leituras: nada da A aparece para a B.
  assert.deepEqual((await b.get("/api/containers?situacao=todos")).body, [], "containers");
  assert.equal((await b.get(`/api/containers/${ids.reefer}`)).status, 404, "ficha de outra organização");
  assert.deepEqual((await b.get("/api/locais")).body, [], "locais");
  assert.deepEqual((await b.get("/api/grupos")).body, [], "pontos de carregamento");
  assert.deepEqual((await b.get("/api/alertas")).body, [], "alertas");
  assert.deepEqual((await b.get("/api/usuarios")).body.map((u) => u.email), ["admin@clienteb.local"], "usuários");
  assert.ok((await b.get("/api/logs")).body.every((l) => !l.descricao.includes("TGHU")), "log");
  const painel = (await b.get("/api/painel")).body;
  assert.equal(painel.totais.ativos, 0, "painel");

  // Escritas na A pela B: 404 (não existe para ela) e nada muda.
  const antes = await prisma.container.findUnique({ where: { id: ids.reefer } });
  assert.equal((await b.patch(`/api/containers/${ids.reefer}`).send({ booking: "INVADIDO" })).status, 404);
  assert.equal((await b.post(`/api/containers/${ids.reefer}/avancar`).send({})).status, 404);
  assert.equal((await b.post(`/api/containers/${ids.reefer}/cancelar`).send({ motivo: "x" })).status, 404);
  assert.equal((await b.patch(`/api/locais/${ids.santos}`).send({ nome: "Invadido" })).status, 404);
  const depois = await prisma.container.findUnique({ where: { id: ids.reefer } });
  assert.equal(depois.booking, antes.booking);
  assert.equal(depois.status, antes.status);

  // Mesmo nome em organizações diferentes: permitido (únicos por organização).
  const tipoB = await comOrganizacao(orgB.id, () => bruto.tipoLocal.create({ data: { nome: "Porto / Terminal", funcao: "RETIRADA_ENTREGA", rotuloColeta: "Coleta", rotuloEntrega: "Entrega" } }));
  const localB = await b.post("/api/locais").send({ nome: "Porto de Santos", tipoId: tipoB.id });
  assert.equal(localB.status, 201, JSON.stringify(localB.body));
  assert.ok(!(await a.get("/api/locais")).body.some((l) => l.id === localB.body.id), "A não vê o local da B");
  // B não usa o tipo de local da A.
  const tipoA = (await a.get("/api/tipos-local")).body[0];
  assert.equal((await b.post("/api/locais").send({ nome: "Outro", tipoId: tipoA.id })).status, 400);

  // QR e etiquetas da A: invisíveis para a B.
  const [etqA] = (await a.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  assert.equal((await b.get(`/api/qr/${etqA.token}`)).status, 404);
  assert.deepEqual((await b.get("/api/etiquetas")).body.etiquetas ?? (await b.get("/api/etiquetas")).body, []);
  // 2ª barreira (banco): conexão do sistema é o usuário restrito e o RLS filtra até SQL direto.
  const { comoPlataforma } = await import("./lib/tenant.js");
  assert.equal((await comOrganizacao(orgB.id, () => bruto.$queryRaw`SELECT current_user AS u`))[0].u, "ccs_app");
  const contar = () => bruto.$queryRaw`SELECT count(*)::int AS n FROM "Container"`;
  assert.equal((await comOrganizacao(orgB.id, contar))[0].n, 0, "RLS: B não conta containers da A nem em SQL direto");
  assert.ok((await comOrganizacao(ORG_TESTE, contar))[0].n > 0, "RLS: A vê os seus");
  assert.equal((await comoPlataforma(contar))[0].n, 0, "RLS: plataforma não vê containers");
  assert.equal((await bruto.$queryRaw`SELECT count(*)::int AS n FROM "Container"`)[0].n, 0, "RLS: sem contexto nenhuma linha");
  await assert.rejects(comOrganizacao(orgB.id, () => bruto.$executeRaw`UPDATE "Container" SET booking = 'X' WHERE id = ${ids.reefer}`).then((n) => { if (n === 0) throw new Error("0 linhas"); }), /0 linhas/, "RLS: B não altera linha da A");
  // Configurações: cada uma com as suas.
  const cfgB = (await b.get("/api/configuracao")).body;
  assert.equal((await b.put("/api/configuracao").send({ ...cfgB, kmPorDia: 777 })).status, 200);
  assert.equal((await b.get("/api/configuracao")).body.kmPorDia, 777);
  assert.notEqual((await a.get("/api/configuracao")).body.kmPorDia, 777);
});

test("v3.0: admin da plataforma cria organizações (com cadastros padrão) e não vê dados dos clientes", async () => {
  const { criarAdminPlataformaSeNecessario } = await import("./lib/adminInicial.js");
  const env = { PLATAFORMA_ADMIN_EMAIL: "plataforma@teste.local", PLATAFORMA_ADMIN_SENHA: "senha-plataforma-123", PLATAFORMA_ADMIN_NOME: "Dono da Plataforma" };
  assert.equal(await criarAdminPlataformaSeNecessario({ ...env, PLATAFORMA_ADMIN_SENHA: "curta" }), null, "senha curta não cria");
  assert.equal((await criarAdminPlataformaSeNecessario(env))?.perfil, "PLATAFORMA");
  assert.equal(await criarAdminPlataformaSeNecessario({ ...env, PLATAFORMA_ADMIN_EMAIL: "outro@teste.local" }), null, "só um, depois ignora");
  const pl = request.agent(app);
  assert.equal((await pl.post("/api/auth/login").send({ email: "plataforma@teste.local", senha: "senha-plataforma-123" })).status, 200);

  // Não enxerga nada operacional.
  for (const rota of ["/api/containers", "/api/usuarios", "/api/locais", "/api/painel", "/api/logs", "/api/motoristas"]) {
    assert.equal((await pl.get(rota)).status, 403, rota);
  }
  assert.equal((await agentes.ADMIN.get("/api/organizacoes")).status, 403, "admin de cliente não gerencia organizações");

  const lista = (await pl.get("/api/organizacoes")).body;
  assert.ok(lista.some((o) => o.nome === "AS TECH LOG" && o.containers > 0), "vê só contagens");
  assert.ok(!JSON.stringify(lista).includes("TGHU"), "nenhum dado de container");

  // Nova organização: validações, cadastros padrão e 1º admin.
  assert.equal((await pl.post("/api/organizacoes").send({ nome: "Cliente C", adminNome: "Admin C", adminEmail: "admin@teste.local", adminSenha: "senha-c-12345" })).status, 409, "e-mail já usado");
  assert.equal((await pl.post("/api/organizacoes").send({ nome: "AS TECH LOG", adminNome: "X", adminEmail: "x@c.local", adminSenha: "senha-c-12345" })).status, 409, "nome repetido");
  const criada = await pl.post("/api/organizacoes").send({ nome: "Cliente C", adminNome: "Admin C", adminEmail: "admin@clientec.local", adminSenha: "senha-c-12345" });
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  assert.equal(criada.body.usuarios, 1);
  const c = request.agent(app);
  const login = await c.post("/api/auth/login").send({ email: "admin@clientec.local", senha: "senha-c-12345" });
  assert.equal(login.body.organizacao, "Cliente C");
  assert.deepEqual((await c.get("/api/tipos-local")).body.map((t) => t.nome).sort(), ["Armazém", "Fábrica", "Ponto Fiscal", "Porto / Terminal", "Terminal Ferroviário"]);
  const tiposOp = (await c.get("/api/tipos-operacao")).body;
  assert.deepEqual(tiposOp.map((t) => t.nome), ["Exportação padrão", "Coleta de cheio", "Importação", "Transferência"]);
  assert.equal(tiposOp[0].etapas.length, 6);
  assert.deepEqual((await c.get("/api/containers?situacao=todos")).body, []);

  // Motoristas e transportadoras da plataforma: invisíveis até registrarem algo para a C.
  assert.deepEqual((await c.get("/api/motoristas")).body, [], "não vê a lista geral de motoristas");
  assert.deepEqual((await c.get("/api/transportadoras")).body, [], "nem de transportadoras");
  const m = await prisma.motorista.findFirst({ include: { transportadora: true } });
  const t = await c.post("/api/transportadoras").send({ nome: "Transportadora da C" });
  assert.equal(t.status, 201);
  const dup = await c.post("/api/motoristas").send({ nome: "Qualquer", celular: m.celular, transportadoraId: t.body.id });
  assert.equal(dup.status, 409);
  assert.ok(!dup.body.erro.includes(m.nome), "não revela quem é o motorista");
  assert.equal((await c.patch(`/api/motoristas/${m.id}`).send({ nome: "Invadido" })).status, 404, "não mexe em motorista não vinculado");
  // Motorista registra pelo QR uma carga da C → passa a aparecer (celular mascarado), com a transportadora.
  const orgC = (await pl.get("/api/organizacoes")).body.find((o) => o.nome === "Cliente C");
  const { assumirRastreio: assumir } = await import("./lib/rastreamento.js");
  const armadorC = await c.post("/api/armadores").send({ nome: "Armador C", freeTimeDias: 7, valorDiaria: 100 });
  const grupoC = await c.post("/api/grupos").send({ cliente: "Cliente C", fabrica: "Fábrica C", metaEstadiaHoras: 24 });
  const contC = await c.post("/api/containers").send({ numero: "CCCU1234560", confirmarDigito: true, tipo: "DRY_40", grupoId: grupoC.body.id, armadorId: armadorC.body.id });
  assert.equal(contC.status, 201, JSON.stringify(contC.body));
  await comOrganizacao(orgC.id, () => assumir({ containerId: contC.body.id, motoristaId: m.id }));
  const visiveis = (await c.get("/api/motoristas")).body;
  assert.deepEqual(visiveis.map((x) => x.id), [m.id]);
  assert.match(visiveis[0].celular, /^\(••\) •••••-\d{4}$/);
  assert.ok((await c.get("/api/transportadoras")).body.some((x) => x.id === m.transportadoraId), "transportadora dele também");
  // Transportadora compartilhada (A e C): C não altera nem exclui.
  assert.equal((await c.patch(`/api/transportadoras/${m.transportadoraId}`).send({ nome: "Renomeada" })).status, 409);
  assert.equal((await c.patch(`/api/transportadoras/${t.body.id}`).send({ nome: "Transportadora da C Ltda" })).status, 200, "a exclusiva dela pode");

  // Organização desativada: ninguém dela entra, nem com sessão aberta.
  assert.equal((await pl.patch(`/api/organizacoes/${orgC.id}`).send({ ativo: false })).status, 200);
  assert.equal((await c.get("/api/containers")).status, 401, "sessão aberta cai");
  assert.equal((await request(app).post("/api/auth/login").send({ email: "admin@clientec.local", senha: "senha-c-12345" })).status, 401);
  assert.equal((await pl.patch(`/api/organizacoes/${orgC.id}`).send({ ativo: true })).status, 200);
});

test("v3.0: invasão — organização B ataca TODAS as rotas com identificador da A e nada muda", async () => {
  const fs = await import("node:fs");
  const b = await logar("admin@clienteb.local");
  const A = (fn) => comOrganizacao(ORG_TESTE, fn);
  const { prisma: bruto } = await import("./lib/prisma.js");

  // Recursos da A usados no ataque.
  const cont = await prisma.container.findFirst({ where: { id: ids.reefer } });
  const parada = await prisma.paradaContainer.findFirst();
  const alerta = await prisma.alerta.findFirst();
  const etiqueta = await prisma.etiquetaQR.findFirst();
  const local = await prisma.local.findFirst();
  const tipoLocal = await prisma.tipoLocal.findFirst();
  const tipoOp = await prisma.tipoOperacao.findFirst();
  const usuarioA = await prisma.usuario.findFirst({ where: { email: "operador@teste.local" } });
  const token = await prisma.tokenIntegracao.findFirst();
  const regiao = await prisma.regiao.findFirst();
  const grupo = await prisma.grupoOperacao.findFirst();
  const armador = await prisma.armador.findFirst();
  const produto = await prisma.produto.findFirst();
  const motoristaSoDaA = await bruto.motorista.findFirst({ where: { organizacoes: { some: {}, every: { organizacaoId: ORG_TESTE } } } });
  const transpSoDaA = await bruto.transportadora.findFirst({ where: { organizacoes: { some: {}, every: { organizacaoId: ORG_TESTE } } } });
  for (const [nome, v] of Object.entries({ cont, parada, alerta, etiqueta, local, tipoLocal, tipoOp, usuarioA, token, regiao, grupo, armador, produto, motoristaSoDaA, transpSoDaA })) {
    assert.ok(v, `recurso da A para o teste: ${nome}`);
  }

  // Foto dos dados da A (antes/depois).
  const foto = () => A(async () => JSON.stringify(await Promise.all([
    prisma.container.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, booking: true, placa: true, portoEntregaId: true, atualizadoEm: true } }),
    prisma.paradaContainer.findMany({ orderBy: { id: "asc" }, select: { id: true, passouEm: true, localId: true } }),
    prisma.alerta.findMany({ orderBy: { id: "asc" }, select: { id: true, reconhecidoEm: true } }),
    prisma.etiquetaQR.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, vezesImpressa: true, containerId: true } }),
    prisma.local.findMany({ orderBy: { id: "asc" }, select: { id: true, nome: true, ativo: true } }),
    prisma.tipoLocal.findMany({ orderBy: { id: "asc" }, select: { id: true, nome: true, ativo: true } }),
    prisma.tipoOperacao.findMany({ orderBy: { id: "asc" }, select: { id: true, nome: true, ativo: true } }),
    prisma.usuario.findMany({ orderBy: { id: "asc" }, select: { id: true, nome: true, perfil: true, ativo: true, permissoes: true, resetTokenHash: true } }),
    prisma.tokenIntegracao.findMany({ orderBy: { id: "asc" }, select: { id: true, ativo: true } }),
    prisma.regiao.findMany({ orderBy: { id: "asc" } }), prisma.grupoOperacao.findMany({ orderBy: { id: "asc" } }),
    prisma.armador.findMany({ orderBy: { id: "asc" } }), prisma.produto.findMany({ orderBy: { id: "asc" } }),
    prisma.leituraTemperatura.count(), prisma.posicaoContainer.count(), prisma.solicitacaoPosicao.count(), prisma.mensagemSms.count(),
    bruto.motorista.findMany({ orderBy: { id: "asc" }, select: { id: true, nome: true, celular: true, placa: true, bloqueado: true } }),
    bruto.transportadora.findMany({ orderBy: { id: "asc" } }), bruto.sessaoMotorista.count({ where: { revogadaEm: null } }),
    bruto.organizacao.findMany({ orderBy: { id: "asc" } }),
  ])));
  const antes = await foto();

  const c = cont.id;
  const CASOS = [
    ["POST /api/alertas/:id/reconhecer", () => b.post(`/api/alertas/${alerta.id}/reconhecer`).send({ acaoTomada: "invasão de teste com texto longo" })],
    ["GET /api/containers/:id", () => b.get(`/api/containers/${c}`)],
    ["PATCH /api/containers/:id", () => b.patch(`/api/containers/${c}`).send({ booking: "X", portoEntregaId: local.id })],
    ["GET /api/containers/:id/rastreamento", () => b.get(`/api/containers/${c}/rastreamento`)],
    ["POST /api/containers/:id/avancar", () => b.post(`/api/containers/${c}/avancar`).send({})],
    ["POST /api/containers/:id/desfazer", () => b.post(`/api/containers/${c}/desfazer`).send({})],
    ["POST /api/containers/:id/cancelar", () => b.post(`/api/containers/${c}/cancelar`).send({ motivo: "x" })],
    ["POST /api/containers/:id/leituras", () => b.post(`/api/containers/${c}/leituras`).send({ temperatura: -18 })],
    ["POST /api/containers/:id/solicitar-posicao", () => b.post(`/api/containers/${c}/solicitar-posicao`).send({})],
    ["PUT /api/containers/:id/trajeto", () => b.put(`/api/containers/${c}/trajeto`).send({ pontos: [] })],
    ["POST /api/containers/:id/paradas/:paradaId/passagem", () => b.post(`/api/containers/${parada.containerId}/paradas/${parada.id}/passagem`).send({})],
    ["DELETE /api/containers/:id/paradas/:paradaId/passagem", () => b.delete(`/api/containers/${parada.containerId}/paradas/${parada.id}/passagem`)],
    ["POST /api/etiquetas/:id/cancelar", () => b.post(`/api/etiquetas/${etiqueta.id}/cancelar`).send({ motivo: "x" })],
    ["PATCH /api/locais/:id", () => b.patch(`/api/locais/${local.id}`).send({ nome: "X" })],
    ["DELETE /api/locais/:id", () => b.delete(`/api/locais/${local.id}`)],
    ["PATCH /api/tipos-local/:id", () => b.patch(`/api/tipos-local/${tipoLocal.id}`).send({ nome: "X" })],
    ["DELETE /api/tipos-local/:id", () => b.delete(`/api/tipos-local/${tipoLocal.id}`)],
    ["PATCH /api/tipos-operacao/:id", () => b.patch(`/api/tipos-operacao/${tipoOp.id}`).send({ nome: "X" })],
    ["DELETE /api/tipos-operacao/:id", () => b.delete(`/api/tipos-operacao/${tipoOp.id}`)],
    ["GET /api/motoristas/:id", () => b.get(`/api/motoristas/${motoristaSoDaA.id}`)],
    ["GET /api/motoristas/:id/sessoes", () => b.get(`/api/motoristas/${motoristaSoDaA.id}/sessoes`)],
    ["PATCH /api/motoristas/:id", () => b.patch(`/api/motoristas/${motoristaSoDaA.id}`).send({ bloqueado: true })],
    ["POST /api/motoristas/:id/encerrar-sessoes", () => b.post(`/api/motoristas/${motoristaSoDaA.id}/encerrar-sessoes`).send({})],
    ["POST /api/motoristas/:id/anonimizar", () => b.post(`/api/motoristas/${motoristaSoDaA.id}/anonimizar`).send({})],
    ["PATCH /api/organizacoes/:id", () => b.patch(`/api/organizacoes/${ORG_TESTE}`).send({ ativo: false })],
    ["GET /api/qr/:token", () => b.get(`/api/qr/${etiqueta.token}`)],
    ["GET /api/qr/codigo/:codigo", () => b.get(`/api/qr/codigo/${etiqueta.codigo}`)],
    ["POST /api/qr/:token/coleta", () => b.post(`/api/qr/${etiqueta.token}/coleta`).send({ numero: cont.numero, portoRetiradaId: local.id })],
    ["POST /api/qr/:token/leituras", () => b.post(`/api/qr/${etiqueta.token}/leituras`).send({ temperatura: -18 })],
    ["POST /api/qr/:token/passagem", () => b.post(`/api/qr/${etiqueta.token}/passagem`).send({})],
    ["POST /api/qr/:token/portaria", () => b.post(`/api/qr/${etiqueta.token}/portaria`).send({ movimento: "ENTRADA", placa: "ABC1D23" })],
    ["POST /api/qr/:token/viagem", () => b.post(`/api/qr/${etiqueta.token}/viagem`).send({ comContainerId: cont.id })],
    ["POST /api/qr/:token/portaria/ficam", () => b.post(`/api/qr/${etiqueta.token}/portaria/ficam`).send({ containerIds: [cont.id] })],
    ["POST /api/qr/:token/vincular", () => b.post(`/api/qr/${etiqueta.token}/vincular`).send({ numero: cont.numero, temperatura: -18 })],
    ["POST /api/tokens/:id/revogar", () => b.post(`/api/tokens/${token.id}/revogar`).send({})],
    ["PATCH /api/usuarios/:id", () => b.patch(`/api/usuarios/${usuarioA.id}`).send({ ativo: false, perfil: "ADMIN" })],
    ["POST /api/usuarios/:id/enviar-redefinicao", () => b.post(`/api/usuarios/${usuarioA.id}/enviar-redefinicao`).send({})],
    ["PUT /api/usuarios/:id/permissoes", () => b.put(`/api/usuarios/${usuarioA.id}/permissoes`).send({ permissoes: [] })],
    ["PATCH /api/regioes/:id", () => b.patch(`/api/regioes/${regiao.id}`).send({ nome: "X" })],
    ["DELETE /api/regioes/:id", () => b.delete(`/api/regioes/${regiao.id}`)],
    ["PATCH /api/grupos/:id", () => b.patch(`/api/grupos/${grupo.id}`).send({ metaEstadiaHoras: 1 })],
    ["DELETE /api/grupos/:id", () => b.delete(`/api/grupos/${grupo.id}`)],
    ["PATCH /api/armadores/:id", () => b.patch(`/api/armadores/${armador.id}`).send({ freeTimeDias: 1 })],
    ["DELETE /api/armadores/:id", () => b.delete(`/api/armadores/${armador.id}`)],
    ["PATCH /api/produtos/:id", () => b.patch(`/api/produtos/${produto.id}`).send({ nome: "X" })],
    ["DELETE /api/produtos/:id", () => b.delete(`/api/produtos/${produto.id}`)],
    ["PATCH /api/transportadoras/:id", () => b.patch(`/api/transportadoras/${transpSoDaA.id}`).send({ nome: "X" })],
    ["DELETE /api/transportadoras/:id", () => b.delete(`/api/transportadoras/${transpSoDaA.id}`)],
  ];
  for (const [nome, fazer] of CASOS) {
    const r = await fazer();
    assert.ok([400, 403, 404].includes(r.status), `${nome} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  // Rotas cujo código identifica a própria organização (o atacante não escolhe a organização).
  const FORA = new Set(["GET /api/auth/redefinir-senha/:codigo", "GET /api/posicao/:codigo", "POST /api/posicao/:codigo", "POST /api/posicao/:codigo/acompanhar", "POST /api/posicao/:codigo/acompanhar/estado", "GET /api/qr/opcoes/container/:numero"]);

  // Ids da A no CORPO / na busca.
  assert.equal((await b.post("/api/containers").send({ numero: "INVU1234567", confirmarDigito: true, tipo: "DRY_40", grupoId: grupo.id, armadorId: armador.id })).status, 400, "container com cadastros da A");
  assert.equal((await b.get(`/api/qr/opcoes/container/${cont.numero}`)).body.cadastrado, false, "número de container da A");
  assert.ok([400, 404].includes((await b.get(`/api/rotas/estimar?portoRetiradaId=${local.id}&localCarregamentoId=${local.id}&portoEntregaId=${local.id}`)).status), "estimar com locais da A");
  const imp = await b.post("/api/etiquetas/impressas").send({ ids: [etiqueta.id] });
  assert.ok(imp.status >= 400 || !JSON.stringify(imp.body).includes(etiqueta.codigo), "marcar impressa etiqueta da A");
  const excl = await b.post("/api/etiquetas/excluir").send({ ids: [etiqueta.id] });
  assert.ok(excl.status >= 400 || !JSON.stringify(excl.body).includes(etiqueta.codigo), "excluir etiqueta da A");
  const zpl = await b.post("/api/etiquetas/zpl").send({ ids: [etiqueta.id] });
  assert.ok(zpl.status >= 400 || !String(zpl.text).includes(etiqueta.codigo), "ZPL de etiqueta da A");
  assert.ok(!(await b.get(`/api/custos?grupo=${grupo.id}`)).text.includes(cont.numero), "custos com grupo da A");
  // Integração: token da B enviando número de container da A.
  const tokB = await b.post("/api/tokens").send({ nome: "Sensor B" });
  assert.equal(tokB.status, 201, JSON.stringify(tokB.body));
  const integ = await request(app).post("/api/integracao/temperaturas").set("Authorization", `Bearer ${tokB.body.token}`).send({ leituras: [{ container: cont.numero, temperatura: -18, lidaEm: new Date().toISOString() }] });
  assert.ok(!JSON.stringify(integ.body).match(/"gravadas":[1-9]/), `integração da B no container da A → ${integ.status} ${JSON.stringify(integ.body).slice(0, 160)}`);

  assert.equal(await foto(), antes, "NENHUM dado da organização A mudou");

  // Cobertura: toda rota com parâmetro nos arquivos de rotas tem caso de ataque (ou está em FORA).
  const MONTAGEM = { alertas: "/api/alertas", containers: "/api/containers", etiquetas: "/api/etiquetas", locais: "/api/locais", tiposLocal: "/api/tipos-local", tiposOperacao: "/api/tipos-operacao", motoristas: "/api/motoristas", organizacoes: "/api/organizacoes", posicao: "/api/posicao", qr: "/api/qr", tokens: "/api/tokens", usuarios: "/api/usuarios", auth: "/api/auth" };
  const cobertas = new Set([...CASOS.map(([n]) => n), ...FORA]);
  const faltando = [];
  for (const arq of fs.readdirSync(new URL("./routes/", import.meta.url))) {
    const txt = fs.readFileSync(new URL(`./routes/${arq}`, import.meta.url), "utf8");
    for (const m of txt.matchAll(/^(\w+)Router\.(get|post|put|patch|delete)\("([^"]*:[^"]*)"/gm)) {
      const nome = `${m[2].toUpperCase()} ${MONTAGEM[m[1]] ?? "?"}${m[3].replace(/\(.*?\)/g, "")}`;
      if (!cobertas.has(nome)) faltando.push(nome);
    }
    if (arq === "cadastros.js") {
      for (const rota of ["regioes", "grupos", "armadores", "produtos", "transportadoras"]) {
        for (const met of ["PATCH", "DELETE"]) if (!cobertas.has(`${met} /api/${rota}/:id`)) faltando.push(`${met} /api/${rota}/:id`);
      }
    }
  }
  assert.deepEqual(faltando, [], "rota com identificador sem teste de invasão");
});

test("v3.2 segurança: gestor, motorista compartilhado, código curto, cliente desativado, concorrência e endereço", async () => {
  const { comoSistema } = await import("./lib/tenant.js");
  const { prisma: bruto } = await import("./lib/prisma.js");
  const { caixaDeSaidaSms } = await import("./lib/sms.js");
  const { buscarDestinatario } = await import("./lib/rastreamento.js");
  const a = agentes.ADMIN;
  const orgA = ORG_TESTE;
  const orgB = await comoSistema(() => bruto.organizacao.create({ data: { nome: "Cliente Seg 3.2" } }));
  const senhaHash = await bcrypt.hash("senha-teste-123", 4);
  await comOrganizacao(orgB.id, () => bruto.usuario.create({ data: { email: "admin@seg32.local", nome: "Admin Seg", perfil: "ADMIN", senhaHash } }));
  const b = await logar("admin@seg32.local");
  const vincularEm = (motoristaId, organizacaoId) => comoSistema(() => bruto.motoristaOrganizacao.upsert({
    where: { motoristaId_organizacaoId: { motoristaId, organizacaoId } }, create: { motoristaId, organizacaoId }, update: {},
  }));

  // ---- Item 1: gestor só com transportadora do próprio cliente; só vê motoristas do cliente ----
  const tB = await b.post("/api/transportadoras").send({ nome: "Transp Só da B" });
  assert.equal(tB.status, 201, JSON.stringify(tB.body));
  const gestorInvasor = await a.post("/api/usuarios").send({ email: "gestor-invasor@teste.local", nome: "Gestor X", perfil: "GESTOR_TRANSPORTADORA", senha: "senha-teste-123", transportadoraId: tB.body.id });
  assert.equal(gestorInvasor.status, 400, "transportadora de outro cliente");
  const tComum = await a.post("/api/transportadoras").send({ nome: "Transp Comum 3.2" });
  await comoSistema(() => bruto.transportadoraOrganizacao.create({ data: { transportadoraId: tComum.body.id, organizacaoId: orgB.id } }));
  const gA = await a.post("/api/usuarios").send({ email: "gestor-comum@teste.local", nome: "Gestor Comum", perfil: "GESTOR_TRANSPORTADORA", senha: "senha-teste-123", transportadoraId: tComum.body.id });
  assert.equal(gA.status, 201, JSON.stringify(gA.body));
  const gestorA = await logar("gestor-comum@teste.local");
  const daA = await a.post("/api/motoristas").send({ nome: "Motorista da A", celular: "11955557101", transportadoraId: tComum.body.id, cpf: "529.982.247-25" });
  assert.equal(daA.status, 201, JSON.stringify(daA.body));
  const daB = await b.post("/api/motoristas").send({ nome: "Motorista da B", celular: "11955557102", transportadoraId: tComum.body.id });
  assert.equal(daB.status, 201, JSON.stringify(daB.body));
  const listaGestor = (await gestorA.get("/api/motoristas")).body;
  assert.deepEqual(listaGestor.map((m) => m.nome), ["Motorista da A"], "gestor da A não vê o motorista que só a B cadastrou");
  assert.equal((await gestorA.get(`/api/motoristas/${daB.body.id}`)).status, 404);
  // CPF mascarado e sem e-mail de quem cadastrou/bloqueou (LGPD).
  assert.equal(daA.body.cpf, "***.982.247-**");
  assert.equal(listaGestor[0].cpf, "***.982.247-**");
  assert.equal((await a.get(`/api/motoristas/${daA.body.id}`)).body.cpf, "***.982.247-**");
  for (const m of [daA.body, listaGestor[0]]) assert.ok(!("criadoPor" in m) && !("bloqueadoPor" in m));

  // ---- Item 2: motorista compartilhado — bloqueio por cliente e dados só por ele ----
  const XFF = { "X-Forwarded-For": "198.51.100.32" };
  const TEL = "+5511955557103";
  const mot = request.agent(app);
  const codigoDe = (tel, re = /codigo de acesso e (\d{6})/) => re.exec(caixaDeSaidaSms.filter((s) => s.para === tel).at(-1)?.texto ?? "")?.[1];
  const [etqLogin] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  await mot.post("/api/motorista/codigo").set(XFF).send({ celular: TEL, etiqueta: etqLogin.token });
  const v = await mot.post("/api/motorista/verificar").set(XFF).send({ celular: TEL, codigo: codigoDe(TEL) });
  const cad = await mot.post("/api/motorista/cadastro").set(XFF).send({ comprovante: v.body.comprovante, nome: "Carlos Compartilhado", transportadoraId: tComum.body.id, aceite: true });
  assert.equal(cad.status, 201, JSON.stringify(cad.body));
  const motId = cad.body.motorista.id;
  await vincularEm(motId, orgA);
  await vincularEm(motId, orgB.id);
  const bloqB = await b.patch(`/api/motoristas/${motId}`).send({ bloqueado: true });
  assert.equal(bloqB.status, 200, JSON.stringify(bloqB.body));
  assert.deepEqual([bloqB.body.bloqueado, bloqB.body.bloqueadoNoCliente, bloqB.body.bloqueadoPelaTransportadora], [true, true, false]);
  const naA = (await a.get("/api/motoristas")).body.find((m) => m.id === motId);
  assert.equal(naA.bloqueado, false, "o bloqueio da B não aparece para a A");
  assert.equal(naA.compartilhado, true);
  assert.equal((await mot.get("/api/motorista/eu")).status, 200, "bloqueio de um cliente não derruba o acesso");
  // QR da B recusado; QR da A segue.
  const [etqA] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  const [etqB] = (await b.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  const qrB = await mot.get(`/api/motorista/qr/${etqB.token}`);
  assert.deepEqual([qrB.status, qrB.body.codigo], [403, "BLOQUEADO_NO_CLIENTE"]);
  assert.equal((await mot.get(`/api/motorista/qr/${etqA.token}`)).status, 200);
  // SMS: na B o motorista está inativo; na A, ativo.
  assert.equal((await comOrganizacao(orgB.id, () => buscarDestinatario({ motoristaId: motId }))).ativo, false);
  assert.equal((await comOrganizacao(orgA, () => buscarDestinatario({ motoristaId: motId }))).ativo, true);
  // Nome, placa e celular de compartilhado: 409 para os clientes.
  assert.equal((await a.patch(`/api/motoristas/${motId}`).send({ celular: "11955557199" })).status, 409);
  assert.equal((await b.patch(`/api/motoristas/${motId}`).send({ nome: "Outro Nome" })).status, 409);
  assert.equal((await a.patch(`/api/motoristas/${daA.body.id}`).send({ placa: "ABC1D23" })).status, 200, "exclusivo da A: pode");
  // Desbloqueio pela B.
  assert.equal((await b.patch(`/api/motoristas/${motId}`).send({ bloqueado: false })).body.bloqueado, false);
  // Troca de celular pelo próprio motorista, confirmando o número novo por SMS.
  const NOVO = "+5511955557104";
  assert.equal((await mot.post("/api/motorista/eu/celular").set(XFF).send({ celular: "11955557101" })).status, 409, "número de outro motorista");
  assert.equal((await mot.post("/api/motorista/eu/celular").set(XFF).send({ celular: NOVO })).status, 200);
  const codNovo = codigoDe(NOVO, /novo celular: (\d{6})/);
  assert.ok(codNovo);
  assert.equal((await mot.post("/api/motorista/eu/celular/confirmar").set(XFF).send({ celular: NOVO, codigo: "000000" === codNovo ? "111111" : "000000" })).status, 400);
  const troca = await mot.post("/api/motorista/eu/celular/confirmar").set(XFF).send({ celular: NOVO, codigo: codNovo });
  assert.equal(troca.status, 200, JSON.stringify(troca.body));
  assert.equal(troca.body.motorista.celular, NOVO);
  assert.ok(caixaDeSaidaSms.some((s) => s.para === TEL && s.texto.includes("foi trocado")), "aviso no número antigo");
  assert.equal((await mot.get("/api/motorista/eu")).status, 200, "quem trocou continua conectado");

  // ---- Item 3: código curto — limite de falhas e regra do motorista ----
  const XFF3 = { "X-Forwarded-For": "198.51.100.33" };
  assert.equal((await a.post("/api/usuarios").send({ email: "codigo32@teste.local", nome: "Op Código", perfil: "OPERADOR", senha: "senha-teste-123" })).status, 201);
  const op = await logar("codigo32@teste.local");
  for (let i = 0; i < 10; i++) assert.equal((await op.get("/api/qr/codigo/CC-ZZZZZZZZ").set(XFF3)).status, 404);
  const bloqueado = await op.get("/api/qr/codigo/CC-ZZZZZZZZ").set(XFF3);
  assert.equal(bloqueado.status, 429, "11ª falha seguida");
  assert.equal((await op.get(`/api/qr/codigo/${etqA.codigo}`).set(XFF3)).status, 429, "pessoa limitada até a janela passar");
  // Motorista: etiqueta livre não abre pelo código; ligada, só com o número do container.
  const XFF4 = { "X-Forwarded-For": "198.51.100.34" };
  assert.equal((await mot.get(`/api/motorista/qr/codigo/${etqA.codigo}`).set(XFF4)).status, 404, "livre");
  const ativoId = async (rec) => (await a.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cadA = { grupoId: await ativoId("grupos"), armadorId: await ativoId("armadores") };
  const cA = await a.post("/api/containers").send({ numero: "SEGU3200001", confirmarDigito: true, tipo: "DRY_40", ...cadA });
  assert.equal(cA.status, 201, JSON.stringify(cA.body));
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${etqA.token}/vincular`).send({ numero: "SEGU3200001" })).status, 201);
  assert.equal((await mot.get(`/api/motorista/qr/codigo/${etqA.codigo}`).set(XFF4)).status, 404, "sem número");
  assert.equal((await mot.get(`/api/motorista/qr/codigo/${etqA.codigo}?numero=MSCU1234566`).set(XFF4)).status, 404, "número errado");
  const certo = await mot.get(`/api/motorista/qr/codigo/${etqA.codigo}?numero=SEGU3200001`).set(XFF4);
  assert.equal(certo.status, 200, JSON.stringify(certo.body));
  assert.equal(certo.body.token, etqA.token);

  // ---- Item 4: cliente desativado não recebe dados (motorista pelo QR e integração) ----
  const tokB = await b.post("/api/tokens").send({ nome: "Sensor Seg" });
  assert.equal(tokB.status, 201);
  await comoSistema(() => bruto.organizacao.update({ where: { id: orgB.id }, data: { ativo: false } }));
  assert.equal((await mot.get(`/api/motorista/qr/${etqB.token}`)).status, 403, "motorista no QR do cliente desativado");
  const integ = await request(app).post("/api/integracao/temperaturas").set("Authorization", `Bearer ${tokB.body.token}`).send({ leituras: [{ container: "SEGU3200001", temperatura: -18, lidaEm: new Date().toISOString() }] });
  assert.equal(integ.status, 403, "token de cliente desativado");
  await comoSistema(() => bruto.organizacao.update({ where: { id: orgB.id }, data: { ativo: true } }));

  // ---- Item 5: concorrência — um passa, os outros 409 ----
  const corpo = { numero: "SEGU3200017", confirmarDigito: true, tipo: "DRY_40", ...cadA };
  const simultaneos = await Promise.all(Array.from({ length: 6 }, () => a.post("/api/containers").send(corpo)));
  assert.deepEqual(simultaneos.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
  assert.equal(await prisma.container.count({ where: { numero: "SEGU3200017", status: { notIn: ["ENTREGUE_PORTO", "CANCELADO"] } } }), 1);
  const idNovo = simultaneos.find((r) => r.status === 201).body.id;
  const avancos = await Promise.all([a.post(`/api/containers/${idNovo}/avancar`).send({}), a.post(`/api/containers/${idNovo}/avancar`).send({})]);
  assert.deepEqual(avancos.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await prisma.eventoContainer.count({ where: { containerId: idNovo, statusPara: "COLETADO" } }), 1, "evento gravado uma vez");
  const cancelamentos = await Promise.all([a.post(`/api/containers/${idNovo}/cancelar`).send({ motivo: "x" }), a.post(`/api/containers/${idNovo}/cancelar`).send({ motivo: "y" })]);
  assert.deepEqual(cancelamentos.map((r) => r.status).sort(), [200, 409]);
  // Mesma etiqueta em dois containers ao mesmo tempo: uma ligação só.
  const c2 = await a.post("/api/containers").send({ numero: "SEGU3200022", confirmarDigito: true, tipo: "DRY_40", ...cadA });
  const c3 = await a.post("/api/containers").send({ numero: "SEGU3200038", confirmarDigito: true, tipo: "DRY_40", ...cadA });
  assert.deepEqual([c2.status, c3.status], [201, 201], JSON.stringify([c2.body, c3.body]));
  const [etq2] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  const vinculos = await Promise.all([
    agentes.OPERADOR.post(`/api/qr/${etq2.token}/vincular`).send({ numero: "SEGU3200022" }),
    agentes.OPERADOR.post(`/api/qr/${etq2.token}/vincular`).send({ numero: "SEGU3200038" }),
  ]);
  assert.deepEqual(vinculos.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await prisma.logAuditoria.count({ where: { acao: "VINCULAR", entidadeId: String(etq2.id) } }), 1, "um vínculo no log");

  // ---- Item 19: em produção, o endereço dos links é sempre o da plataforma ----
  const { enderecoPublicoFixo } = await import("./lib/enderecoPublico.js");
  const ambiente = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL };
  const cfg = (await a.get("/api/configuracao")).body;
  await a.put("/api/configuracao").send({ ...cfg, urlPublica: "https://cliente-escolheu.example.com" });
  try {
    process.env.NODE_ENV = "production";
    process.env.APP_URL = "https://plataforma.example.com/";
    assert.equal(await naOrg(enderecoPublicoFixo)(), "https://plataforma.example.com");
  } finally {
    process.env.NODE_ENV = ambiente.NODE_ENV;
    if (ambiente.APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = ambiente.APP_URL;
  }
  assert.equal(await naOrg(enderecoPublicoFixo)(), "https://cliente-escolheu.example.com", "fora de produção vale a configuração (teste em rede local)");
  await a.put("/api/configuracao").send(cfg);

  for (const id of [cA.body.id, c2.body.id, c3.body.id]) await a.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste 3.2" });
});

test("v3.3 endurecimento: log imutável, SMS por cliente, ORS, login, LGPD, planilha, IPs e outros", async () => {
  const { comoSistema } = await import("./lib/tenant.js");
  const { prisma: bruto } = await import("./lib/prisma.js");
  const { purgarLogsExpirados } = await import("./lib/auditoria.js");
  const { purgarDadosAntigos } = await import("./lib/rastreamento.js");
  const { paraCadaOrganizacao } = await import("./lib/organizacoes.js");
  const { MAX_CODIGOS_POR_HORA_CLIENTE } = await import("./lib/acessoMotorista.js");
  const jwt = (await import("jsonwebtoken")).default;
  const a = agentes.ADMIN;
  const DIA = 24 * 3600e3;

  // ---- Item 8: o sistema (ccs_app) não altera nem apaga o log; a purga vai pela função ----
  const velho = await prisma.logAuditoria.create({ data: { usuarioEmail: "teste", acao: "TESTE", entidade: "Teste", descricao: "log antigo", criadoEm: new Date(Date.now() - 400 * DIA) } });
  const novo = await prisma.logAuditoria.create({ data: { usuarioEmail: "teste", acao: "TESTE", entidade: "Teste", descricao: "log novo" } });
  await assert.rejects(prisma.logAuditoria.deleteMany({ where: { id: novo.id } }), /permission denied|denied/i, "DELETE negado");
  await assert.rejects(prisma.logAuditoria.updateMany({ where: { id: novo.id }, data: { descricao: "alterado" } }), /permission denied|denied/i, "UPDATE negado");
  await assert.rejects(comoSistema(() => bruto.$queryRaw`SELECT purgar_log_auditoria(30)`), /365/, "retenção mínima");
  assert.ok((await purgarLogsExpirados()) >= 1);
  assert.equal(await prisma.logAuditoria.count({ where: { id: velho.id } }), 0, "antigo apagado pela função");
  assert.equal(await prisma.logAuditoria.count({ where: { id: novo.id } }), 1, "recente fica");

  // ---- Item 10: código SMS do motorista exige etiqueta válida; teto por cliente ----
  const XFF = { "X-Forwarded-For": "198.51.100.40" };
  assert.equal((await request(app).post("/api/motorista/codigo").set(XFF).send({ celular: "11955558001" })).status, 400, "sem etiqueta");
  const [etq, etqCancelada] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 2 })).body.etiquetas;
  await agentes.SUPERVISOR.post(`/api/etiquetas/${etqCancelada.id}/cancelar`).send({ motivo: "teste" });
  assert.equal((await request(app).post("/api/motorista/codigo").set(XFF).send({ celular: "11955558001", etiqueta: etqCancelada.token })).status, 400, "etiqueta cancelada");
  const ok = await request(app).post("/api/motorista/codigo").set(XFF).send({ celular: "11955558001", etiqueta: etq.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await prisma.codigoAcessoMotorista.findFirst({ where: { celular: "+5511955558001" } })).organizacaoId, ORG_TESTE);
  // Cliente no teto: 429 para ele (os outros clientes seguem — o teto é por organizacaoId).
  const enchidos = Array.from({ length: MAX_CODIGOS_POR_HORA_CLIENTE }, (_, i) => ({ celular: `+55119500${String(i).padStart(5, "0")}`, codigoHash: "x", expiraEm: new Date(Date.now() + 60e3), organizacaoId: ORG_TESTE }));
  await prisma.codigoAcessoMotorista.createMany({ data: enchidos });
  assert.equal((await request(app).post("/api/motorista/codigo").set({ "X-Forwarded-For": "198.51.100.41" }).send({ celular: "11955558002", etiqueta: etq.token })).status, 429);
  await prisma.codigoAcessoMotorista.deleteMany({ where: { codigoHash: "x" } });

  // ---- Item 11: simulação de rota só para quem cadastra container ----
  assert.equal((await agentes.VISUALIZACAO.get("/api/rotas/estimar")).status, 403);

  // ---- Item 13: e-mail inexistente leva o mesmo tempo (passa pelo bcrypt) ----
  const tempo = async (email) => {
    const t0 = performance.now();
    await request(app).post("/api/auth/login").set("X-Forwarded-For", "198.51.100.42").send({ email, senha: "senha-errada-123" });
    return performance.now() - t0;
  };
  const mediana = (v) => v.sort((x, y) => x - y)[Math.floor(v.length / 2)];
  const existe = [], naoExiste = [];
  for (let i = 0; i < 4; i++) { existe.push(await tempo("operador@teste.local")); naoExiste.push(await tempo(`ninguem${i}@teste.local`)); }
  assert.ok(mediana(naoExiste) > mediana(existe) * 0.5, `inexistente ${mediana(naoExiste).toFixed(0)} ms × existente ${mediana(existe).toFixed(0)} ms`);

  // ---- Item 15: retenção — organização desativada também; telefone dos SMS antigos sai ----
  const orgInativa = await comoSistema(() => bruto.organizacao.create({ data: { nome: "Cliente Inativo 3.3", ativo: false } }));
  const visitadas = [];
  await paraCadaOrganizacao(async (o) => visitadas.push(o.id), "teste", { incluirInativas: true });
  assert.ok(visitadas.includes(orgInativa.id), "purga percorre as desativadas");
  const smsVelho = await prisma.mensagemSms.create({ data: { containerId: ids.reefer, telefone: "+5511999990000", tipo: "POSICAO", status: "SIMULADA", texto: "x", criadaEm: new Date(Date.now() - 100 * DIA) } });
  await purgarDadosAntigos();
  const depois = await prisma.mensagemSms.findUnique({ where: { id: smsVelho.id } });
  assert.deepEqual([depois.telefone, depois.texto], [null, "x"], "fica a mensagem, sem o número");
  // Anonimização do motorista (direito de exclusão).
  const tr = await a.post("/api/transportadoras").send({ nome: "Transp LGPD 3.3" });
  const mot = await a.post("/api/motoristas").send({ nome: "Fulano Exclusivo", celular: "11955558010", transportadoraId: tr.body.id, cpf: "529.982.247-25", placa: "ABC1D23" });
  assert.equal((await logar("gestor-comum@teste.local").then((g) => g.post(`/api/motoristas/${mot.body.id}/anonimizar`))).status, 403, "gestor não anonimiza");
  const an = await a.post(`/api/motoristas/${mot.body.id}/anonimizar`);
  assert.equal(an.status, 200, JSON.stringify(an.body));
  const dbMot = await comoSistema(() => bruto.motorista.findUnique({ where: { id: mot.body.id } }));
  assert.deepEqual([dbMot.nome, dbMot.cpf, dbMot.placa, dbMot.bloqueado], [`Motorista anonimizado #${mot.body.id}`, null, null, true]);
  assert.ok(dbMot.celular.startsWith("anonimizado-"));
  assert.equal((await a.post(`/api/motoristas/${mot.body.id}/anonimizar`)).status, 409, "já anonimizado");
  const compartilhado = await a.post("/api/motoristas").send({ nome: "Ciclano Compartilhado", celular: "11955558011", transportadoraId: tr.body.id });
  await comoSistema(() => bruto.motoristaOrganizacao.create({ data: { motoristaId: compartilhado.body.id, organizacaoId: orgInativa.id } }));
  assert.equal((await a.post(`/api/motoristas/${compartilhado.body.id}/anonimizar`)).status, 409, "compartilhado: pedido à plataforma");

  // ---- Item 16: planilha maior que 1 MB recusada antes de abrir ----
  const grande = await a.post("/api/containers/importar").set("Content-Type", "application/octet-stream").send(Buffer.alloc(1024 * 1024 + 10, 1));
  assert.equal(grande.status, 413);

  // ---- Item 17: IPs internos só para quem administra (e nunca em produção) ----
  assert.deepEqual((await agentes.VISUALIZACAO.get("/api/etiquetas/impressao")).body.sugestoes, []);
  assert.ok(Array.isArray((await a.get("/api/etiquetas/impressao")).body.sugestoes));

  // ---- Item 20: mensagens que não revelam cadastro de outro cliente; comprovante separado; CSP; log ----
  const { comOrganizacao: naOrganizacao } = await import("./lib/tenant.js");
  await naOrganizacao(orgInativa.id, () => bruto.usuario.create({ data: { email: "de-outro-cliente@teste.local", nome: "X", perfil: "ADMIN", senhaHash: "x" } }));
  const outro = await a.post("/api/usuarios").send({ email: "de-outro-cliente@teste.local", nome: "Y", perfil: "OPERADOR", senha: "senha-teste-123" });
  assert.deepEqual([outro.status, /não pode ser usado/.test(outro.body.erro)], [409, true], "e-mail de outro cliente: genérico");
  const mesmo = await a.post("/api/usuarios").send({ email: "operador@teste.local", nome: "Y", perfil: "OPERADOR", senha: "senha-teste-123" });
  assert.deepEqual([mesmo.status, mesmo.body.erro], [409, "Já existe um usuário com esse e-mail."], "mesmo cliente: mensagem clara");
  const forjado = jwt.sign({ tipo: "cadastro-motorista", celular: "+5511955558099" }, process.env.JWT_SECRET, { expiresIn: "30m" });
  assert.equal((await request(app).post("/api/motorista/cadastro").set(XFF).send({ comprovante: forjado, nome: "Forjado Silva", transportadoraId: tr.body.id, aceite: true })).status, 401, "assinado com o segredo da sessão não vale");
  const csp = (await request(app).get("/api/saude")).headers["content-security-policy"];
  assert.match(csp ?? "", /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  // Ação do motorista pelo QR grava o id dele no log.
  const XFFm = { "X-Forwarded-For": "198.51.100.43" };
  const { caixaDeSaidaSms } = await import("./lib/sms.js");
  const m = request.agent(app);
  await m.post("/api/motorista/codigo").set(XFFm).send({ celular: "11955558020", etiqueta: etq.token });
  const cod = /codigo de acesso e (\d{6})/.exec(caixaDeSaidaSms.filter((s) => s.para === "+5511955558020").at(-1).texto)[1];
  const v = await m.post("/api/motorista/verificar").set(XFFm).send({ celular: "11955558020", codigo: cod });
  const cad = await m.post("/api/motorista/cadastro").set(XFFm).send({ comprovante: v.body.comprovante, nome: "Beltrano Log", transportadoraId: tr.body.id, aceite: true });
  assert.equal(cad.status, 201, JSON.stringify(cad.body));
  const ativo = async (rec) => (await a.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cadL = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  const c = await a.post("/api/containers").send({ numero: "LOGU3300004", confirmarDigito: true, tipo: "DRY_40", ...cadL });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const vin = await m.post(`/api/motorista/qr/${etq.token}/vincular`).send({ numero: "LOGU3300004" });
  assert.equal(vin.status, 201, JSON.stringify(vin.body));
  const logVinculo = await prisma.logAuditoria.findFirst({ where: { acao: "VINCULAR", entidadeId: String(etq.id) } });
  assert.equal(logVinculo.motoristaId, cad.body.motorista.id);
  await a.post(`/api/containers/${c.body.id}/cancelar`).send({ motivo: "fim do teste 3.3" });
});

test("v3.4 referência cruzada: cliente B não consegue apontar para cadastros da A (item 7)", async () => {
  const { criarOrganizacao } = await import("./lib/organizacoes.js");
  await criarOrganizacao({ nome: "Cliente Ref 3.4", admin: { email: "admin@ref34.local", nome: "Admin Ref", senha: "senha-teste-123" }, criadoPor: "teste" });
  const b = await logar("admin@ref34.local");
  const a = agentes.ADMIN;
  const primeiro = async (ag, rota) => (await ag.get(rota)).body[0];
  const doA = {
    grupoId: (await primeiro(a, "/api/grupos?ativos=1")).id,
    armadorId: (await primeiro(a, "/api/armadores?ativos=1")).id,
    produtoId: (await primeiro(a, "/api/produtos?ativos=1")).id,
    localId: ids.santos,
    tipoLocalId: (await primeiro(a, "/api/tipos-local")).id,
  };
  const regiaoA = await a.post("/api/regioes").send({ nome: "Região Só da A" });
  assert.equal(regiaoA.status, 201, JSON.stringify(regiaoA.body));

  // Cadastros válidos da própria B (para cada recusa ser pela referência cruzada, não por falta de dado).
  const tipoRetB = (await b.get("/api/tipos-local")).body.find((t) => t.funcao === "RETIRADA_ENTREGA");
  const localB = await b.post("/api/locais").send({ nome: "Porto B", tipoId: tipoRetB.id });
  const grupoB = await b.post("/api/grupos").send({ cliente: "Cli B", fabrica: "Fab B", metaEstadiaHoras: 24 });
  const armB = await b.post("/api/armadores").send({ nome: "Arm B", freeTimeDias: 10, valorDiaria: 100 });
  for (const r of [localB, grupoB, armB]) assert.equal(r.status, 201, JSON.stringify(r.body));
  const base = { numero: "REFU3400005", confirmarDigito: true, tipo: "DRY_40", grupoId: grupoB.body.id, armadorId: armB.body.id };
  const recusado = (r, oQue) => assert.ok([400, 404, 409].includes(r.status), `${oQue} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

  // Container: cada campo com o id da A é recusado.
  recusado(await b.post("/api/containers").send({ ...base, grupoId: doA.grupoId }), "container com ponto de carregamento da A");
  recusado(await b.post("/api/containers").send({ ...base, armadorId: doA.armadorId }), "container com armador da A");
  recusado(await b.post("/api/containers").send({ ...base, tipo: "REEFER_40", produtoId: doA.produtoId }), "container com produto da A");
  recusado(await b.post("/api/containers").send({ ...base, portoRetiradaId: doA.localId }), "container com local de retirada da A");
  const cB = await b.post("/api/containers").send(base);
  assert.equal(cB.status, 201, JSON.stringify(cB.body));
  // armadorId não é editável no PATCH: o pedido é aceito, mas o campo é ignorado (fica o da B).
  const editado = await b.patch(`/api/containers/${cB.body.id}`).send({ armadorId: doA.armadorId });
  assert.ok(editado.status >= 400 || editado.body.armadorId === armB.body.id, "armador da A não gravado");
  recusado(await b.patch(`/api/containers/${cB.body.id}`).send({ portoEntregaId: doA.localId }), "editar container com local da A");
  // Cadastros apontando para cadastros da A.
  recusado(await b.post("/api/grupos").send({ cliente: "X", fabrica: "Y", metaEstadiaHoras: 24, regiaoId: regiaoA.body.id }), "ponto de carregamento com região da A");
  recusado(await b.post("/api/grupos").send({ cliente: "X", fabrica: "Z", metaEstadiaHoras: 24, localId: doA.localId }), "ponto de carregamento com local da A");
  recusado(await b.post("/api/locais").send({ nome: "Outro", tipoId: doA.tipoLocalId }), "local com tipo da A");
  // Nada da A foi tocado e nada da B aponta para a A.
  const { prisma: bruto } = await import("./lib/prisma.js");
  const { comoSistema } = await import("./lib/tenant.js");
  const cruzados = await comoSistema(() => bruto.$queryRaw`
    SELECT count(*)::int AS n FROM "Container" c
    LEFT JOIN "GrupoOperacao" g ON g.id = c."grupoId" LEFT JOIN "Armador" ar ON ar.id = c."armadorId"
    WHERE g."organizacaoId" <> c."organizacaoId" OR ar."organizacaoId" <> c."organizacaoId"`);
  assert.equal(cruzados[0].n, 0, "nenhum container no banco aponta para cadastro de outro cliente");
});

test("v3.4 transportadora: nome único só no cliente; mesmo CNPJ reaproveita o cadastro (item 9)", async () => {
  const b = await logar("admin@ref34.local");
  const a = agentes.ADMIN;
  // Mesmo nome, sem CNPJ, em clientes diferentes: cadastros separados (podem ser empresas diferentes).
  const ra = await a.post("/api/transportadoras").send({ nome: "Rodo Homônima" });
  const rb = await b.post("/api/transportadoras").send({ nome: "rodo homônima" });
  assert.deepEqual([ra.status, rb.status], [201, 201], JSON.stringify([ra.body, rb.body]));
  assert.notEqual(ra.body.id, rb.body.id);
  assert.equal((await a.post("/api/transportadoras").send({ nome: "RODO HOMÔNIMA" })).status, 409, "no mesmo cliente o nome é único");
  // Mesmo CNPJ = mesma empresa: o segundo cliente só ganha o vínculo.
  const ca = await a.post("/api/transportadoras").send({ nome: "Transp CNPJ", cnpj: "11.222.333/0001-81" });
  assert.equal(ca.status, 201);
  const cb = await b.post("/api/transportadoras").send({ nome: "Transp CNPJ (filial)", cnpj: "11222333000181" });
  assert.equal(cb.status, 201, JSON.stringify(cb.body));
  assert.equal(cb.body.id, ca.body.id, "cadastro reaproveitado");
  assert.ok((await b.get("/api/transportadoras")).body.some((t) => t.id === ca.body.id), "B passa a ver");
  assert.equal((await b.post("/api/transportadoras").send({ nome: "De novo", cnpj: "11222333000181" })).status, 409, "já está no cadastro da B");
  // Compartilhada: nenhum dos dois altera sozinho; CNPJ de outra empresa na edição → 409.
  assert.equal((await b.patch(`/api/transportadoras/${ca.body.id}`).send({ nome: "Renomeada" })).status, 409);
  assert.equal((await a.patch(`/api/transportadoras/${ra.body.id}`).send({ cnpj: "11222333000181" })).status, 409);
  const log = (await b.get(`/api/logs?entidade=Transportadora&entidadeId=${ca.body.id}`)).body;
  assert.ok(log.some((l) => /vinculado.*mesmo CNPJ/.test(l.descricao)));
});

test("v3.4.1: desfazer entrega com outro ativo de mesmo número → 409; total de Custos = soma das fichas; 413 em português", async () => {
  const { resumir } = await import("../web/src/custos.js");
  const a = agentes.ADMIN;
  const ativo = async (rec) => (await a.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };

  // Item 4: A entregue, B ativo com o mesmo número, desfazer a entrega de A → 409 (antes: 500).
  const A = await a.post("/api/containers").send({ numero: "DSFU3410004", confirmarDigito: true, tipo: "DRY_40", ...cad });
  assert.equal(A.status, 201, JSON.stringify(A.body));
  await a.post(`/api/containers/${A.body.id}/cancelar`).send({ motivo: "teste desfazer" });
  const B = await a.post("/api/containers").send({ numero: "DSFU3410004", confirmarDigito: true, tipo: "DRY_40", ...cad });
  assert.equal(B.status, 201, JSON.stringify(B.body));
  const desfazer = await a.post(`/api/containers/${A.body.id}/desfazer`);
  assert.equal(desfazer.status, 409);
  assert.match(desfazer.body.erro, /Já existe outro container DSFU3410004 ativo/);
  await a.post(`/api/containers/${B.body.id}/cancelar`).send({ motivo: "fim" });

  // Item 7: N containers com estadia excedida e custo/h "quebrado": total da tela = soma das fichas.
  let semente = 7;
  const aleatorio = () => ((semente = (semente * 1103515245 + 12345) % 2147483648) / 2147483648);
  const criados = [];
  for (let i = 0; i < 40; i++) {
    const numero = `CSTU34${String(10000 + i).slice(1)}`;
    const r = await a.post("/api/containers").send({ numero: numero + "0", confirmarDigito: true, tipo: "DRY_40", ...cad });
    const id = r.status === 201 ? r.body.id : (await a.post("/api/containers").send({ numero: numero + "0", tipo: "DRY_40", ...cad })).body?.id;
    if (!id) continue;
    await prisma.container.update({
      where: { id },
      // Saída já registrada: custo fixo (não cresce entre a leitura da tela e a das fichas).
      data: { status: "SAIU_FABRICA", coletadoEm: new Date(Date.now() - 6 * 24 * 3600e3), chegadaFabricaEm: new Date(Date.now() - (60 + aleatorio() * 60) * 3600e3), saidaFabricaEm: new Date(Date.now() - aleatorio() * 30 * 3600e3), metaEstadiaHoras: 24, custoEstadiaPorHora: Math.round(aleatorio() * 99999) / 100 },
    });
    criados.push(id);
  }
  assert.ok(criados.length >= 30, `containers de custo criados: ${criados.length}`);
  const dados = (await a.get("/api/custos")).body;
  const meus = new Set(criados);
  const r = resumir({ ...dados, containers: dados.containers.filter((c) => meus.has(c.id)) }, dados.grupos.map((g) => g.id));
  let fichas = 0;
  for (const c of dados.containers.filter((x) => meus.has(x.id))) {
    const f = (await a.get(`/api/containers/${c.id}`)).body;
    fichas += f.situacao?.estadia?.custo ?? 0;
  }
  assert.equal(Math.round((r.estadia.BRL ?? 0) * 100), Math.round(fichas * 100), "total da tela bate ao centavo com a soma das fichas");
  for (const id of criados) await a.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste de custos" });

  // Planilha > 1 MB: mensagem em português.
  const grande = await a.post("/api/containers/importar").set("Content-Type", "application/octet-stream").send(Buffer.alloc(1024 * 1024 + 10, 1));
  assert.equal(grande.status, 413);
  assert.match(grande.body.erro, /Arquivo grande demais/);
});

test("v3.5 revisão: bloqueio do gestor por cliente, anonimização sem homônimos, CNPJ e dono, prazo do acompanhamento, teto por etiqueta", async () => {
  const { comoSistema, comOrganizacao } = await import("./lib/tenant.js");
  const { prisma: bruto } = await import("./lib/prisma.js");
  const { buscarDestinatario } = await import("./lib/rastreamento.js");
  const { caixaDeSaidaSms } = await import("./lib/sms.js");
  const { MAX_CODIGOS_POR_HORA_ETIQUETA } = await import("./lib/acessoMotorista.js");
  const a = agentes.ADMIN;
  const b = await logar("admin@ref34.local");
  const orgB = (await comoSistema(() => bruto.usuario.findFirst({ where: { email: "admin@ref34.local" } }))).organizacaoId;
  const H = 3600e3;

  // ---- Item 1: gestor criado por A bloqueia motorista compartilhado com B → só em A ----
  const T = await a.post("/api/transportadoras").send({ nome: "Transp Gestor 3.5" });
  assert.equal(T.status, 201, JSON.stringify(T.body));
  const M = await a.post("/api/motoristas").send({ nome: "Compartilhado Gestor", celular: "11955559001", transportadoraId: T.body.id });
  await comoSistema(() => bruto.motoristaOrganizacao.create({ data: { motoristaId: M.body.id, organizacaoId: orgB } }));
  assert.equal((await a.post("/api/usuarios").send({ email: "gestor35@teste.local", nome: "Gestor 3.5", perfil: "GESTOR_TRANSPORTADORA", senha: "senha-teste-123", transportadoraId: T.body.id })).status, 201);
  const gestor = await logar("gestor35@teste.local");
  const bl = await gestor.patch(`/api/motoristas/${M.body.id}`).send({ bloqueado: true });
  assert.deepEqual([bl.status, bl.body.bloqueado, bl.body.bloqueadoNoCliente], [200, true, true], JSON.stringify(bl.body));
  assert.equal((await comoSistema(() => bruto.motorista.findUnique({ where: { id: M.body.id } }))).bloqueado, false, "Motorista.bloqueado continua falso");
  assert.equal((await b.get("/api/motoristas")).body.find((m) => m.id === M.body.id).bloqueado, false, "B vê ativo");
  assert.equal((await comOrganizacao(orgB, () => buscarDestinatario({ motoristaId: M.body.id }))).ativo, true, "SMS de B segue");
  assert.equal((await comOrganizacao(ORG_TESTE, () => buscarDestinatario({ motoristaId: M.body.id }))).ativo, false, "SMS de A para");

  // ---- Item 2: anonimizar não toca homônimo e limpa a autoria ----
  const N1 = await a.post("/api/motoristas").send({ nome: "Homônimo Silva", celular: "11955559011", transportadoraId: T.body.id });
  const N2 = await a.post("/api/motoristas").send({ nome: "Homônimo Silva", celular: "11955559012", transportadoraId: T.body.id });
  const ativo = async (rec) => (await a.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  const c1 = await a.post("/api/containers").send({ numero: "HOMU3500005", confirmarDigito: true, tipo: "DRY_40", ...cad });
  const c2 = await a.post("/api/containers").send({ numero: "HOMU3500010", confirmarDigito: true, tipo: "DRY_40", ...cad });
  assert.deepEqual([c1.status, c2.status], [201, 201], JSON.stringify([c1.body, c2.body]));
  const identidade1 = "Homônimo Silva (motorista · Transp Gestor 3.5)";
  await prisma.container.update({ where: { id: c1.body.id }, data: { motorista: "Homônimo Silva", placa: "AAA1A11", rastreioMotoristaId: N1.body.id } });
  await prisma.container.update({ where: { id: c2.body.id }, data: { motorista: "Homônimo Silva", placa: "BBB2B22", rastreioMotoristaId: N2.body.id } });
  await prisma.eventoContainer.create({ data: { containerId: c1.body.id, statusDe: "PROGRAMADO", statusPara: "COLETADO", ocorridoEm: new Date(), usuarioEmail: identidade1 } });
  await prisma.leituraTemperatura.create({ data: { containerId: c1.body.id, temperatura: -18, lidaEm: new Date(), origem: "QRCODE", fonte: identidade1 } });
  const an = await a.post(`/api/motoristas/${N1.body.id}/anonimizar`);
  assert.equal(an.status, 200, JSON.stringify(an.body));
  const d1 = await prisma.container.findUnique({ where: { id: c1.body.id } });
  const d2 = await prisma.container.findUnique({ where: { id: c2.body.id } });
  assert.deepEqual([d1.motorista, d1.placa], [`Motorista anonimizado #${N1.body.id}`, null]);
  assert.deepEqual([d2.motorista, d2.placa], ["Homônimo Silva", "BBB2B22"], "homônimo intacto");
  const restos = (await prisma.eventoContainer.count({ where: { usuarioEmail: identidade1 } })) + (await prisma.leituraTemperatura.count({ where: { fonte: identidade1 } }))
    + (await prisma.container.count({ where: { criadoPor: identidade1 } })) + (await prisma.etiquetaQR.count({ where: { vinculadaPor: identidade1 } }));
  assert.equal(restos, 0, "identidade anonimizada some das colunas de autoria");

  // ---- Item 3: CNPJ com dígito verificador; dono edita, outro vinculado não ----
  assert.equal((await a.post("/api/transportadoras").send({ nome: "CNPJ Ruim", cnpj: "12345678000100" })).status, 400);
  const dono = await a.post("/api/transportadoras").send({ nome: "Transp Dona 3.5", cnpj: "47.960.950/0001-21" });
  assert.equal(dono.status, 201, JSON.stringify(dono.body));
  const td = dono.body;
  const cnpjDono = "47960950000121";
  const vinc = await b.post("/api/transportadoras").send({ nome: "Outro nome", cnpj: cnpjDono });
  assert.deepEqual([vinc.status, vinc.body.id], [201, td.id], "B vinculado ao mesmo cadastro");
  assert.equal((await a.patch(`/api/transportadoras/${td.id}`).send({ nome: "Transp Dona 3.5 Renomeada" })).status, 200, "dono edita mesmo compartilhado");
  assert.equal((await b.patch(`/api/transportadoras/${td.id}`).send({ nome: "Tomada" })).status, 409, "quem não é dono só usa");

  // ---- Item 5: acompanhamento termina por inatividade (6 h) e prazo máximo (72 h) ----
  const u = await a.post("/api/usuarios").send({ email: "acomp35@teste.local", nome: "Acomp 3.5", perfil: "OPERADOR", senha: "senha-teste-123", celular: "11966669035" });
  const cfg = (await a.get("/api/configuracao")).body;
  await a.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: 1 });
  const c5 = await a.post("/api/containers").send({ numero: "ACPU3500004", confirmarDigito: true, tipo: "DRY_40", ...cad });
  await prisma.container.update({ where: { id: c5.body.id }, data: { status: "COLETADO", coletadoEm: new Date(Date.now() - 4 * H), rastreioResponsavelId: u.body.id, rastreioDesde: new Date(Date.now() - 4 * H) } });
  assert.equal((await a.post(`/api/containers/${c5.body.id}/solicitar-posicao`)).status, 201);
  const codigo = /\/p\/([A-Za-z0-9_-]+)$/.exec(caixaDeSaidaSms.filter((s) => s.para === "+5511966669035").at(-1).texto)[1];
  const pos = { latitude: -23.5, longitude: -46.6, precisaoM: 10 };
  assert.equal((await request(app).post(`/api/posicao/${codigo}`).send(pos)).status, 201);
  const acompanhar = () => request(app).post(`/api/posicao/${codigo}/acompanhar`).send(pos);
  const ajustar = (respondidaH, sinalH) => Promise.all([
    prisma.solicitacaoPosicao.updateMany({ where: { containerId: c5.body.id }, data: { respondidaEm: new Date(Date.now() - respondidaH * H) } }),
    prisma.container.update({ where: { id: c5.body.id }, data: { acompanhamentoSinalEm: sinalH === null ? null : new Date(Date.now() - sinalH * H) } }),
    prisma.posicaoContainer.updateMany({ where: { containerId: c5.body.id, origem: "ACOMPANHAMENTO" }, data: { registradaEm: new Date(Date.now() - 2 * H) } }),
  ]);
  await ajustar(72 + 1, 1);
  assert.equal((await acompanhar()).status, 409, "link respondido há 3 dias: passou de 72 h");
  await ajustar(48, 7);
  assert.equal((await acompanhar()).status, 409, "7 h sem sinal");
  await ajustar(48, 1);
  assert.equal((await acompanhar()).status, 201, "dentro das 72 h e com sinal há 1 h");
  await a.put("/api/configuracao").send(cfg);

  // ---- Item 6: teto por etiqueta só para números novos; motorista conhecido segue entrando ----
  const [etq] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  await prisma.codigoAcessoMotorista.createMany({
    data: Array.from({ length: MAX_CODIGOS_POR_HORA_ETIQUETA }, (_, i) => ({ celular: `+5511950${String(i).padStart(6, "0")}`, codigoHash: "y", expiraEm: new Date(Date.now() + 60e3), organizacaoId: ORG_TESTE, etiquetaId: etq.id })),
  });
  const novo = await request(app).post("/api/motorista/codigo").set("X-Forwarded-For", "198.51.100.61").send({ celular: "11955559099", etiqueta: etq.token });
  assert.equal(novo.status, 429, "número novo: teto da etiqueta");
  const conhecido = await request(app).post("/api/motorista/codigo").set("X-Forwarded-For", "198.51.100.62").send({ celular: "11955559012", etiqueta: etq.token });
  assert.equal(conhecido.status, 200, JSON.stringify(conhecido.body));
  assert.equal((await prisma.codigoAcessoMotorista.findFirst({ where: { celular: "+5511955559012" }, orderBy: { id: "desc" } })).conhecido, true);
  await prisma.codigoAcessoMotorista.deleteMany({ where: { codigoHash: "y" } });
  for (const id of [c1.body.id, c2.body.id, c5.body.id]) await a.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste 3.5" });
});

test("v3.6 chaves compostas: o banco recusa apontar para cadastro de outro cliente (mesmo como ccs_app)", async () => {
  const { comoSistema, comOrganizacao } = await import("./lib/tenant.js");
  const { prisma: bruto } = await import("./lib/prisma.js");
  const orgB = (await comoSistema(() => bruto.usuario.findFirst({ where: { email: "admin@ref34.local" } }))).organizacaoId;
  const armadorB = await comOrganizacao(orgB, () => bruto.armador.findFirst({ select: { id: true } }));
  const localB = await comOrganizacao(orgB, () => bruto.local.findFirst({ select: { id: true } }));
  assert.ok(armadorB && localB, "cadastros da B existem");
  const conexao = await prisma.$queryRaw`SELECT current_user AS u`;
  assert.equal(conexao[0].u, "ccs_app", "teste roda com o usuário do sistema (RLS)");
  // Exatamente o caso da revisão: UPDATE num container da A com o id de um armador da B.
  const antes = await prisma.container.findUnique({ where: { id: ids.reefer }, select: { armadorId: true, portoEntregaId: true } });
  await assert.rejects(prisma.container.update({ where: { id: ids.reefer }, data: { armadorId: armadorB.id } }), (e) => e.code === "P2003", "armador da B");
  await assert.rejects(prisma.container.update({ where: { id: ids.reefer }, data: { portoEntregaId: localB.id } }), (e) => e.code === "P2003", "local da B");
  await assert.rejects(prisma.paradaContainer.create({ data: { containerId: ids.reefer, localId: localB.id, fase: "ANTES_CARREGAMENTO", ordem: 99 } }), (e) => e.code === "P2003", "parada em local da B");
  const depois = await prisma.container.findUnique({ where: { id: ids.reefer }, select: { armadorId: true, portoEntregaId: true } });
  assert.deepEqual(depois, antes, "nada gravado");
  // Guarda contra remoção acidental (ex.: migração futura): as 31 chaves e os 11 índices existem.
  const [{ fks, idx }] = await comoSistema(() => bruto.$queryRaw`
    SELECT (SELECT count(*)::int FROM pg_constraint WHERE contype = 'f' AND conname LIKE '%\_org\_fkey') AS fks,
           (SELECT count(*)::int FROM pg_indexes WHERE indexname LIKE '%\_id\_organizacaoId\_key') AS idx`);
  // v3.6: 31 + v3.8 (viagem): 3 chaves e 1 índice.
  assert.deepEqual([fks, idx], [34, 12]);
});

test("v3.7 entrega a definir: previsão parcial, plano em duas partes, alerta, só equipe e portaria definem", async () => {
  const a = agentes.ADMIN;
  const tr = await logar("transportador@teste.local");
  const po = await logar("portaria@teste.local");
  const ativo = async (rec) => (await a.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  const novo = (numero) => a.post("/api/containers").send({ numero, confirmarDigito: true, tipo: "DRY_40", ...cad, portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao });

  // Criado sem entrega: previsão parcial e plano congelado só na parte conhecida.
  const c1 = await novo("ADFU3700001");
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.equal(c1.body.portoEntregaId, null);
  const p1 = c1.body.situacao.previsao;
  assert.deepEqual([p1.disponivel, p1.parcial, p1.previsaoEntrega], [true, true, null], JSON.stringify(p1).slice(0, 300));
  let db = await prisma.container.findUnique({ where: { id: c1.body.id } });
  assert.equal(db.planejamento.entregaPendente, true);
  assert.equal(db.planejamento.ENTREGUE_PORTO, null);
  const chegadaPlanejada = db.planejamento.NA_FABRICA;
  assert.ok(chegadaPlanejada);
  assert.equal((await a.get("/api/painel")).body.grupos.flatMap((g) => g.containers).find((x) => x.id === c1.body.id).entregaADefinir, true, "Home mostra 'a definir'");

  // Transportador na coleta NÃO define a entrega a definir (o campo é ignorado).
  const [e1] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  const col = await tr.post(`/api/qr/${e1.token}/coleta`).send({ numero: "ADFU3700001", portoRetiradaId: ids.santos, portoEntregaId: ids.santos });
  assert.equal(col.status, 201, JSON.stringify(col.body));
  assert.equal((await prisma.container.findUnique({ where: { id: c1.body.id } })).portoEntregaId, null);

  // Alerta: nada no trânsito para o carregamento; atenção na chegada.
  const alertas = async (id) => (await prisma.alerta.findMany({ where: { containerId: id, tipo: "ENTREGA_A_DEFINIR", chaveAberta: { not: null } } })).map((x) => x.nivel);
  assert.deepEqual(await alertas(c1.body.id), []);
  const ent = await po.post(`/api/qr/${e1.token}/portaria`).send({ movimento: "ENTRADA", placa: "ABC1D23" });
  assert.equal(ent.status, 201, JSON.stringify(ent.body));
  assert.deepEqual(await alertas(c1.body.id), ["ATENCAO"]);

  // Portaria define a entrega na saída: alerta some, trajeto no Histórico, plano completado (a parte congelada não muda).
  const sai = await po.post(`/api/qr/${e1.token}/portaria`).send({ movimento: "SAIDA", placa: "ABC1D23", portoEntregaId: ids.santos });
  assert.equal(sai.status, 201, JSON.stringify(sai.body));
  db = await prisma.container.findUnique({ where: { id: c1.body.id } });
  assert.equal(db.portoEntregaId, ids.santos);
  assert.deepEqual(await alertas(c1.body.id), []);
  assert.equal(db.planejamento.entregaPendente, false);
  assert.ok(db.planejamento.ENTREGUE_PORTO, "entrega planejada preenchida");
  assert.equal(db.planejamento.NA_FABRICA, chegadaPlanejada, "parte congelada não muda");
  assert.equal(await prisma.mudancaTrajeto.count({ where: { containerId: c1.body.id } }), 1);
  const ficha = (await a.get(`/api/containers/${c1.body.id}`)).body;
  assert.equal(ficha.situacao.previsao.parcial, undefined, "previsão completa");

  // Saída sem definir: alerta crítico; a equipe define pelo Editar trajeto.
  const c2 = await novo("ADFU3700017");
  assert.equal(c2.status, 201, JSON.stringify(c2.body));
  await prisma.container.update({ where: { id: c2.body.id }, data: { status: "SAIU_FABRICA", coletadoEm: new Date(Date.now() - 30 * 3600e3), chegadaFabricaEm: new Date(Date.now() - 20 * 3600e3), saidaFabricaEm: new Date(Date.now() - 3600e3) } });
  const { sincronizarAlertas } = await import("./lib/alertas.js");
  await naOrg(sincronizarAlertas)(c2.body.id);
  assert.deepEqual(await alertas(c2.body.id), ["CRITICO"]);
  // Editar trajeto aceita a entrega "a definir" (localId vazio) e também defini-la.
  const pontos = (entrega) => [{ papel: "RETIRADA", localId: ids.santos }, { papel: "CARREGAMENTO", localId: ids.cubatao }, { papel: "ENTREGA", localId: entrega }];
  assert.equal((await a.put(`/api/containers/${c2.body.id}/trajeto`).send({ pontos: pontos("") })).status, 200);
  const def = await a.put(`/api/containers/${c2.body.id}/trajeto`).send({ pontos: pontos(ids.santos) });
  assert.equal(def.status, 200, JSON.stringify(def.body));
  assert.deepEqual(await alertas(c2.body.id), []);

  for (const id of [c1.body.id, c2.body.id]) await a.post(`/api/containers/${id}/cancelar`).send({ motivo: "fim do teste 3.7" });
});

test("v3.8 viagem: 2 containers no mesmo caminhão — pergunta no QR, 1 SMS, posição para os dois, portaria escolhe quem fica", async () => {
  const executarRastreamento = naOrg((await import("./lib/rastreamento.js")).executarRastreamento);
  const { caixaDeSaidaSms } = await import("./lib/sms.js");
  const a = agentes.ADMIN;
  const tr = await logar("transportador@teste.local");
  const po = await logar("portaria@teste.local");
  const trId = (await prisma.usuario.findFirst({ where: { email: "transportador@teste.local" } })).id;
  assert.equal((await a.patch(`/api/usuarios/${trId}`).send({ celular: "11977770038" })).status, 200);
  const TEL = "+5511977770038";
  const cfg = (await a.get("/api/configuracao")).body;
  await a.put("/api/configuracao").send({ ...cfg, rastreioSmsAtivo: 1, rastreioPersonalizado: 1 });
  const ativo = async (rec) => (await a.get(`/api/${rec}?ativos=1`)).body[0].id;
  const cad = { grupoId: await ativo("grupos"), armadorId: await ativo("armadores") };
  const trajeto = { portoRetiradaId: ids.santos, localCarregamentoId: ids.cubatao, portoEntregaId: ids.santos };
  const criar = async (numero) => {
    const r = await a.post("/api/containers").send({ numero, confirmarDigito: true, tipo: "DRY_40", ...cad, ...trajeto });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const etiqueta = async () => (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas[0];
  const coletar = async (e, numero) => {
    const r = await tr.post(`/api/qr/${e.token}/coleta`).send({ numero, portoRetiradaId: ids.santos });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };

  // ---- Monta a viagem: 2º QR pergunta "vai no mesmo caminhão?" ----
  const v1 = await criar("VGMU3800003");
  const v2 = await criar("VGMU3800019");
  const e1 = await etiqueta();
  const e2 = await etiqueta();
  const r1 = await coletar(e1, "VGMU3800003");
  assert.deepEqual(r1.sugestoesViagem, [], "1º container: nada a sugerir");
  const r2 = await coletar(e2, "VGMU3800019");
  assert.deepEqual(r2.sugestoesViagem.map((s) => s.numero), ["VGMU3800003"]);
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e2.token}/viagem`).send({ comContainerId: v1.id })).status, 409, "quem não registrou não monta a viagem");
  const junta = await tr.post(`/api/qr/${e2.token}/viagem`).send({ comContainerId: v1.id });
  assert.equal(junta.status, 200, JSON.stringify(junta.body));
  assert.deepEqual(junta.body.viagem.containers.map((c) => c.numero).sort(), ["VGMU3800003", "VGMU3800019"]);
  assert.deepEqual(junta.body.sugestoesViagem, [], "já juntos: não pergunta de novo");
  assert.deepEqual((await a.get(`/api/containers/${v1.id}`)).body.viagem.containers.map((c) => c.numero).sort(), ["VGMU3800003", "VGMU3800019"], "ficha mostra a viagem");

  // ---- Um SMS para os dois; a posição do link vai para os dois ----
  await prisma.container.updateMany({ where: { id: { in: [v1.id, v2.id] } }, data: { rastreioUltimoEnvioEm: new Date(Date.now() - 40 * 60e3) } });
  const antes = caixaDeSaidaSms.filter((s) => s.para === TEL).length;
  await executarRastreamento();
  const novos = caixaDeSaidaSms.filter((s) => s.para === TEL).slice(antes);
  assert.equal(novos.length, 1, "um SMS só por viagem");
  assert.match(novos[0].texto, /containers VGMU3800003 e VGMU3800019|containers VGMU3800019 e VGMU3800003/);
  assert.ok(novos[0].texto.length <= 160);
  const codigo = /\/p\/([A-Za-z0-9_-]+)$/.exec(novos[0].texto)[1];
  assert.equal((await request(app).post(`/api/posicao/${codigo}`).send({ latitude: -23.7, longitude: -46.5, precisaoM: 9 })).status, 201);
  for (const v of [v1, v2]) assert.equal(await prisma.posicaoContainer.count({ where: { containerId: v.id, origem: "LINK_SMS" } }), 1, `posição gravada no ${v.numero}`);

  // ---- Portaria: entrada do V1; o V2 (mesmo ponto) é oferecido e fica também ----
  const ent = await po.post(`/api/qr/${e1.token}/portaria`).send({ movimento: "ENTRADA", placa: "VGM1A23" });
  assert.equal(ent.status, 201, JSON.stringify(ent.body));
  assert.deepEqual(ent.body.ficamTambem.map((x) => x.numero), ["VGMU3800019"]);
  assert.equal((await agentes.OPERADOR.post(`/api/qr/${e1.token}/portaria/ficam`).send({ containerIds: [v2.id] })).status, 403, "só portaria");
  const ficam = await po.post(`/api/qr/${e1.token}/portaria/ficam`).send({ containerIds: [v2.id] });
  assert.equal(ficam.status, 200, JSON.stringify(ficam.body));
  const d2 = await prisma.container.findUnique({ where: { id: v2.id } });
  assert.deepEqual([d2.status, d2.placa], ["NA_FABRICA", "VGM1A23"]);
  assert.ok((await prisma.eventoContainer.findFirst({ where: { containerId: v2.id, statusPara: "NA_FABRICA" } })).observacao.includes("mesmo caminhão"));
  assert.equal((await a.get(`/api/containers/${v1.id}`)).body.viagem, null, "viagem terminou");

  // ---- Outra viagem: o V4 fica, o V5 segue (não escolhido) ----
  const v4 = await criar("VGMU3800024");
  const v5 = await criar("VGMU3800030");
  const e4 = await etiqueta();
  const e5 = await etiqueta();
  await coletar(e4, "VGMU3800024");
  await coletar(e5, "VGMU3800030");
  assert.equal((await tr.post(`/api/qr/${e5.token}/viagem`).send({ comContainerId: v4.id })).status, 200);
  const ent4 = await po.post(`/api/qr/${e4.token}/portaria`).send({ movimento: "ENTRADA", placa: "VGM1A23" });
  assert.deepEqual(ent4.body.ficamTambem.map((x) => x.numero), ["VGMU3800030"]);
  const d5 = await prisma.container.findUnique({ where: { id: v5.id } });
  assert.equal(d5.status, "COLETADO", "o não escolhido segue viagem");
  assert.equal((await a.get(`/api/containers/${v5.id}`)).body.viagem, null, "sozinho: viagem terminou");
  assert.ok(await prisma.viagemContainer.findFirst({ where: { containerId: v5.id, saiuEm: { not: null } } }), "histórico fica");

  await a.put("/api/configuracao").send(cfg);
  for (const v of [v1, v2, v4, v5]) await a.post(`/api/containers/${v.id}/cancelar`).send({ motivo: "fim do teste 3.8" });
});
