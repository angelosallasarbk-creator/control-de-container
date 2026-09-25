// Etiquetas QR: geração de códigos e ZPL (linguagem nativa das impressoras Zebra). Funções puras.
import crypto from "node:crypto";
import QRCode from "qrcode";

// Código curto impresso na etiqueta (para ler/digitar se o QR estragar): sem 0/O, 1/I/L.
const ALFABETO = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function gerarCodigo() {
  const bytes = crypto.randomBytes(6);
  return `CC-${[...bytes].map((b) => ALFABETO[b % ALFABETO.length]).join("")}`;
}

// Token da URL: 128 bits aleatórios — não dá para "chutar" etiquetas de outros containers.
export function gerarToken() {
  return crypto.randomBytes(16).toString("base64url");
}

export function urlDaEtiqueta(baseUrl, token) {
  return `${String(baseUrl).replace(/\/+$/, "")}/q/${token}`;
}

// Modelos comuns de etiqueta (mm). A tela também aceita medida livre.
export const MODELOS_ETIQUETA = [
  { chave: "50x25", nome: "50 × 25 mm", larguraMm: 50, alturaMm: 25 },
  { chave: "50x30", nome: "50 × 30 mm", larguraMm: 50, alturaMm: 30 },
  { chave: "60x40", nome: "60 × 40 mm", larguraMm: 60, alturaMm: 40 },
  { chave: "70x50", nome: "70 × 50 mm", larguraMm: 70, alturaMm: 50 },
  { chave: "100x50", nome: "100 × 50 mm", larguraMm: 100, alturaMm: 50 },
  { chave: "100x100", nome: "100 × 100 mm", larguraMm: 100, alturaMm: 100 },
  { chave: "100x150", nome: "100 × 150 mm", larguraMm: 100, alturaMm: 150 },
];
export const DPI_SUPORTADOS = [203, 300, 600];

const pontosPorMm = (dpi) => ({ 203: 8, 300: 12, 600: 24 })[dpi] ?? 8;
// ZPL não aceita qualquer caractere no texto livre: mantém ASCII imprimível.
const textoZpl = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "").replace(/[\^~]/g, "");

// ^BQ da Zebra só amplia até 10×. Em etiqueta grande, em vez de sobrar espaço, sobe o nível de
// correção de erro: o QR ganha módulos (fica maior) e aguenta mais sujeira/risco (Q ~25%, H ~30%).
const AMPLIACAO_MAX = 10;
function escolherQr(url, espacoPontos) {
  let escolha = null;
  for (const nivel of ["M", "Q", "H"]) {
    const modulos = QRCode.create(url, { errorCorrectionLevel: nivel }).modules.size;
    const ampliacao = Math.max(1, Math.min(AMPLIACAO_MAX, Math.floor(espacoPontos / modulos)));
    if (!escolha || (ampliacao * modulos <= espacoPontos && ampliacao * modulos >= escolha.lado)) {
      escolha = { nivel, modulos, ampliacao, lado: ampliacao * modulos };
    }
    if (Math.floor(espacoPontos / modulos) <= AMPLIACAO_MAX) break; // já usa o espaço: não precisa subir
  }
  return escolha;
}

/**
 * Uma etiqueta em ZPL. Layout horizontal (QR à esquerda, textos à direita) em etiquetas largas
 * e vertical (QR em cima, textos embaixo, bloco centralizado) nas quadradas/altas.
 */
export function zplDaEtiqueta({ codigo, url }, { larguraMm, alturaMm, dpi = 203, titulo = "Controle de Container" }) {
  const dpm = pontosPorMm(dpi);
  const W = Math.round(larguraMm * dpm);
  const H = Math.round(alturaMm * dpm);
  const margem = Math.round(2 * dpm);
  const horizontal = W >= H * 1.3;

  const espacoQr = horizontal ? Math.min(H - 2 * margem, Math.round(W * 0.5)) : Math.min(W - 2 * margem, Math.round(H * 0.62));
  const { nivel, modulos, ampliacao, lado: ladoQr } = escolherQr(url, espacoQr);
  const campoQr = `^BQN,2,${ampliacao}^FD${nivel}A,${url}^FS`;

  const linhas = ["^XA", "^CI28", `^PW${W}`, `^LL${H}`, "^LH0,0"];
  if (horizontal) {
    const yQr = Math.max(margem, Math.round((H - ladoQr) / 2));
    linhas.push(`^FO${margem},${yQr}${campoQr}`);
    const xTexto = margem * 2 + ladoQr;
    const larguraTexto = Math.max(dpm * 10, W - xTexto - margem);
    const alturaCodigo = Math.max(dpm * 2, Math.min(Math.round(H * 0.22), Math.round(larguraTexto / 5.5)));
    const alturaPequena = Math.max(dpm * 2, Math.round(alturaCodigo * 0.5));
    let y = Math.max(margem, Math.round((H - (alturaCodigo + alturaPequena * 3.4)) / 2));
    linhas.push(`^FO${xTexto},${y}^A0N,${alturaCodigo},${alturaCodigo}^FB${larguraTexto},1,0,L^FD${textoZpl(codigo)}^FS`);
    y += Math.round(alturaCodigo * 1.25);
    linhas.push(`^FO${xTexto},${y}^A0N,${alturaPequena},${alturaPequena}^FB${larguraTexto},2,0,L^FDEscaneie para registrar^FS`);
    y += Math.round(alturaPequena * 2.4);
    linhas.push(`^FO${xTexto},${y}^A0N,${alturaPequena},${alturaPequena}^FB${larguraTexto},1,0,L^FD${textoZpl(titulo)}^FS`);
  } else {
    const larguraTexto = W - 2 * margem;
    const livre = H - ladoQr - 2 * margem;
    const alturaCodigo = Math.max(dpm * 2, Math.min(Math.round(livre * 0.4), Math.round(W / 8)));
    const alturaPequena = Math.max(dpm * 2, Math.round(alturaCodigo * 0.45));
    const vao = margem;
    const mostrarInstrucoes = livre >= alturaCodigo + alturaPequena * 2 + vao * 3;
    const alturaBloco = ladoQr + vao + alturaCodigo + (mostrarInstrucoes ? vao + alturaPequena * 2 + vao : 0);
    let y = Math.max(margem, Math.round((H - alturaBloco) / 2)); // bloco centralizado na etiqueta
    linhas.push(`^FO${Math.max(margem, Math.round((W - ladoQr) / 2))},${y}${campoQr}`);
    y += ladoQr + vao;
    linhas.push(`^FO${margem},${y}^A0N,${alturaCodigo},${alturaCodigo}^FB${larguraTexto},1,0,C^FD${textoZpl(codigo)}^FS`);
    if (mostrarInstrucoes) {
      y += alturaCodigo + vao;
      linhas.push(`^FO${margem},${y}^A0N,${alturaPequena},${alturaPequena}^FB${larguraTexto},1,0,C^FDEscaneie para registrar^FS`);
      y += Math.round(alturaPequena * 1.2);
      linhas.push(`^FO${margem},${y}^A0N,${alturaPequena},${alturaPequena}^FB${larguraTexto},1,0,C^FD${textoZpl(titulo)}^FS`);
    }
  }
  linhas.push("^XZ");
  return { zpl: linhas.join("\n"), nivel, ampliacao, modulos, horizontal, larguraPontos: W, alturaPontos: H };
}

export function zplDoLote(etiquetas, opcoes) {
  return etiquetas.map((e) => zplDaEtiqueta(e, opcoes).zpl).join("\n");
}
