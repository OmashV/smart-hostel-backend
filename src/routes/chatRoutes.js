const express = require("express");
const { askDashboardAssistant } = require("../controllers/chatController");

const router = express.Router();
router.post("/query", askDashboardAssistant);

module.exports = router;
