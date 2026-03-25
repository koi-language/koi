/**
 * Incremental JSON Parser for Streaming LLM Responses
 *
 * Parses JSON stream incrementally and yields complete action objects
 * as soon as they're fully received, without waiting for the entire response.
 */

export class IncrementalJSONParser {
  constructor() {
    this.buffer = '';
    this.actionsStartIndex = -1; // Position where "actions":[ was found
    this.lastParsedIndex = 0; // Last position we successfully parsed up to
    this.parsedActions = 0; // Count of actions we've parsed
    this.pendingObjectEnd = -1; // Position where a potential complete object ended (} char)
    this.pendingObjectStart = -1; // Start position of the pending object
  }

  /**
   * Feed more content from the stream
   * Returns array of complete actions found in this chunk
   */
  feed(chunk) {
    const actions = [];
    const oldBufferLength = this.buffer.length;
    this.buffer += chunk;

    // First, find where the actions array starts (if we haven't found it yet)
    if (this.actionsStartIndex === -1) {
      // Look for "actions" : [ with flexible whitespace
      const match = this.buffer.match(/"actions"\s*:\s*\[/);
      if (match) {
        const actionsIndex = match.index;
        this.actionsStartIndex = actionsIndex + match[0].length; // Position right after "actions": [
        this.lastParsedIndex = this.actionsStartIndex;

        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[IncrementalParser] 📍 Found "actions" array at position ${actionsIndex}, starting to parse from ${this.actionsStartIndex}`);
        }
      } else {
        // Haven't found actions array yet, wait for more data
        return actions;
      }
    }

    // Try to parse actions from the buffer
    // We'll try to extract complete JSON objects from the actions array
    let currentPos = this.lastParsedIndex;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let objectStart = -1;

    for (let i = currentPos; i < this.buffer.length; i++) {
      const char = this.buffer[i];

      // Handle string escaping
      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      // Track if we're inside a string
      if (char === '"') {
        inString = !inString;
        continue;
      }

      // Skip processing inside strings
      if (inString) {
        continue;
      }

      // Track object depth
      if (char === '{') {
        if (depth === 0) {
          objectStart = i; // Start of new action object
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && objectStart !== -1) {
          // Potential complete object - save position but wait for delimiter
          this.pendingObjectEnd = i;
          this.pendingObjectStart = objectStart;
          objectStart = -1;
        }
      } else if ((char === ',' || char === ']') && depth === 0) {
        // Delimiter found - if we have a pending object, parse it now
        if (this.pendingObjectEnd !== -1) {
          const actionJSON = this.buffer.substring(this.pendingObjectStart, this.pendingObjectEnd + 1);

          try {
            const action = JSON.parse(actionJSON);

            actions.push(action);
            this.parsedActions++;
            this.lastParsedIndex = this.pendingObjectEnd + 1;

            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[IncrementalParser] ✅ Parsed action #${this.parsedActions}: ${action.intent || action.type || 'unknown'}${action.id ? ` (id: ${action.id})` : ''}`);
            }
          } catch (e) {
            // Failed to parse - might be malformed JSON
            if (process.env.KOI_DEBUG_LLM) {
              console.error(`[IncrementalParser] ⚠️  Failed to parse object at ${this.pendingObjectStart}: ${e.message}`);
            }
          }

          this.pendingObjectEnd = -1;
          this.pendingObjectStart = -1;
        }

        // If this is the end of the array, stop parsing
        if (char === ']') {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[IncrementalParser] 🏁 End of actions array reached`);
          }
          break;
        }
      }
    }

    return actions;
  }

  /**
   * Signal end of stream - parse any remaining content
   */
  finalize() {
    const actions = [];

    // If we have unparsed content, try one final parse
    if (this.lastParsedIndex < this.buffer.length) {
      if (process.env.KOI_DEBUG_LLM) {
        console.error(`[IncrementalParser] Finalizing - ${this.buffer.length - this.lastParsedIndex} chars remaining`);
      }

      // Try to find any remaining complete objects
      const remaining = this.buffer.substring(this.lastParsedIndex);
      const objects = this.extractObjects(remaining);
      actions.push(...objects);
    }

    // If no "actions" array was found, the LLM returned raw JSON
    // Wrap it in a return action so it can be executed properly
    if (this.actionsStartIndex === -1 && this.buffer.length > 0) {
      try {
        const rawJSON = JSON.parse(this.buffer.trim());
        // Check if it's not already an action (has actionType or intent)
        if (!rawJSON.actionType && !rawJSON.actions) {
          if (process.env.KOI_DEBUG_LLM) {
            console.error(`[IncrementalParser] ⚠️ No "actions" array found - wrapping raw JSON in return action`);
          }
          return [{
            actionType: 'direct',
            intent: 'return',
            data: rawJSON
          }];
        }
      } catch (e) {
        // Not valid JSON, return whatever objects we found
        if (process.env.KOI_DEBUG_LLM) {
          console.error(`[IncrementalParser] ⚠️ Failed to parse raw response as JSON: ${e.message}`);
        }
      }
    }

    return actions;
  }

  /**
   * Extract complete JSON objects from a string
   */
  extractObjects(str) {
    const objects = [];
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let objectStart = -1;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') {
        if (depth === 0) objectStart = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && objectStart !== -1) {
          try {
            const obj = JSON.parse(str.substring(objectStart, i + 1));
            objects.push(obj);
          } catch (e) {
            // Ignore parse errors in finalize
          }
          objectStart = -1;
        }
      }
    }

    return objects;
  }

  /**
   * Reset parser state for new stream
   */
  reset() {
    this.buffer = '';
    this.actionsStartIndex = -1;
    this.lastParsedIndex = 0;
    this.parsedActions = 0;
  }
}
