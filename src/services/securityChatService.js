const groq = require("./groqClient");
const {
  getSecuritySummary,
  getSecuritySuspiciousRooms,
  getSecurityDoorEvents,
  getSecurityTrend,
  getSecurityAnomalies,
  getSecurityPatterns
} = require("./securityChatTools");

const TOOL_IMPL = {
  get_security_summary:        getSecuritySummary,
  get_security_suspicious_rooms: getSecuritySuspiciousRooms,
  get_security_door_events:    getSecurityDoorEvents,
  get_security_trend:          getSecurityTrend,
  get_security_anomalies:      getSecurityAnomalies,
  get_security_patterns:       getSecurityPatterns
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_security_summary",
      description: "Get the latest security summary across rooms or for a specific room.",
      parameters: {
        type: "object",
        properties: {
          roomId: {
            type: "string",
            description: "Optional room id like A101 or B102"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_security_suspicious_rooms",
      description: "Get suspicious security rooms with door and motion data.",
      parameters: {
        type: "object",
        properties: {
          roomId: {
            type: "string",
            description: "Optional room id like A101 or B102"
          }
        }
      }
    }
  },
  {
    type: "function",
  function: {
    name: "get_security_door_events",
    description: "Get recent door open events for security monitoring.",
    parameters: {
      type: "object",
      properties: {
        roomId: {
          type: "string",
          description: "Optional room id like A101 or B102"
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of events to return, must be a whole number"
        }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_security_trend",
      description: "Get the door-stability security trend and Prophet forecast for today.",
      parameters: {
        type: "object",
        properties: {
          roomId: {
            type: "string",
            description: "Optional room id like A101 or B102"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_security_anomalies",
      description: "Get recent ML-detected security anomalies for rooms.",
      parameters: {
        type: "object",
        properties: {
          roomId: {
            type: "string",
            description: "Optional room id like A101 or B102"
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of anomalies to return"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_security_patterns",
      description: "Get K-Means discovered behavior patterns for rooms.",
      parameters: {
        type: "object",
        properties: {
          roomId: {
            type: "string",
            description: "Optional room id like A101 or B102"
          }
        }
      }
    }
  }
];

// ── Single merged system prompt ───────────────────────────────────────────────
function systemPrompt() {
  return `You are a Smart Hostel dashboard security assistant.

You help users understand door security data, anomalies, and trends across hostel rooms.

RULES:
- Always use tools to fetch data before answering. Never invent or assume values.
- When a tool result directly answers the question, answer from it exactly.
- Do not say "no data" unless the tool result is genuinely null or empty.
- Use the current dashboard state (roomId) when no specific room is mentioned.
- If the user mentions a specific room ID in their message (e.g. B102, A103), extract it and pass it as roomId to the tool — even if the dashboard is showing all rooms.
- For follow-up questions that reference a previous answer (e.g. "what about that room?"), infer the room from conversation history.
- If asked about patterns, use the get_security_patterns tool.
- If asked about trends or the chart, use the get_security_trend tool.
- If asked about anomalies or risk, use the get_security_anomalies tool.
- Keep answers concise and actionable. Suggest dashboard actions where helpful (e.g. "Use the room filter to drill into B102").

CONTEXT:
- Rooms monitored: A101 (real sensor data), A102, A103, B101, B102, B103, C101, C102 (demo data)
- B102 has the highest risk profile
- Anomaly scores closer to -0.5 are most anomalous (Isolation Forest model)
- Prophet model provides expected door duration with 95% confidence bands
- After-hours is defined as 11pm to 5am`;
}

// ── Main reply generator ──────────────────────────────────────────────────────
async function generateSecurityReply({ message, dashboardState, history = [] }) {
  const roomId = dashboardState?.roomId || "all";

  // Build messages — single system prompt + history + current user message
  const messages = [
    {
      role:    "system",
      content: systemPrompt()
    },
    // Inject last 6 messages of history (3 exchanges) for follow-up support
    ...history.slice(-6).map((h) => ({
      role:    h.role,
      content: h.content
    })),
    {
      role:    "user",
      content: `Current dashboard state:\nroomId=${roomId}\n\nUser question:\n${message}`
    }
  ];

  // ── First completion — let model decide which tools to call ────────────────
  let firstResponse;
  try {
    firstResponse = await groq.chat.completions.create({
      model:       "llama-3.3-70b-versatile",
      temperature: 0.1,
      messages,
      tools:       TOOLS,
      tool_choice: "auto"
    });
  } catch (error) {
    console.error("Security chat first completion error:", error);
    return {
      reply:        "Something went wrong while querying the security assistant.",
      context_used: {}
    };
  }

  const assistantMessage = firstResponse.choices?.[0]?.message;

  if (!assistantMessage) {
    return {
      reply:        "I could not generate a response.",
      context_used: {}
    };
  }

  // No tool calls — model answered directly
  if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
    return {
      reply:        assistantMessage.content || "I could not generate a response.",
      context_used: {}
    };
  }

  // ── Execute tool calls ─────────────────────────────────────────────────────
  messages.push(assistantMessage);
  const toolResults = {};

  for (const toolCall of assistantMessage.tool_calls) {
    const toolName = toolCall.function.name;
    const rawArgs  = toolCall.function.arguments || "{}";

    let parsedArgs = {};
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      parsedArgs = {};
    }

    if (parsedArgs.limit !== undefined) {
      parsedArgs.limit = Number(parsedArgs.limit);
    }

    // Fall back to dashboard roomId if the model didn't extract one
    // but only when not viewing all rooms
    if (!parsedArgs.roomId && roomId !== "all") {
      parsedArgs.roomId = roomId;
    }

    const impl = TOOL_IMPL[toolName];
    if (!impl) {
      toolResults[toolName] = { error: `Unknown tool: ${toolName}` };
      messages.push({
        role:         "tool",
        tool_call_id: toolCall.id,
        content:      JSON.stringify(toolResults[toolName])
      });
      continue;
    }

    try {
      const result = await impl(parsedArgs);
      toolResults[toolName] = result;
      messages.push({
        role:         "tool",
        tool_call_id: toolCall.id,
        content:      JSON.stringify(result)
      });
    } catch (error) {
      console.error(`Security tool ${toolName} error:`, error);
      toolResults[toolName] = { error: error.message || "Tool execution failed" };
      messages.push({
        role:         "tool",
        tool_call_id: toolCall.id,
        content:      JSON.stringify(toolResults[toolName])
      });
    }
  }

  // ── Final completion — generate answer from tool results ───────────────────
  let finalResponse;
  try {
    finalResponse = await groq.chat.completions.create({
      model:       "llama-3.3-70b-versatile",
      temperature: 0.2,
      messages
    });
  } catch (error) {
    console.error("Security chat final completion error:", error);
    return {
      reply:        "Something went wrong while generating the security assistant response.",
      context_used: toolResults
    };
  }

  return {
    reply:
      finalResponse.choices?.[0]?.message?.content ||
      "I could not generate a response.",
    context_used: toolResults
  };
}

module.exports = { generateSecurityReply };