# Histórico de versões

A versão que está no ar aparece no rodapé do menu lateral e em `GET /api/saude` (`versao`).
Cada versão publicada tem uma tag no Git (`vX.Y.Z`) — é o ponto de retorno em caso de rollback
(procedimento no README, seção "Versões e rollback").

## 1.1.0 — em desenvolvimento (branch `versao-1.1`)

- **Fase 1 — Pedidos de posição por trechos críticos (pronta):** o padrão passa a pedir posição só
  quando a previsão estoura, há risco de prazo (alertas abertos), o container está parado (2 últimas
  posições a até 500 m, 3 h entre elas) ou sem posição há 12 h; repete a cada 60 min enquanto houver
  motivo; no ponto de carregamento só o risco de prazo. "Intervalo personalizado" opcional (regra
  antiga de 30 min / 4 h). Botão "Solicitar posição" na aba Rastreamento (1 a cada 5 min por
  container). Cada pedido guarda o motivo (coluna nova na lista de SMS). Migração só com acréscimos
  (`20260928090000_motivo_pedido_posicao`). Versão visível no rodapé e em `/api/saude`.

Planejado:
- **Fase 2 — Transportadoras e motoristas sem usuário:** motorista identificado pelo celular com
  código SMS (15 min), sessão lembrada no celular, gestor da transportadora bloqueia motoristas,
  retenção de posições (LGPD).

## 1.0.0 — 27/09/2026 (tag `v1.0.0`, commit c28ace5)

Versão em produção antes da 1.1: alertas de estadia, demurrage, temperatura, atraso na coleta e
risco de prazo; previsão de rota e plano congelado; etiquetas QR (vínculo, leituras, transportador,
portaria); tipos de local; permissões por usuário; login C.C.S com "Lembrar meu login" e
"Esqueci minha senha" (Brevo); rastreamento por SMS com intervalos fixos; cadastro de containers
por planilha; filtro "Sem QR code".
