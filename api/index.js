
const express = require('express');
const { Redis } = require('@upstash/redis');
const path = require('path');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');

const app = express();

// --- KONFIGURASI UPSTASH ---
const redis = new Redis({
  url: 'https://growing-firefly-50232.upstash.io',
  token: 'AcQ4AAIncDFlYjI2ZWM2ODhmOGQ0N2YwOTI1Njg5ZDA3ZjRjMDdhMHAxNTAyMzI',
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cookieParser());

// Middleware Auth
const auth = async (req, res, next) => {
    const phone = req.cookies.userPhone;
    if (!phone) {
        if (req.path === '/' || req.path === '/login' || req.path === '/register') return next();
        return res.redirect('/');
    }
    await redis.set(`status:${phone}`, 'online', { ex: 60 });
    req.userPhone = phone;
    next();
};

// Routes
app.get('/', (req, res) => {
    if (req.cookies.userPhone) return res.redirect('/home');
    res.render('auth');
});

app.post('/register', async (req, res) => {
    const { name } = req.body;
    let phone;
    let isUnique = false;
    while (!isUnique) {
        const randomDigits = Math.floor(10000000 + Math.random() * 90000000);
        phone = `+88${randomDigits}`;
        const exists = await redis.get(`user:${phone}`);
        if (!exists) isUnique = true;
    }
    const userData = { phone, name, bio: "Available", photo: "https://cdn-icons-png.flaticon.com/512/149/149071.png" };
    await redis.set(`user:${phone}`, userData);
    await redis.sadd('all_users', phone);
    res.cookie('userPhone', phone, { maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, phone });
});

app.post('/login', async (req, res) => {
    const { phone } = req.body;
    const user = await redis.get(`user:${phone}`);
    if (user) {
        res.cookie('userPhone', phone, { maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
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

app.get('/chat/:targetPhone', auth, async (req, res) => {
    const myPhone = req.userPhone;
    const targetPhone = req.params.targetPhone;
    const targetUser = await redis.get(`user:${targetPhone}`);
    if (!targetUser) return res.redirect('/home');
    const status = await redis.get(`status:${targetPhone}`) || 'offline';
    const chatId = [myPhone, targetPhone].sort().join('_');
    // Ambil pesan (Upstash otomatis parse JSON ke Object)
    const messages = await redis.lrange(`chats:${chatId}`, 0, -1) || [];
    res.render('chat', { targetUser, messages, myPhone, status });
});

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
    await redis.lpush(`chats:${chatId}`, newMessage);
    await redis.zadd(`chat_list:${myPhone}`, { score: timestamp, member: targetPhone });
    await redis.zadd(`chat_list:${targetPhone}`, { score: timestamp, member: myPhone });
    res.json({ success: true });
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

app.post('/add-contact', auth, async (req, res) => {
    await redis.zadd(`chat_list:${req.userPhone}`, { score: Date.now(), member: req.body.targetPhone });
    res.json({ success: true });
});

app.get('/profile/:phone', auth, async (req, res) => {
    const user = await redis.get(`user:${req.params.phone}`);
    res.render('profile', { user, isMe: req.params.phone === req.userPhone });
});

app.post('/profile/update', auth, async (req, res) => {
    const { name, bio, photo } = req.body;
    const updated = { phone: req.userPhone, name, bio, photo };
    await redis.set(`user:${req.userPhone}`, updated);
    res.json({ success: true });
});

module.exports = app;
