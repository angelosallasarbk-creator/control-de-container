# Histórico de versões

A versão que está no ar aparece no rodapé do menu lateral e em `GET /api/saude` (`versao`).
Cada versão publicada tem uma tag no Git (`vX.Y.Z`) — é o ponto de retorno em caso de rollback
(procedimento no README, seção "Versões e rollback").

## 2.1.0 — em desenvolvimento (branch `versao-2.1`)

- **Mapa na ficha** (aba Rastreamento): cada posição registrada é um ponto, ligados pelo caminho
  percorrido; a última posição fica destacada; passar o mouse mostra data/hora (etapa, quem,
  precisão). Locais do trajeto aparecem como referência. Leaflet + OpenStreetMap (sem chave).
  Rastreamento passa a devolver até 500 posições.
- **Paginação** 10/20/50 por página (lembrada no navegador, por tela): Containers (tabela e lista
  do Grid), Alertas, Etiquetas, Custo estimado, Locais, Cadastros, Usuários, Motoristas, Log e,
  na ficha, leituras, posições, SMS e Histórico.
- **Menu com ícones**; recolhido na tela larga vira uma faixa só com os ícones (nome no passar do
  mouse). No celular continua a gaveta.
- **Histórico da ficha** mostra as mudanças no trajeto (retirada, carregamento, entrega, paradas)
  com antes/depois, quem e por onde (edição, Editar trajeto, QR), marcando as feitas após o
  Planejado. Migração `20261002090000_mudanca_trajeto` (só acréscimo; voltar para a 2.0 sem script).

## 2.0.0 — 28/09/2026 (tag `v2.0.0`)

**2.0-A:**

- **Tipo de Operação** (menu Cadastros): fluxo de etapas personalizável por tipo (arrastar), com nome
  livre, tipo de local exigido e local sugerido por etapa, passagens (pontos de parada) e etapas de
  início/fim do free time. Tipos iniciais: Exportação padrão, Coleta de cheio, Importação, Transferência.
- **Container segue o fluxo do tipo:** etapas, próxima etapa, avançar, aba Etapas, validação dos
  locais, estadia só com local de operação, demurrage pelas etapas do tipo, previsão/ETA sem local de
  operação (retirada → paradas → entrega), passagens do fluxo viram paradas do trajeto.
- Migração `20261001090000_tipo_operacao`: só acréscimos (enum AcaoEtapa, tabelas TipoOperacao e
  EtapaFluxo, Container.tipoOperacaoId e Container.fluxo); cadastra os 4 tipos e liga os containers
  existentes à Exportação padrão (fluxo vazio = o de sempre).
- **Voltar para a 1.4 não precisa de script** (testado: a 1.4 sobe sobre o banco da 2.0 e todas as
  telas respondem). Atenção: na 1.4, containers de tipos sem local de operação voltam a seguir o fluxo
  de exportação (as etapas deles não são perdidas, mas a 1.4 pediria chegada/saída).

**2.0-B:**

- **QR do transportador** segue o fluxo do container: locais de retirada/carregamento/entrega pela
  regra do tipo (Coleta de cheio: retirada na fábrica/armazém, sem carregamento); cadastro pelo QR
  com escolha do tipo de operação. `/api/qr/opcoes/coleta` ganha todosTipos, todosLocais e
  tiposOperacao (chaves antigas mantidas).
- **Portaria:** tipos sem local de operação não têm entrada/saída (aviso na tela, 409 na API).
- **Planilha:** coluna "Tipo de Operação" (opcional; em branco = padrão), locais conferidos pelo
  tipo da linha, Local de carregamento obrigatório só com local de operação.
- **Home:** seções genéricas (a caminho do local de operação / no local de operação / a caminho da
  entrega) e tipo de operação no card quando não é o padrão.
- Sem migração nova na 2.0-B.

## 1.4.0 — 28/09/2026 (tag `v1.4.0`)

- **Produtos com categoria** (Congelado, Refrigerado, Carga Seca); menu "Produtos". Carga Seca sem
  temperatura: sem pedido no QR, sem aba/informações de temperatura na ficha, sem alertas de
  temperatura. Migração `20260929120000_categoria_produto` (acrescenta a categoria, faixa passa a
  aceitar vazio e classifica os produtos existentes pela faixa). Voltar para a 1.3 não precisa de script.
- **Portaria:** placa do veículo obrigatória no QR; troca de placa exige motivo (etapa + log).

## 1.3.0 — 28/09/2026 (tag `v1.3.0`)

