/**
 * index.js - IZZY BOT
 * Mantido conforme seu código; apenas adaptei execução de yt-dlp para usar o binário do sistema.
 *
 * Requisitos:
 * - package.json com "type": "module"
 * - ffmpeg instalado
 * - yt-dlp instalado no sistema (ex: `pkg install yt-dlp` no Termux, ou apt no Debian)
 * - npm install (dependências: @whiskeysockets/baileys pino qrcode-terminal node-webpmux p-limit file-type ...)
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  DisconnectReason
} from "@whiskeysockets/baileys"

import pino from "pino"
import fs from "fs"
import { exec as _exec, spawn } from "child_process"
import { promisify } from "util"
import qrcode from "qrcode-terminal"
import Webp from "node-webpmux"
import path from "path"
import os from "os"
import { fileTypeFromBuffer } from "file-type"
import pLimit from "p-limit"

const exec = promisify(_exec)
const writeFile = promisify(fs.writeFile)
const readFile = promisify(fs.readFile)
const unlink = async (p) => { try { await promisify(fs.unlink)(p) } catch(e){} }

// ===== CONFIG FILE =====
const CONFIG_FILE = "./botconfig.json"
let config = {
  prefix: "#",
  botName: "IZZY BOT",
  menuImage: null,           // path to saved menu image
  disabledGroups: {}        // map: groupJid -> true (disabled)
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf8")
      const parsed = JSON.parse(raw)
      config = { ...config, ...parsed }
    } else {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
    }
  } catch (e) {
    console.error("Falha ao carregar config:", e)
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
  } catch (e) {
    console.error("Falha ao salvar config:", e)
  }
}

// load at startup
loadConfig()

// ====== RUNTIME VARS (backwards-compatible) ======
let PREFIX = config.prefix || "#"
let BOT_NAME = config.botName || "IZZY BOT"

// ====== OWNER (COLOQUE SEU LID AQUI) ======
const OWNER_LID = "90882111979730@lid"

// ======= CONTROLES / LIMITES (conforme solicitado) =======
const GLOBAL_CONCURRENCY = 4                 // máx ffmpeg concorrentes no total
const USER_CONCURRENT_STICKERS = 5          // quantas figurinhas um usuário pode processar ao mesmo tempo
const USER_QUEUE_LIMIT = 10                 // máximo de items enfileirados por usuário (fotos+vídeos)
const STICKER_SEND_DELAY_MS = 800           // pausa entre envios de stickers para evitar flood
const COOLDOWN_MS = 5000                    // cooldown de 5 segundos por usuário
const USER_RATE_WINDOW_MS = 60_000          // janela de medição para rate limit (1 minuto)
const USER_RATE_LIMIT = 30                  // quantos pedidos por usuário por janela (ajustável)
const TEMP_BLOCK_MS = 60_000                // bloqueio temporário se abuse (1 minuto)

const limit = pLimit(GLOBAL_CONCURRENCY)

// estado por usuário
const userQueues = new Map() // userId -> { count, videoCount, lastRequestTs, timestamps[], blockedUntil }

function ensureUserEntry(user) {
  if (!userQueues.has(user)) userQueues.set(user, { count: 0, videoCount: 0, lastRequestTs: 0, timestamps: [], blockedUntil: 0 })
  return userQueues.get(user)
}

function nowTmp(name) {
  const uid = `${Date.now()}_${Math.floor(Math.random()*10000)}`
  return path.join(os.tmpdir(), `${name}_${uid}`)
}

async function bufferFromStream(stream) {
  let buffer = Buffer.from([])
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk])
  return buffer
}

// baixa buffer da mídia (quoted ou attach)
async function downloadQuotedBuffer(mediaObject) {
  if (!mediaObject) return null
  const key = Object.keys(mediaObject)[0]
  const media = mediaObject[key]
  const type = (key.includes('image') && 'image') ||
               (key.includes('video') && 'video') ||
               (key.includes('sticker') && 'sticker') ||
               (key.includes('audio') && 'audio') ||
               'file'
  const stream = await downloadContentFromMessage(media, type)
  return await bufferFromStream(stream)
}

// ---------------------------------------------------------
//  FORÇAR ESCALA EXATA 512x512 (esticada)
// ---------------------------------------------------------

const STRETCH_512_FILTER = "scale=512:512,setsar=1"

async function createStickerFromImageBuffer(buffer) {
  const ft = await fileTypeFromBuffer(buffer).catch(()=>null)
  const ext = (ft && ft.ext) ? ft.ext : 'jpg'
  const inFile = nowTmp("in_img") + "." + ext
  const outFile = nowTmp("out_stk") + ".webp"
  await writeFile(inFile, buffer)
  const cmd = `ffmpeg -y -i ${inFile} -vf "${STRETCH_512_FILTER}" -vcodec libwebp -lossless 0 -q:v 70 -preset default -loop 0 -an -fps_mode vfr ${outFile}`
  await exec(cmd)
  const result = await readFile(outFile)
  await unlink(inFile)
  await unlink(outFile)
  return result
}

async function createStickerFromVideoBuffer(buffer, maxSeconds = 6) {
  const ft = await fileTypeFromBuffer(buffer).catch(()=>null)
  const ext = (ft && ft.ext) ? ft.ext : 'mp4'
  const inFile = nowTmp("in_vid") + "." + ext
  const outFile = nowTmp("out_vid_stk") + ".webp"
  await writeFile(inFile, buffer)
  const cmd = `ffmpeg -y -i ${inFile} -t ${maxSeconds} -vf "${STRETCH_512_FILTER},fps=15" -vcodec libwebp -lossless 0 -q:v 55 -preset default -loop 0 -an -fps_mode vfr ${outFile}`
  await exec(cmd)
  const result = await readFile(outFile)
  await unlink(inFile)
  await unlink(outFile)
  return result
}

async function stickerBufferToPng(buffer) {
  const inFile = nowTmp("in_stk") + ".webp"
  const outFile = nowTmp("out_png") + ".png"
  await writeFile(inFile, buffer)
  await exec(`ffmpeg -y -i ${inFile} ${outFile}`)
  const res = await readFile(outFile)
  await unlink(inFile)
  await unlink(outFile)
  return res
}

// NOTE: função sticker -> mp4 removida por solicitação (não existe mais aqui)

async function videoBufferToMp3(buffer) {
  const inFile = nowTmp("in_vid") + ".mp4"
  const outFile = nowTmp("out_audio") + ".mp3"
  await writeFile(inFile, buffer)
  await exec(`ffmpeg -y -i ${inFile} -vn -ar 44100 -ac 2 -b:a 192k ${outFile}`)
  const res = await readFile(outFile)
  await unlink(inFile)
  await unlink(outFile)
  return res
}

function buildExif(packname, publisher = "") {
  const json = {
    "sticker-pack-id": "izzy-pack",
    "sticker-pack-name": packname,
    "sticker-pack-publishers": publisher,
    "emojis": ["✨"]
  }
  const jsonBuffer = Buffer.from(JSON.stringify(json))
  const exifAttr = Buffer.from([
    0x49,0x49,0x2A,0x00,0x08,0x00,0x00,0x00,
    0x01,0x00,0x41,0x57,0x07,0x00,
    jsonBuffer.length & 0xff, (jsonBuffer.length >> 8) & 0xff, (jsonBuffer.length >> 16) & 0xff, (jsonBuffer.length >> 24) & 0xff,
    0x16,0x00,0x00,0x00
  ])
  return Buffer.concat([exifAttr, jsonBuffer])
}

async function addExifToWebpBuffer(webpBuffer, packname) {
  const img = new Webp.Image()
  await img.load(webpBuffer)
  img.exif = buildExif(packname, "")
  return await img.save(null)
}

async function ensureFfmpegAvailable() {
  try { await exec("ffmpeg -version"); return true } catch (e) { return false }
}

const fofas = [
  "🌸 Ai que fofo! Já vou cuidar disso...",
  "✨ Hehe, que gracinha — processando com carinho!",
  "🐾 UwU, espera só um tiquinho que vai ficar lindo!",
  "💖 Tô preparando com muito amor...",
  "🌈 Preparando sua coisinha fofinha agora!"
]

function pickFofa() {
  return fofas[Math.floor(Math.random() * fofas.length)]
}

let __reconnecting = false
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function gatherMediaObjects(message, quoted) {
  const mediaObjs = []

  if (quoted && typeof quoted === "object") {
    for (const key of Object.keys(quoted)) {
      if (key.includes("image") || key.includes("video") || key.includes("sticker") || key.includes("audio")) {
        const obj = {}
        obj[key] = quoted[key]
        mediaObjs.push(obj)
      }
    }
  }

  if (message.imageMessage) mediaObjs.push({ imageMessage: message.imageMessage })
  if (message.videoMessage) mediaObjs.push({ videoMessage: message.videoMessage })
  if (message.stickerMessage) mediaObjs.push({ stickerMessage: message.stickerMessage })
  if (message.audioMessage) mediaObjs.push({ audioMessage: message.audioMessage })

  return mediaObjs
}

/**
 * runYtDlpBinary
 * Usa o yt-dlp do sistema (binário). Retorna Promise que resolve com caminho do arquivo baixado.
 * - mode: 'mp3' ou 'mp4'
 * - outPattern: caminho com %(ext)s (ex: /tmp/yt_1234.%(ext)s)
 */
