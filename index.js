// api/index.js

// Variabel dari file .env (hanya untuk pengembangan lokal).
// Di Vercel, variabel ini akan diambil langsung dari Environment Variables yang Anda set di Dashboard.
require('dotenv').config(); 

// Impor library yang dibutuhkan
const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const crypto = require('crypto');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

// --- INISIALISASI FIREBASE ADMIN SDK ---
// PENTING: Mengambil kredensial dari Environment Variable, BUKAN dari file lokal.
let db;
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set!');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('Firebase Admin SDK initialized successfully from Environment Variable.');
} catch (error) {
  console.error('ERROR: Failed to initialize Firebase Admin SDK:', error.message);
  // Di lingkungan produksi Vercel, error ini akan menyebabkan fungsi gagal.
  // Pastikan variabel lingkungan sudah benar.
  db = null; // Menandai bahwa Firestore tidak dapat digunakan
}

// --- KONFIGURASI APLIKASI EXPRESS ---
const app = express();
// Vercel akan mengelola port secara otomatis, jadi tidak perlu app.listen()
app.use(cors());
app.use(express.json());

// --- KONFIGURASI MIDTRANS ---
const snap = new midtransClient.Snap({
  // Atur isProduction berdasarkan NODE_ENV Vercel
  isProduction: process.env.NODE_ENV === 'production',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

// ===================================
// --- ENDPOINT UNTUK MEMBUAT TRANSAKSI ---
// ===================================
app.post('/create-transaction', async (req, res) => {
  try {
    const transaction = await snap.createTransaction(req.body);
    res.status(200).json({ 
      token: transaction.token, 
      orderId: req.body.transaction_details.order_id 
    });
  } catch (error) {
    console.error("Error creating Midtrans transaction:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// =========================================
// --- ENDPOINT UNTUK WEBHOOK MIDTRANS ---
// =========================================
app.post('/midtrans-notification', async (req, res) => {
  if (!db) {
    console.error('Firestore not initialized due to previous error. Cannot process webhook.');
    return res.status(500).send('Database not available.');
  }
  try {
    const notification = req.body;
    const signature = crypto.createHash('sha512')
      .update(`${notification.order_id}${notification.status_code}${notification.gross_amount}${process.env.MIDTRANS_SERVER_KEY}`)
      .digest('hex');

    if (signature !== notification.signature_key) {
      return res.status(403).send('Invalid signature');
    }

    const orderId = notification.order_id;
    const transactionStatus = notification.transaction_status;
    const fraudStatus = notification.fraud_status;

    const orderRef = db.collection('orders').doc(orderId);
    
    if (transactionStatus === 'capture' || transactionStatus === 'settlement') {
      if (fraudStatus === 'accept') {
        const orderSnap = await orderRef.get();
        if (!orderSnap.exists) {
          return res.status(200).send('Order not found.'); // Atau tangani sesuai logika Anda
        }
        if (orderSnap.data().status === 'paid') {
           return res.status(200).send('Order already processed.'); // Pesanan sudah diproses
        }

        const orderData = orderSnap.data();
        const batch = db.batch();
        batch.update(orderRef, { status: 'paid', paymentResult: notification });

        let totalItemsQuantity = 0;
        for (const item of orderData.items) {
          if (item.id !== 'SHIPPING_COST') { // Pastikan item 'SHIPPING_COST' tidak memengaruhi stok
            const productRef = db.collection('products').doc(item.id);
            totalItemsQuantity += item.quantity;
            batch.update(productRef, {
              stock: admin.firestore.FieldValue.increment(-item.quantity),
              soldCount: admin.firestore.FieldValue.increment(item.quantity)
            });
          }
        }
        
        const statsRef = db.collection('summary').doc('stats');
        batch.update(statsRef, { 
          totalRevenue: admin.firestore.FieldValue.increment(orderData.totalAmount),
          totalStock: admin.firestore.FieldValue.increment(-totalItemsQuantity), // Ini mungkin perlu disesuaikan jika totalStock mencerminkan stok global
          totalOrders: admin.firestore.FieldValue.increment(1)
        });

        await batch.commit();
        console.log(`Order ${orderId}, stocks, and summary stats updated successfully.`);
      }
    } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
      await orderRef.update({ status: 'failed' });
      console.log(`Order ${orderId} marked as failed due to ${transactionStatus}.`);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// ===================================
// --- ENDPOINT UNTUK KIRIM EMAIL KONTAK ---
// ===================================
app.post('/send-contact-email', async (req, res) => {
  const { firstName, lastName, email, phone, subject, message } = req.body;

  // Pastikan variabel lingkungan untuk email sudah diatur
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.error('EMAIL_USER or EMAIL_PASS environment variables are not set!');
      return res.status(500).json({ error: 'Email service not configured.' });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail', // Pastikan Anda menggunakan "App password" jika 2FA aktif
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: `"${firstName} ${lastName}" <${email}>`,
    to: process.env.EMAIL_USER, // Email tujuan, biasanya email admin Anda
    subject: `Contact Form: ${subject}`,
    html: `
      <h3>Pesan Baru dari Formulir Kontak Smyva Leather</h3>
      <p><b>Nama:</b> ${firstName} ${lastName}</p>
      <p><b>Email:</b> ${email}</p>
      <p><b>Telepon:</b> ${phone || 'Tidak diisi'}</p>
      <hr>
      <p><b>Pesan:</b></p>
      <p>${message}</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Email sent successfully!');
    res.status(200).json({ message: 'Email sent successfully!' });
  } catch (error) {
    console.error("Error sending email:", error);
    // Vercel logs akan menampilkan error ini. Pastikan konfigurasi email sudah benar.
    res.status(500).json({ error: 'Failed to send email. Check server logs.' });
  }
});

// --- PENTING: EKSPOR APLIKASI EXPRESS ANDA UNTUK VERCEL ---
// Vercel akan otomatis menangani serverless function dari objek yang diekspor ini.
// Jangan gunakan app.listen() untuk deployment Vercel.
module.exports = app;