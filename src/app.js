const express = require("express");
const cors = require("cors");
const roomRoutes = require("./routes/roomRoutes");
const chatRoutes = require("./routes/chatRoutes");
const studentRoutes = require("./routes/studentRoutes");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Smart Hostel analytics backend is running" });
});

app.use("/api/rooms/student", studentRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/chat", chatRoutes);

module.exports = app;
