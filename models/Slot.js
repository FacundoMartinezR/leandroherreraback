// models/Slot.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const SlotSchema = new Schema({
  serviceId: { type: Schema.Types.ObjectId, ref: 'Service', required: false },
  start:     { type: Date, required: true },
  end:       { type: Date, required: false },
  status:    { type: String, enum: ['free','booked'], default: 'free' }
});

// Si ya existe, reutilízalo, si no, créalo
module.exports = mongoose.models.Slot
  ? mongoose.model('Slot')
  : mongoose.model('Slot', SlotSchema);
