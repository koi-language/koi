/**
 * Call LLM Action - Call an LLM to process data dynamically at runtime
 */

export default {
  type: 'call_llm',
  intent: 'call_llm',
  description: 'Call an LLM to process data based on instructions → Returns: { result: "processed text" }',
  thinkingHint: 'Processing response',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      data: {
        description: 'Data to process (any type: object, array, string, etc.)'
      },
      instruction: {
        type: 'string',
        description: 'Natural language instruction describing what to do with the data'
      }
    },
    required: ['data', 'instruction']
  },

  examples: [
    {
      type: 'call_llm',
      data: { users: [{ name: 'Alice', age: 30 }] },
      instruction: 'Generate a markdown table with columns: Name, Age'
    }
  ],

  async execute(action, agent) {
    const { data, instruction } = action;

    if (!instruction) {
      throw new Error('call_llm action requires an instruction');
    }

    if (!agent.llmProvider) {
      throw new Error('Agent does not have an LLM provider configured');
    }

    const systemPrompt = `You are a data processor. Your job is to process data according to user instructions.

CRITICAL RULES:
1. Return ONLY the processed result - NO explanations, NO markdown wrapping, NO code blocks, NO JSON wrapper
2. Follow the instruction exactly as specified
3. NEVER generate template variables (\${...}) or placeholders ([name], {x}, [DD]) - use ACTUAL VALUES from data
4. When calculations are needed (dates, time differences, derived values), perform them accurately
5. Use the most authoritative data source available (e.g., birthdate over age field, timestamps over derived dates)
6. Current date for any time-based calculations: ${new Date().toISOString().split('T')[0]}
7. If instruction says "generate", "format as", output the result as TEXT - NOT JSON or arrays
8. Default output should be human-readable text unless instruction explicitly asks for JSON/table/specific format

CALCULATION REQUIREMENTS:
- Parse all date/time fields carefully, supporting multiple formats
- For derived values (age, days remaining, time elapsed), calculate accurately from source data
- When calculating age: current_year - birth_year, then subtract 1 if birthday hasn't occurred yet this year
- Use birthdate field as authoritative source, ignore any "age" field as it may be stale
- Verify results make logical sense (e.g., age should be positive and reasonable)

CONTENT GENERATION:
- When generating emails or personalized text, create properly formatted text for each item
- Include salutations, body text, and sign-offs as appropriate
- Separate multiple emails/items with blank lines
- Use natural, human-friendly language
- Infer formatting details from context (e.g., "Estimado" vs "Estimada" based on names ending in 'a')
- Generate DIFFERENT content each time based on the data - don't reuse the same text for different values`;

    const userPrompt = `IMPORTANT: Today's date is ${new Date().toISOString().split('T')[0]}. Use this for all date calculations.

Data:
${JSON.stringify(data, null, 2)}

Instruction:
${instruction}

Output (result only):`;

    try {
      // Call OpenAI with centralized logging
      const completion = await agent.llmProvider.callOpenAI(
        {
          model: agent.llmProvider?.model || 'auto',
          temperature: 0.3,
          max_tokens: 2000,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        },
        'call_llm action'
      );

      let resultText = completion.choices[0].message.content.trim();

      // Clean up any markdown code blocks that might have leaked through
      resultText = resultText.replace(/^```[\w]*\n/gm, '').replace(/\n```$/gm, '');
      resultText = resultText.trim();

      return { result: resultText };
    } catch (error) {
      agent.llmProvider.logError('call_llm action failed', error);
      throw error;
    }
  }
};
