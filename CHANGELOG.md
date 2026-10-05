# Histórico de versões

A versão que está no ar aparece no rodapé do menu lateral e em `GET /api/saude` (`versao`).
Cada versão publicada tem uma tag no Git (`vX.Y.Z`) — é o ponto de retorno em caso de rollback
(procedimento no README, seção "Versões e rollback").

## 3.9.0 (reauditoria da 3.8.0: teste de estresse com 3 empresas e correções)

Teste: 3 empresas usando o app inteiro por HTTP (todos os perfis, planilhas, QR, motorista por SMS, viagem,
rastreamento, custos, redefinição de senha) mais 276 ataques cruzados com ids de outra empresa, no sistema
em modo produção (RLS ligado). Resultado de isolamento: 0 vazamentos e 0 ataques aceitos, **exceto o item 1**.

- **Transportadora do motorista só do cliente da etiqueta (vazamento entre clientes):** no primeiro acesso, a
  lista de transportadoras era a da plataforma inteira. Um desconhecido com um celular via os nomes das
  transportadoras de todos os clientes e, escolhendo a de outro cliente e registrando uma leitura no QR, o
  cliente passava a ver o **nome e o CNPJ completo** dela (e podia criar gestor para ela). Agora a lista traz só as
  transportadoras do cliente da etiqueta (mais a que o motorista já tem, se foi pré-cadastrado por outro
  cliente), sem CNPJ, e o cadastro recusa (400) uma transportadora fora dela.
- **CNPJ único só dentro do cliente:** como o CNPJ é público, quem cadastrava primeiro um CNPJ com um nome falso
  virava dono do cadastro e a empresa verdadeira recebia esse cadastro sem poder corrigir. Agora cada cliente tem
  o seu cadastro (nome e CNPJ únicos só dentro dele). Migração `20261013100000_cnpj_por_cliente` (troca o
  índice único do CNPJ por `(organizacaoDonaId, cnpj)`; não apaga nada).
- **Portaria, containers que ficam junto (`/portaria/ficam`):** agora tudo ou nada. Antes cada container era gravado
  na sua vez: um inválido no meio deixava os anteriores registrados com a resposta de erro e repetir o pedido
  falhava nos que já tinham entrado.
- **Desempenho (medido no teste, 3 empresas, Alfa com ~1.300 containers ativos):**
  - A varredura de alertas fazia uma consulta de viagem por container (regressão da 3.8.0 sobre o lote da 3.4).
    Agora a participação em viagem vem em lote: salvar Configurações com 1.283 ativos passou de **20,5 s para 1,0 s**
    (383 ativos: de 6,3 s para 0,3 a 1,2 s). A varredura periódica ganha o mesmo.
  - A importação grava os alertas e o plano dos containers criados em lote: 900 linhas de **70 s para 16,6 s**.
  - `GET /api/alertas/resumo` (consultado por todo navegador aberto, a cada poucos segundos) devolvia o container
    de cada alerta: de 365 KB para ~35 KB e de 110 ms para 34 ms.
  - Pico de memória do servidor no teste de carga: de 697 MB para 486 MB.
- **Decisão sobre a anonimização com homônimos:** não alterado. A autoria é texto livre ("Nome (motorista ·
  Transportadora)"); com nome e transportadora iguais não há como distinguir, e o direito de exclusão tem
  prioridade. Resolver de vez exige gravar o `motoristaId` em cada tabela de autoria (mudança maior, fica anotada).
- **Ainda de pé (recomendado para a próxima versão):** `GET /api/containers` e `/api/painel` devolvem tudo de uma vez
  (6 MB e 1 MB com 1.286 ativos; 0,9 s e 0,7 s com um usuário, e a vazão cai a ~5 a 10 requisições/s com
  vários usuários por causa do custo de montar e serializar). Pede paginação ou lista resumida, com mudança na tela.

## 3.8.0 — 04/10/2026 (tag `v3.8.0`)

