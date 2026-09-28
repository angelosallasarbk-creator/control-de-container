# Controle de Container

Controle de containers de **exportação** entre o porto e a fábrica: estadia na fábrica, demurrage, deadline do navio e temperatura de reefer, com alertas antecipados e visão do pátio por **Ponto de Carregamento** (Cliente + Fábrica).

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
| **Estadia** | chegada → saída da fábrica | Meta em horas por Ponto de Carregamento | faltam ≤ X h (configurável) | meta estourada (+ custo/h se cadastrado) |
| **Demurrage** | coleta → entrega no porto | Free time (dias) + diária por Armador | faltam ≤ X dias | free time vencido (diárias × valor) |
| **Deadline** | — | data/hora do cut-off no container | < 24 h | passou sem entrega |
| **Temperatura** (reefer, qualquer etapa até a entrega) | leitura fora da faixa mín/máx do Produto | tolerância em min | na hora | fora há mais que a tolerância |
| **Sem leitura** (reefer em ovação/liberado) | desde a última leitura | intervalo global (Configurações) | passou do intervalo | passou do dobro |
| **Atraso na coleta** | coleta programada → coleta registrada | "Coleta programada para" no container (cadastro/edição) | passou do horário e o container segue "Programado" | atraso ≥ X h (Configurações → Geral, padrão 4 h) |

- **Demurrage conta por dia de calendário (horário de Brasília)**: o dia da coleta é o dia 1; cada dia iniciado após o free time é uma diária, inclusive o dia da entrega. ⚠ Confirme essa regra com o contrato de cada armador. Alguns contam a partir da descarga ou em períodos de 24 h.
- **Prazos são copiados** do cadastro quando o container é criado (meta, custo/h, free time, diária, faixa de temperatura). Ao **editar** um Ponto de Carregamento, Armador ou Produto com containers em andamento, a tela oferece **"Aplicar também aos N containers em andamento"** (marcado por padrão). Essa opção aplica os valores *atuais* do cadastro e recalcula prazos, alertas e custos. Containers entregues ou cancelados nunca mudam, para preservar o histórico. Supervisor também pode ajustar os prazos de um container específico (ex.: free time negociado); com a opção marcada, esse ajuste individual é substituído.
- **Alertas** são abertos e encerrados automaticamente por um verificador (a cada 5 min e logo após qualquer mudança). O mesmo alerta nunca é aberto duas vezes (índice único). Se o alerta passa de Atenção para Crítico, abre-se um novo e o anterior é encerrado. Alguém pode **reconhecer** o alerta, com a ação tomada registrada, mas ele só fecha quando a condição acaba.
- **Região é da fábrica**: cada Ponto de Carregamento pode ter uma região. Escolher a região de um cliente aplica a mesma região a todos os clientes da mesma fábrica. Um cliente novo de fábrica já cadastrada, criado sem região, herda a região da fábrica. Região com fábricas vinculadas não pode ser excluída, só desativada.
- Número do container validado pelo padrão **ISO 6346** (dígito verificador). Se o dígito não conferir, o sistema pede confirmação. Só pode existir **uma passagem ativa** por número.

## Previsão de rota e risco de demurrage

Cada container pode ter o **trajeto**: local de retirada do vazio (porto, terminal ferroviário…) → local de carregamento (fábrica, armazém…) → local de entrega do cheio. Com ele o sistema prevê a entrega no porto e compara com o free time e o deadline.

