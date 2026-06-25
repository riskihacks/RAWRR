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
const DEFAULT_SERVER_CODE = '237yxy';

function getServerCode() {
    const tracker = getTracker();
    return tracker.serverCode || DEFAULT_SERVER_CODE;
}

function getFiveStatsUrls() {
    const code = getServerCode();
    return {
        server: `https://fivestats.io/api/servers/${code}`,
        players: `https://fivestats.io/api/servers/${code}/players`
    };
}
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

// === USER MANAGEMENT ===
const OWNER_NAME = 'riski/james';
const PENDING_DURATION = 18 * 60 * 1000; // 18 menit dalam ms

function getUserByJid(jid) {
    const tracker = getTracker();
    return (tracker.users || {})[jid] || null;
}

function getUserByNama(nama) {
    const tracker = getTracker();
    const users = tracker.users || {};
    const lower = nama.toLowerCase();
    const entry = Object.entries(users).find(([, u]) => u.nama.toLowerCase() === lower);
    return entry ? { jid: entry[0], ...entry[1] } : null;
}

function isNamaTaken(nama) {
    const tracker = getTracker();
    const lower = nama.toLowerCase();
    return Object.values(tracker.users || {}).some(u => u.nama.toLowerCase() === lower);
}

function registerUser(jid, nama) {
    const tracker = getTracker();
    if (!tracker.users) tracker.users = {};
    const isOwner = nama.toLowerCase() === OWNER_NAME.toLowerCase();
    const now = Date.now();
    tracker.users[jid] = {
        nama,
        registeredAt: now,
        approvedAt: isOwner ? now : null,
        status: isOwner ? 'owner' : 'pending'
    };
    saveTracker(tracker);
    return tracker.users[jid];
}

function checkAndUpgradeUser(jid) {
    const tracker = getTracker();
    if (!tracker.users || !tracker.users[jid]) return null;
    const user = tracker.users[jid];
    if (user.status === 'pending' && (Date.now() - user.registeredAt) >= PENDING_DURATION) {
        tracker.users[jid].status = 'approved';
        tracker.users[jid].approvedAt = Date.now();
        saveTracker(tracker);
        return { ...tracker.users[jid], upgraded: true };
    }
    return user;
}

function deleteUserByNama(nama) {
    const tracker = getTracker();
    if (!tracker.users) return false;
    const lower = nama.toLowerCase();
    const jid = Object.keys(tracker.users).find(k => tracker.users[k].nama.toLowerCase() === lower);
    if (!jid) return false;
    delete tracker.users[jid];
    saveTracker(tracker);
    return true;
}

function approveUserByNama(nama) {
    const tracker = getTracker();
    if (!tracker.users) return null;
    const lower = nama.toLowerCase();
    const jid = Object.keys(tracker.users).find(k => tracker.users[k].nama.toLowerCase() === lower);
    if (!jid) return null;
    if (tracker.users[jid].status === 'owner') return tracker.users[jid];
    tracker.users[jid].status = 'approved';
    tracker.users[jid].approvedAt = Date.now();
    saveTracker(tracker);
    return tracker.users[jid];
}

// Format angka ke singkatan: 5000 -> 5K, 500000 -> 500K, 1500000 -> 1.5M
function formatRupiah(amount) {
    if (amount >= 1000000) {
        const val = amount / 1000000;
        return (val % 1 === 0 ? val : val.toFixed(1)) + 'M';
    } else if (amount >= 1000) {
        const val = amount / 1000;
        return (val % 1 === 0 ? val : val.toFixed(1)) + 'K';
    }
    return amount.toString();
}