- **Viagem com vários containers (mesmo caminhão):** antes cada container era tratado como uma viagem —
  2 containers no mesmo caminhão geravam 2 SMS (custo em dobro) e a posição de um link ficava só num
  deles (o outro podia acusar "sem posição"/"parado").
  - Na leitura do 2º QR: **"Este container vai no mesmo caminhão que X?"** (motorista/transportador).
  - **Um SMS por viagem**, citando os containers; a posição do link e do acompanhamento pela página vale
    para todos (a situação do acompanhamento também).
  - **Portaria:** na entrada, oferece os outros containers do caminhão com o mesmo ponto de carregamento
    — marca os que ficam (entrada registrada junto, com a temperatura dos reefer); os outros seguem viagem.
  - O container sai da viagem ao chegar a um ponto, ao ser encerrado ou se outra pessoa assumir o
    rastreamento; com menos de 2, a viagem termina. Histórico guardado (`ViagemContainer`).
  - Ficha: "Viaja junto com" (com link para o outro container).
- Migração `20261012100000_viagem`: tabelas `Viagem` e `ViagemContainer` (RLS por organização e chaves
  compostas, como as demais tabelas de cliente).

## 3.7.0 — 04/10/2026 (tag `v3.7.0`)

- **Entrega a definir:** o local de entrega pode ficar "A definir" (cadastro, ficha, Editar trajeto). Antes, sem
  ele, não havia previsão nenhuma e o plano não congelava; ninguém era avisado.
  - **Previsão parcial:** coleta, ida, chegada e saída do carregamento (distância da ida na ficha). Sem ETA
    final, ciclo, folga nem risco de demurrage/deadline até a entrega ser definida.
  - **Planejado em duas partes:** congela a parte conhecida; quando a entrega é definida, entra só a entrega
    planejada (com a previsão daquele momento) — a parte já congelada não muda.
  - **Alerta novo "Definir local de entrega":** atenção no local de carregamento, crítico a caminho da
    entrega (fluxos sem local de operação: desde a coleta). Some quando a entrega é definida.
  - **Quem define:** a equipe (ficha → Editar trajeto, que aceita "A definir") e a portaria (campo novo na
    leitura do QR, registrado no Histórico do trajeto). Na coleta, transportador e motorista não definem.
  - Home ("Entrega a definir" no card), lista de containers e ficha mostram a situação.
- Migração `20261011100000_entrega_a_definir` (só acrescenta o tipo de alerta).

## 3.6.0 — 04/10/2026 (tag `v3.6.0`)

- **Chaves estrangeiras compostas (pendência do item 7 da análise de segurança):** a conferência de chave
  estrangeira do PostgreSQL não passa pelo RLS — o banco aceitava gravar num registro de um cliente o id de
  um cadastro de outro (só a validação das rotas impedia). Agora as 31 ligações entre tabelas de cliente
  têm também uma chave composta `(campo, organizacaoId) → (id, organizacaoId)`, e o próprio banco recusa.
  As chaves simples continuam (exclusão em cascata, restrição e esvaziar o campo seguem iguais).
- Declaradas no `schema.prisma` (relações `org_*` e `@@unique([id, organizacaoId])`): o Prisma as conhece e um
  `migrate dev` futuro não propõe removê-las.
- Migração `20261010100000_fk_compostas` (só acrescenta 11 índices e 31 restrições; se algum dado existente
  apontasse para outro cliente, ela falharia inteira sem mudar nada).
- README: o risco "referência cruzada sem barreira no banco" sai da lista de riscos aceitos.

## 3.5.0 — 04/10/2026 (tag `v3.5.0`)

Revisão da v3.4 (itens 1, 2, 3, 5 e 6). Publicada junto com a 3.4.1.

- **Bloqueio do gestor só no cliente dele:** o gestor é criado por um cliente, e o bloqueio dele gravava
  o bloqueio de toda a plataforma — um motorista compartilhado ficava bloqueado (e sem acesso) também
  nos outros clientes. Agora gestor e administração bloqueiam só no próprio cliente (QR, pedido de
  código pela etiqueta e SMS desse cliente). O bloqueio de plataforma fica só para a anonimização.
- **Anonimizar motorista:** não usa mais o nome (texto livre) para achar containers — homônimos ficavam
  sem nome/placa. Os containers são achados pelo id do motorista (rastreio, posições, pedidos, SMS, log)
  e o nome só é trocado onde é exatamente o dele; a identidade "Nome (motorista · Transportadora)" sai das
  etapas, leituras de temperatura, etiqueta, paradas, mudanças de trajeto e do criador do container.
  Continua no log de auditoria (imutável, 365 dias).
- **Transportadora:** CNPJ com dígitos verificadores; o **cliente dono** (quem criou) continua editando
  mesmo quando outro cliente se vincula pelo mesmo CNPJ (antes, ficava bloqueado com 409).