- **Tipos de local** (*Cadastros → Locais*, seção "Tipos de local", ou "+ Novo tipo…" ao cadastrar um local): padrões **Fábrica**, **Armazém**, **Porto / Terminal** e **Terminal Ferroviário**, e dá para criar outros. Cada tipo tem uma **função**: *retirada/entrega do container* (pode ser retirada ou entrega e tem fila/gate) ou *carregamento* (onde o container é ovado). Tem também os **nomes das etapas** naquele tipo de local, sugeridos a partir do nome e editáveis: coleta e entrega, ou chegada e saída. A linha do tempo, os botões, o histórico e a situação nas listas (Containers, Home, Alertas, Custos, celular) usam esses nomes. Exemplo: coleta num terminal ferroviário aparece como **"Coleta ferroviária"**, e o botão como "Registrar coleta ferroviária". Sem local definido, vale o nome genérico ("Coletado no porto"). O filtro por situação continua com os nomes genéricos. Um tipo com locais não pode mudar de função nem ser excluído, só desativado. Um local usado em containers só pode trocar para um tipo com a mesma função.
- **Locais** (*Cadastros → Locais*): locais de carregamento e de retirada/entrega com coordenadas. A tela tem busca de endereço, que prioriza a UF digitada, marca "⚠ outra UF" e mostra o link "ver no mapa"; confira sempre, porque o serviço às vezes traz nomes parecidos de outro estado. Também dá para colar a coordenada copiada do Google Maps. Cada local de retirada/entrega pode ter seu **tempo de fila/gate**. O Ponto de Carregamento tem um **local de carregamento padrão**, e o container já vem com ele.
- **Distância**: pelo **OpenRouteService** (perfil caminhão, plano gratuito, `ORS_API_KEY`), calculada **uma vez por par e guardada** (`DistanciaRota`). O ponto é aproximado à via mais próxima até 5 km. Sem chave ou com falha do serviço, usa linha reta × fator (Configurações) e marca "aproximada"; o verificador tenta de novo depois. Mudar a coordenada de um local descarta e recalcula as distâncias dele.
- **Tempo**: do ORS usa-se **só a distância**. O tempo segue a regra configurável (*Configurações → Previsão de rota*): **janela diária de rodagem** (padrão 05:00–22:00) e **km máximos por dia** (padrão 500). Fora da janela o caminhão fica parado; roda todos os dias, inclusive fim de semana e feriado. Somam-se o **tempo no local de carregamento** (percentil 80 do histórico real dos últimos 180 dias, com no mínimo 3 passagens; senão, a meta de estadia) e a **fila no porto de entrega**.
- **Previsão viva**: etapas já registradas usam as datas reais. Um evento atrasado (ex.: caminhão que já devia ter chegado) é previsto para "agora", nunca para o passado. Container **Programado** é simulado "se coletar agora" e, com deadline, mostra **até quando coletar**.
- **Alertas**: **Risco de demurrage** e **Risco de deadline**. Atenção quando a folga é menor que o limite configurado (padrão 24h); Crítico quando a previsão passa do prazo, já com diárias e custo estimados. Só existem enquanto o prazo real não venceu; depois disso vale o alerta real.
- Onde aparece: ficha do container (quadro **Trajeto e previsão**, trecho a trecho), simulação ao vivo no **Novo container**, coluna **Previsão** na lista e linha "Previsão" nos blocos da Home.

## Produtos: categoria e temperatura (v1.4)

- **Categoria do produto:** Congelado, Refrigerado ou **Carga Seca**. Congelado e Refrigerado têm faixa (setpoint, mínima, máxima, tolerância); Carga Seca não tem temperatura.
- **Controle de temperatura** = container **reefer** com produto **Congelado/Refrigerado**. Sem isso (container dry ou produto Carga Seca): o QR não pede temperatura, a ficha não mostra a aba nem as informações de temperatura, não há alerta de temperatura/sem leitura, e leituras (manual, QR ou integração) são recusadas.
- Numa etiqueta nova, o QR descobre o container pelo número digitado e esconde a temperatura se ele for Carga Seca.
- Produtos já cadastrados foram classificados pela faixa na migração (setpoint ≤ -5 °C = Congelado, senão Refrigerado). Pela API, produto sem categoria recebe a mesma regra.

## Portaria: placa obrigatória (v1.4)

- Ao registrar entrada/saída pelo QR, a **placa do veículo é obrigatória** (vem preenchida com a placa vinculada ao container). Se for **diferente** da vinculada, o **motivo da troca é obrigatório**. A placa nova vai para o container e o motivo fica na etapa e no log.

## Pontos de parada no trajeto — Ponto Fiscal (v1.2)

