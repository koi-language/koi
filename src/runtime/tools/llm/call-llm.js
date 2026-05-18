/**
 * Call LLM Action - Call an LLM to process data dynamically at runtime
 */

import { ProviderBlockedError } from '../../llm/providers/base.js';
import { blockedResult } from '../../llm/blocked-result.js';

export default {
  type: 'call_llm',
  intent: 'call_llm',
  description:
    'Call an LLM to process data based on instructions. Returns: { result: "processed text" }. ' +
    '\n\n' +
    'DO NOT pass a `model` field — the runtime picks the model automatically from the factory ' +
    'based on `complexity` (see below) and the active provider catalog. Any `model` you put on ' +
    'this action is ignored. Hardcoding model names is forbidden project-wide.\n\n' +
    'DO NOT inline long blobs (transcripts, vision manifests, full file contents) into the `data` ' +
    'field by typing them out — LLMs routinely abbreviate long copies with placeholders like ' +
    '"(contenido resumido: …)" or "[full transcript]" which silently destroys the input. Instead ' +
    'pass `dataFiles` pointing at the file paths on disk; the tool reads the bytes verbatim and ' +
    'builds the prompt itself, bypassing the token-stream copy step entirely.',
  thinkingHint: 'Processing response',
  permission: null,

  schema: {
    type: 'object',
    properties: {
      data: {
        description:
          'Inline data to process (object, array, string, number). Use this ONLY for SMALL data ' +
          '(a couple of fields, a single short string). For anything large — transcripts, full ' +
          'JSON dumps, file contents the agent already wrote to disk — use `dataFiles` instead. ' +
          'When both are present, `data` is appended after the loaded files.',
      },
      dataFiles: {
        description:
          'Absolute file path (string) or array of absolute paths to load as input data. The ' +
          'tool reads each file verbatim and concatenates them into the prompt under labelled ' +
          'sections. Use this for transcripts (`transcription.json`), vision manifests ' +
          '(`moments.json`), draft articles, long source files — anything the agent would ' +
          'otherwise have to copy through its own tokens (and probably abbreviate by mistake). ' +
          'Files must exist; missing paths fail the call cleanly.',
      },
      instruction: {
        type: 'string',
        description:
          'Natural language instruction describing what to do with the data. Required.',
      },
      complexity: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description:
          'How much reasoning effort the task needs. Maps to the factory\'s ' +
          '(taskType, difficulty) pair: low → code:3 (fast/cheap — e.g. format a table, ' +
          'extract one field, rephrase a sentence), medium → reasoning:40 (multi-step ' +
          'transformations, schema generation, summaries with citations — DEFAULT), high → ' +
          'reasoning:80 (long-form article drafting, multi-page synthesis, code review of an ' +
          'entire module). Default: medium. Drop to "low" explicitly when the task is a trivial ' +
          'one-shot transform; bump to "high" for long-form / multi-step reasoning. NEVER specify ' +
          '`model` to override this — let the factory pick the right slug from the active catalog.',
      },
    },
    required: ['instruction'],
  },

  examples: [
    {
      type: 'call_llm',
      data: { users: [{ name: 'Alice', age: 30 }] },
      instruction: 'Generate a markdown table with columns: Name, Age',
    },
    {
      type: 'call_llm',
      dataFiles: ['/abs/path/to/transcription.json', '/abs/path/to/moments.json'],
      instruction: 'Write a 2000-word Spanish article from the transcript, embedding the tables and code from moments.json.',
      complexity: 'high',
    },
  ],

  async execute(action, agent) {
    const { instruction } = action;
    let { data } = action;
    const complexity = action.complexity ?? 'medium';
    const dataFiles = action.dataFiles;

    if (!instruction) {
      throw new Error('call_llm action requires an instruction');
    }

    if (!agent.llmProvider) {
      throw new Error('Agent does not have an LLM provider configured');
    }

    // Surface the ignored `model` field as a warning rather than silently
    // accepting it — the agent that emitted it almost certainly expected
    // it to work, and the prompt-builder reading the logs should know
    // their model pin had no effect. The factory still decides via
    // `complexity` below.
    if (action.model) {
      const { channel } = await import('../../io/channel.js');
      channel.log(
        'call_llm',
        `WARNING: ignored model="${action.model}" — call_llm does not accept a model field, the factory picks from the catalog. Use the "complexity" parameter to influence selection.`,
      );
    }

    // Load any file-backed inputs FIRST so a typo'd path fails fast.
    // The whole point of `dataFiles` is that the agent doesn't have to
    // copy the bytes through its token stream (where it would often
    // abbreviate with placeholders like "(transcript omitted)"). Read
    // them straight from disk and stitch into the prompt below.
    const fs = await import('fs');
    const path = await import('path');
    const loadedFiles = [];
    if (dataFiles != null) {
      const paths = Array.isArray(dataFiles) ? dataFiles : [dataFiles];
      for (const raw of paths) {
        if (typeof raw !== 'string' || raw.length === 0) continue;
        const resolved = path.resolve(raw);
        if (!fs.existsSync(resolved)) {
          throw new Error(`call_llm dataFiles: not found: ${raw}`);
        }
        try {
          const bytes = fs.readFileSync(resolved, 'utf8');
          loadedFiles.push({ path: resolved, name: path.basename(resolved), content: bytes });
        } catch (err) {
          throw new Error(`call_llm dataFiles: cannot read ${raw}: ${err.message || err}`);
        }
      }
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

    // Build the data section: each loaded file under its own labelled
    // block (so the LLM can tell `transcription.json` apart from
    // `moments.json`), then the inline `data` field if the agent
    // passed one as well. Files come first because they're typically
    // the bulk of the input.
    const dataSections = [];
    for (const f of loadedFiles) {
      dataSections.push(`=== ${f.name} (loaded from ${f.path}) ===\n${f.content}`);
    }
    if (data !== undefined && data !== null) {
      const inline = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      dataSections.push(loadedFiles.length > 0
        ? `=== inline data ===\n${inline}`
        : `Data:\n${inline}`);
    }
    if (dataSections.length === 0) {
      // Allow instruction-only calls (e.g. "Write a haiku about CI").
      dataSections.push('(no input data — instruction-only call)');
    }

    const userPrompt = `IMPORTANT: Today's date is ${new Date().toISOString().split('T')[0]}. Use this for all date calculations.

${dataSections.join('\n\n')}

Instruction:
${instruction}

Output (result only):`;

    try {
      // Use the same provider/model as the agent's main loop (via resolveModel).
      // No explicit maxTokens — BaseLLM will use 1/4 of the model's max output.
      const { resolve: resolveModel } = await import('../../llm/providers/factory.js');
      const { costCenter } = await import('../../llm/cost-center.js');

      await agent.llmProvider._ensureClients();
      // Map the caller-supplied complexity to the factory's
      // (taskType, difficulty) pair. NEVER read `action.model` — model
      // selection is the factory's job. The complexity ladder:
      //   low    → code   /  3  (cheap & fast: short transforms, table
      //                          formatting, single-field extraction)
      //   medium → reason / 40  (multi-step transforms, summaries,
      //                          schema generation)
      //   high   → reason / 80  (long-form drafting, multi-page
      //                          synthesis, deep editorial work)
      const complexityMap = {
        low:    { taskType: 'code',      difficulty: 3 },
        medium: { taskType: 'reasoning', difficulty: 40 },
        high:   { taskType: 'reasoning', difficulty: 80 },
      };
      const sel = complexityMap[complexity] ?? complexityMap.medium;
      const { instance: llm, provider, model } = resolveModel({
        type: 'llm', taskType: sel.taskType, difficulty: sel.difficulty,
        availableProviders: agent.llmProvider._availableProviders,
        clients: agent.llmProvider._gatewayMode
          ? agent.llmProvider._gatewayClients()
          : { openai: agent.llmProvider._oa, anthropic: agent.llmProvider._ac, gemini: agent.llmProvider._gc },
      });

      const t0 = Date.now();
      const result = await llm.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);
      costCenter.recordUsage(model, provider, result.usage?.input || 0, result.usage?.output || 0, Date.now() - t0);

      let resultText = (result.text || '').trim();
      resultText = resultText.replace(/^```[\w]*\n/gm, '').replace(/\n```$/gm, '').trim();

      return { result: resultText };
    } catch (error) {
      agent.llmProvider.logError('call_llm action failed', error);
      // Structured provider block — return as BlockedResult so the
      // Coordinator can distinguish it from a generic failure.
      if (error instanceof ProviderBlockedError) {
        return blockedResult({
          blockType: error.blockType,
          provider: error.provider,
          reason: error.providerReason || error.message,
          retryable: error.retryable,
        });
      }
      throw error;
    }
  }
};
