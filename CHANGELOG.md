# Histórico de versões

A versão que está no ar aparece no rodapé do menu lateral e em `GET /api/saude` (`versao`).
Cada versão publicada tem uma tag no Git (`vX.Y.Z`) — é o ponto de retorno em caso de rollback
(procedimento no README, seção "Versões e rollback").

## 1.1.1 — 27/09/2026 (branch `versao-1.1.1`)

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