- **Cadastro:** Cadastros → Locais, tipo **"Ponto Fiscal"** (função "Parada no trajeto"; dá para criar outros tipos com essa função). Ao escolher o tipo, o formulário pergunta se o ponto fica **antes ou depois do ponto de carregamento** (posição padrão) e o **tempo médio de parada** (padrão 1 h).
- **Editar trajeto** (ficha do container → aba Trajeto): lista Retirada → pontos → Carregamento → pontos → Entrega. Retirada, carregamento e entrega ficam fixos na ordem (troca-se só o local). **"+ Adicionar ponto"** cria uma linha no final; ao escolher o ponto ele vai para a posição padrão e pode ser **arrastado** (pela alça ⋮⋮, ou ↑ ↓ no celular) para antes ou depois do carregamento. Ao salvar: distâncias de cada trecho, km total, **ciclo, ETA e alertas recalculados**; container ainda **Programado** tem o **Planejado refeito** (depois da coleta, o Planejado original fica).
- **Ponto de Carregamento como parada (v1.3):** em Cadastros → Ponto de Carregamento, o checkbox **"Pode ser ponto de parada no trajeto"** (com posição padrão antes/depois do carregamento e tempo médio de parada) faz o local desse ponto aparecer como opção no "Editar trajeto" ("Ponto de Carregamento: Cliente / Fábrica"). O próprio local de carregamento do container não pode ser também uma parada.
- **Previsão:** cada ponto soma a rodagem até ele + o tempo de parada. Os trechos aparecem separados na aba Trajeto (ex.: "Retirada → Ponto Fiscal X", "Parada: Ponto Fiscal X", "Ponto Fiscal X → carregamento").
- **Passagem** (marco — não muda o status do container): aparece na aba **Etapas** com Planejado, ETA e Realizado. Registro pela **ficha** ("Registrar passagem", com horário) ou pelo **QR** no próprio ponto ("Registrar passagem" com horário de agora + GPS; o QR oferece o próximo ponto pendente da etapa). Pontos antes do carregamento só depois da coleta; depois do carregamento, só após a saída. Com a passagem registrada, a previsão dos trechos seguintes parte do horário real. **Desfazer** exige "Desfazer e cancelar etapas". Ponto com passagem registrada não pode sair do trajeto nem trocar de lado. Tudo no log (TRAJETO, PASSAGEM, DESFAZER).

## Motoristas e transportadoras (v1.1)

- **Motorista e placa no container (v1.3):** a cada registro pelo QR feito por um motorista, o container passa a mostrar o nome e a placa dele (ficha → Dados e coluna "Motorista / Placa" na Tabela). Na tela do QR o motorista confere a placa e toca em **"Trocar"** se mudou de caminhão; o próximo registro atualiza o container (a troca fica no log).

Motorista **não é usuário do sistema** — com milhares de motoristas, criar e manter um login para cada um não é viável.

- **Identidade = celular verificado.** Ao ler o QR sem estar logado, o motorista informa o celular e recebe um **código de 6 dígitos por SMS** (vale **15 min**; pedir outro encerra o anterior; até 5 tentativas; 1 pedido/min e 5/h por celular, limite por aparelho e teto global de 500 códigos/hora — `MOTORISTA_MAX_CODIGOS_HORA`, ajustável no Render). No banco fica só o HMAC do código.
- **Primeiro acesso:** nome, transportadora (lista), placa, CPF opcional (validado) e **aceite do termo de uso dos dados (LGPD)**. Cadastro livre — a transportadora bloqueia quem não for dela.
- **Sessão no celular por 60 dias** (cookie httpOnly `cc_motorista`, só para `/api/motorista`; só o hash do token no banco). Nas próximas leituras o QR abre direto.
- **O que ele faz:** as mesmas telas do QR do perfil Transportador (coleta com local de retirada, cadastro do container se não existir, vínculo, temperatura) — rotas `/api/motorista/qr/*`, as mesmas do QR da equipe. Nos registros aparece como "Nome (motorista · Transportadora)". Portaria e o resto do sistema ficam fechados.
- **Rastreamento:** a cadeia vira QR → Container → **Motorista** → celular verificado (ou usuário da equipe, se for ele quem registrou). A regra de troca continua: quem registrar pelo QR por último recebe os SMS.
- **Transportadoras:** Cadastros → Transportadoras (nome, CNPJ opcional).
- **Gestor da transportadora** (perfil novo, ligado a uma transportadora): vê só a tela **Motoristas** com os motoristas dela — pré-cadastrar (tela ou planilha "Baixar modelo"/"Upload"), **bloquear/desbloquear** (derruba o acesso na hora e para os SMS), **encerrar acessos** (celular perdido) e ver os aparelhos com acesso. Quem tem "Editar cadastros" vê todos, com filtro por transportadora.
- **Pré-cadastrado** (pelo gestor): no 1º acesso confirma o celular pelo código, confere os dados e aceita o termo.
- **Retenção (LGPD):** posições GPS mais antigas que **90 dias** (Configurações → Rastreamento) são apagadas automaticamente 1x por dia; códigos de acesso com mais de 1 dia e sessões encerradas/vencidas há mais de 30 dias também.
- O login da equipe continua no mesmo QR ("Sou da equipe"); os usuários do perfil Transportador continuam funcionando.

