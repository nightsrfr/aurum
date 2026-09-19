import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { loadConversation, saveConversation, type ConversationMessage } from "../db.js";
import { getSystemPrompt } from "./systemPrompt.js";
import { toolDefinitions, runTool } from "./tools.js";
import { hasReachedTurnCap, tryConsumeDailyModelCall, TURN_CAP_MESSAGE, DAILY_CAP_MESSAGE } from "./guards.js";

// Exported so tests can mock .messages.create directly instead of making a
// real network call to Anthropic — same reasoning and pattern as
// concierge-platform's own agent/claude.ts.
export const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MAX_TOOL_ITERATIONS = 5;

/**
 * Runs one turn of the concierge agent for a given guest phone number:
 * loads their conversation history, sends the new message to Claude along
 * with the booking tools, executes any tool calls Claude makes, and returns
 * the final text reply to send back over SMS.
 */
export async function runAgent(phone: string, incomingText: string): Promise<string> {
  const history = loadConversation(phone);

  // Turn cap — checked BEFORE the incoming message is even added to
  // history, so the guest's 26th message never reaches the model at all;
  // it still gets saved below (as a real turn) so a reload of the widget
  // shows the wrap-up reply rather than silently dropping the message.
  if (hasReachedTurnCap(history)) {
    const messages: ConversationMessage[] = [
      ...history,
      { role: "user", content: incomingText },
      { role: "assistant", content: [{ type: "text", text: TURN_CAP_MESSAGE }] },
    ];
    saveConversation(phone, messages);
    return TURN_CAP_MESSAGE;
  }

  const messages: Anthropic.MessageParam[] = [
    ...(history as Anthropic.MessageParam[]),
    { role: "user", content: incomingText },
  ];

  let finalText = "Sorry, I'm having trouble right now — someone from our team will follow up shortly.";
  const channel: "sms" | "web" = phone.startsWith("web:") ? "web" : "sms";

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    // Global daily model-call cap — checked immediately before every real
    // API call, not just once per guest turn, since a single turn can
    // round-trip through the model more than once via tool use.
    if (!tryConsumeDailyModelCall()) {
      finalText = DAILY_CAP_MESSAGE;
      // No model call happened this iteration, so — unlike the normal
      // completion path just below, which pushes the model's own response
      // onto `messages` — nothing has recorded this reply yet. Push it
      // explicitly so it's saved and shows up on the next history load.
      messages.push({ role: "assistant", content: [{ type: "text", text: finalText }] });
      break;
    }

    const response = await anthropic.messages.create({
      model: config.claudeModel,
      max_tokens: 1024,
      system: getSystemPrompt(channel),
      tools: toolDefinitions,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      // For an SMS conversation, `phone` (the channel id this function was
      // called with) already IS the guest's real number — force it onto the
      // tool input so the model can't hallucinate or mistype it. For the
      // web widget, `phone` is just "web:<uuid>", not a real number, so
      // leave whatever actual phone number the model collected from the
      // guest during the conversation untouched — that's the one that gets
      // texted the payment/booking confirmation.
      const input =
        (block.name === "start_booking" || block.name === "flag_for_human") && channel !== "web"
          ? { ...(block.input as any), phone }
          : block.input;
      const result = await runTool(block.name, input, phone);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  saveConversation(phone, messages as unknown as ConversationMessage[]);
  return finalText || "Got it, thanks! Let me get back to you on that.";
}
