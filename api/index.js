
const express = require('express');
const { Redis } = require('@upstash/redis');
const path = require('path');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const multer = require('multer');

const app = express();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // Limit 5MB

// --- KONFIGURASI UPSTASH (MASUKKAN DATA ANDA DI SINI) ---
const redis = new Redis({
  url: 'MASUKKAN_URL_UPSTASH_DI_SINI',
  token: 'MASUKKAN_TOKEN_UPSTASH_DI_SINI',
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cookieParser());

// Middleware cek login
const auth = async (req, res, next) => {
  const phone = req.cookies.userPhone;
  if (!phone) return res.redirect('/');
  req.userPhone = phone;
  // Update status online
  await redis.set(`status:${phone}`, 'online', { ex: 60 }); 
  next();
};

// --- ROUTES ---

// Halaman Awal (Login/Daftar)
app.get('/', (req, res) => {
  res.render('auth');
});

// Proses Daftar
app.post('/register', async (req, res) => {
  const { name } = req.body;
  // Generate nomor otomatis +88 + 8 digit acak
  let phone;
  let isUnique = false;
  while (!isUnique) {
    const randomDigits = Math.floor(10000000 + Math.random() * 90000000);
    phone = `+88${randomDigits}`;
    const exists = await redis.get(`user:${phone}`);
    if (!exists) isUnique = true;
  }

  const userData = { phone, name, bio: "Hey there! I am using WhatsApp", photo: "https://cdn-icons-png.flaticon.com/512/149/149071.png" };
  await redis.set(`user:${phone}`, JSON.stringify(userData));
  await redis.sadd('all_users', phone);

  res.cookie('userPhone', phone);
  res.json({ success: true, phone });
});

// Proses Login
app.post('/login', async (req, res) => {
  const { phone } = req.body;
  const user = await redis.get(`user:${phone}`);
  if (user) {
    res.cookie('userPhone', phone);
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "Nomor tidak terdaftar" });
  }
});

// Beranda (List Chat)
app.get('/home', auth, async (req, res) => {
  const myPhone = req.userPhone;
  const me = await redis.get(`user:${myPhone}`);
  // Ambil history chat (disederhanakan)
  const contacts = await redis.smembers(`contacts:${myPhone}`) || [];
  let chatList = [];
  for (let cPhone of contacts) {
    const cData = await redis.get(`user:${cPhone}`);
    if(cData) chatList.push(cData);
  }
  res.render('home', { me, chatList });
});

// Kontak Global & Search
app.get('/contacts', auth, async (req, res) => {
  const allPhones = await redis.smembers('all_users');
  let users = [];
  for (let p of allPhones) {
    if (p !== req.userPhone) {
      const u = await redis.get(`user:${p}`);
      users.push(u);
    }
  }
  res.render('contacts', { users });
});

// Simpan Kontak
app.post('/add-contact', auth, async (req, res) => {
  const { targetPhone } = req.body;
  await redis.sadd(`contacts:${req.userPhone}`, targetPhone);
  res.json({ success: true });
});

// Chat Privat
app.get('/chat/:targetPhone', auth, async (req, res) => {
  const myPhone = req.userPhone;
  const targetPhone = req.params.targetPhone;
  const targetUser = await redis.get(`user:${targetPhone}`);
  const status = await redis.get(`status:${targetPhone}`) || 'offline';
  
  // Ambil chat log
  const chatId = [myPhone, targetPhone].sort().join('_');
  const messages = await redis.lrange(`chats:${chatId}`, 0, -1) || [];

  res.render('chat', { targetUser, messages: messages.reverse(), myPhone, status });
});

// Kirim Pesan
app.post('/send-message', auth, upload.single('photo'), async (req, res) => {
  const { targetPhone, text } = req.body;
  const myPhone = req.userPhone;
  const chatId = [myPhone, targetPhone].sort().join('_');

  const newMessage = {
    sender: myPhone,
    text: text || "",
    photo: req.body.photoData || null, // Base64 handling
    time: new Date().toLocaleTimeString()
  };

  await redis.lpush(`chats:${chatId}`, JSON.stringify(newMessage));
  await redis.sadd(`contacts:${myPhone}`, targetPhone); // Auto save to history
  await redis.sadd(`contacts:${targetPhone}`, myPhone);
  
  res.json({ success: true });
});

// Profile Saya & Orang Lain
app.get('/profile/:phone', auth, async (req, res) => {
  const targetPhone = req.params.phone;
  const user = await redis.get(`user:${targetPhone}`);
  const isMe = (targetPhone === req.userPhone);
  res.render('profile', { user, isMe });
});

// Update Profile
app.post('/profile/update', auth, async (req, res) => {
  const { name, bio, photo } = req.body;
  const userData = { phone: req.userPhone, name, bio, photo };
  await redis.set(`user:${req.userPhone}`, JSON.stringify(userData));
  res.json({ success: true });
});

module.exports = app;