## Etiquetas QR (leitura pelo celular)

- **Coleta pelo QR (transportador/motorista):** retirada, carregamento e entrega já vêm **preenchidos com a programação** do container (etiqueta já ligada, ou ao digitar o número numa etiqueta nova). Quem lê só confere e altera o que estiver diferente; a alteração fica no log ("local de entrega alterado na leitura").

Rastreabilidade sem digitação posterior: a etiqueta vai **colada no container** e vale para **uma viagem**.

1. **Gerar** (menu *Etiquetas QR*; supervisor/admin): informe a quantidade. Cada etiqueta recebe um **token aleatório de 128 bits**, que vai na URL do QR e não pode ser "adivinhado", e um **código curto** impresso (ex.: `CC-7K3F9P`, sem 0/O/1/I/L).
2. **Imprimir** (impressora de etiquetas tipo Zebra, **tamanho ajustável**: modelos 50×25 até 100×150 mm ou medida livre):
   - **Pelo navegador:** cada etiqueta vira uma página no tamanho exato (`@page`). Na impressão, escolha a Zebra, o mesmo tamanho de papel, margens "Nenhuma" e escala 100%.
   - **Arquivo ZPL** (linguagem nativa da Zebra, 203/300/600 dpi): envie direto à impressora. O QR usa correção de erro M e sobe para Q/H quando a etiqueta tem espaço, aguentando até ~30% de sujeira ou risco.
3. **1ª leitura** (câmera do celular → página `/q/<token>`, **com login**): número do container (conferido pelo ISO 6346 e precisa estar **ativo**), temperatura (obrigatória em reefer) e data/hora (já vem "agora"). Salvar **liga a etiqueta ao container** e registra a leitura.
4. **Leituras seguintes:** a página já abre no container, pedindo só temperatura e data/hora. A tela mostra na hora se a leitura está dentro, acima ou abaixo da faixa, e o alerta aparece no sistema.
5. **Encerramento:** entregue ou cancelado o container, a etiqueta fica "encerrada" e não aceita novas leituras. Etiqueta danificada: numa etiqueta nova, informe o mesmo container e confirme a **substituição** (a antiga é cancelada). Supervisor também pode cancelar uma etiqueta com motivo.
6. **Excluir selecionadas:** marque uma ou mais etiquetas na lista e use **🗑 Excluir selecionadas**. Todas vão numa **única requisição**, qualquer que seja a quantidade (máx. 500). Só são excluídas as que **nunca foram usadas** (sem container e sem leituras). As usadas ficam como histórico e continuam podendo ser canceladas; a resposta informa quais foram mantidas e por quê. A exclusão é tudo ou nada: se algo mudar no meio, nada é apagado. Ela é irreversível e fica registrada no log. Se a etiqueta já foi impressa, confira se não está colada em algum container.

**Cada usuário vê só as suas etiquetas:** listar, imprimir (navegador e ZPL), marcar como impressa, cancelar e excluir valem apenas para as etiquetas dos lotes que a própria pessoa gerou. A regra é aplicada no servidor, então nem uma URL de impressão editada traz etiquetas de outra pessoa. Assim uma fábrica não imprime as etiquetas de outra. O administrador vê as dele por padrão e pode marcar "Ver de todos os usuários" (coluna "Gerada por"). **Ler o QR** continua aberto a qualquer operador logado, porque a etiqueta está no container.

**Controle de impressão:** cada etiqueta registra quantas vezes foi enviada à impressora, quando e por quem: no ZPL, ao baixar; no navegador, quando a janela de impressão fecha. O navegador não informa se a pessoa cancelou, então isso conta como enviada. Há o filtro "Ainda não impressas", e **reimprimir pede confirmação**, porque a cópia tem o mesmo QR.

**Registrar pelo código** (menu, ou `/leitura` no celular): se o QR não abrir (etiqueta riscada, ou IP do teste que mudou), digite o código curto impresso (`CC-7K3F9P`, com ou sem "CC-") e siga para a mesma tela.

**Confiança nos dados:** cada leitura grava quem registrou, a etiqueta usada, o horário informado e o horário real do registro. Leitura com horário digitado **mais de 2h antes** de chegar ao sistema aparece como **"lançada com atraso"** na ficha. Com o sistema em **https**, o celular pode enviar a **localização** da leitura (📍 na ficha). A mesma leitura nunca entra duas vezes.

