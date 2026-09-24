# Controle de Container

Controle de containers de **exportação** entre o porto e a fábrica: estadia na fábrica, demurrage, deadline do navio e temperatura de reefer, com alertas antecipados e visão do pátio por **Cliente / Fábrica**.

Substitui o controle manual por planilha + WhatsApp.

## Processo (exportação)

```
PROGRAMADO → COLETADO NO PORTO → NA FÁBRICA → EM OVAÇÃO → LIBERADO → SAIU DA FÁBRICA → ENTREGUE NO PORTO
                 │ inicia demurrage     │ inicia estadia                  │ encerra estadia      │ encerra demurrage
```

Cada etapa registra data/hora real (pode ser retroativa, nunca anterior à etapa anterior nem no futuro), usuário e observação. A sequência é obrigatória; supervisor pode **desfazer** a última etapa (fica no log) ou **cancelar** o container.

## Regras de negócio

| Prazo | Início → fim | Parâmetro (cadastro) | Atenção | Crítico |
|---|---|---|---|---|
| **Estadia** | chegada → saída da fábrica | Meta em horas por Cliente/Fábrica | faltam ≤ X h (configurável) | meta estourada (+ custo/h se cadastrado) |
| **Demurrage** | coleta → entrega no porto | Free time (dias) + diária por Armador | faltam ≤ X dias | free time vencido (diárias × valor) |
| **Deadline** | — | data/hora do cut-off no container | < 24 h | passou sem entrega |
| **Temperatura** (reefer) | leitura fora da faixa mín/máx do Produto | tolerância em min | na hora | fora há mais que a tolerância |
| **Sem leitura** (reefer em ovação/liberado) | desde a última leitura | intervalo global (Configurações) | passou do intervalo | passou do dobro |

- **Demurrage conta por dia de calendário (horário de Brasília)**: o dia da coleta é o dia 1; cada dia iniciado após o free time é uma diária, inclusive o dia da entrega. ⚠ Confirme essa regra com o contrato de cada armador. Alguns contam a partir da descarga ou em períodos de 24 h.
- **Prazos são copiados** do cadastro quando o container é criado. Mudar o armador/grupo depois não afeta containers em andamento. Supervisor pode ajustar os prazos de um container específico (ex.: free time negociado).
- **Alertas** são abertos e encerrados automaticamente por um verificador (a cada 5 min e logo após qualquer mudança). O mesmo alerta nunca é aberto duas vezes (índice único). Se o alerta passa de Atenção para Crítico, abre-se um novo e o anterior é encerrado. Alguém pode **reconhecer** o alerta, com a ação tomada registrada, mas ele só fecha quando a condição acaba.
- **Região é da fábrica**: cada Cliente/Fábrica pode ter uma região. Escolher a região de um cliente aplica a mesma região a todos os clientes da mesma fábrica. Um cliente novo de fábrica já cadastrada, criado sem região, herda a região da fábrica. Região com fábricas vinculadas não pode ser excluída, só desativada.
- Número do container validado pelo padrão **ISO 6346** (dígito verificador). Se o dígito não conferir, o sistema pede confirmação. Só pode existir **uma passagem ativa** por número.

## Telas

- **Pátio**: **uma aba por região** ("Todas" + regiões + "Sem região" se houver fábrica sem região), com contagem de containers e de críticos em cada aba. Os indicadores do topo são os da aba escolhida, e a aba fica lembrada. Dentro da aba, containers por Cliente/Fábrica divididos em *A caminho da fábrica / Na fábrica / A caminho do porto*, com semáforo, barra da estadia, demurrage e temperatura. Atualiza a cada minuto.
- **Containers**: lista com filtros e cadastro. **Ficha**: linha do tempo, prazos, alertas, leitura manual de temperatura com gráfico e histórico.
- **Alertas**: abertos e histórico. Faixa vermelha no topo + sino + bipe quando surge alerta crítico não reconhecido (consulta a cada 30 s).
- **Custo estimado**: custo de estadia e demurrage por **abas de Região** e, dentro delas, **abas de Cliente/Fábrica** (mais a "Visão geral"). Tem filtro de período (30/90 dias, 6/12 meses, mês atual/anterior, personalizado); indicadores; gráfico de tendência empilhado estadia × demurrage (por dia, semana ou mês, conforme o período); ranking por Cliente/Fábrica; **principais impactos** gerados automaticamente (estadia × demurrage, concentração por cliente e por armador, etapa em que o tempo foi perdido, estouros de meta, variação entre as metades do período, horas sem custo/h); detalhamento por container com tempo em cada trecho e exportação CSV (Excel).
  - O custo é lançado **no dia em que ocorre**: cada diária de demurrage no dia cobrado, cada hora além da meta de estadia no dia em que passou. Containers ativos contam até agora; cancelados não entram.
  - A estadia usa o custo/h **gravado no container** na criação, como os demais prazos. Se o custo/h do Cliente/Fábrica for cadastrado depois, só vale para containers novos (ou o supervisor ajusta em *Editar → Prazos deste container*, na ficha). Horas sem valor aparecem como "sem R$/h".
  - **Moedas**: estadia em R$ e demurrage na moeda do armador. Com a cotação informada em *Configurações* (US$ e €), tudo é consolidado em R$. Sem cotação, cada moeda aparece separada, em gráficos separados, sem somar moedas diferentes.