- **Ponto de Carregamento como ponto de parada:** checkbox no cadastro (posição padrão e tempo de
  parada); aparece como opção no Editar trajeto. Migração só com acréscimos
  (`20260929090000_ponto_carregamento_parada`); voltar para a 1.2 não precisa de script.
- **Motorista e placa do QR no container:** gravados a cada registro do motorista pelo QR; troca de
  placa na tela do QR; coluna "Motorista / Placa" na Tabela de containers.

## 1.2.0 — 28/09/2026 (tag `v1.2.0`)

- **Ponto Fiscal / pontos de parada no trajeto:** tipo de local novo (função PARADA) com posição
  padrão (antes/depois do carregamento) e tempo médio de parada.
- **Editar trajeto** na ficha: adicionar pontos, arrastar (ou ↑ ↓) e remover; recalcula distâncias,
  ciclo, ETA e alertas; container Programado refaz o Planejado.
- **Passagem** pelos pontos: marco na aba Etapas (Planejado/ETA/Realizado), registrada pela ficha ou
  pelo QR (com GPS); desfazer com permissão de correção.
- Migrações só com acréscimos: `20260928150000_paradas_trajeto` e `20260928150100_tipo_ponto_fiscal`.
  Rollback para 1.1: `scripts/rollback-1.2-antes.sql` (testado).

## 1.1.1 — 27/09/2026 (tag `v1.1.1`)

Ajustes visuais:
- Marca "C.C.S" passa a ser **"CCS"** em todas as telas (login, redefinir senha, enviar posição,
  acesso do motorista), no e-mail de redefinição de senha, no nome do remetente e no Excel.
- Removida a faixa vermelha de alertas críticos do topo: o **sino** (com o número) e o bipe bastam.
- Removido o botão "Baixar modelo" do cabeçalho de Containers (redundante: fica dentro do Upload).

Cadastro por planilha e coleta pelo QR:
- Planilha: **Produto, Local de retirada, Local de carregamento, Local de entrega e Coleta
  programada passam a ser obrigatórios** (linha em branco é recusada com o nome do campo).
- Upload: continua uma requisição por etapa; no servidor a confirmação grava **em lote** (uma
  transação, inserção única dos containers, etapas e logs), lê cada cadastro uma vez e calcula as
  distâncias do lote de uma vez.
- QR da coleta: retirada, carregamento e entrega vêm **preenchidos com a programação** do
  container; quem lê confere e altera só o que estiver diferente (alteração registrada no log).

## 1.1.0 — 27/09/2026 (tag `v1.1.0`)

- **Fase 1 — Pedidos de posição por trechos críticos (pronta):** o padrão passa a pedir posição só
  quando a previsão estoura, há risco de prazo (alertas abertos), o container está parado (2 últimas
  posições a até 500 m, 3 h entre elas) ou sem posição há 12 h; repete a cada 60 min enquanto houver
  motivo; no ponto de carregamento só o risco de prazo. "Intervalo personalizado" opcional (regra
  antiga de 30 min / 4 h). Botão "Solicitar posição" na aba Rastreamento (1 a cada 5 min por
  container). Cada pedido guarda o motivo (coluna nova na lista de SMS). Migração só com acréscimos
  (`20260928090000_motivo_pedido_posicao`). Versão visível no rodapé e em `/api/saude`.

- **Fase 2 — Transportadoras e motoristas sem usuário (pronta):** cadastro de Transportadoras;
  motorista entra pelo QR com o celular + código SMS de 6 dígitos (15 min, pedido novo encerra o
  anterior, 5 tentativas, limites por celular/aparelho e teto global de 500 códigos/hora), primeiro acesso com termo LGPD,
  sessão de 60 dias no celular; registra pelo QR como Transportador; rastreamento aponta para o
  motorista; perfil **Gestor da transportadora** com a tela Motoristas (pré-cadastro, planilha,
  bloquear/desbloquear, encerrar acessos); retenção automática de posições (90 dias). Migração
  `20260928120000_motoristas_transportadoras` (só acréscimos; `SolicitacaoPosicao.usuarioId` passa
  a aceitar vazio).

## 1.0.0 — 27/09/2026 (tag `v1.0.0`, commit c28ace5)

Versão em produção antes da 1.1: alertas de estadia, demurrage, temperatura, atraso na coleta e
risco de prazo; previsão de rota e plano congelado; etiquetas QR (vínculo, leituras, transportador,
portaria); tipos de local; permissões por usuário; login C.C.S com "Lembrar meu login" e
"Esqueci minha senha" (Brevo); rastreamento por SMS com intervalos fixos; cadastro de containers
por planilha; filtro "Sem QR code".