**Endereço dentro do QR** (só em *Configurações → Etiquetas QR*, definido pelo administrador): toda impressão (navegador e ZPL) usa sempre esse endereço, lido no servidor. A tela de Etiquetas não pede endereço e bloqueia a impressão enquanto ele não estiver configurado. Sistema publicado: use o endereço https dele (ex.: `https://control-de-container.onrender.com`). Para **testar na rede local**, use o IP deste computador e a porta 5174 (ex.: `http://192.168.0.132:5174`), com o celular no mesmo Wi-Fi. O campo sugere os IPs da rede, e `localhost` não funciona no celular. **Ao publicar online, troque para o endereço https antes de imprimir**, porque etiquetas já impressas continuam apontando para o endereço antigo. ⚠ No teste local, o IP costuma ser dado pelo roteador (DHCP) e **muda** (ex.: trocar do cabo para o Wi-Fi mudou de `.132` para `.249`), e aí as etiquetas impressas param de abrir. Para testes longos, reserve um IP fixo para o computador no roteador; senão, use "Registrar pelo código".

## Telas

- **Login** (CCS · Container Control Solutions):
  - **Mostrar/ocultar senha:** botão com o ícone de olho (aberto para ver, cortado para esconder).
  - **"Lembrar meu login":** mantém a sessão por **30 dias** neste navegador. Sem essa opção, a sessão acaba ao fechar o navegador.
  - **Segurança:**
    - A senha **nunca** é guardada no navegador. Só o e-mail fica lembrado.
    - A sessão é um cookie **httpOnly**, que o JavaScript não lê, e **Secure** em produção.
    - O campo de senha é limpo depois do envio.
    - Salvar a senha fica a cargo do gerenciador de senhas do próprio navegador.
  - **Troca de senha:** quando a senha é redefinida, todas as sessões abertas daquela conta caem na hora, inclusive as lembradas. Quem trocou a própria senha continua logado na sessão atual.
  - **Bloqueio de tentativas:** só as tentativas **erradas** contam para o bloqueio (10 a cada 15 minutos por IP).
  - **Esqueci minha senha:** a pessoa informa o e-mail e recebe um link para criar uma nova senha.
    - A resposta é sempre a mesma, exista ou não a conta.
    - O link é de **uso único** e vale **30 minutos**. No banco fica só o hash do código.
    - Um pedido novo substitui o anterior. Há intervalo mínimo de 1 minuto enquanto houver link pendente e limite de pedidos por IP.
    - Redefinir a senha **derruba todas as sessões** da conta. Contas desativadas não recebem o link.
    - O administrador também pode mandar o link, pelo botão **"Enviar link de senha"** em Usuários.
    - O envio é feito pelo **Brevo** (`BREVO_API_KEY`, remetente `EMAIL_REMETENTE`), usando o **endereço do sistema** de Configurações → Etiquetas QR (ou `APP_URL`) para montar o link. Sem a chave, o e-mail não sai e o link aparece só no console do servidor.