- **Acompanhamento pela página:** termina se a página ficar 6 h sem enviar ou após 72 h da resposta do
  link — o link do SMS não vale mais por dias. Depois, só pelo link do próximo SMS.
- **Código SMS do motorista:** teto de 20 pedidos/hora **por etiqueta** para números novos; motorista já
  vinculado ao cliente não entra nos tetos de números novos (abuso não tranca quem já trabalha com o cliente).
- Migração `20261009100000_revisao_3_5` (só acrescenta): `Transportadora.organizacaoDonaId` (existentes:
  o primeiro cliente vinculado), `CodigoAcessoMotorista.etiquetaId` e `conhecido`.

## 3.4.1 — 04/10/2026 (tag `v3.4.1`, publicada junto com a 3.5.0)

- **Desfazer etapa sem erro 500:** desfazer a entrega (ou o cancelamento) de um container cujo número já está ativo em
  outro cadastro respondia erro interno (índice único da v3.2). Agora responde 409 com mensagem clara.
- **Custos, total do topo ao centavo:** os totais em dinheiro passam a somar os containers (cada um igual à sua ficha),
  não a série por dia — que, arredondada por dia, ainda diferia 1 centavo em lotes grandes. A série segue só nos gráficos.
- **Planilha acima de 1 MB:** mensagem em português (antes: "request entity too large").
- **Correção de texto (3.4.0):** o RLS não barra a GRAVAÇÃO de referência a cadastro de outro cliente (a conferência de
  chave estrangeira não passa por ele); quem barra é a validação das rotas. README ganhou a seção "Riscos aceitos".

## 3.4.0 — 02/10/2026 (tag `v3.4.0`)

**Estrutura e desempenho** (análise de segurança da v3.0.2: itens 7, 9 e 12). Publicada junto com
a 3.1.2, a 3.2.0 e a 3.3.0.

- **Isolamento entre clientes (item 7):** em produção o sistema **não sobe** sem `APP_DB_ROLE_PASSWORD`
  (antes era só um aviso) — sem ela não haveria o RLS. README corrigido: o filtro automático da
  aplicação vale para a consulta de primeiro nível; relações carregadas junto ficam a cargo do RLS e
  da validação das rotas. Teste novo de "referência cruzada": o cliente B tenta usar ponto de
  carregamento, armador, produto, local, região e tipo de local da A em containers e cadastros — tudo
  recusado, e nenhum container no banco aponta para cadastro de outro cliente. (Chaves estrangeiras
  compostas ficaram para depois, como recomendado na análise: custo alto, e o teste cobre o risco hoje. Correção na 3.4.1:
  o RLS não barra a gravação cruzada — ver README, "Riscos aceitos".)
- **Transportadora (item 9):** nome único só dentro do cliente; CNPJ único na plataforma; mesmo CNPJ
  reaproveita o cadastro (só o vínculo é criado, e fica no log). Migração
  `20261008100000_transportadora_cnpj` (troca o índice único do nome pelo do CNPJ; não apaga nada).
- **Desempenho (item 12):** a varredura de alertas (a cada minuto, por cliente) carrega containers,
  leituras, contexto de rota e alertas abertos **em lote** (4 consultas) em vez de ~4 consultas por
  container — no banco local, 8 containers: de 35–39 para ~9–15 transações e de 211–490 ms para
  59–85 ms. Configurações com cache de 5 s por cliente (invalidado ao salvar).

## 3.3.0 — 02/10/2026 (tag `v3.3.0`, publicada junto com a 3.4.0)

**Endurecimento, custo e LGPD** (análise de segurança da v3.0.2: itens 8, 10, 11, 13, 14, 15, 16, 17
e 20). Publicada junto com a 3.1.2 e a 3.2.0.

- **Log de auditoria imutável para o sistema (item 8):** o usuário da aplicação (`ccs_app`) não
  altera nem apaga o log (REVOKE em `scripts/preparar-banco.js`). A purga de 365 dias passa pela
  função `purgar_log_auditoria` (roda com o dono das tabelas e recusa retenção menor que 365 dias).
- **SMS do motorista por cliente (item 10):** pedir o código exige a etiqueta lida (válida, de cliente
  ativo) e o teto passa a ser **por cliente** (`MOTORISTA_MAX_CODIGOS_HORA_CLIENTE`, padrão 100/h); o
  total da plataforma (`MOTORISTA_MAX_CODIGOS_HORA`, 500/h) vira só alarme de custo no log.
