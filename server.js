// server.js
require('dotenv').config();
const express      = require('express');
const mongoose     = require('mongoose');
const cors         = require('cors');
const stripe       = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt          = require('jsonwebtoken');
const { google }   = require('googleapis');
const nodemailer   = require('nodemailer');

// Configuración Nodemailer (Gmail SMTP)
const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});
mailTransporter.verify()
  .then(() => console.log('✔️ SMTP configurado correctamente'))
  .catch(err => console.error('❌ Error en SMTP:', err));

// Modelos
const Service     = require('./models/Service');
const Slot        = require('./models/Slot');
const Reservation = require('./models/Reservation');

// Google API setup
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

// Función para crear evento de Google Meet
async function createGoogleMeet(startDate, durationMinutes, summary, attendees = []) {
  if (!Array.isArray(attendees)) throw new Error('Attendees debe ser un array de emails');
  const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
  const event = {
    summary,
    start: { dateTime: startDate.toISOString() },
    end:   { dateTime: endDate.toISOString() },
    conferenceData: {
      createRequest: {
        requestId: `meet-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    },
    attendees: attendees.map(email => ({ email })),
  };
  const resp = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: event,
    conferenceDataVersion: 1,
    sendUpdates: 'all'
  });
  return resp.data.hangoutLink;
}

// Conexión a MongoDB
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB conectado'))
  .catch(err => console.error('Error conectando MongoDB:', err));

const app = express();
app.use(cors());

// 1) Stripe webhook debe usar raw body parser antes de JSON
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log('✔️ Recibí webhook:', event.id);
  } catch (err) {
    console.error('Error firma webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { reservationId, slotId } = session.metadata;

    // Actualizo reserva y slot
    const reservation = await Reservation.findByIdAndUpdate(
      reservationId,
      { status: 'paid', stripeSessionId: session.id },
      { new: true }
    );
    await Slot.findByIdAndUpdate(slotId, { status: 'booked' });

    // Obtengo datos de slot y servicio
    const slot    = await Slot.findById(slotId);
    const service = await Service.findById(reservation.serviceId);

    // Creo Google Meet
    const meetLink = await createGoogleMeet(
      slot.start,
      service.duration,
      `Reserva: ${service.title}`,
      [reservation.customerEmail, service.mentorEmail]
    );
    await Reservation.findByIdAndUpdate(reservationId, { meetingLink: meetLink });

    // Envío correo de confirmación
    const fullRes = await Reservation.findById(reservationId)
      .populate('serviceId')
      .populate('slotId');
    const to      = fullRes.customerEmail;
    const name    = fullRes.firstName;
    const title   = fullRes.serviceId.title;
    const dateStr = fullRes.slotId.start.toLocaleString('es-UY', { dateStyle: 'full', timeStyle: 'short' });
    const link    = fullRes.meetingLink;
    console.log('📧 Preparando para enviar mail a', to);

    const mailOptions = {
      from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.SMTP_USER}>`,
      to,
      subject: `✅ Tu reserva de "${title}" está confirmada`,
      html: `
        <p>Hola ${name},</p>
        <p>¡Tu pago se recibió correctamente! 📥</p>
        <p><strong>Servicio:</strong> ${title}<br/>
           <strong>Fecha y hora:</strong> ${dateStr}</p>
        <p>Para unirte a la reunión haz clic aquí:<br/>
           <a href="${link}">${link}</a>
        </p>
        <p>¡Nos vemos pronto!</p>
        <hr/>
        <p>Si tenés consultas, respondé este correo.</p>
      `
    };
    try {
      await mailTransporter.sendMail(mailOptions);
      console.log('✉️ Email de confirmación enviado a', to);
    } catch (err) {
      console.error('Error enviando mail:', err);
    }
  }
  res.json({ received: true });
});

// 2) Parser JSON para demás rutas
app.use(express.json());

// 3) Endpoint para verificar el pago (usado en frontend)
app.post('/api/stripe/verify', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Falta sessionId.' });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') return res.status(400).json({ error: 'Pago no completado.' });
    return res.json({ status: 'paid' });
  } catch (err) {
    console.error('Error en /api/stripe/verify:', err);
    return res.status(500).json({ error: 'Error interno.' });
  }
});