- **Rastreamento por SMS** (Configurações → Rastreamento (SMS); vem **desligado**):
  - **Cadeia:** Etiqueta QR → Container → Usuário responsável → Celular. O celular é o do cadastro do usuário (Usuários → campo "Celular (SMS)"), gravado em formato internacional (+55…) e lido no momento de cada envio.
  - **Quem vira responsável:** quem **registra algo pelo QR** (vínculo, temperatura, coleta do transportador, entrada/saída da portaria), em qualquer perfil. Só abrir a página do QR para consultar não muda nada.
  - **Troca de responsável:** quando outra pessoa registra pelo QR, o rastreamento passa para ela na hora e ela recebe um SMS de aviso. O anterior **para de receber** e os links que ele já tinha **deixam de valer**. A troca fica no log de auditoria (ação RASTREIO).
  - **Pedidos de posição — padrão "só em trechos críticos"** (v1.1, para reduzir custo e volume de SMS): o sistema pede a posição quando
    - a **previsão estoura**: em trânsito, passou do horário planejado da próxima etapa (plano congelado da aba Etapas) além da tolerância de Configurações → Geral;
    - há **risco de prazo**: alerta aberto de risco de demurrage, risco de deadline, free time (demurrage) ou deadline;
    - o container está **parado**: em trânsito, as 2 últimas posições estão a até 500 m uma da outra com mais de **3 h** entre elas;
    - está **sem posição**: em trânsito, nenhuma posição há mais de **12 h** (checagem esparsa, repete a cada 12 h).
    Enquanto houver motivo (exceto "sem posição"), repete a cada **60 min**. No ponto de carregamento (container parado lá é o esperado) só vale o risco de prazo. Os tempos são configuráveis; cada SMS guarda o **motivo**.
  - **Intervalo personalizado** (opcional, Configurações → Rastreamento): a cada **30 min**; no ponto de carregamento, a cada **4 h** (configuráveis). Uma posição enviada pela leitura do QR também conta, e o próximo pedido passa a contar dali. Com o container entregue ou cancelado, os pedidos param.
  - **"Solicitar posição"** (aba Rastreamento da ficha, quem opera containers): manda o pedido na hora ao responsável — no máximo 1 pedido de posição a cada 5 min por container (contando os automáticos); fica no log.
  - **Link do SMS** (`/p/código`): abre sem login, mostra o container e tem o botão **"Enviar minha posição"**, que usa o GPS do celular em alta precisão. O link é de uso único, vale 12 h e só é aceito do responsável atual. No banco fica só o hash do código, e há limite de tentativas por IP.
  - **Aba "Rastreamento" da ficha:** mostra o responsável (celular mascarado), o próximo pedido, as posições com link para o mapa e cada SMS com a situação (enviado, simulado, falhou, sem celular).
  - **Envio:** feito pelo Brevo (mesma `BREVO_API_KEY`; remetente `SMS_REMETENTE`, até 11 letras). Precisa de **créditos de SMS** na conta Brevo. Os textos vão sem acento para caber em 1 SMS (160 caracteres). Sem a chave, o SMS não sai: é só simulado e aparece no console. Em caso de falha, tenta de novo em 5 min.
  - **Agendador:** roda a cada 1 minuto no próprio servidor. Por isso o serviço no Render precisa ficar sempre ligado (plano pago; o gratuito "dorme" sem acesso). A reserva de cada envio é idempotente, então duas rodadas simultâneas não duplicam SMS.

- **Home** (antes "Pátio"): **uma aba por região** ("Todas" + regiões + "Sem região" se houver fábrica sem região), com contagem de containers e de críticos em cada aba. Os indicadores do topo são os da aba escolhida, e a aba fica lembrada. Dentro da aba, containers por Ponto de Carregamento divididos em *A caminho da fábrica / Na fábrica / A caminho do porto*, com semáforo, barra da estadia, demurrage e temperatura. Atualiza a cada minuto.
- **Containers**: lista com filtros e cadastro. O símbolo de QR antes do número indica etiqueta QR vinculada; a caixa **"Sem QR code"** no cabeçalho mostra só os que ainda não têm (vale no Grid e na Tabela, fica lembrada).
  - **Cadastro por planilha:** o botão **"Upload"** (ao lado do "+ Novo") abre a janela com **"Baixar modelo"**, que gera um Excel (.xlsx) com as colunas, listas suspensas dos cadastros ativos (Pontos de Carregamento, armadores, produtos, locais) e uma aba de instruções. Na mesma janela, envie a planilha preenchida: primeiro mostra a conferência linha a linha (mesmas regras do cadastro na tela), e só grava as linhas válidas depois da confirmação. Só cadastra containers **novos** — número já ativo ou repetido na planilha é recusado, então reenviar o mesmo arquivo não duplica. **Obrigatórios** (com * no modelo): número, tipo, Ponto de Carregamento, armador, produto, locais de retirada, carregamento e entrega e coleta programada — linha com algum em branco é recusada com o nome do campo. Datas em dd/mm/aaaa hh:mm (Brasília); até 1.000 linhas e 5 MB por arquivo. **Uma requisição por etapa** (conferência e confirmação) e gravação **em lote** no servidor: uma transação só, cadastros lidos uma vez, distâncias do trajeto calculadas para o lote inteiro. Fica no log como IMPORTAR (e um CRIAR por container).