- **Cota do OpenRouteService (item 11):** limite por cliente — busca de endereço 100/h, simulação de
  rota 600/h — e a simulação exige "operar containers" (é usada só no Novo container).
- **Login e "Esqueci minha senha" (item 13):** e-mail inexistente também passa pelo bcrypt (hash
  fictício) e o e-mail de redefinição sai depois da resposta — o tempo não revela quais contas existem.
- **Custo de estadia (item 14):** a tela Custos soma os valores exatos e arredonda só no total — não
  difere mais 1 centavo da ficha (0 diferenças em 200 mil casos, teste de regressão).
- **LGPD (item 15):** a limpeza diária vale também para clientes desativados e apaga o celular dos SMS
  mais antigos que a retenção (a mensagem fica). **Anonimizar motorista** (Motoristas → Editar →
  "Anonimizar (LGPD)"): nome, celular, CPF e placa saem do cadastro e dos containers do cliente, o
  acesso é encerrado; só a administração e só motorista exclusivo do cliente.
- **Planilhas (item 16):** upload limitado a 1 MB (1.000 containers ou 5.000 motoristas cabem).
- **IPs internos (item 17):** as sugestões de endereço com os IPs do servidor só aparecem fora de
  produção e para quem administra.
- **Outros (item 20):** e-mail de usuário/nome de transportadora já usados em **outro** cliente
  recebem mensagem genérica; o comprovante de celular do motorista tem segredo próprio (derivado) e
  audience — não se confunde com a sessão; **Content-Security-Policy ligado** (só scripts do próprio
  site; imagens também do OpenStreetMap); o log das ações do motorista guarda o id dele (`motoristaId`).
- Migração `20261007100000_seguranca_3_3` (só acrescenta): `CodigoAcessoMotorista.organizacaoId`,
  `LogAuditoria.motoristaId` e a função `purgar_log_auditoria`.

## 3.2.0 — 02/10/2026 (tag `v3.2.0`, publicada junto com a 3.4.0)

**Segurança antes do primeiro cliente real** (itens da análise de segurança da v3.0.2: 1, 2, 3, 4, 5,
6, 18, 19 e CPF mascarado). Publicada junto com a 3.1.2.

- **Gestor de transportadora só do próprio cliente (item 1):** o gestor só pode ser ligado a uma
  transportadora vinculada à organização de quem o cria, e só enxerga os motoristas dela vinculados ao
  seu cliente. A tela/API de Motoristas não devolve mais o e-mail de quem cadastrou ou bloqueou, e o
  **CPF sai sempre mascarado** (`***.982.247-**`).
- **Motorista compartilhado entre clientes (item 2):** bloqueio **por cliente** (novas colunas em
  MotoristaOrganizacao): o bloqueio da administração vale só para aquele cliente (QR e SMS dele); o do
  gestor continua sendo o da transportadora (todos os clientes, derruba o acesso). Nome, placa e celular
  só são editáveis pelo cliente quando o motorista atende só ele; compartilhado → 409. O **próprio
  motorista troca o celular** na tela do QR ("Trocar celular"), confirmando o número novo por SMS; os
  outros acessos dele caem e o número antigo recebe aviso.
- **Código curto do QR (itens 3 e 18):** no máximo 10 códigos errados a cada 15 min por aparelho e por
  pessoa (só falhas contam; a 11ª → 429). O motorista só abre pelo código etiqueta já ligada a um
  container e informando o número dele. Etiquetas novas com **8 caracteres** (`CC-XXXXXXXX`), sorteados
  com `crypto.randomInt` (sem o viés de `byte % 31`); as antigas de 6 seguem valendo. Fonte do código
  na etiqueta (tela e ZPL) proporcional ao tamanho.
- **Cliente desativado (item 4):** motorista pelo QR, token de integração e link do SMS de um cliente
  desativado recebem 403.
- **Concorrência (item 5):** índice único parcial — um container ativo por número em cada organização;
  avançar, desfazer e cancelar só gravam se a etapa não mudou (`updateMany` condicionado; o segundo
  recebe 409); vínculo de etiqueta condicionado a "LIVRE" (QR, coleta e portaria).
