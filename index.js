const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    generateForwardMessageContent,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    generateMessageID,
    downloadContentFromMessage,
    makeInMemoryStore,
    jidDecode,
    proto
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const axios = require("axios");
const qrcode = require("qrcode-terminal");

// Konfigurasi FiveM
const SERVER_ID = '237yxy';
const API_URL = `https://servers-frontend.fivem.net/api/servers/single/${SERVER_ID}`;

async function fetchServerData() {
    try {
        const response = await axios.get(API_URL, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching FiveM data:', error.message);
        return null;
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Menggunakan WA v${version.join('.')}, latest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('SCAN QR CODE INI UNTUK LOGIN:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Koneksi terputus, mencoba menghubungkan kembali...');
                connectToWhatsApp();
            } else {
                console.log('❌ Koneksi keluar. Silakan hapus folder auth_info_baileys dan scan ulang.');
            }
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp sudah Online dan Siap digunakan!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Handler Pesan
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message) return;
        const from = msg.key.remoteJid;
        if (msg.key.fromMe || from === 'status@broadcast') return;
        const type = Object.keys(msg.message).find(key => key !== 'senderKeyDistributionMessage' && key !== 'messageContextInfo') || '';
        const content = type === 'conversation' ? msg.message.conversation : type === 'extendedTextMessage' ? msg.message.extendedTextMessage.text : type === 'imageMessage' ? msg.message.imageMessage.caption : '';
        const command = content.trim().toUpperCase();

        console.log(`[DEBUG] Pesan masuk dari ${from}: ${content}`);
        console.log(`[DEBUG] Command: ${command}`);

        // Fitur #BMMC
        if (command.startsWith('#BMMC')) {
            const data = await fetchServerData();
            if (!data || !data.Data) return sock.sendMessage(from, { text: '❌ Gagal mengambil data dari server FiveM.' }, { quoted: msg });

            const players = data.Data.players || [];
            const bmmcPlayers = players.filter(p => p.name.toUpperCase().includes('BMMC'));

            let responseText = `🎮 *INDOPRIDE ROLEPLAY - BOT BY JAMES/RISKI*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;

            if (bmmcPlayers.length > 0) {
                responseText += `👥 *LIST PLAYER BMMC (${bmmcPlayers.length} ONLINE):*\n`;
                bmmcPlayers.forEach((p, index) => {
                    responseText += `${index + 1}. 🆔 [${p.id}] *${p.name}* (⚡ ${p.ping}ms)\n`;
                });
            } else {
                responseText += `❌ *Tidak ada pemain BMMC yang online.*\n`;
            }

            responseText += `\n📊 *TOTAL ONLINE:* ${data.Data.clients} Players\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `_BMMC GACORRRRRRRRRRRRRRRRRRRR_`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur #SEARCH
        if (command.startsWith('#SEARCH')) {
            const searchQuery = command.replace('#SEARCH', '').trim();
            if (!searchQuery) return sock.sendMessage(from, { text: 'ℹ️ Format salah. Gunakan: *#search [nama_player]*' }, { quoted: msg });
            const data = await fetchServerData();
            if (!data || !data.Data) return sock.sendMessage(from, { text: '❌ Gagal mengambil data FiveM.' }, { quoted: msg });

            const players = data.Data.players || [];
            const foundPlayers = players.filter(p => p.name.toUpperCase().includes(searchQuery));

            let responseText = `🔍 *HASIL PENCARIAN: "${searchQuery}"*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;

            if (foundPlayers.length > 0) {
                const limit = 15;
                const displayed = foundPlayers.slice(0, limit);
                responseText += `✅ *Ditemukan ${foundPlayers.length} Player:* \n\n`;
                displayed.forEach((p) => {
                    responseText += `👤 *Name:* ${p.name}\n`;
                    responseText += `🆔 *KANTONG:* ${p.id}  |  📶 *Ping:* ${p.ping}ms\n`;
                    responseText += `────────────────────\n`;
                });
                if (foundPlayers.length > limit) responseText += `_...dan ${foundPlayers.length - limit} lainnya._\n`;
            } else {
                responseText += `❌ *Player "${searchQuery}" tidak online.*\n`;
            }

            responseText += `\n📊 *Total Server Online:* ${data.Data.clients}\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }
    });
}

connectToWhatsApp();
