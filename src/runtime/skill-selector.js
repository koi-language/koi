/**
 * Skill Selector with Semantic Matching
 *
 * Uses embedding-based similarity search to intelligently select
 * which skills are relevant for a given task, reducing the number
 * of tools passed to the LLM and improving accuracy.
 *
 * Similar approach to AgentRouter but for skill selection.
 */

import { LLMProvider } from './llm-provider.js';

export class SkillSelector {
  constructor(config = {}) {
    this.skillAffordances = []; // Array of { skillName, description, embedding, confidence, functions }
    this.embeddingProvider = null;

    // Configuration
    this.similarityThreshold = config.similarityThreshold || 0.35; // Lower threshold for skills
    this.verbose = config.verbose || false;
  }

  /**
   * Register a skill with its affordance and available functions
   * @param skillName - Name of the skill
   * @param functions - Array of function objects { name, fn, description }
   * @param cachedAffordance - Optional pre-computed affordance from build cache
   */
  async register(skillName, functions, cachedAffordance = null) {
    if (!skillName || !functions || functions.length === 0) {
      return;
    }

    let description, embedding, confidence;

    // Use cached affordance if available
    if (cachedAffordance) {
      description = cachedAffordance.description;
      embedding = cachedAffordance.embedding;
      confidence = cachedAffordance.confidence || 0.9;

      // Generate embedding at runtime if cache is incomplete
      if (!embedding) {
        if (description && description.trim() !== '') {
          embedding = await this.getEmbedding(description);
        } else {
          console.warn(`⚠️  [SkillSelector] Skipping skill ${skillName} - empty description`);
          return;
        }
      }
    } else {
      // No cache: use function descriptions as affordance
      description = functions.map(f => f.description).join('. ');
      if (!description || description.trim() === '') {
        console.warn(`⚠️  [SkillSelector] Skipping skill ${skillName} - no function descriptions`);
        return;
      }
      embedding = await this.getEmbedding(description);
      confidence = 0.7;
    }

    this.skillAffordances.push({
      skillName,
      description,
      embedding,
      confidence,
      functions
    });
  }

  /**
   * Select relevant skills for a given task/playbook using semantic matching
   * @param playbookContent - The playbook text describing what needs to be done
   * @param maxSkills - Maximum number of skills to return
   * @returns Array of function objects to pass to LLM
   */
  async selectSkillsForTask(playbookContent, maxSkills = 2) {
    if (this.skillAffordances.length === 0) {
      return [];
    }

    // If playbook is too short or generic, return all skills
    if (!playbookContent || playbookContent.trim().length < 20) {
      // Return all available functions from all skills
      return this.skillAffordances.flatMap(skill => skill.functions);
    }

    // Extract the meaningful part of the playbook (first few sentences)
    const intent = this.extractIntent(playbookContent);

    // Generate embedding for the task intent
    const intentEmbedding = await this.getEmbedding(intent);

    // Calculate similarity with each skill
    const similarities = this.skillAffordances.map(skill => ({
      ...skill,
      similarity: this.cosineSimilarity(intentEmbedding, skill.embedding)
    }));

    // Sort by similarity descending
    similarities.sort((a, b) => b.similarity - a.similarity);

    // Filter by threshold and take top N
    const relevantSkills = similarities
      .filter(s => s.similarity >= this.similarityThreshold)
      .slice(0, maxSkills);

    if (this.verbose && relevantSkills.length > 0) {
      console.log(`[SkillSelector] Selected ${relevantSkills.length} skills for: "${intent.substring(0, 50)}..."`);
      relevantSkills.forEach(skill => {
        console.log(`  - ${skill.skillName} (similarity: ${skill.similarity.toFixed(3)})`);
      });
    }

    // Return functions from relevant skills
    return relevantSkills.flatMap(skill => skill.functions);
  }

  /**
   * Extract intent from playbook content
   */
  extractIntent(playbookContent) {
    // Remove template literals and extract meaningful sentences
    const cleanText = playbookContent
      .replace(/\$\{[^}]+\}/g, '') // Remove ${...}
      .replace(/IMPORTANT:.*/gi, '') // Remove "IMPORTANT" instructions
      .replace(/Return.*JSON.*/gi, '') // Remove JSON format instructions
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('//'))
      .slice(0, 3) // Take first 3 meaningful lines
      .join(' ')
      .trim();

    return cleanText || playbookContent.substring(0, 200);
  }

  /**
   * Get embedding for text (with lazy initialization)
   */
  async getEmbedding(text) {
    if (!this.embeddingProvider) {
      this.embeddingProvider = new LLMProvider({
        provider: 'openai',
        model: 'text-embedding-3-small'
      });
    }

    return await this.embeddingProvider.getEmbedding(text);
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      return 0;
    }

    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
  }
}

// Global skill selector instance
export const skillSelector = new SkillSelector({ verbose: false });