- **Salvar Configurações (item 6):** recalcula só a organização de quem salvou (antes, a plataforma toda).
- **Endereço dos links (item 19):** em produção, links de SMS/e-mail e a URL dos QR usam sempre o
  endereço da plataforma (`APP_URL`, ou `RENDER_EXTERNAL_URL` no Render); o campo das Configurações
  vira informativo. Fora de produção continua valendo (teste em rede local).
- Migração `20261006100000_seguranca_3_2` (só acrescenta): colunas de bloqueio por cliente e o índice
  `Container_numero_ativo_unico`. ⚠ O Prisma 5 não representa índice parcial: um `prisma migrate dev`
  futuro vai propor removê-lo — não aceite (README, "Banco de dados").

## 3.1.2 — 02/10/2026 (tag `v3.1.2`, publicada junto com a 3.4.0)

- **Ficha → Rastreamento mostra quando o acompanhamento pela página parou.** Antes só virava
  "pausado" 20 min depois da última posição gravada — a ficha seguia "ativo" com a página já parada.
  Agora a página do link avisa o servidor quando inicia, quando é **minimizada ou fechada** (via
  sendBeacon, que entrega mesmo com a página saindo) e quando o motorista toca em **Parar**; cada
  envio renova o último sinal. A ficha mostra: *ativo · último sinal há X*, *parou — pausado desde*
  (página minimizada/fechada), *parou — sem sinal desde* (deixou de mandar sem avisar: tela bloqueada,
  sem internet ou bateria — mais de 7 min sem sinal, com envios a cada 5 min) ou *encerrado pelo motorista*.
- Rota nova `POST /api/posicao/:codigo/acompanhar/estado` (ATIVO | PAUSADO | ENCERRADO; mesmas regras do
  link: respondido, responsável atual, container ativo; limite próprio de 20 por 5 min por link).
- Migração `20261005100000_acompanhamento_estado`: só acrescenta 3 colunas opcionais em Container
  (situação, quando mudou e último sinal). Troca de responsável pelo QR limpa a situação.

## 3.1.1 — 02/10/2026 (tag `v3.1.1`)

- **Home:** só aparecem os Pontos de Carregamento com demanda (pelo menos 1 container ativo —
  programado, em trânsito ou no local). Os sem container saem dos cards e da lista do filtro
  "Ponto de Carregamento"; continuam no cadastro e voltam a aparecer quando receberem container.

## 3.1.0 — 02/10/2026 (tag `v3.1.0`)

**Geolocalização do navegador (`watchPosition`) como reforço do rastreamento — o SMS continua sendo o principal.**

- **Posição mais precisa:** o link do SMS e a leitura do QR não aceitam mais a 1ª leitura do GPS
  (que costuma vir da rede, com centenas de metros de erro): acompanham as leituras por alguns
  segundos e ficam com a melhor (link: até 15 s ou ±30 m; QR: até 8 s ou ±50 m). Arquivo novo
  `web/src/geolocalizacao.js`.
- **Acompanhamento pela página (opcional):** depois de enviar a posição do link, a pessoa pode tocar em
  "Acompanhar com a página aberta". Enquanto a página estiver **aberta e na tela**, o celular envia a
  posição a cada 5 min, mantendo a tela ligada quando o celular permite. Se a página for
  minimizada/fechada ou a tela bloquear, o envio para (limite dos navegadores) e retoma ao voltar.
  Rota nova `POST /api/posicao/:codigo/acompanhar`: só depois da posição do link e **até a leitura de
  entrega no destino** (ou cancelamento / troca de responsável), no máximo 1 posição por minuto (429).
  Parado no mesmo lugar (até 200 m), grava no máximo 1 posição a cada 15 min. Posições com a origem
  **"Acompanhamento (página aberta)"**.
- **Limites de requisição revisados:** celulares da mesma operadora saem pelo mesmo IP (CGNAT). O
  acompanhamento tem limites próprios (600 por 15 min por IP; 15 por 5 min por link) e não consome o
  limite do link do SMS, que subiu de 30 para 60 por 15 min por IP. A consulta do agendador que busca
  as últimas posições passou a usar o índice por container (`LATERAL ... LIMIT`).
- **O agendador de SMS não muda:** as posições do acompanhamento não adiam nem substituem os pedidos por
  SMS — entram como dados a mais no mapa e nos motivos.
