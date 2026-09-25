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
- **Prazos são copiados** do cadastro quando o container é criado (meta, custo/h, free time, diária, faixa de temperatura). Ao **editar** um Cliente/Fábrica, Armador ou Produto com containers em andamento, a tela oferece **"Aplicar também aos N containers em andamento"** (marcado por padrão). Essa opção aplica os valores *atuais* do cadastro e recalcula prazos, alertas e custos. Containers entregues ou cancelados nunca mudam, para preservar o histórico. Supervisor também pode ajustar os prazos de um container específico (ex.: free time negociado); com a opção marcada, esse ajuste individual é substituído.
- **Alertas** são abertos e encerrados automaticamente por um verificador (a cada 5 min e logo após qualquer mudança). O mesmo alerta nunca é aberto duas vezes (índice único). Se o alerta passa de Atenção para Crítico, abre-se um novo e o anterior é encerrado. Alguém pode **reconhecer** o alerta, com a ação tomada registrada, mas ele só fecha quando a condição acaba.
- **Região é da fábrica**: cada Cliente/Fábrica pode ter uma região. Escolher a região de um cliente aplica a mesma região a todos os clientes da mesma fábrica. Um cliente novo de fábrica já cadastrada, criado sem região, herda a região da fábrica. Região com fábricas vinculadas não pode ser excluída, só desativada.
- Número do container validado pelo padrão **ISO 6346** (dígito verificador). Se o dígito não conferir, o sistema pede confirmação. Só pode existir **uma passagem ativa** por número.

## Previsão de rota e risco de demurrage

Cada container pode ter o **trajeto**: porto de retirada (vazio) → local de carregamento (fábrica ou armazém) → porto de entrega (cheio). Com ele o sistema prevê a entrega no porto e compara com o free time e o deadline.

- **Locais** (*Cadastros → Locais*): fábricas, armazéns e portos/terminais com coordenadas. A tela tem busca de endereço, que prioriza a UF digitada, marca "⚠ outra UF" e mostra o link "ver no mapa"; confira sempre, porque o serviço às vezes traz nomes parecidos de outro estado. Também dá para colar a coordenada copiada do Google Maps. Cada porto pode ter seu **tempo de fila/gate**. O Cliente/Fábrica tem um **local de carregamento padrão**, e o container já vem com ele.
- **Distância**: pelo **OpenRouteService** (perfil caminhão, plano gratuito, `ORS_API_KEY`), calculada **uma vez por par e guardada** (`DistanciaRota`). O ponto é aproximado à via mais próxima até 5 km. Sem chave ou com falha do serviço, usa linha reta × fator (Configurações) e marca "aproximada"; o verificador tenta de novo depois. Mudar a coordenada de um local descarta e recalcula as distâncias dele.
- **Tempo**: do ORS usa-se **só a distância**. O tempo segue a regra configurável (*Configurações → Previsão de rota*): **janela diária de rodagem** (padrão 05:00–22:00) e **km máximos por dia** (padrão 500). Fora da janela o caminhão fica parado; roda todos os dias, inclusive fim de semana e feriado. Somam-se o **tempo no local de carregamento** (percentil 80 do histórico real dos últimos 180 dias, com no mínimo 3 passagens; senão, a meta de estadia) e a **fila no porto de entrega**.
- **Previsão viva**: etapas já registradas usam as datas reais. Um evento atrasado (ex.: caminhão que já devia ter chegado) é previsto para "agora", nunca para o passado. Container **Programado** é simulado "se coletar agora" e, com deadline, mostra **até quando coletar**.
- **Alertas**: **Risco de demurrage** e **Risco de deadline**. Atenção quando a folga é menor que o limite configurado (padrão 24h); Crítico quando a previsão passa do prazo, já com diárias e custo estimados. Só existem enquanto o prazo real não venceu; depois disso vale o alerta real.
- Onde aparece: ficha do container (quadro **Trajeto e previsão**, trecho a trecho), simulação ao vivo no **Novo container**, coluna **Previsão** na lista e linha "Previsão" nos blocos do Pátio.

## Etiquetas QR (leitura pelo celular)

Rastreabilidade sem digitação posterior: a etiqueta vai **colada no container** e vale para **uma viagem**.

