/**
 * Automatic Planning System
 *
 * Allows agents to automatically decompose complex tasks into executable steps
 * using LLM-based planning.
 */

import { LLMProvider } from './llm-provider.js';
import { actionRegistry } from './action-registry.js';

export class Planner {
  constructor(config) {
    this.name = config.name || 'DefaultPlanner';
    this.llm = config.llm || { provider: 'openai', model: 'gpt-5.2', temperature: 0 };
    this.maxSteps = config.maxSteps || 10;
    this.allowReplanning = config.allowReplanning !== false;
    this.llmProvider = null;
  }

  /**
   * Create a plan for a given goal/task
   * @param {string} goal - The goal to plan for
   * @param {object} context - Execution context
   * @param {Agent} agent - The agent that will execute the plan (for permission filtering)
   */
  async createPlan(goal, context = {}, agent = null) {
    console.log(`[Planner:${this.name}] 📋 Creating plan for: ${goal}`);

    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    const planningPrompt = this.buildPlanningPrompt(goal, context, agent);

    try {
      const plan = await this.llmProvider.executePlanning(planningPrompt);

      if (!plan || !plan.steps || !Array.isArray(plan.steps)) {
        throw new Error('Invalid plan format: missing steps array');
      }

      console.log(`[Planner:${this.name}] ✓ Created plan with ${plan.steps.length} steps`);

      return {
        goal,
        steps: plan.steps,
        context: plan.context || {},
        created_at: Date.now()
      };
    } catch (error) {
      console.error(`[Planner:${this.name}] ✗ Planning failed:`, error.message);
      throw new Error(`Planning failed: ${error.message}`);
    }
  }

  /**
   * Replan after a step failure
   */
  async replan(originalGoal, failedStep, executedSteps, error, context = {}, agent = null) {
    if (!this.allowReplanning) {
      throw new Error('Re-planning is disabled');
    }

    console.log(`[Planner:${this.name}] 🔄 Re-planning after failure at step ${failedStep}`);

    const replanPrompt = this.buildReplanningPrompt(
      originalGoal,
      executedSteps,
      failedStep,
      error,
      context,
      agent
    );

    if (!this.llmProvider) {
      this.llmProvider = new LLMProvider(this.llm);
    }

    const newPlan = await this.llmProvider.executePlanning(replanPrompt);

    if (!newPlan || !newPlan.steps || !Array.isArray(newPlan.steps)) {
      throw new Error('Invalid re-plan format: missing steps array');
    }

    console.log(`[Planner:${this.name}] ✓ Created new plan with ${newPlan.steps.length} steps`);

    return {
      goal: originalGoal,
      steps: newPlan.steps,
      context: newPlan.context || context,
      replanned: true,
      replanned_at: Date.now()
    };
  }

  /**
   * Build the planning prompt
   */
  buildPlanningPrompt(goal, context, agent = null) {
    return `Break down this goal into executable steps.

Goal: ${goal}

${actionRegistry.generatePromptDocumentation(agent)}

Return ONLY JSON (no markdown):
{
  "steps": [
    { "intent": "action_name", ... }
  ]
}`;
  }

  /**
   * Build the re-planning prompt
   */
  buildReplanningPrompt(goal, executedSteps, failedStep, error, context, agent = null) {
    return `Plan failed at step ${failedStep}. Create recovery plan.

Goal: ${goal}
Error: ${error}

${actionRegistry.generatePromptDocumentation(agent)}

Return ONLY JSON (no markdown):
{
  "steps": [
    { "intent": "action_name", ... }
  ]
}`;
  }
}

/**
 * Planning-enabled Agent
 * Extends regular agents with automatic planning capabilities
 */
export class PlanningAgent {
  constructor(agent, plannerConfig) {
    this.agent = agent;
    this.planner = new Planner(plannerConfig);
    this.currentPlan = null;
    this.executionHistory = [];
  }

  /**
   * Execute a goal with automatic planning
   */
  async executeWithPlanning(goal, context = {}) {
    console.log(`[PlanningAgent:${this.agent.name}] 🎯 Starting planned execution`);
    console.log(`[PlanningAgent:${this.agent.name}] Goal: ${goal}`);

    // Create initial plan (pass the agent for permission filtering)
    this.currentPlan = await this.planner.createPlan(goal, context, this.agent);
    this.executionHistory = [];

    let stepIndex = 0;
    let retryCount = 0;
    const maxRetries = 2;

    while (stepIndex < this.currentPlan.steps.length) {
      const step = this.currentPlan.steps[stepIndex];

      console.log(`[PlanningAgent:${this.agent.name}] 📍 Step ${stepIndex + 1}/${this.currentPlan.steps.length}: ${step.description || step.type}`);

      try {
        const result = await this.executeStep(step, context);

        this.executionHistory.push({
          step: stepIndex,
          action: step,
          result,
          success: true
        });

        // Update context with result
        if (result && typeof result === 'object') {
          context = { ...context, ...result };
        }

        stepIndex++;
        retryCount = 0;

      } catch (error) {
        console.error(`[PlanningAgent:${this.agent.name}] ✗ Step ${stepIndex + 1} failed:`, error.message);

        this.executionHistory.push({
          step: stepIndex,
          action: step,
          error: error.message,
          success: false
        });

        // Try re-planning
        if (retryCount < maxRetries && this.planner.allowReplanning) {
          retryCount++;
          console.log(`[PlanningAgent:${this.agent.name}] 🔄 Attempting re-plan (${retryCount}/${maxRetries})`);

          try {
            this.currentPlan = await this.planner.replan(
              goal,
              stepIndex,
              this.executionHistory.filter(h => h.success),
              error.message,
              context,
              this.agent
            );

            // Restart from beginning of new plan
            stepIndex = 0;

          } catch (replanError) {
            console.error(`[PlanningAgent:${this.agent.name}] ✗ Re-planning failed:`, replanError.message);
            throw new Error(`Planning failed: ${error.message}. Re-planning also failed: ${replanError.message}`);
          }
        } else {
          throw new Error(`Step ${stepIndex + 1} failed after ${retryCount} retries: ${error.message}`);
        }
      }
    }

    console.log(`[PlanningAgent:${this.agent.name}] ✓ Plan execution complete`);

    // Return final result from last step
    const lastHistory = this.executionHistory[this.executionHistory.length - 1];
    return lastHistory?.result || { success: true };
  }

  /**
   * Execute a single step from the plan
   */
  async executeStep(step, context) {
    // Delegate to the agent's action execution system
    if (this.agent.executeActions) {
      return await this.agent.executeActions([step]);
    }

    // Fallback: execute based on step type
    switch (step.type) {
      case 'call_skill':
        return await this.agent.callSkill(step.skill, step.input);

      case 'send_message':
      case 'update_state':
        // Use action registry executor
        const actionDef = actionRegistry.get(step.type);
        if (actionDef && actionDef.execute) {
          return await actionDef.execute(step, this.agent);
        }
        throw new Error(`Action type "${step.type}" has no executor registered`);

      case 'return':
        return step.data || step.result || {};

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  /**
   * Get execution summary
   */
  getSummary() {
    return {
      goal: this.currentPlan?.goal,
      totalSteps: this.currentPlan?.steps.length,
      executedSteps: this.executionHistory.length,
      successfulSteps: this.executionHistory.filter(h => h.success).length,
      failedSteps: this.executionHistory.filter(h => !h.success).length,
      replanned: this.currentPlan?.replanned || false
    };
  }
}
