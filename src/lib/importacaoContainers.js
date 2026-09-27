// Cadastro de containers em lote por planilha Excel (.xlsx).
// - Modelo: aba "Containers" (cabeçalho + listas suspensas com os cadastros ativos), aba
//   "Instruções" e aba oculta "Listas" (origem das listas suspensas).
// - Leitura: colunas pelo nome do cabeçalho (ordem livre), nomes de cadastro → IDs (sem
//   diferença de maiúsculas/acentos), datas como data do Excel ou texto dd/mm/aaaa hh:mm
//   (horário de Brasília). Cada linha passa pela MESMA validação do cadastro na tela.
// - Só cadastra containers novos: número já ativo no sistema (ou repetido na planilha) é recusado.
import ExcelJS from "exceljs";
import { prisma } from "./prisma.js";
import { erroHttp } from "./asyncHandler.js";

export const MAX_LINHAS = 1000;

export const ROTULO_TIPO = { DRY_20: "20' Dry", DRY_40: "40' Dry", HC_40: "40' HC", REEFER_20: "20' Reefer", REEFER_40: "40' Reefer" };

// chave = campo do cadastro; lista = aba "Listas" usada na lista suspensa.
export const COLUNAS = [
  { chave: "numero", titulo: "Número do container", obrigatorio: true, largura: 20, ajuda: "4 letras + 7 dígitos (ex.: MSKU1234565)." },
  { chave: "tipo", titulo: "Tipo", obrigatorio: true, largura: 13, lista: "tipos", ajuda: "20' Dry, 40' Dry, 40' HC, 20' Reefer ou 40' Reefer." },
  { chave: "grupo", titulo: "Ponto de Carregamento", obrigatorio: true, largura: 38, lista: "grupos", ajuda: "Exatamente como no cadastro: Cliente / Fábrica." },
  { chave: "armador", titulo: "Armador", obrigatorio: true, largura: 22, lista: "armadores" },
  { chave: "produto", titulo: "Produto", largura: 24, lista: "produtos", ajuda: "Obrigatório para reefer (define a faixa de temperatura)." },
  { chave: "portoRetirada", titulo: "Local de retirada", largura: 30, lista: "retirada", ajuda: "Porto ou terminal de retirada do vazio." },
  { chave: "localCarregamento", titulo: "Local de carregamento", largura: 30, lista: "carregamento", ajuda: "Vazio = o local padrão do Ponto de Carregamento." },
  { chave: "portoEntrega", titulo: "Local de entrega", largura: 30, lista: "retirada", ajuda: "Porto ou terminal de entrega do cheio." },
  { chave: "coletaProgramadaEm", titulo: "Coleta programada", largura: 18, data: true, ajuda: "Data/hora (dd/mm/aaaa hh:mm), horário de Brasília." },
  { chave: "booking", titulo: "Booking", largura: 16 },
  { chave: "navio", titulo: "Navio", largura: 20 },
  { chave: "deadline", titulo: "Deadline do navio", largura: 18, data: true, ajuda: "Data/hora do cut-off (dd/mm/aaaa hh:mm)." },
  { chave: "lacre", titulo: "Lacre", largura: 14 },
  { chave: "placa", titulo: "Placa", largura: 11 },
  { chave: "motorista", titulo: "Motorista", largura: 22 },
  { chave: "observacao", titulo: "Observação", largura: 36 },
  { chave: "confirmarDigito", titulo: "Dígito conferido", largura: 14, lista: "simNao", ajuda: "Escreva SIM só se o número estiver certo mas o dígito verificador não bater." },
];

// Comparação tolerante: sem acento, sem diferença de maiúsculas, espaços únicos.
export const normalizar = (s) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const nomeGrupo = (g) => `${g.cliente} / ${g.fabrica}`;

async function carregarCadastros() {
  const [grupos, armadores, produtos, locais] = await Promise.all([
    prisma.grupoOperacao.findMany({ where: { ativo: true }, orderBy: [{ cliente: "asc" }, { fabrica: "asc" }], select: { id: true, cliente: true, fabrica: true } }),
    prisma.armador.findMany({ where: { ativo: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true } }),
    prisma.produto.findMany({ where: { ativo: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true } }),
    prisma.local.findMany({ where: { ativo: true }, orderBy: { nome: "asc" }, select: { id: true, nome: true, tipo: { select: { funcao: true } } } }),
  ]);
  return {
    grupos, armadores, produtos,
    retirada: locais.filter((l) => l.tipo.funcao === "RETIRADA_ENTREGA"),
    carregamento: locais.filter((l) => l.tipo.funcao === "CARREGAMENTO"),
  };
}

// ---------- Modelo ----------