1. **Gerar** (menu *Etiquetas QR*; supervisor/admin): informe a quantidade. Cada etiqueta recebe um **token aleatório de 128 bits**, que vai na URL do QR e não pode ser "adivinhado", e um **código curto** impresso (ex.: `CC-7K3F9P`, sem 0/O/1/I/L).
2. **Imprimir** (impressora de etiquetas tipo Zebra, **tamanho ajustável**: modelos 50×25 até 100×150 mm ou medida livre):
   - **Pelo navegador:** cada etiqueta vira uma página no tamanho exato (`@page`). Na impressão, escolha a Zebra, o mesmo tamanho de papel, margens "Nenhuma" e escala 100%.
   - **Arquivo ZPL** (linguagem nativa da Zebra, 203/300/600 dpi): envie direto à impressora. O QR usa correção de erro M e sobe para Q/H quando a etiqueta tem espaço, aguentando até ~30% de sujeira ou risco.
3. **1ª leitura** (câmera do celular → página `/q/<token>`, **com login**): número do container (conferido pelo ISO 6346 e precisa estar **ativo**), temperatura (obrigatória em reefer) e data/hora (já vem "agora"). Salvar **liga a etiqueta ao container** e registra a leitura.
4. **Leituras seguintes:** a página já abre no container, pedindo só temperatura e data/hora. A tela mostra na hora se a leitura está dentro, acima ou abaixo da faixa, e o alerta aparece no sistema.
5. **Encerramento:** entregue ou cancelado o container, a etiqueta fica "encerrada" e não aceita novas leituras. Etiqueta danificada: numa etiqueta nova, informe o mesmo container e confirme a **substituição** (a antiga é cancelada). Supervisor também pode cancelar uma etiqueta com motivo.

**Cada usuário vê só as suas etiquetas:** listar, imprimir (navegador e ZPL), marcar como impressa e cancelar valem apenas para as etiquetas dos lotes que a própria pessoa gerou. A regra é aplicada no servidor, então nem uma URL de impressão editada traz etiquetas de outra pessoa. Assim uma fábrica não imprime as etiquetas de outra. O administrador vê as dele por padrão e pode marcar "Ver de todos os usuários" (coluna "Gerada por"). **Ler o QR** continua aberto a qualquer operador logado, porque a etiqueta está no container.

**Controle de impressão:** cada etiqueta registra quantas vezes foi enviada à impressora, quando e por quem: no ZPL, ao baixar; no navegador, quando a janela de impressão fecha. O navegador não informa se a pessoa cancelou, então isso conta como enviada. Há o filtro "Ainda não impressas", e **reimprimir pede confirmação**, porque a cópia tem o mesmo QR.

**Registrar pelo código** (menu, ou `/leitura` no celular): se o QR não abrir (etiqueta riscada, ou IP do teste que mudou), digite o código curto impresso (`CC-7K3F9P`, com ou sem "CC-") e siga para a mesma tela.

**Confiança nos dados:** cada leitura grava quem registrou, a etiqueta usada, o horário informado e o horário real do registro. Leitura com horário digitado **mais de 2h antes** de chegar ao sistema aparece como **"lançada com atraso"** na ficha. Com o sistema em **https**, o celular pode enviar a **localização** da leitura (📍 na ficha). A mesma leitura nunca entra duas vezes.

**Endereço dentro do QR** (*Configurações → Etiquetas QR* ou na tela de impressão): para **testar na rede local**, use o IP deste computador e a porta 5174 (ex.: `http://192.168.0.132:5174`), com o celular no mesmo Wi-Fi. A tela de impressão sugere o IP e avisa que `localhost` não funciona no celular. **Ao publicar online, troque para o endereço https antes de imprimir**, porque etiquetas já impressas continuam apontando para o endereço antigo. ⚠ No teste local, o IP costuma ser dado pelo roteador (DHCP) e **muda** (ex.: trocar do cabo para o Wi-Fi mudou de `.132` para `.249`), e aí as etiquetas impressas param de abrir. Para testes longos, reserve um IP fixo para o computador no roteador; senão, use "Registrar pelo código".

## Telas

