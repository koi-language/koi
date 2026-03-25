/**
 * Vision-based Element Detector — uses LLM to detect UI elements from screenshots.
 *
 * Replaces IDB/ADB accessibility tree with a fast LLM vision call.
 * Works with any screenshot (iOS, Android, browser, desktop).
 * Uses normalized coordinates (0-1000 scale) for reliability.
 */

const DETECT_PROMPT = `You are a UI element detector. Analyze this mobile app screenshot and find ALL interactive elements.

OUTPUT FORMAT: JSON array with NORMALIZED coordinates (0-1000 scale).
- x_norm: 0 = left edge, 1000 = right edge
- y_norm: 0 = top edge, 1000 = bottom edge

For each interactive element (buttons, search bars, text fields, icons, tabs, links):
{"label": "element text or description", "type": "button|search_bar|text_field|icon|tab|link", "x_norm": 500, "y_norm": 300}

EXAMPLE: A search bar horizontally centered in the lower third of the screen would have:
x_norm = 500, y_norm = 700

IMPORTANT:
- Include ALL tappable elements
- Search bars and text fields are critical
- Icon buttons too (mic, profile, settings)
- y_norm > 500 means bottom half of screen

Respond with ONLY the JSON array, no other text.`;

/**
 * Detect UI elements from a screenshot using LLM vision.
 *
 * @param {Buffer} imageBuffer - PNG screenshot (raw, without grid overlay)
 * @param {object} llmProvider - The LLM provider instance from agent
 * @param {number} screenWidth - Screenshot width in pixels
 * @param {number} screenHeight - Screenshot height in pixels
 * @returns {Promise<Array<{ type, label, text, x, y, width, height }>>}
 */
export async function detectElementsViaVision(imageBuffer, llmProvider, screenWidth, screenHeight) {
  // Get any available OpenAI-compatible client (Gemini, OpenAI, etc.)
  const client = llmProvider._gc || llmProvider._oa || llmProvider.openai;
  if (!client) return [];

  const base64 = imageBuffer.toString('base64');

  // Use the provider's configured model
  const model = llmProvider.model || 'auto';

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: DETECT_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
            { type: 'text', text: 'Detect all interactive elements.' },
          ],
        },
      ],
    });

    const text = completion.choices?.[0]?.message?.content?.trim() || '';
    return parseVisionResponse(text, screenWidth, screenHeight);
  } catch (err) {
    if (process.env.KOI_DEBUG_LLM) {
      console.error(`[vision-detector] Failed: ${err.message}`);
    }
    return [];
  }
}

/**
 * Parse LLM vision response into normalized element list.
 */
function parseVisionResponse(text, screenWidth, screenHeight) {
  let jsonStr = text.trim();

  // Strip markdown code blocks
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  // Find array boundaries
  const start = jsonStr.indexOf('[');
  const end = jsonStr.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  jsonStr = jsonStr.substring(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(el => el && el.label)
    .map(el => {
      // Convert 0-1000 normalized coords to pixel coords
      const cx = Math.round((el.x_norm / 1000) * screenWidth);
      const cy = Math.round((el.y_norm / 1000) * screenHeight);
      // Approximate element bounding box around center
      const w = Math.round(screenWidth * 0.1);
      const h = Math.round(screenHeight * 0.03);

      return {
        type: el.type || 'unknown',
        label: el.label || '',
        text: el.label || '',
        identifier: '',
        x: cx - Math.round(w / 2),
        y: cy - Math.round(h / 2),
        width: w,
        height: h,
      };
    });
}