async function fetchServerData() {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://fivestats.io/'
        };
        const urls = getFiveStatsUrls();
        const [serverRes, playersRes] = await Promise.all([
            axios.get(urls.server, { timeout: 10000, headers }),
            axios.get(urls.players, { timeout: 10000, headers })
        ]);

        // Deduplicate player berdasarkan ID (fivestats kadang return duplikat)
        const rawPlayers = playersRes.data || [];
        const seen = new Set();
        const uniquePlayers = rawPlayers.filter(p => {
            if (seen.has(p.id)) return false;
            seen.add(p.id);
            return true;
        });

        return {
            Data: {
                players: uniquePlayers,
                clients: serverRes.data?.clients || uniquePlayers.length || 0,
                hostname: serverRes.data?.hostname || ''
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
                let message = `🏍️ *WLMC BOT - SYSTEM ONLINE* 🏍️\n`;
                message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
                message += `🎮 *INDOPRIDE COMMANDS:*\n`;
                message += `🟢 #WLMC / #WL — List WLMC online di Indopride\n`;
                message += `🌐 #ALL [nama] — Cari player di semua server\n`;
                message += `🔍 #SEARCH [nama] — Cari player di Indopride\n`;
                message += `📊 #LISTALL — Statistik semua faksi\n`;
                message += `🆔 #KANTONG [ID] — Cari nama by ID\n`;
                message += `📡 #TOPPING — Cek ping player\n`;
                message += `🎲 #RANDOMID — Pick random player\n`;
                message += `📈 #SERVERINFO — Status server\n`;
                message += `⚙️ #SETIDP [code] — Ganti server code FiveM\n\n`;
                message += `🛠️ *TOOLS:*\n`;
                message += `🔗 #HEX [link] — Konversi Steam ke Hex\n`;
                message += `🖼️ #STICKER — Buat stiker dari foto\n`;
                message += `⏱️ #PING — Cek respon bot\n`;
                message += `🕐 #TIME — Waktu saat ini\n\n`;
                message += `💰 *INFO WLMC:*\n`;
                message += `💎 #DONATUR — List top donatur\n`;
                message += `📋 #WLMCINFO — Info grup & discord\n`;
                message += `🌊 #BADAI — Notif daily restart kota\n\n`;
                message += `🛡️ *ANTI-TOXIC:*\n`;
                message += `🔒 #ANTITOXIC — Aktifkan/nonaktifkan filter\n`;
                message += `📝 #LISTBADWORD — Lihat daftar kata toxic\n`;
                message += `➕ #ADDBADWORD [kata] — Tambah kata toxic\n`;
                message += `➖ #REMOVEBADWORD [kata] — Hapus kata toxic\n\n`;
                message += `━━━━━━━━━━━━━━━━━━━━\n`;
                message += `⏰ *Update otomatis setiap ${intervalText}*\n`;
                message += `_WLMC GACORRRRRRRRRRRRRRRRRRRR_ 🔥`;

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
        // Track sesi kirim: key = "YYYY-MM-DD-HH" supaya tiap jam hanya kirim 1x
        const sentSessions = new Set();

        async function checkRestart() {
            try {
                // Selalu pakai WIB (Asia/Jakarta) agar tidak bergantung timezone server
                const nowWIB = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
                const hour   = nowWIB.getHours();
                const minute = nowWIB.getMinutes();

                // Hanya proses di jam 06 atau 18
                if (hour !== 6 && hour !== 18) return;

                // Buat key unik per hari + jam, misal "2026-06-10-06"
                const dateKey = `${nowWIB.getFullYear()}-${String(nowWIB.getMonth()+1).padStart(2,'0')}-${String(nowWIB.getDate()).padStart(2,'0')}-${String(hour).padStart(2,'0')}`;

                // Sudah dikirim di sesi ini? Skip
                if (sentSessions.has(dateKey)) return;

                // Hanya kirim di menit 0 s/d 2 (toleransi 2 menit kalau bot baru start)
                if (minute > 2) return;

                const tracker = getTracker();
                const restartGroups = tracker.restartGroups || [];
                if (restartGroups.length === 0) return;

                // Tandai sudah kirim SEBELUM loop, supaya tidak double-send
                sentSessions.add(dateKey);

                const waktuLabel = hour === 6 ? 'Pagi (06:00)' : 'Sore (18:00)';
                const restartMessage =
                    `🔄 *DAILY RESTART SERVER KOTA* 🔄\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `⚠️ *INFO:* Server kota sedang melakukan daily restart ${waktuLabel}.\n\n` +
                    `Silakan tunggu beberapa menit lalu relog kota kembali. Pastikan kendaraan dan barang bawaan sudah aman sebelum server kembali online!\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `_WLMC Relog Setelah Server Online!_ 🏍️🔥`;

                console.log(`[RESTART NOTIF] Mengirim notif badai jam ${hour}:00 WIB ke ${restartGroups.length} grup...`);
                for (const jid of restartGroups) {
                    try {
                        await sock.sendMessage(jid, { text: restartMessage });
                        console.log(`[RESTART NOTIF] Sent to ${jid}`);
                    } catch (err) {
                        console.error(`[ERROR] Failed to send restart notif to ${jid}:`, err.message);
                    }
                }
            } catch (err) {
                console.error('[ERROR] checkRestart failed:', err);
            }
        }

        // Jalankan setiap 30 detik untuk lebih responsif
        setInterval(checkRestart, 30 * 1000);
        console.log('[RESTART NOTIF] Scheduler aktif — notif akan dikirim jam 06:00 & 18:00 WIB');
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
        const content = type === 'conversation' ? msg.message.conversation : type === 'extendedTextMessage' ? msg.message.extendedTextMessage.text : type === 'imageMessage' ? (msg.message.imageMessage.caption || '') : '';
        if (!content && type !== 'imageMessage') return; // skip pesan non-teks
        const command = (content || '').trim().toUpperCase();

        console.log(`[DEBUG] Pesan masuk dari ${from}: ${content}`);
        console.log(`[DEBUG] Command: ${command}`);

        // === ANTI TOXIC FILTER ===
        const isGroup = from.endsWith('@g.us');
        if (isGroup && content) {
            const tracker = getTracker();
            const antiToxicGroups = tracker.antiToxicGroups || [];
            if (antiToxicGroups.includes(from)) {
                const lowerContent = content.toLowerCase().replace(/[^a-z0-9]/g, '');
                const allBadWords = [...TOXIC_WORDS, ...(tracker.customBadWords || [])];
                const foundToxic = allBadWords.find(word => {
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

        const senderJid = msg.key.participant || from;
        if (command.startsWith('/DAFTAR')) {
            const namaInput = content.replace(/\/daftar/gi, '').trim();

            if (!namaInput || namaInput.length < 3) {
                return sock.sendMessage(from, {
                    text: `╔══════════════════════════════╗\n║  ⚠️ FORMAT SALAH, BESTIE!   ║\n╚══════════════════════════════╝\n\nNama minimal *3 karakter* ya cuyy 😅\n\n➡️ Ketik: */daftar [nama kamu]*\nContoh: */daftar RiskiPenghancur*`
                }, { quoted: msg });
            }

            if (namaInput.length > 30) {
                return sock.sendMessage(from, {
                    text: `⚠️ Nama terlalu panjang cuyy! Maksimal *30 karakter* ya king.`
                }, { quoted: msg });
            }

            const existingUser = getUserByJid(senderJid);
            if (existingUser) {
                return sock.sendMessage(from, {
                    text: `╔══════════════════════════════╗\n║  ℹ️ UDAH TERDAFTAR, KING!   ║\n╚══════════════════════════════╝\n\nKamu udah terdaftar dengan nama *"${existingUser.nama}"* cuyy!\n\n👤 *Status:* ${existingUser.status.toUpperCase()}\n_Gak perlu daftar lagi ya!_ 🔥`
                }, { quoted: msg });
            }

            if (namaInput.toLowerCase() === OWNER_NAME.toLowerCase()) {
                registerUser(senderJid, OWNER_NAME);
                return sock.sendMessage(from, {
                    text: `╔═══════════════════════════════════╗\n║  👑 OWW, OWNER NIH TERNYATA!     ║\n╚═══════════════════════════════════╝\n\nHeyy *${OWNER_NAME}*! Kamu langsung di-ACC dari sistem karena kamu *OWNER* bot ini cuyy! 🔥\n\nGak perlu nunggu 5 menit, langsung gaskeun semua fitur!\n\n👑 *Status:* OWNER - Full Access\n⚡ *Approved:* Langsung dari sistem\n\n_Welcome back king!_ 🏍️🔥`
                }, { quoted: msg });
            }

            if (isNamaTaken(namaInput)) {
                return sock.sendMessage(from, {
                    text: `╔══════════════════════════════════╗\n║  ⚠️ NAMA UDAH KEPAKE, BESTIE!  ║\n╚══════════════════════════════════╝\n\nNama *"${namaInput}"* udah ada yang pake duluan di bot ini cuyy 😅\n\nCoba ganti nama lain ya:\n➡️ */daftar [nama baru kamu]*\n\n_Pilih nama yang unik biar kece!_ 🔥`
                }, { quoted: msg });
            }

            registerUser(senderJid, namaInput);
            return sock.sendMessage(from, {
                text: `╔══════════════════════════════╗\n║  ✅ DAFTAR BERHASIL, CUYY!  ║\n╚══════════════════════════════╝\n\nYooo *${namaInput}* berhasil masuk antrian! Sekarang tinggal tunggu bentar ya 🙏\n\n⏳ *Estimasi:* 18 menit\n👑 *Di-approve oleh:* James/Riski\n\nJangan buru-buru, sabar is power king, ditunggu ACC nya yaaa! 🔥🏍️\n\n_WLMC GACORRRRR_ 🔥`
            }, { quoted: msg });
        }

        const rawUserData = getUserByJid(senderJid);
        if (!rawUserData) {
            return sock.sendMessage(from, {
                text: `╔══════════════════════════════╗\n║  ⚠️ AKSES DITOLAK, KING!    ║\n╚══════════════════════════════╝\n\nMaaf cuy, kamu belum terdata di bot *James/Riski* jadi gak bisa akses fitur apapun dulu ye 🫡\n\nCara daftar gampang banget:\n➡️ Ketik: */daftar [nama kamu]*\n\nContoh:\n*/daftar RiskiPenghancur*\n\n_Setelah daftar, tunggu 5 menit biar James/Riski approve kamu ya!_ 🔥`
            }, { quoted: msg });
        }
        const userData = checkAndUpgradeUser(senderJid);
        if (userData.status === 'pending') {
            const sisaMs = PENDING_DURATION - (Date.now() - userData.registeredAt);
            const sisaMenit = Math.floor(sisaMs / 60000);
            const sisaDetik = Math.floor((sisaMs % 60000) / 1000);
            return sock.sendMessage(from, {
                text: `╔══════════════════════════════╗\n║  ⏳ BELUM DI-ACC KING!      ║\n╚══════════════════════════════╝\n\nSabar cuyy, akunmu *${userData.nama}* lagi dalam proses approval sama *James/Riski* 🙏\n\n⏱️ *Sisa waktu:* ${sisaMenit} menit ${sisaDetik} detik lagi\n\nTunggu dikit lagi ya bestie, abis ini kamu udah bisa gaskeun semua fitur bot!\n\n_KING JAMES TUNGGU ACC_ 🔥👑`
            }, { quoted: msg });
        }


        if (command === '#WLMC' || command === '#WL') {
            const data = await fetchServerData();
            if (!data || !data.Data) return sock.sendMessage(from, { text: '❌ Gagal mengambil data dari server FiveM.' }, { quoted: msg });

            const players = data.Data.players || [];
            const wlmcPlayers = players.filter(p => p.name.toUpperCase().includes('WLMC'));
            const totalOnline = data.Data.clients || 0;
            const maxSlot = data.Data.sv_maxclients || '?';
            const now = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

            let responseText = '';
            responseText += `╔══════════════════════════╗\n`;
            responseText += `║  🏍️  *WLMC TRACKER*  🏍️  ║\n`;
            responseText += `║  _IndoPride Roleplay_      ║\n`;
            responseText += `╚══════════════════════════╝\n\n`;

            if (wlmcPlayers.length > 0) {
                responseText += `👥 *MEMBER WLMC ONLINE — ${wlmcPlayers.length} ORANG*\n`;
                responseText += `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n`;
                wlmcPlayers.forEach((p, index) => {
                    const pingIcon = p.ping <= 50 ? '🟢' : p.ping <= 120 ? '🟡' : '🔴';
                    const num = String(index + 1).padStart(2, '0');
                    responseText += `*${num}.* 🎮 *${p.name}*\n`;
                    responseText += `      🪪 ID: \`${p.id}\`  ${pingIcon} Ping: *${p.ping}ms*\n`;
                    responseText += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`;
                });
            } else {
                responseText += `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n`;
                responseText += `😴 *Belum ada member WLMC yang online.*\n`;
                responseText += `    Kapan lagi masuk kota, King? 🏙️\n`;
                responseText += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`;
            }

            responseText += `\n📊 *STATUS SERVER*\n`;
            responseText += `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n`;
            responseText += `🌐 Total Online : *${totalOnline} / ${maxSlot} Players*\n`;
            responseText += `🏍️ WLMC Online  : *${wlmcPlayers.length} Orang*\n`;
            responseText += `🕐 Update       : *${now} WIB*\n`;
            responseText += `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n`;
            responseText += `🔥 _WLMC GACOR TERUS, KING!_ 🔥\n`;
            responseText += `_Bot by James/Riski_`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur #ALL [keyword] - Cari player di semua server FiveM
        if (command.startsWith('#ALL')) {
            const keyword = content.replace(/#all/gi, '').trim();
            if (!keyword) return sock.sendMessage(from, { text: 'ℹ️ Format: *#all [nama]*\nContoh: *#all wlmc*' }, { quoted: msg });

            await sock.sendMessage(from, { text: `🔍 Mencari *${keyword}* di semua server FiveM...` }, { quoted: msg });

            try {
                const res = await axios.get(`https://fivestats.io/api/players?search=${encodeURIComponent(keyword)}&limit=200`, {
                    timeout: 15000,
                    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120', 'Referer': 'https://fivestats.io/players' }
                });

                const allPlayers = res.data?.data || [];
                const now = Math.floor(Date.now() / 1000);
                const ONLINE_THRESHOLD = 1800; // 30 menit threshold (fivestats update ~12 menit sekali)

                // Filter: nama mengandung keyword DAN sedang online (last_seen < 10 menit)
                const filtered = allPlayers.filter(p =>
                    p.clean_name.toUpperCase().includes(keyword.toUpperCase()) &&
                    (now - p.last_seen) <= ONLINE_THRESHOLD
                );

                if (filtered.length === 0) {
                    return sock.sendMessage(from, { text: `❌ Tidak ada player *${keyword}* yang sedang online di server manapun saat ini.` }, { quoted: msg });
                }

                // Group by server
                const serverMap = {};
                filtered.forEach(p => {
                    const key = p.last_server_endpoint;
                    if (!serverMap[key]) serverMap[key] = { name: p.last_server_name, players: [] };
                    const minsAgo = Math.floor((now - p.last_seen) / 60);
                    serverMap[key].players.push(`${p.clean_name} _(${minsAgo}m lalu)_`);
                });

                const servers = Object.values(serverMap).sort((a, b) => b.players.length - a.players.length);

                let responseText = `🌐 *${keyword.toUpperCase()} DI SELURUH SERVER FIVEM* 🏍️\n`;
                responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;

                // Ringkasan per server di atas
                responseText += `� *RINGKASAN:*\n`;
                servers.slice(0, 10).forEach((srv) => {
                    const srvShort = srv.name.length > 30 ? srv.name.substring(0, 30) + '...' : srv.name;
                    responseText += `🟢 ${srvShort} = *${srv.players.length} online*\n`;
                });
                if (servers.length > 10) responseText += `➕ ...dan ${servers.length - 10} server lainnya\n`;

                responseText += `\n━━━━━━━━━━━━━━━━━━━━\n`;
                responseText += `👥 *DETAIL PER SERVER:*\n\n`;

                servers.slice(0, 10).forEach((srv, i) => {
                    const srvName = srv.name.length > 35 ? srv.name.substring(0, 35) + '...' : srv.name;
                    responseText += `${i + 1}️⃣ 🏠 *${srvName}*\n`;
                    responseText += `   👥 *${srv.players.length} orang online*\n`;
                    srv.players.forEach(name => {
                        responseText += `   🏍️ ${name}\n`;
                    });
                    responseText += `\n`;
                });

                responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
                responseText += `🟢 *Total: ${filtered.length} player* di *${servers.length} server*\n`;
                responseText += `_WLMC GACORRRRRRRRRRRRRRRRRRRR_ 🔥`;

                await sock.sendMessage(from, { text: responseText }, { quoted: msg });
            } catch (err) {
                console.error('[#ALL] Error:', err.message);
                await sock.sendMessage(from, { text: '❌ Gagal mengambil data. Coba lagi.' }, { quoted: msg });
            }
        }

        // Fitur #LISTBADWORD - Tampilkan daftar kata toxic
        if (command === '#LISTBADWORD') {
            const tracker = getTracker();
            const customWords = tracker.customBadWords || [];
            const allWords = [...TOXIC_WORDS, ...customWords];

            let responseText = `🚫 *DAFTAR KATA TOXIC*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
            responseText += `📋 *Default (${TOXIC_WORDS.length} kata):*\n`;
            responseText += TOXIC_WORDS.join(', ') + '\n\n';

            if (customWords.length > 0) {
                responseText += `➕ *Custom tambahan (${customWords.length} kata):*\n`;
                responseText += customWords.join(', ') + '\n\n';
            }

            responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `📝 *Total: ${allWords.length} kata*\n`;
            responseText += `_Gunakan #addbadword [kata] untuk tambah_\n`;
            responseText += `_Gunakan #removebadword [kata] untuk hapus_`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur #ADDBADWORD - Tambah kata toxic custom
        if (command.startsWith('#ADDBADWORD')) {
            const newWord = content.replace(/#addbadword/gi, '').trim().toLowerCase();
            if (!newWord) return sock.sendMessage(from, { text: 'ℹ️ Format: *#addbadword [kata]*\nContoh: *#addbadword katakasarnya*' }, { quoted: msg });

            const tracker = getTracker();
            if (!tracker.customBadWords) tracker.customBadWords = [];

            if (TOXIC_WORDS.includes(newWord) || tracker.customBadWords.includes(newWord)) {
                return sock.sendMessage(from, { text: `⚠️ Kata *"${newWord}"* sudah ada di daftar.` }, { quoted: msg });
            }

            tracker.customBadWords.push(newWord);
            saveTracker(tracker);
            await sock.sendMessage(from, { text: `✅ Kata *"${newWord}"* berhasil ditambahkan ke daftar toxic.` }, { quoted: msg });
        }

        // Fitur #REMOVEBADWORD - Hapus kata toxic custom
        if (command.startsWith('#REMOVEBADWORD')) {
            const removeWord = content.replace(/#removebadword/gi, '').trim().toLowerCase();
            if (!removeWord) return sock.sendMessage(from, { text: 'ℹ️ Format: *#removebadword [kata]*\nContoh: *#removebadword katakasarnya*' }, { quoted: msg });

            if (TOXIC_WORDS.includes(removeWord)) {
                return sock.sendMessage(from, { text: `⚠️ Kata *"${removeWord}"* adalah kata default dan tidak bisa dihapus.` }, { quoted: msg });
            }

            const tracker = getTracker();
            if (!tracker.customBadWords || !tracker.customBadWords.includes(removeWord)) {
                return sock.sendMessage(from, { text: `❌ Kata *"${removeWord}"* tidak ditemukan di daftar custom.` }, { quoted: msg });
            }

            tracker.customBadWords = tracker.customBadWords.filter(w => w !== removeWord);
            saveTracker(tracker);
            await sock.sendMessage(from, { text: `✅ Kata *"${removeWord}"* berhasil dihapus dari daftar toxic.` }, { quoted: msg });
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
            const tracker = getTracker();
            const donaturList = tracker.donatur || [];

            if (donaturList.length === 0) {
                return sock.sendMessage(from, { text: '📋 Belum ada data donatur.' }, { quoted: msg });
            }

            // Sort by total tertinggi
            const sorted = [...donaturList].sort((a, b) => b.total - a.total);

            let responseText = `💎 *TOP DONATUR WLMC* 💎\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━\n`;

            sorted.forEach((d, i) => {
                const medal = i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                responseText += `${medal} ${d.nama} — *${formatRupiah(d.total)}*\n`;
            });

            const totalAll = donaturList.reduce((sum, d) => sum + d.total, 0);
            responseText += `\n━━━━━━━━━━━━━━━━━━━━\n`;
            responseText += `💰 *Total Terkumpul: ${formatRupiah(totalAll)}*\n`;
            responseText += `👥 *${donaturList.length} Donatur*\n\n`;
            responseText += `*NOTE* = BAGI YANG MERASA ADA YANG SALAH HUBUNGIN JAMES/RISKI\n`;
            responseText += `🔥 *THANK YOU PARA DONATUR* 🔥`;

            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        }

        // Fitur /SETDONAME - Tambah nama donatur baru
        if (command.startsWith('/SETDONAME')) {
            const namaInput = content.replace(/\/setdoname/gi, '').trim();
            if (!namaInput) {
                return sock.sendMessage(from, {
                    text: `ℹ️ *Format:* /setdoname [nama]\nContoh: */setdoname Fikri*`
                }, { quoted: msg });
            }

            const tracker = getTracker();
            if (!tracker.donatur) tracker.donatur = [];

            // Cek nama sudah ada (case-insensitive)
            const existing = tracker.donatur.find(d => d.nama.toLowerCase() === namaInput.toLowerCase());
            if (existing) {
                return sock.sendMessage(from, {
                    text: `⚠️ Nama *"${existing.nama}"* sudah ada di list donatur dengan total *${formatRupiah(existing.total)}*.`
                }, { quoted: msg });
            }

            tracker.donatur.push({ nama: namaInput, total: 0 });
            saveTracker(tracker);

            await sock.sendMessage(from, {
                text: `✅ *${namaInput}* berhasil ditambahkan ke list donatur!\n💰 Total saat ini: *0*\n\n_Gunakan /setdonate ${namaInput} [jumlah] untuk tambah donasi._`
            }, { quoted: msg });
        }

        // Fitur /SETDONATE - Tambah jumlah donasi (akumulatif)
        if (command.startsWith('/SETDONATE')) {
            const args = content.replace(/\/setdonate/gi, '').trim().split(/\s+/);
            // Format: /setdonate [nama] [jumlah] — nama bisa lebih dari 1 kata, angka paling belakang
            if (args.length < 2) {
                return sock.sendMessage(from, {
                    text: `ℹ️ *Format:* /setdonate [nama] [jumlah]\nContoh: */setdonate Juanda 100000*\n\n_5000 = 5K, 50000 = 50K, 500000 = 500K_`
                }, { quoted: msg });
            }

            // Ambil angka dari argumen terakhir
            const jumlahStr = args[args.length - 1];
            const jumlah = parseInt(jumlahStr);
            if (isNaN(jumlah) || jumlah <= 0) {
                return sock.sendMessage(from, {
                    text: `❌ Jumlah tidak valid. Masukkan angka. Contoh: */setdonate Juanda 100000*`
                }, { quoted: msg });
            }

            // Nama = semua kata kecuali yang terakhir (angka)
            const namaInput = args.slice(0, args.length - 1).join(' ');

            const tracker = getTracker();
            if (!tracker.donatur) tracker.donatur = [];

            // Cari nama (case-insensitive)
            const idx = tracker.donatur.findIndex(d => d.nama.toLowerCase() === namaInput.toLowerCase());
            if (idx === -1) {
                return sock.sendMessage(from, {
                    text: `❌ Nama *"${namaInput}"* tidak ditemukan di list donatur.\n\n_Tambah dulu dengan: /setdoname ${namaInput}_`
                }, { quoted: msg });
            }

            const totalLama = tracker.donatur[idx].total;
            tracker.donatur[idx].total += jumlah;
            const totalBaru = tracker.donatur[idx].total;
            saveTracker(tracker);

            await sock.sendMessage(from, {
                text: `✅ *Donasi berhasil dicatat!*\n━━━━━━━━━━━━━━━━━━━━\n👤 *Nama:* ${tracker.donatur[idx].nama}\n➕ *Tambah:* ${formatRupiah(jumlah)}\n📊 *Sebelum:* ${formatRupiah(totalLama)}\n💰 *Total Sekarang:* *${formatRupiah(totalBaru)}*\n━━━━━━━━━━━━━━━━━━━━`
            }, { quoted: msg });
        }
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

        // Fitur #BADAI - Toggle notifikasi daily restart server (semua bisa)
        if (command === '#BADAI') {
            let tracker = getTracker();
            if (!tracker.restartGroups) tracker.restartGroups = [];
            if (tracker.restartGroups.includes(from)) {
                tracker.restartGroups = tracker.restartGroups.filter(id => id !== from);
                saveTracker(tracker);
                await sock.sendMessage(from, { text: `❌ *Daily Restart Notif dinonaktifkan untuk grup ini.*\nBot tidak akan lagi mengirim notifikasi daily restart jam 06:00 & 18:00.` }, { quoted: msg });
            } else {
                tracker.restartGroups.push(from);
                saveTracker(tracker);
                await sock.sendMessage(from, { text: `✅ *Daily Restart Notif berhasil diaktifkan!*\nBot akan otomatis mengirim pesan di grup ini setiap jam *06:00 Pagi* dan *18:00 Sore* saat server kota restart.` }, { quoted: msg });
            }
        }

        // Fitur #SETIDP - Ganti Server Code FiveM
        if (command.startsWith('#SETIDP')) {
            const newCode = content.replace(/#setidp/gi, '').trim();
            if (!newCode) {
                const currentCode = getServerCode();
                return sock.sendMessage(from, {
                    text: `ℹ️ *Format:* #setidp [server_code]\nContoh: *#setidp bak4pl*\n\n📡 *Server code aktif saat ini:* \`${currentCode}\`\n_Cek code di fivestats.io/servers_`
                }, { quoted: msg });
            }

            // Validasi format server code (alphanumeric, panjang wajar)
            if (!/^[a-zA-Z0-9]{4,10}$/.test(newCode)) {
                return sock.sendMessage(from, {
                    text: `❌ Server code tidak valid. Harus berupa huruf/angka, 4-10 karakter.\nContoh: *#setidp bak4pl*`
                }, { quoted: msg });
            }

            // Test dulu apakah code valid
            await sock.sendMessage(from, { text: `🔄 Mengecek server code *${newCode}*...` }, { quoted: msg });
            try {
                const testUrl = `https://fivestats.io/api/servers/${newCode}`;
                const testRes = await axios.get(testUrl, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 Chrome/120',
                        'Referer': 'https://fivestats.io/'
                    }
                });

                if (!testRes.data || testRes.data.error) {
                    return sock.sendMessage(from, {
                        text: `❌ Server code *${newCode}* tidak ditemukan di fivestats.io. Pastikan code sudah benar.`
                    }, { quoted: msg });
                }

                const oldCode = getServerCode();
                const tracker = getTracker();
                tracker.serverCode = newCode.toLowerCase();
                saveTracker(tracker);

                const serverName = testRes.data.hostname
                    ? testRes.data.hostname.replace(/\^./g, '').substring(0, 40)
                    : 'Unknown';

                await sock.sendMessage(from, {
                    text: `✅ *Server code berhasil diubah!*\n━━━━━━━━━━━━━━━━━━━━\n🔄 *Lama:* \`${oldCode}\`\n🆕 *Baru:* \`${newCode.toLowerCase()}\`\n🏠 *Server:* ${serverName}\n━━━━━━━━━━━━━━━━━━━━\n_Semua command (#WLMC, #SEARCH, dll) sekarang pakai server baru._`
                }, { quoted: msg });

                console.log(`[SETIDP] Server code changed: ${oldCode} → ${newCode.toLowerCase()}`);
            } catch (err) {
                console.error('[SETIDP] Error:', err.message);
                await sock.sendMessage(from, {
                    text: `❌ Gagal mengecek server code *${newCode}*. Pastikan code benar dan coba lagi.`
                }, { quoted: msg });
            }
        }

        // Fitur #LINKCONNECT
        if (command === '#LINKCONNECT') {
            const linkText =
                `🌐 *CONNECT SERVER INDOPRIDE* 🌐\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🖥️ *VIA WEBSITE:*\n` +
                `🔗 https://server.indopride.id/\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `⌨️ *VIA DIRECT CONNECT (tekan F8):*\n\n` +
                `🟢 \`connect kota.indopride.id\`\n` +
                `🟢 \`connect kota2.indopride.id\`\n` +
                `🟢 \`connect kota3.indopride.id\`\n` +
                `🟢 \`connect kota4.indopride.id\`\n` +
                `🟢 \`connect kota5.indopride.id\`\n` +
                `🟢 \`connect kota6.indopride.id\`\n` +
                `🟢 \`connect kota7.indopride.id\`\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `_Pilih server yang ping nya paling kenceng ya!_ 🏍️🔥`;
            await sock.sendMessage(from, { text: linkText }, { quoted: msg });
        }

        // === OWNER ONLY COMMANDS ===
        const isOwner = userData.status === 'owner';

        // /HAPUSUSER [nama] - Hapus user berdasarkan nama
        if (command.startsWith('/HAPUSUSER')) {
            if (!isOwner) return sock.sendMessage(from, { text: `🚫 *Akses ditolak!* Command ini hanya untuk *riski/james* cuyy.` }, { quoted: msg });

            const namaHapus = content.replace(/\/hapususer/gi, '').trim();
            if (!namaHapus) {
                return sock.sendMessage(from, {
                    text: `ℹ️ *Format:* /hapususer [nama]\nContoh: */hapususer RiskiPenghancur*`
                }, { quoted: msg });
            }

            if (namaHapus.toLowerCase() === OWNER_NAME.toLowerCase()) {
                return sock.sendMessage(from, { text: `❌ Gak bisa hapus akun *riski/james* sendiri cuyy! 😅` }, { quoted: msg });
            }

            const deleted = deleteUserByNama(namaHapus);
            if (!deleted) {
                return sock.sendMessage(from, {
                    text: `❌ User dengan nama *"${namaHapus}"* tidak ditemukan di database.`
                }, { quoted: msg });
            }

            await sock.sendMessage(from, {
                text: `✅ *User berhasil dihapus!*\n━━━━━━━━━━━━━━━━━━━━\n🗑️ *Nama:* ${namaHapus}\n\nMereka harus */daftar* ulang kalau mau akses bot lagi.\n_riski/james approved this removal_ 👑`
            }, { quoted: msg });
        }

        // /LISTUSER - Tampilkan semua user terdaftar
        if (command === '/LISTUSER') {
            if (!isOwner) return sock.sendMessage(from, { text: `🚫 *Akses ditolak!* Command ini hanya untuk *riski/james* cuyy.` }, { quoted: msg });

            const tracker = getTracker();
            const users = tracker.users || {};
            const entries = Object.entries(users);

            if (entries.length === 0) {
                return sock.sendMessage(from, { text: `📋 Belum ada user terdaftar di bot.` }, { quoted: msg });
            }

            const now = Date.now();
            let ownerCount = 0, approvedCount = 0, pendingCount = 0;
            let listText = `📋 *DAFTAR USER TERDAFTAR*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

            entries.forEach(([, u]) => {
                if (u.status === 'owner') {
                    listText += `👑 *${u.nama}* — OWNER\n`;
                    ownerCount++;
                } else if (u.status === 'approved') {
                    listText += `✅ *${u.nama}* — Approved\n`;
                    approvedCount++;
                } else {
                    const sisaMs = PENDING_DURATION - (now - u.registeredAt);
                    const sisaMenit = Math.max(0, Math.floor(sisaMs / 60000));
                    const sisaDetik = Math.max(0, Math.floor((sisaMs % 60000) / 1000));
                    listText += `⏳ *${u.nama}* — Pending (${sisaMenit}m ${sisaDetik}s lagi)\n`;
                    pendingCount++;
                }
            });

            listText += `\n━━━━━━━━━━━━━━━━━━━━\n`;
            listText += `📊 *Total: ${entries.length}* | 👑 ${ownerCount} Owner | ✅ ${approvedCount} Approved | ⏳ ${pendingCount} Pending`;

            await sock.sendMessage(from, { text: listText }, { quoted: msg });
        }

        // /APPROVEUSER [nama] - Approve user secara manual
        if (command.startsWith('/APPROVEUSER')) {
            if (!isOwner) return sock.sendMessage(from, { text: `🚫 *Akses ditolak!* Command ini hanya untuk *riski/james* cuyy.` }, { quoted: msg });

            const namaApprove = content.replace(/\/approveuser/gi, '').trim();
            if (!namaApprove) {
                return sock.sendMessage(from, {
                    text: `ℹ️ *Format:* /approveuser [nama]\nContoh: */approveuser RiskiPenghancur*`
                }, { quoted: msg });
            }

            const approvedUser = approveUserByNama(namaApprove);
            if (!approvedUser) {
                return sock.sendMessage(from, {
                    text: `❌ User dengan nama *"${namaApprove}"* tidak ditemukan di database.`
                }, { quoted: msg });
            }

            if (approvedUser.status === 'owner') {
                return sock.sendMessage(from, { text: `ℹ️ *${namaApprove}* udah owner, gak perlu di-approve lagi cuyy.` }, { quoted: msg });
            }

            await sock.sendMessage(from, {
                text: `✅ *User berhasil di-approve!*\n━━━━━━━━━━━━━━━━━━━━\n👤 *Nama:* ${approvedUser.nama}\n⚡ *Status:* APPROVED - Bisa pake bot sekarang!\n_Manual approved by riski/james_ 👑`
            }, { quoted: msg });
        }

        // Fitur #MENU
        if (command === '#MENU') {
            let menuText = `🏍️ *WLMC BOT - COMMAND MENU* 🏍️\n`;
            menuText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
            menuText += `🎮 *INDOPRIDE COMMANDS:*\n`;
            menuText += `🟢 #WLMC / #WL — List WLMC online di Indopride\n`;
            menuText += `🌐 #ALL [nama] — Cari player di semua server\n`;
            menuText += `🔍 #SEARCH [nama] — Cari player di Indopride\n`;
            menuText += `📊 #LISTALL — Statistik semua faksi\n`;
            menuText += `🆔 #KANTONG [ID] — Cari nama by ID\n`;
            menuText += `📡 #TOPPING — Cek ping player\n`;
            menuText += `🎲 #RANDOMID — Pick random player\n`;
            menuText += `📈 #SERVERINFO — Status server\n`;
            menuText += `⚙️ #SETIDP [code] — Ganti server code FiveM\n`;
            menuText += `🔌 #LINKCONNECT — Link connect server Indopride\n\n`;
            menuText += `🛠️ *TOOLS:*\n`;
            menuText += `🔗 #HEX [link] — Konversi Steam ke Hex\n`;
            menuText += `🖼️ #STICKER — Buat stiker dari foto\n`;
            menuText += `⏱️ #PING — Cek respon bot\n`;
            menuText += `🕐 #TIME — Waktu saat ini\n\n`;
            menuText += `💰 *INFO WLMC:*\n`;
            menuText += `💎 #DONATUR — List top donatur\n`;
            menuText += `➕ /setdoname [nama] — Tambah nama donatur baru\n`;
            menuText += `💸 /setdonate [nama] [jumlah] — Catat donasi (akumulatif)\n`;
            menuText += `📋 #WLMCINFO — Info grup & discord\n`;
            menuText += `🌊 #BADAI — Aktifkan/nonaktifkan notif restart kota\n\n`;
            menuText += `🛡️ *ANTI-TOXIC:*\n`;
            menuText += `🔒 #ANTITOXIC — Aktifkan/nonaktifkan filter kata kasar\n`;
            menuText += `📝 #LISTBADWORD — Lihat daftar kata toxic\n`;
            menuText += `➕ #ADDBADWORD [kata] — Tambah kata toxic\n`;
            menuText += `➖ #REMOVEBADWORD [kata] — Hapus kata toxic custom\n\n`;
            if (isOwner) {
                menuText += `👑 *OWNER ONLY (riski/james):*\n`;
                menuText += `📋 /listuser — Lihat semua user terdaftar\n`;
                menuText += `✅ /approveuser [nama] — Approve user manual\n`;
                menuText += `🗑️ /hapususer [nama] — Hapus user dari database\n\n`;
            }
            menuText += `━━━━━━━━━━━━━━━━━━━━\n`;
            menuText += `_Bot by James/Riski_ 🔥`;

            await sock.sendMessage(from, { text: menuText }, { quoted: msg });
        }
    });
}

connectToWhatsApp();
