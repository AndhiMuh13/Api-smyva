// Memuat variabel dari file .env
require('dotenv').config(); 

// Impor library yang dibutuhkan
const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const crypto = require('crypto');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer'); // <-- Impor untuk email

// --- INISIALISASI FIREBASE ADMIN SDK ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// --- KONFIGURASI APLIKASI EXPRESS ---
const app = express();
const port = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

// --- KONFIGURASI MIDTRANS ---
const snap = new midtransClient.Snap({
  isProduction: false,
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
        if (!orderSnap.exists || orderSnap.data().status === 'paid') {
          return res.status(200).send('Order not found or already processed.');
        }

        const orderData = orderSnap.data();
        const batch = db.batch();
        batch.update(orderRef, { status: 'paid', paymentResult: notification });

        let totalItemsQuantity = 0;
        for (const item of orderData.items) {
          if (item.id !== 'SHIPPING_COST') {
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
          totalStock: admin.firestore.FieldValue.increment(-totalItemsQuantity),
          totalOrders: admin.firestore.FieldValue.increment(1)
        });

        await batch.commit();
        console.log(`Order ${orderId}, stocks, and summary stats updated successfully.`);
      }
    } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
      await orderRef.update({ status: 'failed' });
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// ===================================
// --- ENDPOINT BARU UNTUK KIRIM EMAIL KONTAK ---
// ===================================
app.post('/send-contact-email', async (req, res) => {
  const { firstName, lastName, email, phone, subject, message } = req.body;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER, // Ambil dari file .env
      pass: process.env.EMAIL_PASS, // Ambil dari file .env
    },
  });

  const mailOptions = {
    from: `"${firstName} ${lastName}" <${email}>`,
    to: process.env.EMAIL_USER,
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
    res.status(200).json({ message: 'Email sent successfully!' });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ error: 'Failed to send email.' });
  }
});


// Menjalankan server
app.listen(port, () => {
  console.log(`Server backend berjalan di http://localhost:${port}`);
});