- **Ficha** do container no formato **lista + detalhe**:
  - **À esquerda,** a lista de containers: os ativos por padrão, com filtro de status e busca por container, navio ou rota. Trocar de container não recarrega a lista.
  - **À direita,** o cabeçalho com número, etapa, tipo e rota, a ação da próxima etapa, Editar e o menu ⋮ (desfazer ou cancelar).
  - **Faixas coloridas** do que exige ação agora: atraso na coleta, temperatura fora da faixa, leitura atrasada, estadia, demurrage e deadline.
  - **Seis indicadores:** ciclo estimado, distância total, ETA, folga do free time, estadia e deadline.
  - **Abas:** Visão geral (alertas abertos, prazos e dados), Etapas (Planejado × ETA × Realizado, ver abaixo), Trajeto, Temperatura (leitura manual e gráfico) e Histórico. A aba escolhida fica lembrada.
  - **Tela estreita:** mostra só o detalhe, com "← Containers".
  - **Aba Etapas:**
    - **Planejado:** é o plano congelado, gravado na primeira previsão completa do ciclo. Isso acontece no cadastro, ou quando o trajeto for completado depois, desde que o container ainda não tenha chegado ao carregamento. O plano parte da coleta programada, se houver, e **nunca muda**.
    - **ETA:** é a previsão atualizada com o que já aconteceu, a mesma da aba Trajeto. Aparece em vermelho, com "+Xh", quando passa do planejado.
    - **Realizado:** é o que foi registrado por um usuário ou de forma automática. Fica verde com ✓ quando está no prazo e vermelho com ⏱ quando atrasou ou está pendente depois do planejado. A tolerância é ajustável em *Configurações → Geral* ("Tolerância do no prazo nas etapas", padrão 60 min).
- **Filtros da tela de Containers (cabeçalho, ao lado de Grid / Tabela):** Região e Ponto de Carregamento, em listas suspensas com caixas de seleção.
  - Permitem marcar vários itens, e têm "Selecionar todos", "Limpar" e busca de ponto de carregamento.
  - Valem para os dois modelos (Grid e Tabela) e ficam lembrados.
  - Ao marcar regiões, a lista de pontos de carregamento mostra só os daquelas regiões.
  - No Grid, se o container aberto sair do filtro, abre o primeiro da lista filtrada.
- **Menu:** as seções Cadastros e Administração recolhem e expandem. O estado fica lembrado, e a seção da tela aberta fica sempre visível.
- **Previsão de container "Programado":** a simulação parte da **coleta programada**. Se ela não existir ou já tiver passado, parte de agora.
- **Alertas**: abertos e histórico. Sino no topo com o número de alertas não reconhecidos + bipe quando surge alerta crítico (consulta a cada 30 s).
- **Custo estimado**: custo de estadia e demurrage por **abas de Região** e, dentro delas, **abas de Ponto de Carregamento** (mais a "Visão geral"). Tem filtro de período (30/90 dias, 6/12 meses, mês atual/anterior, personalizado); indicadores; gráfico de tendência empilhado estadia × demurrage (por dia, semana ou mês, conforme o período); ranking por Ponto de Carregamento; **principais impactos** gerados automaticamente (estadia × demurrage, concentração por cliente e por armador, etapa em que o tempo foi perdido, estouros de meta, variação entre as metades do período, horas sem custo/h); detalhamento por container com tempo em cada trecho e exportação CSV (Excel).
  - O custo é lançado **no dia em que ocorre**: cada diária de demurrage no dia cobrado, cada hora além da meta de estadia no dia em que passou. Containers ativos contam até agora; cancelados não entram.
  - A estadia usa o custo/h **gravado no container**. Se o custo/h do Ponto de Carregamento for cadastrado depois, salve o cadastro com "Aplicar também aos containers em andamento" (ou o supervisor ajusta em *Editar → Prazos deste container*, na ficha). Horas sem valor aparecem como "sem R$/h".
  - **Moedas**: estadia em R$ e demurrage na moeda do armador. Com a cotação informada em *Configurações* (US$ e €), tudo é consolidado em R$. Sem cotação, cada moeda aparece separada, em gráficos separados, sem somar moedas diferentes.
- **Cadastros**: Regiões, Locais e Tipos de local, Ponto de Carregamento, Armadores, Produtos. Cadastro já usado não pode ser excluído, só desativado.
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
| Cancelar e excluir etiquetas | inutilizar as próprias etiquetas; excluir as nunca usadas | Supervisor |
| Registrar leituras pelo celular | ligar etiqueta e registrar temperatura pelo QR/código | Supervisor, Operador |
| Ver log de auditoria | consultar o histórico de alterações | Supervisor |

