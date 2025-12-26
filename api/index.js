
const express = require('express');
const { Redis } = require('@upstash/redis');
const path = require('path');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');

const app = express();
const redis = new Redis({
  url: 'https://growing-firefly-50232.upstash.io',
  token: 'AcQ4AAIncDFlYjI2ZWM2ODhmOGQ0N2YwOTI1Njg5ZDA3ZjRjMDdhMHAxNTAyMzI',
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cookieParser());

// Fungsi Waktu Indonesia (WIB)
const getWIB = () => {
    return new Date().toLocaleTimeString('id-ID', { 
        timeZone: 'Asia/Jakarta', 
        hour: '2-digit', 
        minute: '2-digit' 
    });
};

// Middleware Auth
const auth = async (req, res, next) => {
    const phone = req.cookies.userPhone;
    if (!phone) return res.redirect('/');
    await redis.set(`status:${phone}`, 'online', { ex: 60 });
    req.userPhone = phone;
    next();
};

// --- ROUTES ---

app.get('/', (req, res) => res.render('auth'));

app.post('/register', async (req, res) => {
    const { name } = req.body;
    let phone;
    let isUnique = false;
    while (!isUnique) {
        phone = `+88${Math.floor(10000000 + Math.random() * 90000000)}`;
        if (!(await redis.get(`user:${phone}`))) isUnique = true;
    }
    const userData = { phone, name, bio: "Available", photo: "https://cdn-icons-png.flaticon.com/512/149/149071.png", pin: null };
    await redis.set(`user:${phone}`, userData);
    await redis.sadd('all_users', phone);
    res.cookie('userPhone', phone, { maxAge: 30*24*60*60*1000 });
    res.json({ success: true, phone });
});

// Login Tahap 1: Cek Nomor & PIN
app.post('/login', async (req, res) => {
    const { phone, pin } = req.body;
    const user = await redis.get(`user:${phone}`);
    if (!user) return res.json({ success: false, message: "Nomor tidak terdaftar" });

    // Jika user punya PIN, wajib masukkan PIN
    if (user.pin && user.pin !== pin) {
        return res.json({ success: false, message: "PIN Salah!", needsPin: true });
    }

    res.cookie('userPhone', phone, { maxAge: 30*24*60*60*1000 });
    res.json({ success: true });
});

app.get('/home', auth, async (req, res) => {
    const myPhone = req.userPhone;
    const me = await redis.get(`user:${myPhone}`);
    const contactPhones = await redis.zrange(`chat_list:${myPhone}`, 0, -1, { rev: true }) || [];
    let chatList = [];
    for (let cPhone of contactPhones) {
        const cData = await redis.get(`user:${cPhone}`);
        if (cData) {
            const chatId = [myPhone, cPhone].sort().join('_');
            const lastMsg = await redis.lindex(`chats:${chatId}`, 0);
            cData.lastMsg = lastMsg ? (lastMsg.photo ? "📷 Foto" : lastMsg.text) : "...";
            cData.lastTime = lastMsg ? lastMsg.time : "";
            chatList.push(cData);
        }
    }
    res.render('home', { me, chatList });
});

// Chat Page & Update Centang Biru (Read)
app.get('/chat/:targetPhone', auth, async (req, res) => {
    const myPhone = req.userPhone;
    const targetPhone = req.params.targetPhone;
    const targetUser = await redis.get(`user:${targetPhone}`);
    const status = await redis.get(`status:${targetPhone}`) || 'offline';
    const chatId = [myPhone, targetPhone].sort().join('_');
    
    let messages = await redis.lrange(`chats:${chatId}`, 0, -1) || [];

    // Logika Centang Biru: Jika saya buka chat, tandai semua pesan lawan sebagai 'read'
    let updated = false;
    messages = messages.map(msg => {
        if (msg.sender === targetPhone && msg.status !== 'read') {
            msg.status = 'read';
            updated = true;
        }
        return msg;
    });

    if (updated) {
        await redis.del(`chats:${chatId}`);
        for (let m of messages.reverse()) await redis.lpush(`chats:${chatId}`, m);
        messages.reverse(); // Kembalikan urutan untuk tampilan
    }

    res.render('chat', { targetUser, messages, myPhone, status });
});

app.post('/send-message', auth, async (req, res) => {
    const { targetPhone, text, photoData } = req.body;
    const myPhone = req.userPhone;
    const chatId = [myPhone, targetPhone].sort().join('_');
    const isOnline = await redis.get(`status:${targetPhone}`);

    const newMessage = {
        sender: myPhone,
        text: text || "",
        photo: photoData || null,
        time: getWIB(),
        status: isOnline ? 'delivered' : 'sent' // centang 2 (online) atau centang 1 (offline)
    };

    await redis.lpush(`chats:${chatId}`, newMessage);
    await redis.zadd(`chat_list:${myPhone}`, { score: Date.now(), member: targetPhone });
    await redis.zadd(`chat_list:${targetPhone}`, { score: Date.now(), member: myPhone });
    res.json({ success: true });
});

// Create/Update A2F PIN
app.post('/profile/a2f', auth, async (req, res) => {
    const { pin } = req.body;
    const user = await redis.get(`user:${req.userPhone}`);
    user.pin = pin; // 6 digit
    await redis.set(`user:${req.userPhone}`, user);
    res.json({ success: true, pin });
});

app.get('/profile/:phone', auth, async (req, res) => {
    const user = await redis.get(`user:${req.params.phone}`);
    res.render('profile', { user, isMe: req.params.phone === req.userPhone });
});

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

module.exports = app;
