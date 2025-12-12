\
        // api-server.js
        const express = require('express');
        const Razorpay = require('razorpay');
        const bodyParser = require('body-parser');
        const crypto = require('crypto');
        const fs = require('fs');
        const path = require('path');
        const cors = require('cors');
        const nodemailer = require('nodemailer');
        require('dotenv').config();

        const app = express();
        app.use(bodyParser.json());
        app.use(cors());
        app.use(express.static(path.join(__dirname, 'public')));

        const PORT = process.env.PORT || 4000;
        const RAZORPAY_KEY_ID = process.env.RP_KEY_ID || '';
        const RAZORPAY_KEY_SECRET = process.env.RP_KEY_SECRET || '';
        const SERVER_DOMAIN = process.env.SERVER_DOMAIN || `http://localhost:${PORT}`;

        const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

        const downloadTokens = new Map();
        function createToken(filename, ttl=300){
          const token = crypto.randomBytes(20).toString('hex');
          const expiresAt = Date.now() + ttl*1000;
          downloadTokens.set(token, { filename, expiresAt });
          return token;
        }
        setInterval(() => {
          const now = Date.now();
          for(const [t, info] of downloadTokens.entries()){
            if(info.expiresAt < now) downloadTokens.delete(t);
          }
        }, 60*1000);

        function getFileForProduct(productId){
          if(productId === 'flexmode-starter') return path.join(__dirname, 'protected-files', 'flexmode-starter.pdf');
          return null;
        }

        app.post('/create-order', async (req, res) => {
          try{
            const { productId, amount } = req.body;
            if(!amount) return res.status(400).json({ error: 'amount required' });

            const amountPaise = parseInt(amount,10) * 100;
            const options = { amount: amountPaise, currency: 'INR', receipt: `rcpt_${Date.now()}`, payment_capture: 1 };
            const order = await razorpay.orders.create(options);
            res.json({ id: order.id, amount: order.amount, currency: order.currency, key_id: RAZORPAY_KEY_ID });
          } catch(err){
            console.error('create-order error', err);
            res.status(500).json({ error: 'order creation failed' });
          }
        });

        app.post('/verify-payment', async (req, res) => {
          try {
            const { razorpay_order_id, razorpay_payment_id, razorpay_signature, productId, email } = req.body;
            if(!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
              return res.status(400).json({ success:false, error:'missing fields' });
            }
            const generated_signature = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
              .update(razorpay_order_id + '|' + razorpay_payment_id)
              .digest('hex');
            if(generated_signature !== razorpay_signature) {
              return res.status(400).json({ success:false, error:'signature mismatch' });
            }

            const filePath = getFileForProduct(productId);
            if(!filePath || !fs.existsSync(filePath)) return res.status(400).json({ success:false, error:'product not found' });

            const token = createToken(path.basename(filePath), 300);
            const downloadUrl = `${SERVER_DOMAIN.replace(/\\/$/,'')}/download/${token}`;

            if(email && process.env.EMAIL_USER && process.env.EMAIL_PASS){
              try {
                const transporter = nodemailer.createTransport({
                  service: 'gmail',
                  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
                });
                await transporter.sendMail({
                  from: process.env.EMAIL_USER,
                  to: email,
                  subject: 'Your FlexMode PDF is ready',
                  html: `<p>Thanks for your purchase. Download link (valid 5 minutes): <a href="${downloadUrl}">${downloadUrl}</a></p>`
                });
              } catch(e){
                console.warn('Email send failed', e.message);
              }
            }

            return res.json({ success:true, downloadUrl });
          } catch(err){
            console.error('verify-payment err', err);
            return res.status(500).json({ success:false, error:'server error' });
          }
        });

        app.get('/download/:token', (req, res) => {
          const token = req.params.token;
          const entry = downloadTokens.get(token);
          if(!entry) return res.status(404).send('Invalid or expired token');
          const filePath = path.join(__dirname, 'protected-files', entry.filename);
          if(!fs.existsSync(filePath)) return res.status(404).send('File not found');

          downloadTokens.delete(token);

          res.download(filePath, entry.filename, (err) => {
            if(err) console.error('download error', err);
          });
        });

        app.get('/_health', (req,res) => res.json({ ok:true }));

        app.listen(PORT, () => {
          console.log(`FlexMode Backend running on ${SERVER_DOMAIN} (port ${PORT})`);
        });