function runYtDlpBinary(url, mode, outPattern) {
  return new Promise((resolve, reject) => {
    const args = []
    if (mode === 'mp3') {
      args.push('-f','bestaudio','--extract-audio','--audio-format','mp3','--audio-quality','0','-o', outPattern, url)
    } else {
      // mp4 bestvideo+bestaudio
      args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '-o', outPattern, url)
    }
    const p = spawn('yt-dlp', args)
    let stderr = ''
    p.stdin?.end()
    p.stderr?.on('data', d => stderr += d.toString())
    p.on('error', err => reject(err))
    p.on('close', code => {
      if (code === 0) resolve() 
      else reject(new Error(`yt-dlp exit code ${code}\n${stderr}`))
    })
  })
}

async function startBot() {

  const ffmpegOk = await ensureFfmpegAvailable()
  if (!ffmpegOk) console.error("FFmpeg não encontrado. Instale ffmpeg e reinicie o bot.")

  const { state, saveCreds } = await useMultiFileAuthState("./session")
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: state,
    markOnlineOnConnect: true,
    syncFullHistory: false
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === "open") {
      console.clear()
      console.log("🔥 IZZY BOT ONLINE COM SUCESSO")
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        if (!__reconnecting) {
          __reconnecting = true
          console.log("🔄 Reconectando automaticamente em 5s...")
          setTimeout(() => { __reconnecting = false; startBot() }, 5000)
        } else {
          console.log("🔄 Reconexão agendada já em andamento...")
        }
      } else {
        console.log("Sessão encerrada. Apague 'session' e reconecte.")
      }
    }
  })

  // helper para reagir (emoji)
  async function reactEmoji(fromJid, emoji, originalMsg) {
    try {
      await sock.sendMessage(fromJid, { react: { text: emoji, key: originalMsg.key } })
    } catch (e) {
      // falhar na reação NÃO deve quebrar o bot
    }
  }

  // helper para enviar reply (quoted)
  async function replyQuoted(fromJid, contentObj, originalMsg, extraOptions = {}) {
    try {
      await sock.sendMessage(fromJid, contentObj, { quoted: originalMsg, ...extraOptions })
    } catch (e) {
      // se falhar, tente sem quoted (fallback)
      try { await sock.sendMessage(fromJid, contentObj) } catch {}
    }
  }

  // MAIN MESSAGES HANDLER
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    const msg = messages[0]
    if (!msg || !msg.message) return
    if (msg.key.fromMe) return

    try {
      let message = msg.message
      if (message.ephemeralMessage) message = message.ephemeralMessage.message
      if (message.viewOnceMessage) message = message.viewOnceMessage.message

      const body =
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ""

      if (!body) return

      const text = body.trim()
      const command = text.startsWith(PREFIX) ? text.slice(PREFIX.length).split(" ")[0].toLowerCase() : ""
      const args = text.split(" ").slice(1)

      const from = msg.key.remoteJid
      const isGroup = from.endsWith("@g.us")
      const sender = msg.key.participant || from
      const senderId = msg.key.participant || from
      const isOwner = senderId === OWNER_LID

      // if group is disabled and sender is not owner, ignore commands
      if (isGroup && config.disabledGroups && config.disabledGroups[from] && !isOwner) {
        // silently ignore to keep group quiet when disabled
        return
      }

      const context =
        message.extendedTextMessage?.contextInfo ||
        message?.imageMessage?.contextInfo ||
        message?.videoMessage?.contextInfo ||
        {}
      const quoted = context?.quotedMessage || null

      const userId = sender
      const userEntry = ensureUserEntry(userId)
      const now = Date.now()

      // IMPORTANT: rate-limit / cooldown / block apply ONLY if it's a command (starts with PREFIX)
      if (command) {
        if (userEntry.blockedUntil && now < userEntry.blockedUntil) {
          const remaining = Math.ceil((userEntry.blockedUntil - now)/1000)
          await replyQuoted(from, { text: `🚫 Você está temporariamente bloqueado por uso excessivo. Tente novamente em ${remaining}s.` }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }

        userEntry.timestamps = (userEntry.timestamps || []).filter(t => now - t <= USER_RATE_WINDOW_MS)
        if ((userEntry.timestamps || []).length >= USER_RATE_LIMIT) {
          userEntry.blockedUntil = now + TEMP_BLOCK_MS
          await replyQuoted(from, { text: `🚫 Muitos pedidos detectados — bloqueio temporário de ${Math.ceil(TEMP_BLOCK_MS/1000)}s para evitar spam.` }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        userEntry.timestamps.push(now)

        if (now - (userEntry.lastRequestTs || 0) < COOLDOWN_MS) {
          const wait = Math.ceil((COOLDOWN_MS - (now - userEntry.lastRequestTs))/1000)
          await replyQuoted(from, { text: `⏳ Calma aí, @${sender.split("@")[0]} — espere ${wait}s antes do próximo comando.`, mentions: [sender] }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        userEntry.lastRequestTs = now
      }

      // MENU (case-insensitive for "Izzy")
      if (text.toLowerCase() === "izzy" || command === "menu") {
        // reaction 🎀
        await reactEmoji(from, "🎀", msg)

        const menu = `
┏═•✭･ﾟ✧*･ﾟ| ⊱✿⊰ |*✭˚･ﾟ✧･ﾟ•═┓
┣⋆⃟ۣۜ᭪➣ 𖡦 𝐈𝐍𝐅𝐎𝐑𝐌𝐀𝐂𝐎𝐄𝐒 【✨】
┗═•✭･ﾟ✧*･ﾟ| ⊱✿⊰ |*✭˚･ﾟ✧･ﾟ•═┛
┃╭━━─ ≪ •❈• ≫ ─━━╮
┃╎  *Olá @${sender.split("@")[0]} 👋*
┃╎ ✯ *Bot*: ${BOT_NAME}
┃╎ ✯ *Modo*: ${isGroup ? "Grupo" : "Privado"}
┃╎ ✯ *Prefixo*: ${PREFIX}
┃╎ ✯ *Figurinha*: Animada ✔
┃╎ ✯ *Vídeo máximo p/ fig*: 6 segundos
┃╰━━─ ≪ •❈• ≫ ─━━╯

┏═•✭･ﾟ✧*･ﾟ| ⊱✿⊰ |*✭˚･ﾟ✧･ﾟ•═┓
┣⋆⃟ۣۜ᭪➣ 𖡦 𝐃𝐎𝐍𝐎 【👑】
┗═•✭･ﾟ✧*･ﾟ| ⊱✿⊰ |*✭˚･ﾟ✧･ﾟ•═┛
┃╭━━─ ≪ •❈• ≫ ─━━╮
┃╎❀ ${PREFIX}set-prefix <novo_prefixo> → (Apenas dono)
┃╎❀ ${PREFIX}set-bot-name <novo_nome> → (Apenas dono)
┃╎❀ ${PREFIX}set-menu-image → (Apenas dono; responda ou anexe imagem)
┃╎❀ ${PREFIX}off → Desliga o bot neste grupo (Apenas dono)
┃╎❀ ${PREFIX}on → Liga o bot neste grupo (Apenas dono)
┃╎❀ ${PREFIX}meu-lid → Mostra seu LID (qualquer um pode usar)
┃╰━━─ ≪ •❈• ≫ ─━━╯

┏═•✭･ﾟ✧*･ﾟ| ⊱✿⊰ |*✭˚･ﾟ✧･ﾟ•═┓
┣⋆⃟ۣۜ᭪➣ 𖡦 𝐅𝐈𝐆𝐔𝐑𝐈𝐍𝐇𝐀𝐒 【🖼】
┗═•✭･ﾟ✧*･ﾟ| ⊱✿⊰ |*✭˚･ﾟ✧･ﾟ•═┛
┃╭━━─ ≪ •❈• ≫ ─━━╮
┃╎❀ ${PREFIX}s → Criar figurinha (foto ou vídeo até 6s)
┃╎❀ ${PREFIX}take → Renomear figurinha com seu nome
┃╎❀ ${PREFIX}rename nome → Renomear pack manualmente
┃╎❀ ${PREFIX}toimg → Sticker para imagem
┃╎❀ ${PREFIX}attp texto → Sticker de texto
┃╎❀ ${PREFIX}packinfo → Info do pack
┃╰━━─ ≪ •❈• ≫ ─━━╯

┏═•✭･ﾟ✧*･ﾟ| ⊱✿⊰ |*✭˚･ﾟ✧･ﾟ•═┓
┣⋆⃟ۣۜ᭪➣ 𖡦 𝐌𝐈𝐃𝐈𝐀 【📡】
┗═•✭･ﾟ✧*･ﾟ| ⊱✿⊰ |*✭˚･ﾟ✧･ﾟ•═┛
┃╭━━─ ≪ •❈• ≫ ─━━╮
┃╎❀ ${PREFIX}tomp3 → Vídeo para MP3
┃╎❀ ${PREFIX}crop → Cortar imagem quadrada
┃╎❀ ${PREFIX}wm nome → Marca d’água
┃╎❀ ${PREFIX}ytmp3 <link> → Baixar áudio do YouTube
┃╎❀ ${PREFIX}ytmp4 <link> → Baixar vídeo do YouTube
┃╎❀ ${PREFIX}toimg → Sticker para imagem
┃╎❀ ${PREFIX}r @usuário → Envia a foto do usuário marcado
┃╰━━─ ≪ •❈• ≫ ─━━╯
┗═•✭･ﾟ✧*･ﾟ| ⊱✿⊰ |*✭˚･ﾟ✧･ﾟ•═┛
`

        // if menu image saved, send image with caption; otherwise send text
        try {
          if (config.menuImage && fs.existsSync(config.menuImage)) {
            await replyQuoted(from, { image: fs.readFileSync(config.menuImage), caption: menu }, msg)
          } else {
            await replyQuoted(from, { text: menu, mentions: [sender] }, msg)
          }
        } catch (e) {
          // fallback to text
          await replyQuoted(from, { text: menu, mentions: [sender] }, msg)
        }

        return
      }

      // PACKINFO
      if (command === "packinfo") {
        await replyQuoted(from, { text: "📦 Pack padrão:\nID: izzy-pack\nPublisher: vazio\n(✨ Tudo fofinho!)" }, msg)
        await reactEmoji(from, "✅", msg)
        return
      }

      // PREFIXO - responde qual o prefixo atual
      if (command === "prefixo") {
        await replyQuoted(from, { text: `✨ O prefixo atual é: *${PREFIX}*` }, msg)
        await reactEmoji(from, "✅", msg)
        return
      }

      // ANIME (local placeholder)
      if (command === "anime") {
        if (!args[0]) {
          await replyQuoted(from, { text: "Use: #anime <nome>" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        await replyQuoted(from, { text: `🎌 Resultado para: ${args.join(" ")}\n(Sistema local)` }, msg)
        await reactEmoji(from, "✅", msg)
        return
      }

      // ============================
      // MEU-LID (qualquer pessoa)
      // ============================
      if (command === "meu-lid") {
        const lid = senderId
        await replyQuoted(from, { text: `🔎 Seu LID:\n\n${lid}` }, msg)
        await reactEmoji(from, "✅", msg)
        return
      }

      // ============================
      // SET-PREFIX (apenas dono) -> persistente
      // ============================
      if (command === "set-prefix") {
        if (!isOwner) {
          await replyQuoted(from, { text: "🔒 Apenas o dono pode usar #set-prefix." }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        const novo = args[0]
        if (!novo || novo.length === 0) {
          await replyQuoted(from, { text: "Use: #set-prefix <novo_prefixo>\nEx: #set-prefix !" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        PREFIX = novo
        config.prefix = PREFIX
        saveConfig()
        await replyQuoted(from, { text: `✅ Prefixo alterado para: *${PREFIX}*` }, msg)
        await reactEmoji(from, "✅", msg)
        return
      }

      // ============================
      // SET-BOT-NAME (apenas dono) -> persistente
      // ============================
      if (command === "set-bot-name") {
        if (!isOwner) {
          await replyQuoted(from, { text: "🔒 Apenas o dono pode usar #set-bot-name." }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        const novoNome = args.join(" ")
        if (!novoNome) {
          await replyQuoted(from, { text: "Use: #set-bot-name <novo_nome>" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        BOT_NAME = novoNome
        config.botName = BOT_NAME
        saveConfig()
        await replyQuoted(from, { text: `✅ Nome do bot alterado para: *${BOT_NAME}*` }, msg)
        await reactEmoji(from, "✅", msg)
        return
      }

      // ============================
      // SET-MENU-IMAGE (apenas dono) -> persistente
      // ============================
      if (command === "set-menu-image") {
        if (!isOwner) {
          await replyQuoted(from, { text: "🔒 Apenas o dono pode usar #set-menu-image." }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }

        // image could be quoted or attached
        const imgObj = quoted?.imageMessage ? { imageMessage: quoted.imageMessage } : (message.imageMessage ? { imageMessage: message.imageMessage } : null)
        if (!imgObj) {
          await replyQuoted(from, { text: "Responda uma imagem com #set-menu-image ou anexe a imagem com a legenda." }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }

        try {
          const buf = await downloadQuotedBuffer(imgObj)
          const savePath = path.join(process.cwd(), "menu_image.jpg")
          fs.writeFileSync(savePath, buf)
          config.menuImage = savePath
          saveConfig()
          await replyQuoted(from, { text: "✅ Imagem do menu atualizada com sucesso." }, msg)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro ao salvar menu image:", e)
          await replyQuoted(from, { text: "❌ Falha ao salvar imagem do menu." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // OFF / ON (apenas dono) -> persistente per-group
      // ============================
      if (command === "off" || command === "on") {
        if (!isOwner) {
          await replyQuoted(from, { text: "🔒 Apenas o dono pode ligar/desligar o bot no grupo." }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        if (!isGroup) {
          await replyQuoted(from, { text: "Use esse comando dentro de um grupo." }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        if (command === "off") {
          config.disabledGroups = config.disabledGroups || {}
          config.disabledGroups[from] = true
          saveConfig()
          await replyQuoted(from, { text: "✅ Bot desativado neste grupo." }, msg)
          await reactEmoji(from, "✅", msg)
        } else {
          if (config.disabledGroups && config.disabledGroups[from]) {
            delete config.disabledGroups[from]
            saveConfig()
          }
          await replyQuoted(from, { text: "✅ Bot ativado neste grupo." }, msg)
          await reactEmoji(from, "✅", msg)
        }
        return
      }

      // ============================
      // STICKER: #s
      // ============================
      if (command === "s") {
        const mediaObjs = gatherMediaObjects(message, quoted)
        if (!mediaObjs || mediaObjs.length === 0) {
          await replyQuoted(from, { text: `${pickFofa()}\n\n💖 Responda a imagem(s) ou vídeo(s) com #s ou envie com legenda #s — posso processar até ${USER_CONCURRENT_STICKERS} por vez!`, mentions: [sender] }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }

        const toProcess = mediaObjs.slice(0, USER_CONCURRENT_STICKERS)

        if ((userEntry.count || 0) + toProcess.length > USER_QUEUE_LIMIT) {
          await replyQuoted(from, { text: `⚠️ Você já tem muitos pedidos (máx ${USER_QUEUE_LIMIT}). Tente reduzir a quantidade por vez.` }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }

        const videoCountInBatch = toProcess.filter(mo => Object.keys(mo)[0].includes("video")).length
        if ((userEntry.videoCount || 0) + videoCountInBatch > USER_CONCURRENT_STICKERS) {
          await replyQuoted(from, { text: `⚠️ Você pode processar no máximo ${USER_CONCURRENT_STICKERS} vídeos ao mesmo tempo.` }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }

        await replyQuoted(from, { text: `${pickFofa()}\n\n🎬 Preparando ${toProcess.length} figurinha(s) pra você...`, mentions: [sender] }, msg)
        await reactEmoji(from, "🎀", msg)

        userEntry.count = (userEntry.count || 0) + toProcess.length
        userEntry.videoCount = (userEntry.videoCount || 0) + videoCountInBatch

        for (let i = 0; i < toProcess.length; i++) {
          const mediaObj = toProcess[i]
          limit(async () => {
            try {
              const buf = await downloadQuotedBuffer(mediaObj)
              if (!buf) {
                await replyQuoted(from, { text: "❌ Erro ao baixar uma das mídias." }, msg)
                await reactEmoji(from, "❌", msg)
                return
              }
              const ft = await fileTypeFromBuffer(buf).catch(()=>null)
              const mime = ft?.mime || (Object.keys(mediaObj)[0].includes("video") ? "video/mp4" : "image/jpeg")

              let stickerBuf
              if (mime.startsWith("video/") || Object.keys(mediaObj)[0].includes("video")) {
                stickerBuf = await createStickerFromVideoBuffer(buf, 6)
              } else {
                stickerBuf = await createStickerFromImageBuffer(buf)
              }

              if (isGroup) {
                const reqId = Date.now().toString().slice(-6)
                await replyQuoted(from, { text: `📥 Pedido de @${sender.split("@")[0]} • ID: ${reqId}`, mentions: [sender] }, msg)
              }

              await replyQuoted(from, { sticker: stickerBuf, mimetype: "image/webp" }, msg)
              await reactEmoji(from, "✅", msg)
              await sleep(STICKER_SEND_DELAY_MS)
            } catch (e) {
              console.error("Erro processando item em #s:", e)
              await replyQuoted(from, { text: "❌ Erro ao processar uma das figurinhas." }, msg)
              await reactEmoji(from, "❌", msg)
            } finally {
              userEntry.count = Math.max(0, (userEntry.count||0) - 1)
              if (Object.keys(mediaObj)[0].includes("video")) {
                userEntry.videoCount = Math.max(0, (userEntry.videoCount||0) - 1)
              }
            }
          }).catch(async (e) => {
            console.error("Erro ao enfileirar job #s:", e)
            userEntry.count = Math.max(0, (userEntry.count||0) - 1)
            if (Object.keys(mediaObj)[0].includes("video")) {
              userEntry.videoCount = Math.max(0, (userEntry.videoCount||0) - 1)
            }
            await replyQuoted(from, { text: "❌ Erro ao enfileirar tarefa." }, msg)
            await reactEmoji(from, "❌", msg)
          })
        }

        return
      }

      // ============================
      // TAKE
      // ============================
      if (command === "take") {
        if (!quoted?.stickerMessage) {
          await replyQuoted(from, { text: "Responda uma figurinha com #take" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        await replyQuoted(from, { text: `${pickFofa()}\n\nRenomeando com seu nome...`, mentions: [sender] }, msg)
        try {
          const buf = await downloadQuotedBuffer({ stickerMessage: quoted.stickerMessage })
          const username = msg.pushName || sender.split("@")[0]
          const webpWithExif = await addExifToWebpBuffer(buf, username)
          await replyQuoted(from, { sticker: webpWithExif }, msg)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro #take:", e)
          await replyQuoted(from, { text: "❌ Erro ao renomear pack." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // RENAME
      // ============================
      if (command === "rename") {
        if (!args[0]) {
          await replyQuoted(from, { text: "Use: #rename <nome> (responda uma figurinha)" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        if (!quoted?.stickerMessage) {
          await replyQuoted(from, { text: "Responda uma figurinha com #rename <nome>" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        await replyQuoted(from, { text: `${pickFofa()}\n\nRenomeando pack...`, mentions: [sender] }, msg)
        try {
          const buf = await downloadQuotedBuffer({ stickerMessage: quoted.stickerMessage })
          const newName = args.join(" ")
          const webpWithExif = await addExifToWebpBuffer(buf, newName)
          await replyQuoted(from, { sticker: webpWithExif }, msg)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro #rename:", e)
          await replyQuoted(from, { text: "❌ Erro ao renomear pack." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // TOIMG
      // ============================
      if (command === "toimg") {
        if (!quoted?.stickerMessage) {
          await replyQuoted(from, { text: `${pickFofa()}\n\nResponda uma figurinha com #toimg para eu converter em imagem.`, mentions: [sender] }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        await replyQuoted(from, { text: pickFofa(), mentions: [sender] }, msg)
        try {
          const buf = await downloadQuotedBuffer({ stickerMessage: quoted.stickerMessage })
          const png = await stickerBufferToPng(buf)
          await replyQuoted(from, { image: png }, msg)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro #toimg:", e)
          await replyQuoted(from, { text: "❌ Erro ao converter figurinha." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // TOMp3
      // ============================
      if (command === "tomp3") {
        const mediaObj = quoted || (message.videoMessage ? { videoMessage: message.videoMessage } : null)
        if (!mediaObj || !Object.keys(mediaObj)[0].includes("video")) {
          await replyQuoted(from, { text: "Responda um vídeo com #tomp3" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        await replyQuoted(from, { text: pickFofa(), mentions: [sender] }, msg)
        try {
          const buf = await downloadQuotedBuffer(mediaObj)
          const mp3 = await videoBufferToMp3(buf)
          if (isGroup) {
            const reqId = Date.now().toString().slice(-6)
            await replyQuoted(from, { text: `📥 Pedido de @${sender.split("@")[0]} • ID: ${reqId}`, mentions: [sender] }, msg)
          }
          await replyQuoted(from, { audio: mp3, mimetype: "audio/mpeg" }, msg)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro #tomp3:", e)
          await replyQuoted(from, { text: "❌ Erro ao extrair áudio." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // CROP
      // ============================
      if (command === "crop") {
        if (!quoted?.imageMessage) {
          await replyQuoted(from, { text: "Responda uma imagem com #crop" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        try {
          const buf = await downloadQuotedBuffer(quoted)
          const inFile = nowTmp("crop_in") + ".jpg"
          const outFile = nowTmp("crop_out") + ".jpg"
          await writeFile(inFile, buf)
          await exec(`ffmpeg -y -i ${inFile} -vf "crop='min(in_w,in_h)':'min(in_w,in_h)'" ${outFile}`)
          const outBuf = await readFile(outFile)
          await replyQuoted(from, { image: outBuf }, msg)
          await unlink(inFile); await unlink(outFile)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro #crop:", e)
          await replyQuoted(from, { text: "❌ Erro ao cortar imagem." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // ATTP
      // ============================
      if (command === "attp") {
        if (!args[0]) {
          await replyQuoted(from, { text: "Use: #attp texto" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        try {
          const textArg = args.join(" ").replace(/'/g, "\\'")
          const outFile = nowTmp("attp_out") + ".webp"
          await exec(`ffmpeg -y -f lavfi -i color=c=black:s=512x512:d=3 -vf "drawtext=text='${textArg}':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=(h-text_h)/2" -loop 0 ${outFile}`)
          const buf = await readFile(outFile)
          await replyQuoted(from, { sticker: buf, mimetype: "image/webp" }, msg)
          await unlink(outFile)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro #attp:", e)
          await replyQuoted(from, { text: "❌ Erro ao gerar sticker de texto." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // WM
      // ============================
      if (command === "wm") {
        if (!args[0]) {
          await replyQuoted(from, { text: "Use: #wm <texto> (responda imagem)" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        if (!quoted?.imageMessage) {
          await replyQuoted(from, { text: "Responda uma imagem com #wm" }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        try {
          const buf = await downloadQuotedBuffer(quoted)
          const inFile = nowTmp("wm_in") + ".jpg"
          const outFile = nowTmp("wm_out") + ".jpg"
          await writeFile(inFile, buf)
          const textArg = args.join(" ").replace(/'/g, "\\'")
          await exec(`ffmpeg -y -i ${inFile} -vf "drawtext=text='${textArg}':fontcolor=white:fontsize=30:x=10:y=10" ${outFile}`)
          const outBuf = await readFile(outFile)
          await replyQuoted(from, { image: outBuf }, msg)
          await unlink(inFile); await unlink(outFile)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro #wm:", e)
          await replyQuoted(from, { text: "❌ Erro ao aplicar marca d'água." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // YT-DLP: ytmp3 / ytmp4 (USANDO BINÁRIO do sistema)
      // ============================
      if (command === "ytmp3" || command === "ytmp4") {
        const url = args[0] || (quoted?.conversation) || ""
        if (!url) {
          await replyQuoted(from, { text: `Use: ${PREFIX}ytmp3 <link> ou ${PREFIX}ytmp4 <link>` }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        await replyQuoted(from, { text: pickFofa() + "\n\n🔎 Baixando... aguarde um pouco dependendo do tamanho." }, msg)
        try {
          const unique = Date.now()
          const tmpBase = nowTmp("ytdl_" + unique)
          const outPattern = tmpBase + ".%(ext)s" // yt-dlp will substitute extension
          // run binary
          await runYtDlpBinary(url, command === "ytmp3" ? 'mp3' : 'mp4', outPattern)

          // find downloaded file (same folder)
          const dir = path.dirname(tmpBase)
          const baseName = path.basename(tmpBase)
          const files = fs.readdirSync(dir).filter(f => f.startsWith(baseName))
          if (!files || files.length === 0) throw new Error("Arquivo não encontrado após download")
          // pick first
          const downloaded = path.join(dir, files[0])
          const buffer = fs.readFileSync(downloaded)

          if (command === "ytmp3") {
            await replyQuoted(from, { audio: buffer, mimetype: "audio/mpeg" }, msg)
          } else {
            // if file is large, you might need to send as stream/file; here we attempt send as video buffer
            await replyQuoted(from, { video: buffer }, msg)
          }
          await unlink(downloaded)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro ytmp:", e)
          await replyQuoted(from, { text: "❌ Erro ao baixar via yt-dlp. Verifique se 'yt-dlp' está instalado no sistema." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // R comando (enviar foto do usuário marcado) - tenta pegar foto de perfil do usuário marcado
      // ============================
      if (command === "r") {
        // tenta extrair mentionedJid
        const mentioned = (message.extendedTextMessage?.contextInfo?.mentionedJid || [])
        if (!mentioned || mentioned.length === 0) {
          await replyQuoted(from, { text: "Use: #r @usuario  — marque o usuário que deseja receber a foto." }, msg)
          await reactEmoji(from, "❌", msg)
          return
        }
        const target = mentioned[0]
        try {
          const ppUrl = await sock.profilePictureUrl?.(target).catch(()=>null)
          if (!ppUrl) {
            await replyQuoted(from, { text: "❌ Não foi possível obter a foto de perfil deste usuário." }, msg)
            await reactEmoji(from, "❌", msg)
            return
          }
          // baixar imagem e enviar
          const tmp = nowTmp("pp") + ".jpg"
          // usar curl via exec para baixar (evita dependência de fetch)
          await exec(`curl -s -L "${ppUrl}" -o "${tmp}"`)
          const imgBuf = fs.readFileSync(tmp)
          await replyQuoted(from, { image: imgBuf }, msg)
          await unlink(tmp)
          await reactEmoji(from, "✅", msg)
        } catch (e) {
          console.error("Erro #r:", e)
          await replyQuoted(from, { text: "❌ Erro ao obter foto do usuário." }, msg)
          await reactEmoji(from, "❌", msg)
        }
        return
      }

      // ============================
      // comando desconhecido quando usa prefixo
      // ============================
      if (text.startsWith(PREFIX)) {
        const cmd = text.slice(PREFIX.length).split(" ")[0]
        if (!cmd) {
          await replyQuoted(from, { text: `✨ Meu prefixo atual é: *${PREFIX}*` }, msg)
          await reactEmoji(from, "✅", msg)
          return
        }
        await replyQuoted(from, { text: `❓ Comando não reconhecido: *${cmd}*\nUse *${PREFIX}menu* ou diga "Izzy" para ver o menu.` }, msg)
        await reactEmoji(from, "❌", msg)
        return
      }

    } catch (err) {
      console.error("Erro interno no messages.upsert:", err)
      try { await reactEmoji(msg.key.remoteJid, "❌", msg) } catch {}
    }
  })
}

startBot().catch(err => {
  console.error("Falha ao iniciar bot:", err)
})
