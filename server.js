require("dotenv").config();
const mongoose = require("mongoose");
const app = require("./src/app");
const { startScheduler } = require("./src/services/schedulerService");

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");
    console.log("Connected DB:", mongoose.connection.name);

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      startScheduler();
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();