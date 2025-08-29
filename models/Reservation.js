// models/Reservation.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const ReservationSchema = new Schema({
  serviceId:       { type: Schema.Types.ObjectId, ref: 'Service', required: true },
  slotId:          { type: Schema.Types.ObjectId, ref: 'Slot',    required: true },
  meetingLink:     { type: String, default: null },
  firstName:       { type: String, required: true },
  lastName:        { type: String, required: true },
  phone:           { type: String, required: true },
  customerEmail:   { type: String, required: true },
  status:          { type: String, enum: ['pending','paid','cancelled'], default: 'pending' },
  stripeSessionId: { type: String, default: null },
  createdAt:       { type: Date, default: Date.now }
});

module.exports = mongoose.models.Reservation
  ? mongoose.model('Reservation')
  : mongoose.model('Reservation', ReservationSchema);