// 4) Login y authAdmin
app.post('/api/login', (req, res) => {
  console.log('Login request body:', req.body);
  const { username, password } = req.body;
  if (!username || !password) {
    console.log('Faltan campos username/password');
    return res.status(400).json({ error: 'Faltan campos.' });
  }
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    console.log('Login exitoso, token:', token);
    return res.json({ token });
  }
  console.log('Credenciales inválidas');
  res.status(401).json({ error: 'Credenciales inválidas.' });
});

function authAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado.' });
  try {
    const payload = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
}
app.use('/api/admin', authAdmin);

// 5) Rutas Admin: reservas y slots
app.get('/api/admin/reservations', async (req, res) => {
  try {
    const reservations = await Reservation.find().populate('slotId').populate('serviceId');
    res.json(reservations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching reservations.' });
  }
});

app.delete('/api/admin/reservation/:reservationId', async (req, res) => {
  try {
    await Reservation.findByIdAndDelete(req.params.reservationId);
    res.json({ message: 'Reserva eliminada.' });
  } catch (err) {
    console.error('Error eliminando reserva (singular):', err);
    res.status(400).json({ error: 'No se pudo eliminar la reserva.' });
  }
});

app.get('/api/admin/slots', async (req, res) => {
  try {
    const slots = await Slot.find();
    res.json(slots);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching slots.' });
  }
});
app.post('/api/admin/slots', async (req, res) => {
  try {
    const { start } = req.body;
    if (!start) return res.status(400).json({ error: 'Falta start.' });
    const slot = await Slot.create({ start, status: 'free' });
    res.status(201).json(slot);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Invalid slot data.' });
  }
});
app.put('/api/admin/slots/:slotId', async (req, res) => {
  try {
    const slot = await Slot.findByIdAndUpdate(req.params.slotId, req.body, { new: true });
    res.json(slot);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Could not update slot.' });
  }
});
app.delete('/api/admin/slots/:slotId', async (req, res) => {
  try {
    await Slot.findByIdAndDelete(req.params.slotId);
    res.json({ message: 'Slot deleted.' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: 'Could not delete slot.' });
  }
});

// 6) Slot público: summary y detalle
app.get('/api/slots/summary', async (req, res) => {
  try {
    const pipeline = [
      { $match: { status: 'free' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$start' } }, count: { $sum: 1 } } },
      { $project: { date: '$_id', availableCount: '$count', _id: 0 } }
    ];
    const summary = await Slot.aggregate(pipeline);
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno.' });
  }
});
app.get('/api/slots', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Falta parámetro date' });
  try {
    const start = new Date(`${date}T00:00:00`);
    const end   = new Date(`${date}T23:59:59`);
    const slots = await Slot.find({ start: { $gte: start, $lte: end }, status: 'free' }).sort('start');
    res.json(slots);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// 7) Crear reserva y Stripe Checkout
app.post('/api/reservations', async (req, res) => {
  try {
    const { serviceId, slotId, customerEmail, firstName, lastName, phone } = req.body;
    if (!serviceId || !slotId || !customerEmail || !firstName || !lastName || !phone) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }
    const [service, slot] = await Promise.all([Service.findById(serviceId), Slot.findById(slotId)]);
    if (!service || !slot || slot.status !== 'free') {
      return res.status(400).json({ error: 'Servicio o slot no disponible.' });
    }
    await Slot.findByIdAndUpdate(slotId, { status: 'booked' });
    const reservation = await Reservation.create({ serviceId, slotId, customerEmail, firstName, lastName, phone, status: 'pending' });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email:       customerEmail,
      line_items: [{ price_data: { currency: 'nzd', unit_amount: Math.round(service.price*100), product_data:{ name: service.title } }, quantity:1 }],
      mode:        'payment',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/cancel`,
      metadata:    { reservationId: reservation._id.toString(), slotId: slotId.toString() }
    });
    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// Inicio servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
