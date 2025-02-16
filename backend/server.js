const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const Razorpay = require("razorpay");
const QRCode = require("qrcode");
const connectDB = require("./config/db");
const Booking = require("./models/booking");
const bookingRoutes = require("./routes/bookingRoutes");
const nodemailer = require("nodemailer");

dotenv.config();
connectDB();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ Temporary storage for blocked seats (consider Redis for production)
global.tempBlockedSeats = {};

// ✅ Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_TEST_KEY_ID,
  key_secret: process.env.RAZORPAY_TEST_KEY_SECRET,
});

// ✅ Setup Nodemailer for issue reporting

const transporter = nodemailer.createTransport({
  service: "gmail", // If using Gmail
  auth: {
    user: process.env.EMAIL, // Your email address
    pass: process.env.PASSWORD, // Your email password or app-specific password if 2FA is enabled
  },
});


// 📩 **Issue Reporting via Email**
app.post("/send-email", async (req, res) => {
  const { name, email, rollNumber, issue } = req.body;

  const mailOptions = {
    from: process.env.EMAIL,
    to: process.env.EMAIL, // Send issue reports to your own email
    subject: "New Issue Reported",
    text: `Name: ${name}\nEmail: ${email}\nRoll Number: ${rollNumber}\nIssue: ${issue}`,
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: "Email sent successfully!" });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ success: false, message: "Error sending email" });
  }
});

// 🏦 **Create Razorpay Order**
app.post("/api/payment/order", async (req, res) => {
  try {
    const { amount } = req.body;
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: `order_${Date.now()}`,
      payment_capture: 1,
    });
    res.json(order);
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// 🎟️ **Block Seats Temporarily**
app.post("/api/bookings/block-seats", async (req, res) => {
  try {
    const { movie, seats } = req.body;

    if (!global.tempBlockedSeats[movie]) global.tempBlockedSeats[movie] = [];

    const alreadyBlocked = seats.some((seat) =>
      global.tempBlockedSeats[movie].includes(seat)
    );
    if (alreadyBlocked) {
      return res.status(400).json({ message: "Some seats are already blocked" });
    }

    global.tempBlockedSeats[movie].push(...seats);

    // ⏳ Remove blocked seats after 1 minute if payment fails
    setTimeout(() => {
      global.tempBlockedSeats[movie] = global.tempBlockedSeats[movie].filter(
        (seat) => !seats.includes(seat)
      );
    }, 60000);

    res.json({ message: "Seats temporarily blocked", blockedSeats: global.tempBlockedSeats[movie] });
  } catch (error) {
    console.error("Error blocking seats:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// 💳 **Verify Payment & Confirm Booking**
app.post("/api/payment/verify", async (req, res) => {
  try {
    const { paymentResponse, name, phone, seatNumbers, movie } = req.body;

    if (!paymentResponse.razorpay_payment_id) {
      return res.status(400).json({ message: "Payment verification failed" });
    }

    const newBooking = new Booking({
      name,
      phoneNumber: phone,
      seats: seatNumbers,
      movie,
      date: new Date().toISOString().split("T")[0],
      time: new Date().toTimeString().split(" ")[0],
      paymentId: paymentResponse.razorpay_payment_id,
    });

    await newBooking.save();

    // ✅ Remove booked seats from temporary blocked list
    global.tempBlockedSeats[movie] = global.tempBlockedSeats[movie].filter(
      (seat) => !seatNumbers.includes(seat)
    );

    // ✅ Generate QR Code
    const bookingDetails = `Name: ${name}\nPhone: ${phone}\nSeats: ${seatNumbers.join(", ")}\nMovie: ${movie}\nDate: ${newBooking.date}`;
    const qrCodeDataUrl = await QRCode.toDataURL(bookingDetails);

    res.json({ message: "Payment verified, booking confirmed!", qrCode: qrCodeDataUrl });
  } catch (error) {
    console.error("Error processing payment:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// 🎟️ **Fetch Booked & Blocked Seats**
app.get("/api/bookings/booked-seats/:movie", async (req, res) => {
  try {
    const { movie } = req.params;
    const bookings = await Booking.find({ movie });

    const bookedSeats = bookings.flatMap(booking => booking.seats);
    const blockedSeats = global.tempBlockedSeats[movie] || [];

    res.json({ bookedSeats, blockedSeats });
  } catch (error) {
    console.error("Error fetching booked seats:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// 📌 **Use Routes for Booking**
app.use("/api/bookings", bookingRoutes);

// 🚀 **Start the Server**
const PORT = process.env.PORT || 8080; // Removed hardcoded 5000
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
