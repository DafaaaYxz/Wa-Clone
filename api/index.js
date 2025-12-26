
const express = require('express');
const { Redis } = require('@upstash/redis');
const path = require('path');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');

const app = express();

// --- KONFIGURASI UPSTASH (WAJIB ISI AGAR WORK) ---
const redis = new Redis({
  url: 'MASUKKAN_URL_UPSTASH_DI_SINI',
  token: 'MASUKKAN_TOKEN_UPSTASH_DI_SINI',
});

// Setting View Engine EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));

// Middleware
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cookieParser());

// Middleware: Cek Login & Update Status Online
const auth = async (req, res, next) => {
    const phone = req.cookies.userPhone;
    if (!phone) {
        if (req.path === '/' || req.path === '/login' || req.path === '/register') {
            return next();
        }
        return res.redirect('/');
    }
    
    // Simpan status online selama 60 detik (auto offline jika tidak ada aktivitas)
    await redis.set(`status:${phone}`, 'online', { ex: 60 });
    req.userPhone = phone;
    next();
};

// --- ROUTES ---

// 1. Halaman Login/Daftar
app.get('/', (req, res) => {
    if (req.cookies.userPhone) return res.redirect('/home');
    res.render('auth');
});

// 2. Proses Daftar (Auto Nomor +88)
app.post('/register', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.json({ success: false, message: "Nama wajib diisi" });

    let phone;
    let isUnique = false;

    // Loop untuk memastikan nomor tidak duplikat di database
    while (!isUnique) {
        const randomDigits = Math.floor(10000000 + Math.random() * 90000000); // 8 digit
        phone = `+88${randomDigits}`;
        const exists = await redis.get(`user:${phone}`);
        if (!exists) isUnique = true;
    }

    const userData = { 
        phone, 
        name, 
        bio: "Hey there! I am using WhatsApp", 
        photo: "https://cdn-icons-png.flaticon.com/512/149/149071.png" 
    };

    await redis.set(`user:${phone}`, JSON.stringify(userData));
    await redis.sadd('all_users', phone); // Masuk ke list kontak global

    res.cookie('userPhone', phone, { maxAge: 30 * 24 * 60 * 60 * 1000 }); // Login 30 hari
    res.json({ success: true, phone });
});

// 3. Proses Login
app.post('/login', async (req, res) => {
    const { phone } = req.body;
    const user = await redis.get(`user:${phone}`);
    if (user) {
        res.cookie('userPhone', phone, { maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.json({ success: true });
    } else {
        res.json({ success: false, message: "Nomor tidak ditemukan!" });
    }
});

// 4. Beranda (List Riwayat Chat Terupdate)
app.get('/home', auth, async (req, res) => {
    const myPhone = req.userPhone;
    const me = await redis.get(`user:${myPhone}`);

    // Ambil daftar nomor yang pernah chat dengan saya (Urut berdasarkan waktu terbaru)
    const contactPhones = await redis.zrange(`chat_list:${myPhone}`, 0, -1, { rev: true }) || [];
    
    let chatList = [];
    for (let cPhone of contactPhones) {
        const cData = await redis.get(`user:${cPhone}`);
        if (cData) {
            // Ambil pesan terakhir untuk ditampilkan di bawah nama
            const chatId = [myPhone, cPhone].sort().join('_');
            const lastMsgRaw = await redis.lindex(`chats:${chatId}`, 0);
            if (lastMsgRaw) {
                const parsed = JSON.parse(lastMsgRaw);
                cData.lastMsg = parsed.photo ? "📷 Foto" : parsed.text;
                cData.lastTime = parsed.time;
            } else {
                cData.lastMsg = "Belum ada pesan";
                cData.lastTime = "";
            }
            chatList.push(cData);
        }
    }

    res.render('home', { me, chatList });
});

// 5. Chat Privat (Halaman Pesan)
app.get('/chat/:targetPhone', auth, async (req, res) => {
    const myPhone = req.userPhone;
    const targetPhone = req.params.targetPhone;
    
    const targetUser = await redis.get(`user:${targetPhone}`);
    if (!targetUser) return res.redirect('/home');

    const status = await redis.get(`status:${targetPhone}`) || 'offline';
    
    // Ambil history chat
    const chatId = [myPhone, targetPhone].sort().join('_');
    const messages = await redis.lrange(`chats:${chatId}`, 0, -1) || [];

    res.render('chat', { targetUser, messages, myPhone, status });
});

// 6. Proses Kirim Pesan (Teks & Foto)
app.post('/send-message', auth, async (req, res) => {
    const { targetPhone, text, photoData } = req.body;
    const myPhone = req.userPhone;
    const chatId = [myPhone, targetPhone].sort().join('_');
    const timestamp = Date.now();

    const newMessage = {
        sender: myPhone,
        text: text || "",
        photo: photoData || null,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // Simpan pesan ke daftar chat
    await redis.lpush(`chats:${chatId}`, JSON.stringify(newMessage));
    
    // Update urutan di halaman beranda (ZADD agar yang terbaru naik ke atas)
    await redis.zadd(`chat_list:${myPhone}`, { score: timestamp, member: targetPhone });
    await redis.zadd(`chat_list:${targetPhone}`, { score: timestamp, member: myPhone });
    
    res.json({ success: true });
});

// 7. Kontak Global & Fitur Cari
app.get('/contacts', auth, async (req, res) => {
    const allPhones = await redis.smembers('all_users');
    let users = [];
    for (let p of allPhones) {
        if (p !== req.userPhone) {
            const u = await redis.get(`user:${p}`);
            if(u) users.push(u);
        }
    }
    res.render('contacts', { users });
});

// Tambah Kontak manual ke history
app.post('/add-contact', auth, async (req, res) => {
    const { targetPhone } = req.body;
    const timestamp = Date.now();
    await redis.zadd(`chat_list:${req.userPhone}`, { score: timestamp, member: targetPhone });
    res.json({ success: true });
});

// 8. Halaman Profil
app.get('/profile/:phone', auth, async (req, res) => {
    const targetPhone = req.params.phone;
    const user = await redis.get(`user:${targetPhone}`);
    if (!user) return res.redirect('/home');

    const isMe = (targetPhone === req.userPhone);
    res.render('profile', { user, isMe });
});

// 9. Update Profil Sendiri
app.post('/profile/update', auth, async (req, res) => {
    const { name, bio, photo } = req.body;
    const updatedData = { 
        phone: req.userPhone, 
        name, 
        bio, 
        photo: photo || "https://cdn-icons-png.flaticon.com/512/149/149071.png" 
    };
    await redis.set(`user:${req.userPhone}`, JSON.stringify(updatedData));
    res.json({ success: true });
});

// Export untuk Vercel
module.exports = app;