- **Cadastros**: Regiões, Cliente/Fábrica, Armadores, Produtos. Cadastro já usado não pode ser excluído, só desativado.
- **Usuários**, **Integração** (tokens), **Configurações e log** de auditoria.

### Perfis

| Perfil | Pode |
|---|---|
| Administrador | tudo, inclusive usuários, tokens e configurações |
| Supervisor | cadastros, prazos por container, desfazer/cancelar, ver log |
| Operador | cadastrar containers, avançar etapas, registrar temperatura, reconhecer alertas |
| Visualização | só consulta |

## Porta automática de temperatura

Hoje a leitura é **manual** (ficha do container). Para sensor próprio ou telemetria do armador, gere um token em *Integração* e envie:

```http
POST /api/integracao/temperaturas
Authorization: Bearer cc_...
Content-Type: application/json

{ "leituras": [ { "container": "ABCU1234567", "temperatura": -18.2, "lidaEm": "2026-09-24T10:00:00-03:00" } ] }
```

Resposta com a contagem de leituras `gravadas`, `duplicadas` e `rejeitadas`, e o motivo de cada rejeição. Reenviar a mesma leitura (mesmo container + horário) não duplica. Máximo de 500 por envio e 120 requisições/min. O token é guardado só como hash e pode ser revogado.

## Arquitetura

Mesma base do *Programação McCain*: **Node/Express + Prisma + PostgreSQL**, front **Vue 3 + Vite**, servido pelo próprio Express.

```
prisma/schema.prisma        modelo de dados
src/server.js               sobe o app + verificador de alertas + purga de log (365 dias)
src/app.js                  rotas e middlewares
src/lib/prazos.js           regras puras de estadia/demurrage/deadline/temperatura/alertas
src/lib/alertas.js          sincroniza alertas desejados × abertos (idempotente)
src/lib/iso6346.js          validação do número do container
src/routes/                 auth, cadastros, containers, painel, alertas, integracao, usuarios, configuracao
web/src/pages/              telas
scripts/criar-admin.js      cria o primeiro administrador
```

## Rodar localmente

Requisitos: Node 20+, Docker.

```bash
docker compose up -d            # Postgres local na porta 5433
cp .env.example .env            # gere um JWT_SECRET próprio
npm install && npm --prefix web install
npx prisma migrate dev
npm run seed                    # opcional: dados de EXEMPLO (só em banco vazio)
npm run dev:server              # API em http://localhost:3000
npm run dev:web                 # tela em http://localhost:5174
```

Logins do seed (senha `demo12345`): `admin@demo.local`, `supervisor@demo.local`, `operador@demo.local`, `visualizacao@demo.local`.

⚠ A porta 3000 é a mesma do McCain local. Não rode os dois ao mesmo tempo, ou mude `PORT`.

## Testes

```bash
npm test
```

São 33 testes: regras de prazo/temperatura (puras) e API completa contra o banco `controle_container_test`, que é **zerado a cada execução**. O teste se recusa a rodar se o nome do banco não terminar em `_test`.

## Deploy (Render)

1. Crie um Postgres de produção (ex.: Supabase, *Session pooler*, porta 5432).
2. Web Service no Render apontando para este repositório (ou use o `render.yaml`):
   - Build: `npm run build`, que instala, gera o Prisma, aplica as migrations (`migrate deploy`) e compila o front
   - Start: `npm start`
   - Variáveis: `DATABASE_URL`, `JWT_SECRET` (valor aleatório próprio), `NODE_ENV=production`
3. Primeiro admin: preencha `ADMIN_INICIAL_EMAIL`, `ADMIN_INICIAL_NOME` e `ADMIN_INICIAL_SENHA` no Render. Na subida, se o banco não tiver nenhum usuário, o admin é criado (ver log "Admin inicial criado"). Depois do primeiro login, troque a senha em *Usuários* e **remova as três variáveis**. Alternativa com shell: `npm run criar-admin -- email@empresa.com "Nome" "senha-forte"`.
4. **Não rode `npm run seed` em produção.**

## Operação e solução de problemas

- **Está funcionando?** `GET /api/saude` → `{"ok":true}`.
- **Erros**: aparecem no log do serviço (Render → Logs). O verificador registra quantos alertas abriu/encerrou e falhas por container sem parar os demais.
- **Alerta não fechou**: ele só fecha quando a condição acaba (container saiu, temperatura voltou à faixa etc.). Reconhecer não fecha.
- **Etapa registrada errada**: supervisor usa *Desfazer etapa* na ficha.
- **Trocar credenciais**: altere `JWT_SECRET` (todos precisam logar de novo) e/ou a senha do banco em `DATABASE_URL`, depois reinicie o serviço.

## Limitações conhecidas

- Temperatura é manual até existir sensor/telemetria (a porta automática já está pronta).
- Alertas só na tela: sem e-mail/WhatsApp ainda.
- A regra de contagem da demurrage é única para todos os armadores (ver regras acima).
- Sem mapa físico do pátio (a posição é um campo de texto).

## Próximas fases sugeridas

1. Notificação por e-mail/WhatsApp com escalonamento (nível 3 com histórico).
2. Mapa do pátio com posições e tomadas reefer.
3. Relatórios: custo de demurrage/estadia por cliente e armador, tempo médio de estadia, ranking.
4. Regra de início da demurrage configurável por armador (coleta × descarga do navio).
