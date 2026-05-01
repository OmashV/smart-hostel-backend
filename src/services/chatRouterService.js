const { generateOwnerReply } = require("./ownerChatService");
const { generateStudentReply } = require("./studentChatService");
const { generateWardenReply } = require("./wardenChatService");

async function chatByRole({ role, message, dashboardState }) {
  switch (role) {
    case "owner":
      return generateOwnerReply({ message, dashboardState });
    case "student":
      return generateStudentReply({ message, dashboardState });
    case "warden":
      return generateWardenReply({ message, dashboardState });
    case "security":
      return {
        reply: "Security chatbot is not implemented yet. Owner and Warden chatbots are currently available.",
        actions: []
      };

    default:
      return {
        reply: "Unknown role provided.",
        actions: []
      };
  }
}

module.exports = {
  chatByRole
};
