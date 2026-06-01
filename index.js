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
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

// Konfigurasi FiveM
const FIVEM_HOST = 'kota.indopride.id';
const FIVEM_PORT = 30120;
const PLAYERS_URL = `http://${FIVEM_HOST}:${FIVEM_PORT}/players.json`;
const DYNAMIC_URL = `http://${FIVEM_HOST}:${FIVEM_PORT}/dynamic.json`;
const TRACKER_FILE = './tracker.json';
const OWNER_NUMBER = '6285831640918@s.whatsapp.net';

// Daftar kata toxic yang akan dihapus otomatis
const TOXIC_WORDS = [
    // Yang disebutin owner
    'kontol', 'anjing', 'anjg', 'anying', 'pantek', 'pantk', 'ngentot', 'ngntd', 'babi',
    // Umum Indonesia
    'bangsat', 'brengsek', 'tolol', 'goblok', 'goblog', 'sialan', 'kampret',
    'bajingan', 'keparat', 'jancok', 'jancuk', 'asu', 'celeng', 'bangke',
    'tai', 'tahi', 'memek', 'pepek', 'cibai', 'puki', 'kimak', 'pukimak',
    'setan', 'iblis', 'laknat', 'biadab', 'kunyuk', 'monyet', 'bedebah',
    // Singkatan/variasi
    'kntl', 'bgst', 'jnck', 'tll', 'gblk', 'bngst', 'mmmk', 'kmprt'
];

// Fungsi helper untuk tracker
function getTracker() {
    if (!fs.existsSync(TRACKER_FILE)) return { dailyGroups: [], links: {} };
    return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8'));
}

function saveTracker(data) {
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
}

