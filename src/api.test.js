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

test("tipos de local: padrões da migração, cadastro, rótulos por função e travas", async () => {
  const padrao = (await agentes.VISUALIZACAO.get("/api/tipos-local")).body;
  const tipo = (nome) => padrao.find((t) => t.nome === nome);
  assert.deepEqual(padrao.map((t) => t.nome).sort(), ["Armazém", "Fábrica", "Porto / Terminal", "Terminal Ferroviário"]);
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
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ numero: "PRTU3000003", movimento: "X", temperatura: -18 })).status, 400);
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ numero: "PRTU9999999", movimento: "ENTRADA", temperatura: -18 })).status, 404, "precisa estar cadastrado");
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ numero: "PRTU3000003", movimento: "SAIDA", temperatura: -18 })).status, 409, "saída sem entrada");
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ numero: "PRTU3000003", movimento: "ENTRADA" })).status, 400, "reefer exige temperatura");

  const entrada = await po.post(`/api/qr/${e1.token}/portaria`).send({ numero: "PRTU3000003", movimento: "ENTRADA", temperatura: -18 });
  assert.equal(entrada.status, 201, JSON.stringify(entrada.body));
  assert.equal(entrada.body.movimento, "ENTRADA");
  assert.deepEqual(entrada.body.completadas, ["Coletado no porto"], "coleta pendente completada");
  let ficha = (await agentes.ADMIN.get(`/api/containers/${c.body.id}`)).body;
  assert.equal(ficha.status, "NA_FABRICA");
  assert.equal(ficha.coletadoEm, ficha.chegadaFabricaEm, "coleta completada com o mesmo horário");
  assert.ok(ficha.eventos.some((ev) => ev.statusPara === "COLETADO" && ev.observacao.includes("completada pela portaria")));
  assert.ok(ficha.eventos.some((ev) => ev.statusPara === "NA_FABRICA" && ev.observacao === "Entrada registrada pela portaria"));
  assert.equal(ficha.leituras.length, 1);
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ movimento: "ENTRADA", temperatura: -18 })).status, 409, "entrada repetida");

  // Saída sem ovação/liberação registradas: completa as duas.
  const saida = await po.post(`/api/qr/${e1.token}/portaria`).send({ movimento: "SAIDA", temperatura: -17.5 });
  assert.equal(saida.status, 201, JSON.stringify(saida.body));
  assert.deepEqual(saida.body.completadas, ["Em ovação", "Liberado"]);
  ficha = (await agentes.ADMIN.get(`/api/containers/${c.body.id}`)).body;
  assert.equal(ficha.status, "SAIU_FABRICA");
  assert.ok(ficha.saidaFabricaEm && ficha.liberadoEm === ficha.saidaFabricaEm && ficha.inicioOperacaoEm === ficha.saidaFabricaEm);
  assert.equal(ficha.situacao.estadia.encerrada, true, "estadia fecha na saída");
  const log = (await agentes.ADMIN.get(`/api/logs?entidade=Container&entidadeId=${c.body.id}`)).body;
  assert.ok(log.some((l) => l.descricao.includes("saída pela portaria") && l.descricao.includes("etapas completadas: Em ovação, Liberado")));
  assert.equal((await po.post(`/api/qr/${e1.token}/portaria`).send({ movimento: "SAIDA", temperatura: -17 })).status, 409, "saída repetida");

  // Etiqueta nova + container dry já com etiqueta: pede confirmação de substituição.
  const dry = await agentes.ADMIN.post("/api/containers").send({ numero: "PRTU4000004", confirmarDigito: true, tipo: "DRY_40", ...cad, coletadoEm: new Date(Date.now() - 3600e3) });
  const [e3] = (await agentes.SUPERVISOR.post("/api/etiquetas/lotes").send({ quantidade: 1 })).body.etiquetas;
  assert.equal((await po.post(`/api/qr/${e2.token}/portaria`).send({ numero: "PRTU4000004", movimento: "ENTRADA" })).status, 201, "dry não pede temperatura");
  const outra = await po.post(`/api/qr/${e3.token}/portaria`).send({ numero: "PRTU4000004", movimento: "SAIDA" });
  assert.equal(outra.body.codigo, "ETIQUETA_EXISTENTE");
  assert.equal((await po.post(`/api/qr/${e3.token}/portaria`).send({ numero: "PRTU4000004", movimento: "SAIDA", substituir: true })).status, 201);
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
  const { sincronizarAlertas } = await import("./lib/alertas.js");
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
  const { sincronizarAlertas } = await import("./lib/alertas.js");
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
