# Izzy-Bot

Bot de WhatsApp feito em Node.js usando a biblioteca Baileys.

O Izzy-Bot é um bot simples e rápido feito para rodar no Termux ou Linux, com suporte a vários comandos e integração com yt-dlp para download de mídias.

---

# Funções

• Download de vídeos  
• Download de músicas  
• Sistema de comandos no WhatsApp  
• Conexão via QR Code  
• Suporte a Termux  
• Execução com PM2  

---

# Requisitos

Antes de instalar o bot você precisa ter:

• Node.js  
• Git  
• FFmpeg  
• yt-dlp  

---

# Instalação no Termux

Atualize os pacotes:

```bash
pkg update && pkg upgrade
```

Instale as dependências:

```bash
pkg install nodejs git ffmpeg yt-dlp
```

Instale o PM2:

```bash
npm install -g pm2
```

---

# Clonar o repositório

```bash
git clone https://github.com/aiku-afk/Izzy-Bot.git
```

Entre na pasta:

```bash
cd Izzy-Bot
```

Instale as dependências do bot:

```bash
npm install
```

---

# Iniciar o bot

Execute:

```bash
node bot.js
```

Vai aparecer um QR Code no terminal.

Abra o WhatsApp > Dispositivos conectados > Conectar dispositivo  
Escaneie o QR Code.

---

# Rodar com PM2 (recomendado)

Para deixar o bot rodando 24h:

```bash
pm2 start bot.js --name izzybot
```

Ver status:

```bash
pm2 status
```

Parar bot:

```bash
pm2 stop izzybot
```

Reiniciar:

```bash
pm2 restart izzybot
```

---

# Atualizar o bot

```bash
git pull
npm install
pm2 restart izzybot
```

---

# Importante

Nunca envie sua pasta de sessão do WhatsApp para o GitHub.

Crie um `.gitignore` com:

```
session
node_modules
```

---

# Dono do bot

Numero do dono:

```
+55 84 9146-7507
```

---

# Créditos

Desenvolvido por:

ynokas.

Bibliotecas usadas:

• Baileys  
• Node.js  
• FFmpeg  
• yt-dlp  

---

# Aviso

Este projeto é apenas para fins educacionais.  
Use por sua própria responsabilidade.
