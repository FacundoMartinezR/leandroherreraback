// models/Service.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const ServiceSchema = new Schema({
  title:       String,
  description: String,
  duration:    Number,
  price:       Number,
  mentorEmail: { type: String, required: true }
});

module.exports = mongoose.models.Service
  ? mongoose.model('Service')
  : mongoose.model('Service', ServiceSchema);
