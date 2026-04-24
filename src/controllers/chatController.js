const { chatByRole } = require("../services/chatRouterService");

async function chatHandler(req, res) {
  try {
    const { role, message, dashboardState } = req.body;

    if (!role) {
      return res.status(400).json({ message: "role is required" });
    }

    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: "message is required" });
    }

    const result = await chatByRole({
      role,
      message: String(message).trim(),
      dashboardState: dashboardState || {}
    });

    res.json(result);
  } catch (error) {
    console.error("Chat handler error:", error);
    res.status(500).json({ message: error.message });
  }
}

module.exports = {
  chatHandler
};