export async function gerarModelo() {
  const cad = await carregarCadastros();
  const listas = {
    tipos: Object.values(ROTULO_TIPO),
    grupos: cad.grupos.map(nomeGrupo),
    armadores: cad.armadores.map((a) => a.nome),
    produtos: cad.produtos.map((p) => p.nome),
    retirada: cad.retirada.map((l) => l.nome),
    carregamento: cad.carregamento.map((l) => l.nome),
    simNao: ["SIM"],
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = "C.C.S – Container Control Solutions";
  wb.created = new Date();
  const ws = wb.addWorksheet("Containers", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUNAS.map((c) => ({ header: c.obrigatorio ? `${c.titulo} *` : c.titulo, key: c.chave, width: c.largura }));
  const cab = ws.getRow(1);
  cab.height = 30;
  cab.eachCell((cell, i) => {
    const col = COLUNAS[i - 1];
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: col.obrigatorio ? "FF1F5FA8" : "FF5B6776" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    if (col.ajuda) cell.note = col.ajuda;
  });

  // Aba oculta com as opções das listas suspensas (uma coluna por lista).
  const wl = wb.addWorksheet("Listas", { state: "hidden" });
  const refLista = {};
  Object.entries(listas).forEach(([nome, valores], i) => {
    const col = wl.getColumn(i + 1);
    col.values = [nome, ...valores];
    const letra = col.letter;
    refLista[nome] = valores.length ? `Listas!$${letra}$2:$${letra}$${valores.length + 1}` : null;
  });

  const ULTIMA = MAX_LINHAS + 1;
  // Uma regra por intervalo da coluna (não por célula: arquivo pequeno).
  COLUNAS.forEach((c, i) => {
    const coluna = ws.getColumn(i + 1);
    const intervalo = `${coluna.letter}2:${coluna.letter}${ULTIMA}`;
    if (c.lista && refLista[c.lista]) {
      ws.dataValidations.add(intervalo, {
        type: "list", allowBlank: true, formulae: [refLista[c.lista]],
        showErrorMessage: true, errorStyle: "warning", errorTitle: c.titulo,
        error: "Valor fora da lista de cadastros. Confira o nome (ou cadastre antes no sistema).",
      });
    } else if (c.data) {
      coluna.numFmt = "dd/mm/yyyy hh:mm";
    } else if (c.chave === "numero") {
      coluna.numFmt = "@";
    }
  });

  const wi = wb.addWorksheet("Instruções");
  wi.getColumn(1).width = 26;
  wi.getColumn(2).width = 90;
  wi.addRow(["Como preencher"]).font = { bold: true, size: 14 };
  for (const t of [
    "Preencha uma linha por container na aba \"Containers\" (não mude os nomes das colunas; a ordem pode mudar).",
    "Colunas com * são obrigatórias. As listas suspensas trazem os cadastros ativos do sistema no momento do download.",
    "Datas: use o formato de data do Excel ou escreva dd/mm/aaaa hh:mm (horário de Brasília).",
    "Só cadastra containers NOVOS. Número já ativo no sistema ou repetido na planilha é recusado (nada é sobrescrito).",
    "No sistema, o upload mostra uma prévia linha a linha; só grava depois que você confirmar. Linhas com erro ficam de fora.",
    `Máximo de ${MAX_LINHAS} containers por arquivo.`,
  ]) wi.addRow(["", t]);
  wi.addRow([]);
  wi.addRow(["Coluna", "O que informar"]).font = { bold: true };
  for (const c of COLUNAS) wi.addRow([`${c.titulo}${c.obrigatorio ? " *" : ""}`, c.ajuda ?? ""]);

  return wb.xlsx.writeBuffer();
}

// ---------- Leitura ----------

// Valor "cru" da célula (fórmula → resultado; texto rico/hiperlink → texto).
function valorCelula(cell) {
  let v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((r) => r.text).join("");
    else if ("text" in v) v = v.text;
    else if ("error" in v) v = null;
  }
  if (typeof v === "string") v = v.trim();
  return v === "" || v === undefined ? null : v;
}

// Data do Excel (o ExcelJS entrega o horário da célula como se fosse UTC) ou texto
// dd/mm/aaaa [hh:mm] → ISO no horário de Brasília (-03:00).
function paraDataIso(v, titulo) {
  const iso = (a, m, d, h = 0, mi = 0) =>
    `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00-03:00`;
  if (v === null) return null;
  if (v instanceof Date) return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), v.getUTCHours(), v.getUTCMinutes());
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(String(v));
  if (!m) throw new Error(`${titulo}: use dd/mm/aaaa hh:mm (recebido "${v}").`);
  const [, d, mes, a, h = 0, mi = 0] = m.map((x) => (x === undefined ? undefined : Number(x)));
  if (mes < 1 || mes > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw new Error(`${titulo}: data inválida "${v}".`);
  return iso(a, mes, d, h, mi);
}

// Nome → ID num cadastro. Nome repetido no cadastro = ambíguo (não adivinha).
function porNome(lista, valor, titulo, nome = (x) => x.nome) {
  if (valor === null) return null;
  const alvo = normalizar(valor);
  const achados = lista.filter((x) => normalizar(nome(x)) === alvo);
  if (!achados.length) throw new Error(`${titulo}: "${valor}" não encontrado nos cadastros ativos.`);
  if (achados.length > 1) throw new Error(`${titulo}: há mais de um cadastro chamado "${valor}".`);
  return achados[0].id;
}