- **Administrador:** acesso total, não configurável. Usuários, permissões, integração e as regras de Configurações são **exclusivos do administrador** e não podem ser liberados, para ninguém se trancar fora nem se autopromover.
- **Visualização:** por padrão, só consulta.
- **Portaria:** acessa as telas do QR e a **Home só para consulta**. O menu mostra só Home e Registrar pelo código; não há alertas nem ficha do container, e o servidor recusa o resto da API. Ao ler a etiqueta, escolhe **Entrada** ou **Saída** do ponto de carregamento e informa a temperatura, se o container for reefer. A tela já sugere o movimento pela etapa atual. Regras:
  - **Entrada** registra a chegada (ex.: "Chegada no armazém") e abre a estadia.
  - **Saída** registra a saída e fecha a estadia.
  - **Etapas pendentes são completadas com o mesmo horário.** Na entrada, completa a coleta. Na saída, completa ovação e liberação. Essas etapas ficam marcadas no histórico como "completada pela portaria".
  - **Saída sem entrada é recusada.** Registre a entrada primeiro; o horário pode ser ajustado.
  - **Etiqueta nova:** a portaria digita o número do container, que precisa estar cadastrado, e a etiqueta é ligada.
  - **Depois da saída,** o QR volta a registrar só temperatura.
- **Transportador:** usa **só as telas do QR** no celular: a leitura da etiqueta e "Registrar pelo código", com botão Sair. Qualquer outra tela redireciona para "Registrar pelo código", e o servidor recusa as demais rotas da API (403). Ao ler a etiqueta de um container **ainda não coletado**, o transportador:
  - escolhe **onde retirou o container**: Tipo (só tipos de retirada, como Porto / Terminal e Terminal Ferroviário) > Local;
  - informa a data/hora (vem preenchida com o horário atual);
  - informa a temperatura, se o container for reefer.

  O sistema grava o local de retirada real (substituindo o previsto, se houver), registra a **etapa de coleta** na linha do tempo (ex.: "Coleta ferroviária") e liga a etiqueta, tudo numa única transação. Se o número digitado **não estiver cadastrado**, a tela pede tipo do container, Ponto de Carregamento, armador e produto (reefer), e o transportador **cadastra o container já coletado**. Depois da coleta, as leituras seguintes do QR registram só a temperatura. Tudo fica no log de auditoria com o e-mail do transportador.
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

## Versões e rollback

- **Produção = branch `main`** (o Render publica a cada push nela). Cada versão publicada ganha uma **tag** (`v1.0.0`, `v1.1.0`…); o histórico está no `CHANGELOG.md`.
- **Versão nova = branch própria** (ex.: `versao-1.1`). Pode ser enviada ao GitHub sem afetar a produção; só vai ao ar quando for juntada na `main` (com aprovação), e aí recebe a tag.
- **Qual versão está no ar:** rodapé do menu lateral ou `GET /api/saude` (campo `versao`).
- **Migrações de banco só com acréscimos** (colunas/tabelas novas, nada apagado ou renomeado): assim a versão anterior continua funcionando com o banco já migrado, e voltar o código não exige mexer no banco.

**Rollback (voltar para a versão anterior):**
1. **Mais rápido:** no Render → serviço → *Events/Deploys* → no deploy da versão anterior, **Rollback**. Volta o código em segundos, sem build. Atenção: o próximo push na `main` publica de novo o que estiver lá — faça o passo 2 em seguida.
2. **Definitivo (Git):** criar na `main` um commit que desfaz a versão (`git revert` do merge, ex.: `git revert -m 1 <merge>`) e dar push. Não usar `git push --force`.
3. **Banco:** normalmente nada a fazer (migração só com acréscimos). **Voltando da 1.1 para a 1.0:** antes, rode `scripts/rollback-1.0-antes.sql` no banco (a 1.0 não conhece o perfil Gestor da transportadora: os gestores viram Visualização e ficam desativados, mantendo o vínculo com a transportadora). Ao republicar a 1.1, rode `scripts/rollback-1.0-desfazer.sql`. Testado: a 1.0 funciona sobre o banco da 1.1 com esse passo. Links de posição enviados a motoristas deixam de valer na 1.0. **Voltando da 1.2 para a 1.1:** antes, rode `scripts/rollback-1.2-antes.sql` (a 1.1 não conhece a função Parada: os tipos "Ponto Fiscal" ficam como carregamento inativo, marcados, e os locais de parada inativos; as paradas dos containers ficam guardadas). Ao republicar a 1.2, rode `scripts/rollback-1.2-desfazer.sql`. Testado: sem o script a 1.1 quebra em Locais/Tipos; com ele, funciona 100%. Antes de publicar qualquer migração que altere/remova dados, fazer **backup** do banco (pg_dump) e planejar o retorno.
4. Conferir `/api/saude` → `versao` e testar o login.

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
