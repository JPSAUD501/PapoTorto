# Fossabot Voting Setup (Twitch + YouTube)

Este projeto usa voto da plateia via Fossabot no endpoint Convex:

- `GET /fossabot/vote?vote=1`
- `GET /fossabot/vote?vote=2`

Cada pessoa tem **1 voto por rodada** (pode trocar de 1 para 2 ou 2 para 1).

## Como funciona

1. Fossabot chama o endpoint HTTP do Convex.
2. O backend lê os headers do Fossabot:
- `x-fossabot-message-userprovider` (ex: twitch/youtube)
- `x-fossabot-message-userproviderid` (id único da plataforma)
3. O voto é salvo com chave única `provider:providerid`, então não duplica voto por usuário na mesma rodada.
4. Troca de voto só move o voto existente.

## Pré-requisitos

Defina no ambiente do Convex:

- `FOSSABOT_VALIDATE_REQUESTS=true` (recomendado)

Quando `true`, o endpoint valida cada chamada usando:
- `x-fossabot-validateurl` (ou token fallback)

## URL base do endpoint

Use o domínio HTTP do seu deployment Convex, por exemplo:

- `https://<seu-deployment>.convex.site/fossabot/vote?vote=1`
- `https://<seu-deployment>.convex.site/fossabot/vote?vote=2`

## Configuração no Fossabot

Referência oficial:
- https://docs.fossabot.com/variables/customapi/

Crie 2 comandos/atalhos (ou keywords) que chamem o `customapi`:

1. Voto no lado 1:
```txt
$(customapi https://<seu-deployment>.convex.site/fossabot/vote?vote=1)
```

2. Voto no lado 2:
```txt
$(customapi https://<seu-deployment>.convex.site/fossabot/vote?vote=2)
```

## Twitch e YouTube

No Fossabot, habilite os dois canais/plataformas (Twitch e YouTube) para os comandos.
O backend já diferencia usuários por plataforma no identificador (`twitch:<id>`, `youtube:<id>`), evitando colisão.

## Comportamento esperado no chat

- Usuário vota 1: `voto 1 registrado`
- Usuário muda para 2: `voto alterado para 2`
- Usuário repete 2: `voto 2 ja registrado`
- Fora da janela de voto: `votacao indisponivel`

## Observações

- O site não envia mais voto por clique.
- A contagem da plateia no frontend e broadcast passa a refletir apenas votos recebidos via Fossabot.
- A janela de voto humano é dinâmica: 120s sem audiência real, 30s com audiência real.