/**
 * Lê o arquivo e devolve { linhas: [{ linha, numero, corpo | erro }] } — `corpo` no formato do
 * cadastro (POST /containers). Erro no arquivo inteiro (não é xlsx, sem colunas) → erroHttp 400.
 */
export async function lerPlanilha(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw erroHttp(400, "Arquivo inválido. Envie a planilha Excel (.xlsx) baixada em \"Baixar modelo\".");
  }
  const ws = wb.getWorksheet("Containers") ?? wb.worksheets.find((w) => w.state !== "hidden");
  if (!ws) throw erroHttp(400, "A planilha não tem nenhuma aba.");

  // Cabeçalho: linha 1, pelo nome da coluna (com ou sem o "*").
  const porTitulo = new Map(COLUNAS.map((c) => [normalizar(c.titulo), c]));
  const colunaDe = {};
  ws.getRow(1).eachCell((cell, i) => {
    const c = porTitulo.get(normalizar(String(valorCelula(cell) ?? "").replace(/\*/g, "")));
    if (c) colunaDe[c.chave] = i;
  });
  const faltando = COLUNAS.filter((c) => c.obrigatorio && !colunaDe[c.chave]).map((c) => c.titulo);
  if (faltando.length) throw erroHttp(400, `Colunas obrigatórias não encontradas na linha 1: ${faltando.join(", ")}. Use o modelo do sistema.`);

  const cad = await carregarCadastros();
  const tipoPorRotulo = new Map(Object.entries(ROTULO_TIPO).flatMap(([cod, rot]) => [[normalizar(rot), cod], [normalizar(cod), cod]]));
  const linhas = [];
  const vistos = new Map();
  for (let n = 2; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const v = Object.fromEntries(COLUNAS.map((c) => [c.chave, colunaDe[c.chave] ? valorCelula(row.getCell(colunaDe[c.chave])) : null]));
    if (Object.values(v).every((x) => x === null)) continue; // linha vazia
    if (linhas.length >= MAX_LINHAS) throw erroHttp(400, `A planilha passa de ${MAX_LINHAS} containers. Divida em arquivos menores.`);
    const numero = v.numero === null ? null : String(v.numero).toUpperCase().replace(/\s/g, "");
    try {
      if (!numero) throw new Error("Número do container em branco.");
      const repetida = vistos.get(numero);
      if (repetida) throw new Error(`Número repetido na planilha (também na linha ${repetida}).`);
      vistos.set(numero, n);
      const tipo = v.tipo === null ? null : tipoPorRotulo.get(normalizar(v.tipo));
      if (v.tipo !== null && !tipo) throw new Error(`Tipo: "${v.tipo}" inválido (use ${Object.values(ROTULO_TIPO).join(", ")}).`);
      const corpo = {
        numero,
        tipo,
        grupoId: porNome(cad.grupos, v.grupo, "Ponto de Carregamento", nomeGrupo),
        armadorId: porNome(cad.armadores, v.armador, "Armador"),
        produtoId: porNome(cad.produtos, v.produto, "Produto"),
        coletaProgramadaEm: paraDataIso(v.coletaProgramadaEm, "Coleta programada"),
        deadline: paraDataIso(v.deadline, "Deadline do navio"),
        confirmarDigito: normalizar(v.confirmarDigito) === "sim",
      };
      // Locais: só manda o campo quando preenchido (vazio no carregamento = local padrão do ponto).
      for (const campo of ["portoRetirada", "localCarregamento", "portoEntrega"]) {
        if (v[campo] === null) continue;
        const col = COLUNAS.find((c) => c.chave === campo);
        const lista = campo === "localCarregamento" ? cad.carregamento : cad.retirada;
        const outra = campo === "localCarregamento" ? cad.retirada : cad.carregamento;
        try {
          corpo[`${campo}Id`] = porNome(lista, v[campo], col.titulo);
        } catch (err) {
          // Existe, mas é da outra função (ex.: fábrica como local de retirada): mensagem clara.
          if (outra.some((l) => normalizar(l.nome) === normalizar(v[campo]))) {
            throw new Error(`${col.titulo}: "${v[campo]}" não é um local de ${campo === "localCarregamento" ? "carregamento (fábrica/armazém)" : "retirada/entrega (porto/terminal)"}.`);
          }
          throw err;
        }
      }
      for (const campo of ["booking", "navio", "lacre", "placa", "motorista", "observacao"]) {
        if (v[campo] !== null) corpo[campo] = String(v[campo]);
      }
      linhas.push({ linha: n, numero, corpo });
    } catch (err) {
      linhas.push({ linha: n, numero, erro: err.message });
    }
  }
  if (!linhas.length) throw erroHttp(400, "Nenhum container preenchido na planilha (a partir da linha 2).");
  return { linhas };
}