- **"Parado" corrigido para posições frequentes:** antes comparava só as 2 últimas posições; com uma
  posição a cada 5 min no mesmo lugar ele nunca disparava. Agora usa o bloco contínuo de posições a até
  500 m da última (até 200 posições) cobrindo as X h configuradas.
- **Ficha → Rastreamento:** mostra se o acompanhamento está ativo (posição há menos de 20 min) ou
  pausado desde quando.

## 3.0.2 — 29/09/2026 (tag `v3.0.2`)

- **Mapa do Rastreamento em produção mostrava "Access blocked" (403) do OpenStreetMap:** o sistema
  envia `Referrer-Policy: no-referrer` (segurança) e a política de uso do OpenStreetMap exige saber
  de qual site vem o pedido. Só as imagens do mapa passam a informar a **origem** do site (sem o
  caminho da página — nenhum dado do container sai); endereço atualizado para `tile.openstreetmap.org`.

## 3.0.1 — 29/09/2026 (tag `v3.0.1`)

- **Correção do deploy da 3.0.0** (o build falhou depois das migrações e a 3.0.0 nunca entrou no ar):
  no Supabase (PostgreSQL 17) o usuário das migrações não é superusuário e não pode nem citar
  `NOSUPERUSER` num `ALTER ROLE`. `scripts/preparar-banco.js` passa a criar/atualizar o `ccs_app`
  só com LOGIN + senha (os atributos padrão já são os seguros) e a conferência final exige que ele
  não seja superusuário nem ignore o RLS. Também funciona num banco vazio (instalação nova).
- Enquanto a 3.0.0 não subiu, a produção ficou na 2.1 com `scripts/rollback-3.0-antes.sql`
  aplicado (plano B); ao entrar a 3.0.1 roda-se `scripts/rollback-3.0-desfazer.sql`.
- Testado simulando o build inteiro com um usuário não superusuário igual ao do Supabase.

## 3.0.0 — 29/09/2026 (tag `v3.0.0`) — não entrou no ar (ver 3.0.1)

**Multi-tenant: vários clientes na mesma plataforma, cada um vendo só a própria organização.**

- **Organizações:** todos os dados atuais passaram para a organização **AS TECH LOG**. Nomes de
  cadastros passam a ser únicos por organização. Configurações, log, etiquetas, tokens e
  usuários são de cada organização.
- **Isolamento em duas camadas:** (1) filtro automático de organização em toda consulta do
  sistema (sem organização definida, a consulta falha); (2) **Row-Level Security** no PostgreSQL,
  com o sistema conectando pelo usuário restrito `ccs_app` (sem permissão de ignorar o RLS).
- **Administrador da plataforma** (perfil novo): tela **Organizações** — criar cliente (já com os
  tipos de local e de operação padrão) e o 1º administrador dele, renomear, desativar. Não vê
  dados operacionais dos clientes. Criado por `PLATAFORMA_ADMIN_EMAIL/SENHA/NOME`.
- **Motoristas e transportadoras** continuam com cadastro único na plataforma; cada cliente só vê
  os que registraram pelo QR uma carga dele (ou que ele cadastrou). Transportadora compartilhada
  não pode ser alterada por um cliente.
- Login pelo e-mail (único na plataforma); organização desativada derruba login e sessões.
- Migrações (todas testadas numa cópia restaurada de produção): `20261003085900_perfil_plataforma`,
  `20261003090000_multi_tenant` (backfill AS TECH LOG), `20261004090000_rls_organizacao`,
  `20261004100000_gestor_na_organizacao`, `20261004110000_rls_tabelas_globais` (o Supabase
  liga o RLS em toda tabela nova — tabelas globais precisam de regra explícita).
- **Voltar para a 2.1 exige** `scripts/rollback-3.0-antes.sql` (para se houver outra organização
  com dados); ao republicar a 3.0, `scripts/rollback-3.0-desfazer.sql`. Ciclo completo testado.
- Testes de invasão: a organização B ataca todas as rotas com identificador da A e nada muda
  (o teste falha se aparecer rota nova sem caso de ataque).

## 2.1.0 — 29/09/2026 (tag `v2.1.0`)

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
- **Privacidade do celular do motorista:** listas, rastreamento e SMS mostram só os 4 últimos
  dígitos ("(••) •••••-4321"); o número completo aparece apenas ao criar e no novo **Editar**
  motorista (nome, celular, placa — trocar o celular encerra os acessos atuais).

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