async function fetchServerData() {
    try {
        const [playersRes, dynamicRes] = await Promise.all([
            axios.get(PLAYERS_URL, { timeout: 10000 }),
            axios.get(DYNAMIC_URL, { timeout: 10000 })
        ]);
        // Bungkus dalam format yang sama seperti API lama: { Data: { players, clients } }
        return {
            Data: {
                players: playersRes.data || [],
                clients: dynamicRes.data?.clients || playersRes.data?.length || 0,
                hostname: dynamicRes.data?.hostname || ''
            }
        };
    } catch (err) {
        console.error('[FiveM] Error fetching data:', err.message);
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
            startDailyChat(sock);
            startRestartNotifier(sock);
        }
    });

    let dailyInterval;
    function startDailyChat(sock) {
        async function runDaily() {
            const now = new Date();
            const hour = now.getHours();
            const tracker = getTracker();
            
            // Tentukan interval berikutnya (dalam ms)
            let nextInterval;
            let intervalText;
            
            if (hour >= 2 && hour < 7) {
                nextInterval = 150 * 60 * 1000; // 2.5 jam
                intervalText = '2.5 jam';
            } else {
                nextInterval = 120 * 60 * 1000; // 2 jam
                intervalText = '2 jam';
            }

            if (tracker.dailyGroups.length > 0) {
                let message = `\u{1F31F} *SYSTEM STATUS: ONLINE* \u{1F31F}\n`;
                message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                message += `\u{1F680} *MAIN COMMANDS:*\n`;
                message += `\u{1F4DD} #WLMC / #WL - List online WLMC\n`;
                message += `\u{1F50D} #SEARCH [Nama] - Cari player\n`;
                message += `\u{1F4CB} #LISTALL - Statistik faksi\n`;
                message += `\u{1F517} #HEX [Link] - Konversi Hex Steam\n`;
                message += `\u{1F194} #KANTONG [ID] - Cari nama by ID\n\n`;
                message += `\u{1F48E} *INFO & SOCIAL:*\n`;
                message += `\u{1F4B0} #DONATUR - List top donatur\n`;
                message += `\u{1F920} #WLMCINFO - Info grup & discord\n`;
                message += `\u{1F4CA} #SERVERINFO - Status server\n`;
                message += `\u{1F30A} #BADAI - Aktifkan daily restart kota\n`;
                message += `\u{1F4F6} #TOPPING - Cek ping player\n\n`;
                message += `\u{1F6E0} *TOOLS & FUN:*\n`;
                message += `\u{1F5BC} #STICKER - Buat stiker dari foto\n`;
                message += `\u{231B} #PING - Cek respon bot\n`;
                message += `\u{1F552} #TIME - Waktu saat ini\n`;
                message += `\u{1F3B2} #RANDOMID - Pick random player\n`;
                message += `\u{1F464} #OWNER - Kontak owner bot\n\n`;
                message += `━━━━━━━━━━━━━━━━━━━━\n`;
                message += `\u{231A} *Update otomatis setiap ${intervalText}*\n`;
                message += `_WLMC GACORRRRRRRRRRRRRRRRRRRR_`;

                for (const jid of tracker.dailyGroups) {
                    try {
                        await sock.sendMessage(jid, { text: message });
                        console.log(`[DAILY] Pesan terkirim ke: ${jid} (Interval: ${intervalText})`);
                    } catch (err) {
                        console.error(`[ERROR] Gagal mengirim daily chat ke ${jid}:`, err.message);
                    }
                }
            }
            
            // Jadwalkan pengiriman berikutnya
            setTimeout(runDaily, nextInterval);
        }

        // Jalankan pengiriman pertama kali setelah interval awal
        setTimeout(runDaily, 120 * 60 * 1000);
    }

    function startRestartNotifier(sock) {
        async function checkRestart() {
            try {
                const now = new Date();
                const hour = now.getHours();
                const minute = now.getMinutes();
                const tracker = getTracker();
                
                const restartGroups = tracker.restartGroups || [];
                if (restartGroups.length === 0) return;

                // Kirim pesan tepat jam 06:00 dan 18:00
                if ((hour === 6 || hour === 18) && minute === 0) {
                    const waktuLabel = hour === 6 ? 'Pagi (06:00)' : 'Sore (18:00)';
                    const restartMessage =
                        `🔄 *DAILY RESTART SERVER KOTA* 🔄\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `⚠️ *INFO:* Server kota sedang melakukan daily restart ${waktuLabel}.\n\n` +
                        `Silakan tunggu beberapa menit lalu relog kota kembali. Pastikan kendaraan dan barang bawaan sudah aman sebelum server kembali online!\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `_WLMC Relog Setelah Server Online!_ 🏍️🔥`;

                    for (const jid of restartGroups) {
                        try {
                            await sock.sendMessage(jid, { text: restartMessage });
                            console.log(`[RESTART NOTIF] Sent to ${jid} at ${hour}:00`);
                        } catch (err) {
                            console.error(`[ERROR] Failed to send restart notif to ${jid}:`, err.message);
                        }
                    }
                }
            } catch (err) {
                console.error('[ERROR] checkRestart failed:', err);
            }
        }

        // Jalankan setiap 60 detik (1 menit)
        setInterval(checkRestart, 60 * 1000);
    }

    sock.ev.on('creds.update', saveCreds);

    // Handler Welcome & Leave
    sock.ev.on('group-participants.update', async (update) => {
        const { id: groupJid, participants, action } = update;
        const tracker = getTracker();
        const l = tracker.links || {};
        const dc_wlmc = l.dc_wlmc || l.dc_bmmc || 'https://discord.gg/5xdtE6RSV';
        
        for (const participantJid of participants) {
            const userTag = `@${participantJid.split('@')[0]}`;
            
            if (action === 'add') {
                const welcomeMessage = `👋 *WELCOME TO WLMC GROUP!* 👋\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `Halo ${userTag}! Selamat datang di faksi *WLMC (White Line Motorcycle Club)*.\n\n` +
                    `Semoga betah di sini! Silakan lengkapi pendataan berikut:\n` +
                    `1\u{FE0F}\u{20E3} *DISCORD WLMC*\n\u{1F449}\u{1F3FB} ${dc_wlmc}\n` +
                    `2\u{FE0F}\u{20E3} *NAMA PROFILE FIVE M*\n\u{1F449}\u{1F3FB} Ganti nama ke: \u{201C}WLMC PULAU - NAMAIC\u{201D}\n` +
                    `3\u{FE0F}\u{20E3} *INFO GROUP*\n\u{1F449}\u{1F3FB} Ketik *#wlmcinfo* untuk panduan lengkap.\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `_WLMC GACORRRRRRRRRRRRRRRRRRRR_ 🏍️🔥`;
                
                try {
                    const ppUrl = await sock.profilePictureUrl(participantJid, 'image');
                    await sock.sendMessage(groupJid, {
                        image: { url: ppUrl },
                        caption: welcomeMessage,
                        mentions: [participantJid]
                    });
                } catch (err) {
                    await sock.sendMessage(groupJid, {
                        text: welcomeMessage,
                        mentions: [participantJid]
                    });
                }
            } else if (action === 'remove') {
                const leaveMessage = `👋 *GOODBYE ${userTag}!* 👋\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `Telah keluar dari grup WLMC. Terima kasih atas kebersamaan dan kontribusinya di kota selama ini. Sukses selalu di luar sana! 🫡🏍️\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;
                
                await sock.sendMessage(groupJid, {
                    text: leaveMessage,
                    mentions: [participantJid]
                });
            }
        }
    });

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

        // === ANTI TOXIC FILTER ===
        const isGroup = from.endsWith('@g.us');
        if (isGroup && content) {
            const tracker = getTracker();
            const antiToxicGroups = tracker.antiToxicGroups || [];
            if (antiToxicGroups.includes(from)) {
                const lowerContent = content.toLowerCase().replace(/[^a-z0-9]/g, '');
                const foundToxic = TOXIC_WORDS.find(word => {
                    const cleanWord = word.replace(/[^a-z0-9]/g, '');
                    return lowerContent.includes(cleanWord);
                });
                if (foundToxic) {
                    try {
                        // Hapus pesan toxic
                        await sock.sendMessage(from, { delete: msg.key });
                        // Kirim peringatan
                        const senderJid = msg.key.participant || from;
                        const warningText =
                            `\u{26A0}\u{FE0F} *PERINGATAN ANTI-TOXIC* \u{26A0}\u{FE0F}\n` +
                            `\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\n` +
                            `@${senderJid.split('@')[0]} pesan kamu dihapus karena mengandung kata tidak sopan.\n\n` +
                            `Jaga etika dan sopan santun di grup ini ya! \u{1F64F}\n` +
                            `\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\n` +
                            `_WLMC Anti-Toxic System_ \u{1F6E1}\u{FE0F}`;
                        await sock.sendMessage(from, {
                            text: warningText,
                            mentions: [senderJid]
                        });
                        console.log(`[ANTI-TOXIC] Deleted toxic message from ${senderJid}`);
                    } catch (err) {
                        console.error('[ANTI-TOXIC] Failed to delete message:', err.message);
                    }
                    return;
                }
            }
        }

        // Fitur #WLMC / #WL
        if (command === '#WLMC' || command === '#WL') {
            const data = await fetchServerData();
            if (!data || !data.Data) return sock.sendMessage(from, { text: '❌ Gagal mengambil data dari server FiveM.' }, { quoted: msg });

            const players = data.Data.players || [];
            const wlmcPlayers = players.filter(p => p.name.toUpperCase().includes('WLMC'));

            let responseText = `\u{1F3AE} *INDOPRIDE ROLEPLAY - BOT BY JAMES/RISKI*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;

            if (wlmcPlayers.length > 0) {
                responseText += `\u{1F465} *LIST PLAYER WLMC (${wlmcPlayers.length} ONLINE):*\n`;
                wlmcPlayers.forEach((p, index) => {
                    responseText += `${index + 1}. \u{1F194} [${p.id}] *${p.name}* (\u{26A1} ${p.ping}ms)\n`;
                });
            } else {
                responseText += `\u{274C} *Tidak ada pemain WLMC yang online.*\n`;
            }

            responseText += `\n\u{1F4CA} *TOTAL ONLINE:* ${data.Data.clients} Players\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `_WLMC GACORRRRRRRRRRRRRRRRRRRR_`;

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

            let responseText = `\u{1F50D} *HASIL PENCARIAN: "${searchQuery}"*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;

            if (foundPlayers.length > 0) {
                const limit = 15;
                const displayed = foundPlayers.slice(0, limit);
                responseText += `\u{2705} *Ditemukan ${foundPlayers.length} Player:* \n\n`;
                displayed.forEach((p) => {
                    responseText += `\u{1F464} *Name:* ${p.name}\n`;
                    responseText += `\u{1F194} *KANTONG:* ${p.id}  |  \u{1F4F6} *Ping:* ${p.ping}ms\n`;
                    responseText += `────────────────────\n`;
                });
                if (foundPlayers.length > limit) responseText += `_...dan ${foundPlayers.length - limit} lainnya._\n`;
            } else {
                responseText += `\u{274C} *Player "${searchQuery}" tidak online.*\n`;
            }

            responseText += `\n\u{1F4CA} *Total Server Online:* ${data.Data.clients}\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur #SETDAILY
        if (command === '#SETDAILY') {
            let tracker = getTracker();
            if (tracker.dailyGroups.includes(from)) {
                tracker.dailyGroups = tracker.dailyGroups.filter(id => id !== from);
                saveTracker(tracker);
                await sock.sendMessage(from, { text: '\u274C *Daily Chat dinonaktifkan untuk grup ini.*' }, { quoted: msg });
            } else {
                tracker.dailyGroups.push(from);
                saveTracker(tracker);
                await sock.sendMessage(from, { text: '\u2705 *Daily Chat berhasil diaktifkan!*\nBot akan mengirim pesan status setiap 15 menit di grup ini.' }, { quoted: msg });
            }
        }

        // Fitur #ANTITOXIC - Toggle anti-toxic filter (Semua bisa aktifkan)
        if (command === '#ANTITOXIC') {
            let tracker = getTracker();
            if (!tracker.antiToxicGroups) tracker.antiToxicGroups = [];
            if (tracker.antiToxicGroups.includes(from)) {
                tracker.antiToxicGroups = tracker.antiToxicGroups.filter(id => id !== from);
                saveTracker(tracker);
                await sock.sendMessage(from, {
                    text: `\u{274C} *Anti-Toxic dinonaktifkan.*\nBot tidak akan lagi menghapus pesan kasar di grup ini.`
                }, { quoted: msg });
            } else {
                tracker.antiToxicGroups.push(from);
                saveTracker(tracker);
                await sock.sendMessage(from, {
                    text: `\u{2705} *Anti-Toxic berhasil diaktifkan!* \u{1F6E1}\u{FE0F}\n\nBot akan otomatis *menghapus pesan* yang mengandung kata-kata kasar dan memberi peringatan ke pengirimnya.\n\n_Pastikan bot sudah jadi Admin grup ya!_`
                }, { quoted: msg });
            }
        }

        // Fitur #HEX
        if (command.startsWith('#HEX')) {
            const input = content.replace(/#hex/gi, '').trim();
            if (!input) return sock.sendMessage(from, { text: 'ℹ️ Format salah. Gunakan: *#hex [link_steam_profile]*' }, { quoted: msg });

            // Extract SteamID64 from URL
            const match = input.match(/profiles\/(\d+)/) || input.match(/(\d{17})/);
            if (!match) return sock.sendMessage(from, { text: '❌ Link Steam tidak valid. Pastikan menggunakan link profiles (contoh: https://steamcommunity.com/profiles/76561198...)' }, { quoted: msg });

            const steamId64 = match[1];
            try {
                const fullHex = `steam:${BigInt(steamId64).toString(16)}`;

                let responseText = `🔗 *STEAM TO HEX CONVERTER*\n`;
                responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                responseText += `Hai! Ini adalah hasil konversi SteamID kamu:\n\n`;
                responseText += `👤 *SteamID64:* ${steamId64}\n`;
                responseText += `💎 *Steam Hex:* \`${fullHex}\`\n\n`;
                responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
                responseText += `_Bot by James/Riski_`;

                await sock.sendMessage(from, { text: responseText }, { quoted: msg });
            } catch (err) {
                await sock.sendMessage(from, { text: '❌ Terjadi kesalahan saat mengonversi SteamID.' }, { quoted: msg });
            }
        }

        // Fitur #LISTALL
        if (command === '#LISTALL') {
            const data = await fetchServerData();
            if (!data || !data.Data) return sock.sendMessage(from, { text: '\u{274C} Gagal mengambil data FiveM.' }, { quoted: msg });

            const players = data.Data.players || [];
            const prefixes = [
                { name: 'WLMC', emoji: '\u{1F7E6}' },
                { name: 'GP', emoji: '\u{1F7E9}' },
                { name: 'SSD', emoji: '\u{1F7E8}' },
                { name: 'TRS', emoji: '\u{1F7E7}' },
                { name: 'MPD', emoji: '\u{1F7E5}' },
                { name: 'RNR', emoji: '\u{1F7EA}' }
            ];

            let responseText = `\u{1F4CA} *PLAYER STATISTICS BY GROUP*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `Berikut adalah total player yang sedang online berdasarkan tag nama:\n\n`;

            prefixes.forEach(p => {
                const count = players.filter(pl => {
                    const playerName = (pl.name || '').toUpperCase().trim();
                    return playerName.includes(p.name);
                }).length;
                responseText += `${p.emoji} *${p.name}:* ${count} ${p.name === 'WLMC' ? 'Player' : 'Total'} Online\n`;
            });

            responseText += `\n━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `\u{1F465} *Total Keseluruhan:* ${data.Data.clients} Players\n`;
            responseText += `_Data diambil langsung dari API FiveM_`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur #KANTONG
        if (command.startsWith('#KANTONG')) {
            const inputId = content.replace(/#kantong/gi, '').trim();
            if (!inputId) return sock.sendMessage(from, { text: '\u{2139}\u{FE0F} Masukkan ID/Kantong. Contoh: *#kantong 123*' }, { quoted: msg });

            const data = await fetchServerData();
            if (!data || !data.Data) return sock.sendMessage(from, { text: '\u{274C} Gagal mengambil data FiveM.' }, { quoted: msg });

            const player = (data.Data.players || []).find(p => p.id.toString() === inputId);
            if (player) {
                await sock.sendMessage(from, { text: `\u{2705} Pemilik ID *${inputId}* adalah: *${player.name}*` }, { quoted: msg });
            } else {
                await sock.sendMessage(from, { text: `\u{274C} Player dengan ID *${inputId}* tidak ditemukan atau tidak online.` }, { quoted: msg });
            }
        }

        // Fitur #DONATUR
        if (command === '#DONATUR') {
            let responseText = `\u{1F48E} *TOP DONATUR WLMC* \u{1F48E}\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `Juanda — 500K \u{1F451}\n`;
            responseText += `Vaya — 300K\n`;
            responseText += `Leno / Margo — 300K\n`;
            responseText += `Khen — 205K\n`;
            responseText += `Cillo — 200K\n`;
            responseText += `Pace Wahyu (Org Batam) — 190K\n`;
            responseText += `Tobi Fajar — 150K\n`;
            responseText += `RISKI / Bryan — 125K\n`;
            responseText += `Pingu — 115K\n`;
            responseText += `Morgan — 100K\n`;
            responseText += `Lily — 100K\n`;
            responseText += `Alex Malpinos — 100K\n`;
            responseText += `Ayu — 100K\n`;
            responseText += `Man Skuy — 100K\n`;
            responseText += `Peter — 100K\n`;
            responseText += `Olavv — 70K\n`;
            responseText += `Dimas a.k.a Elon — 62K\n`;
            responseText += `Soka — 50K\n`;
            responseText += `Mas Gebret — 50K\n`;
            responseText += `Lek Mat — 50K\n`;
            responseText += `Vicenzo — 50K\n`;
            responseText += `Restyooo — 50K\n`;
            responseText += `Alexsandro — 50K\n`;
            responseText += `Cobar XTeam — 50K\n`;
            responseText += `Rahardjj King (Riko) — 50K\n`;
            responseText += `Cokil — 50K\n`;
            responseText += `Bam Bang — 50K\n`;
            responseText += `Budi — 50K\n`;
            responseText += `Gustavo — 50K\n`;
            responseText += `Kyle Brown — 40K\n`;
            responseText += `Pragos Artam — 30K\n`;
            responseText += `Riza — 30K\n`;
            responseText += `Hazzerdarin — 25K\n`;
            responseText += `Jesse Mayer — 25K\n`;
            responseText += `Mbuud — 20K\n\n`;
            responseText += `*NOTE* = BAGI YANG MERASA ADA YANG SALAH HUBUNGIN JAMES/RISKI\n`;
            responseText += `\u{1F525} *THANK YOU PARA DONATUR* \u{1F525}`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur #WLMCINFO
        if (command === '#WLMCINFO') {
            const tracker = getTracker();
            const l = tracker.links || {};
            const dc_wlmc = l.dc_wlmc || l.dc_bmmc || 'https://discord.gg/5xdtE6RSV';
            const wa_wlmc = l.wa_wlmc || l.wa_bmmc || 'https://chat.whatsapp.com/HeOuEPEU9I368zI9BNk51Y';

            let responseText = `\u{1F920} *HOWDYY WLMC* \u{1F920}\n\n`;
            responseText += `Silakan join link grup dan aplikasikan semua di bawah ini untuk pendataan anggota WLMC (id discord & steamhex):\n\n`;
            responseText += `1\u{FE0F}\u{20E3} *DISCORD WLMC*\n\u{1F449}\u{1F3FB} ${dc_wlmc}\n\n`;
            responseText += `2\u{FE0F}\u{20E3} *DISCORD CAYO*\n\u{1F449}\u{1F3FB} ${l.dc_cayo || 'https://discord.gg/4C57xhBdxG'}\n`;
            responseText += `* Ubah nama per server profile: \u{201C}WLMC - NAMAIC\u{201D}\n`;
            responseText += `* Masuk bagian role-fraksi\n`;
            responseText += `* Tambahkan req role wlmc dengan tag @morgan @olav\n`;
            responseText += `* Tunggu acc menjadi anggota WLMC\n`;
            responseText += `* Setiap kegiatan di pulau, wajib parkir masuk voice WLMC\n\n`;
            responseText += `3\u{FE0F}\u{20E3} *GRUP WA WLMC*\n\u{1F449}\u{1F3FB} ${wa_wlmc}\n\n`;
            responseText += `4\u{FE0F}\u{20E3} *GRUP WA WLMC AKTIVITAS & BISNIS*\n\u{1F449}\u{1F3FB} ${l.wa_bisnis || 'https://chat.whatsapp.com/GWZyEZXvNyp64sFNEixdPM?mode=gi_t'}\n\n`;
            responseText += `5\u{FE0F}\u{20E3} *GRUP WA WLMC ABSEN AKTIVITAS*\n\u{1F449}\u{1F3FB} ${l.wa_absen || 'https://chat.whatsapp.com/FsTXrtUxbIt1aGQvWkKaH4?mode=gi_t'}\n\n`;
            responseText += `6\u{FE0F}\u{20E3} *Ganti Nama Player Name*\n`;
            responseText += `* Buka FiveM\n`;
            responseText += `* Pojok kanan atas klik Gear/ Setting\n`;
            responseText += `* Isi kolom Player Name: \u{201C}WLMC PULAU - NAMAIC\u{201D}\n\n`;
            responseText += `7\u{FE0F}\u{20E3} *MASUK DC DARKSIDE*\n\u{1F449}\u{1F3FB} ${l.dc_darkside || 'https://discord.gg/n97xSCTgk'}\n\n`;
            responseText += `\u{1F920} *HOWDYY WLMC* \u{1F920}\n\n`;
            responseText += `@semua yang belum masuk dcnya, grup atau ganti nama bisa di cek disini yaaaa`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur Ganti Link (Owner Only)
        const linkCommands = ['#DCWLMC2', '#DCCAYO2', '#WAWLMC2', '#WABISNIS2', '#WAABSEN2', '#DCDARKSIDE2'];
        const linkKeyMap = {
            '#DCWLMC2': 'dc_wlmc',
            '#DCCAYO2': 'dc_cayo',
            '#WAWLMC2': 'wa_wlmc',
            '#WABISNIS2': 'wa_bisnis',
            '#WAABSEN2': 'wa_absen',
            '#DCDARKSIDE2': 'dc_darkside'
        };

        const currentCmd = linkCommands.find(cmd => command.startsWith(cmd));
        if (currentCmd) {
            const newLink = content.replace(new RegExp(currentCmd, 'gi'), '').trim();
            if (!newLink) return sock.sendMessage(from, { text: `ℹ️ Gunakan: *${currentCmd.toLowerCase()} [link_baru]*` }, { quoted: msg });

            let tracker = getTracker();
            if (!tracker.links) tracker.links = {};
            tracker.links[linkKeyMap[currentCmd]] = newLink;
            saveTracker(tracker);

            await sock.sendMessage(from, { text: `✅ Link *${linkKeyMap[currentCmd]}* berhasil diupdate!` }, { quoted: msg });
        }

        // Fitur #SERVERINFO
        if (command === '#SERVERINFO') {
            const data = await fetchServerData();
            if (!data || !data.Data) return sock.sendMessage(from, { text: '\u{274C} Gagal mengambil data server.' }, { quoted: msg });

            let responseText = `\u{1F4CA} *SERVER INFORMATION*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `\u{1F3F0} *Server Name:* ${data.Data.hostname.replace(/\^./g, '').slice(0, 50)}...\n`;
            responseText += `\u{1F465} *Players:* ${data.Data.clients} / ${data.Data.sv_maxclients}\n`;
            responseText += `\u{1F3AE} *Game Type:* ${data.Data.gametype}\n`;
            responseText += `\u{1F5FA} *Map:* ${data.Data.mapname}\n`;
            responseText += `\u{1F6E0} *Resources:* ${data.Data.resources.length}\n`;
            responseText += `\u{2705} *OneSync:* ${data.Data.vars.onesync_enabled ? 'Enabled' : 'Disabled'}\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `_Bot by James/Riski_`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur #TOPPING
        if (command === '#TOPPING') {
            const data = await fetchServerData();
            if (!data || !data.Data) return sock.sendMessage(from, { text: '❌ Gagal mengambil data.' }, { quoted: msg });

            const players = data.Data.players || [];
            if (players.length === 0) return sock.sendMessage(from, { text: '❌ Tidak ada pemain online.' }, { quoted: msg });

            const sortedPing = [...players].sort((a, b) => b.ping - a.ping);
            const highPing = sortedPing.slice(0, 5);
            const lowPing = [...players].sort((a, b) => a.ping - b.ping).slice(0, 5);

            let responseText = `\u{1F4F6} *NETWORK STATISTICS (PING)*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
            responseText += `\u{1F534} *HIGH PING (LAGGING):*\n`;
            highPing.forEach((p, i) => {
                responseText += `${i + 1}. [${p.id}] *${p.name}* - ${p.ping}ms\n`;
            });

            responseText += `\n\u{1F7E2} *LOW PING (STABLE):*\n`;
            lowPing.forEach((p, i) => {
                responseText += `${i + 1}. [${p.id}] *${p.name}* - ${p.ping}ms\n`;
            });

            responseText += `\n━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `_Gunakan internet stabil agar lancar di kota!_`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur #STICKER
        if (command === '#STICKER' || command === '#STIKER') {
            const isQuotedImage = type === 'extendedTextMessage' && msg.message.extendedTextMessage.contextInfo?.quotedMessage?.imageMessage;
            const isImage = type === 'imageMessage';

            if (isImage || isQuotedImage) {
                try {
                    const messageToDownload = isQuotedImage ? msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage : msg.message.imageMessage;
                    const stream = await downloadContentFromMessage(messageToDownload, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const sticker = new Sticker(buffer, {
                        pack: 'WLMC Bot',
                        author: 'James/Riski',
                        type: StickerTypes.FULL,
                        quality: 70
                    });

                    const stickerBuffer = await sticker.toBuffer();
                    await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
                } catch (err) {
                    console.error('Error sticker:', err);
                    await sock.sendMessage(from, { text: '\u{274C} Gagal membuat stiker. Pastikan gambar tidak terlalu besar.' }, { quoted: msg });
                }
            } else {
                await sock.sendMessage(from, { text: '\u{2139}\u{FE0F} Kirim gambar dengan caption *#sticker* atau reply gambar yang sudah ada.' }, { quoted: msg });
            }
        }

        // 5 Fitur Random
        if (command === '#PING') {
            const start = Date.now();
            await sock.sendMessage(from, { text: 'Pinging...' }, { quoted: msg });
            const end = Date.now();
            await sock.sendMessage(from, { text: `\u{1F3D3} *Pong!* Respon bot: *${end - start}ms*` }, { quoted: msg });
        }

        if (command === '#TIME') {
            const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            await sock.sendMessage(from, { text: `\u{231B} *Waktu Saat Ini (WIB):*\n${now}` }, { quoted: msg });
        }

        if (command === '#RANDOMID') {
            const data = await fetchServerData();
            if (data?.Data?.players?.length > 0) {
                const random = data.Data.players[Math.floor(Math.random() * data.Data.players.length)];
                await sock.sendMessage(from, { text: `\u{1F3B2} *Random Player Picked:*\nNama: *${random.name}*\nID: *${random.id}*` }, { quoted: msg });
            }
        }

        if (command === '#OWNER') {
            await sock.sendMessage(from, { text: `\u{1F464} *OWNER BOT:*\nJames / Riski\nWA: +62 858-3164-0918\n\n_WLMC Gacorrr!_` }, { quoted: msg });
        }

        if (command === '#SPEED') {
            const data = await fetchServerData();
            await sock.sendMessage(from, { text: `\u{26A1} *Server Connection Speed:*\nLatency API: *${data ? 'Normal' : 'Slow'}*` }, { quoted: msg });
        }

        // Fitur #BADAI - Toggle notifikasi daily restart server
        if (command === '#BADAI') {
            if (msg.key.participant !== OWNER_NUMBER && msg.key.remoteJid !== OWNER_NUMBER) {
                return sock.sendMessage(from, { text: `\u{274C} Hanya owner yang bisa menggunakan command ini.` }, { quoted: msg });
            }
            let tracker = getTracker();
            if (!tracker.restartGroups) tracker.restartGroups = [];
            if (tracker.restartGroups.includes(from)) {
                tracker.restartGroups = tracker.restartGroups.filter(id => id !== from);
                saveTracker(tracker);
                await sock.sendMessage(from, { text: `\u{274C} *Daily Restart Notif dinonaktifkan untuk grup ini.*\nBot tidak akan lagi mengirim notifikasi daily restart jam 06:00 & 18:00.` }, { quoted: msg });
            } else {
                tracker.restartGroups.push(from);
                saveTracker(tracker);
                await sock.sendMessage(from, { text: `\u{2705} *Daily Restart Notif berhasil diaktifkan!*\nBot akan otomatis mengirim pesan di grup ini setiap jam *06:00 Pagi* dan *18:00 Sore* saat server kota restart.` }, { quoted: msg });
            }
        }

        // Fitur #MENU
        if (command === '#MENU') {
            let menuText = `\u{1F4CB} *COMMAND MENU*\n`;
            menuText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
            menuText += `\u{1F680} *MAIN COMMANDS:*\n`;
            menuText += `\u{1F4DD} #WLMC / #WL - List online WLMC\n`;
            menuText += `\u{1F50D} #SEARCH [Nama] - Cari player\n`;
            menuText += `\u{1F4CB} #LISTALL - Statistik faksi\n`;
            menuText += `\u{1F517} #HEX [Link] - Konversi Hex Steam\n`;
            menuText += `\u{1F194} #KANTONG [ID] - Cari nama by ID\n\n`;
            menuText += `\u{1F48E} *INFO & SOCIAL:*\n`;
            menuText += `\u{1F4B0} #DONATUR - List top donatur\n`;
            menuText += `\u{1F920} #WLMCINFO - Info grup & discord\n`;
            menuText += `\u{1F4CA} #SERVERINFO - Status server\n`;
            menuText += `\u{1F30A} #BADAI - Aktifkan daily restart kota\n`;
            menuText += `\u{1F4F6} #TOPPING - Cek ping player\n\n`;
            menuText += `\u{1F6E0} *TOOLS & FUN:*\n`;
            menuText += `\u{1F5BC} #STICKER - Buat stiker dari foto\n`;
            menuText += `\u{231B} #PING - Cek respon bot\n`;
            menuText += `\u{1F552} #TIME - Waktu saat ini\n`;
            menuText += `\u{1F3B2} #RANDOMID - Pick random player\n`;
            menuText += `\u{1F464} #OWNER - Kontak owner bot\n\n`;
            menuText += `━━━━━━━━━━━━━━━━━━━━\n`;
            menuText += `_Bot by James/Riski_`;

            await sock.sendMessage(from, { text: menuText }, { quoted: msg });
        }
    });
}

connectToWhatsApp();