- **Pátio**: **uma aba por região** ("Todas" + regiões + "Sem região" se houver fábrica sem região), com contagem de containers e de críticos em cada aba. Os indicadores do topo são os da aba escolhida, e a aba fica lembrada. Dentro da aba, containers por Cliente/Fábrica divididos em *A caminho da fábrica / Na fábrica / A caminho do porto*, com semáforo, barra da estadia, demurrage e temperatura. Atualiza a cada minuto.
- **Containers**: lista com filtros e cadastro. **Ficha**: linha do tempo, prazos, alertas, leitura manual de temperatura com gráfico e histórico.
- **Alertas**: abertos e histórico. Faixa vermelha no topo + sino + bipe quando surge alerta crítico não reconhecido (consulta a cada 30 s).
- **Custo estimado**: custo de estadia e demurrage por **abas de Região** e, dentro delas, **abas de Cliente/Fábrica** (mais a "Visão geral"). Tem filtro de período (30/90 dias, 6/12 meses, mês atual/anterior, personalizado); indicadores; gráfico de tendência empilhado estadia × demurrage (por dia, semana ou mês, conforme o período); ranking por Cliente/Fábrica; **principais impactos** gerados automaticamente (estadia × demurrage, concentração por cliente e por armador, etapa em que o tempo foi perdido, estouros de meta, variação entre as metades do período, horas sem custo/h); detalhamento por container com tempo em cada trecho e exportação CSV (Excel).
  - O custo é lançado **no dia em que ocorre**: cada diária de demurrage no dia cobrado, cada hora além da meta de estadia no dia em que passou. Containers ativos contam até agora; cancelados não entram.
  - A estadia usa o custo/h **gravado no container**. Se o custo/h do Cliente/Fábrica for cadastrado depois, salve o cadastro com "Aplicar também aos containers em andamento" (ou o supervisor ajusta em *Editar → Prazos deste container*, na ficha). Horas sem valor aparecem como "sem R$/h".
  - **Moedas**: estadia em R$ e demurrage na moeda do armador. Com a cotação informada em *Configurações* (US$ e €), tudo é consolidado em R$. Sem cotação, cada moeda aparece separada, em gráficos separados, sem somar moedas diferentes.
- **Cadastros**: Regiões, Cliente/Fábrica, Armadores, Produtos. Cadastro já usado não pode ser excluído, só desativado.
- **Usuários**, **Integração** (tokens), **Configurações e log** de auditoria.

### Perfis e permissões por usuário

Cada perfil tem um **conjunto padrão** de permissões. Em *Configurações → Perfis e permissões*, o administrador pode **personalizar usuário a usuário**, marcando ou desmarcando cada permissão. Um usuário personalizado aparece como "personalizado", e o botão "Padrão do perfil" desfaz a personalização.

| Permissão | Libera | Padrão |
|---|---|---|
| Operar containers | cadastrar, avançar etapas, editar dados, temperatura na ficha, reconhecer alertas | Supervisor, Operador |
| Alterar prazos do container | meta, custo/h, free time e faixa de temperatura de um container | Supervisor |
| Desfazer e cancelar etapas | desfazer a última etapa, cancelar container | Supervisor |
| Editar cadastros | regiões, cliente/fábrica, armadores, produtos, locais | Supervisor |
| Gerar e imprimir etiquetas | gerar lotes e imprimir (navegador/ZPL) **as próprias** etiquetas | Supervisor |
| Cancelar etiquetas | inutilizar as próprias etiquetas | Supervisor |
| Registrar leituras pelo celular | ligar etiqueta e registrar temperatura pelo QR/código | Supervisor, Operador |
| Ver log de auditoria | consultar o histórico de alterações | Supervisor |

- **Administrador:** acesso total, não configurável. Usuários, permissões, integração e as regras de Configurações são **exclusivos do administrador** e não podem ser liberados, para ninguém se trancar fora nem se autopromover.
- **Visualização:** por padrão, só consulta.
- **Troca de perfil:** trocar o perfil de um usuário descarta a personalização dele e aplica o padrão do novo perfil.
- **Mudanças valem na hora:** a cada requisição o servidor relê o usuário no banco. Permissão liberada ou retirada vale imediatamente na API, e a tela se atualiza em até 30 s, sem sair e entrar. **Conta desativada é bloqueada na hora**; antes, a sessão de 12 h continuava válida. Toda mudança fica no log, com "liberou" e "retirou".

**Configurações** é organizada em abas: Geral · Custos · Previsão de rota · Etiquetas QR · Perfis e permissões (só administrador) · Log de auditoria (quem tem a permissão). Quem não é administrador vê as regras apenas para leitura.

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

**Jeito rápido (Windows):** dê dois cliques em **`iniciar.bat`**. Ele:
- abre o Docker Desktop, se preciso, e sobe o banco;
- instala as dependências na primeira vez;
- abre a API e a Tela em duas janelas minimizadas;
- espera o sistema responder e abre http://localhost:5174 no navegador.

Se o sistema já estiver rodando, o script só abre o navegador, sem duplicar janelas. Se a porta 3000 estiver ocupada (ex.: McCain local), ele avisa. Para desligar, feche as janelas "Controle de Container - API" e "Controle de Container - Tela".

**Passo a passo manual.** Requisitos: Node 20+, Docker.

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
