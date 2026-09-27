# Histórico de versões

A versão que está no ar aparece no rodapé do menu lateral e em `GET /api/saude` (`versao`).
Cada versão publicada tem uma tag no Git (`vX.Y.Z`) — é o ponto de retorno em caso de rollback
(procedimento no README, seção "Versões e rollback").

## 1.1.0 — em desenvolvimento (branch `versao-1.1`)

Planejado:
- **Fase 1 — Pedidos de posição por trechos críticos:** padrão passa a pedir posição só quando a
  previsão estoura, há risco de prazo, o container está parado ou sem posição há muito tempo;
  "Intervalo personalizado" opcional (regra antiga de 30 min / 4 h); botão "Solicitar posição".
- **Fase 2 — Transportadoras e motoristas sem usuário:** motorista identificado pelo celular com
  código SMS (15 min), sessão lembrada no celular, gestor da transportadora bloqueia motoristas,
  retenção de posições (LGPD).

## 1.0.0 — 27/09/2026 (tag `v1.0.0`, commit c28ace5)

Versão em produção antes da 1.1: alertas de estadia, demurrage, temperatura, atraso na coleta e
risco de prazo; previsão de rota e plano congelado; etiquetas QR (vínculo, leituras, transportador,
portaria); tipos de local; permissões por usuário; login C.C.S com "Lembrar meu login" e
"Esqueci minha senha" (Brevo); rastreamento por SMS com intervalos fixos; cadastro de containers
por planilha; filtro "Sem QR code".
