/**
 * AgentTaskQueue — Per-agent task queue.
 *
 * Each agent instance gets its own queue. When the System delegates a task
 * to a delegate agent (via task: { subject, description } or task: { id }),
 * the task is enqueued here — NOT in the global TaskManager panel.
 *
 * The global TaskManager remains for the System/coordinator's high-level
 * task tracking. Agent queues are internal to each agent.
 *
 * Usage:
 *   agent._taskQueue.enqueue(task)   // add a task
 *   agent._taskQueue.current()       // get the task being worked on
 *   agent._taskQueue.complete(id)    // mark done
 *   agent._taskQueue.list()          // all tasks
 */

export class AgentTaskQueue {
  constructor(agentName) {
    this.agentName = agentName;
    /** @type {Array<{ id: string, subject: string, description: string, status: 'pending'|'in_progress'|'completed', createdAt: string }>} */
    this._tasks = [];
    this._nextId = 1;
  }

  /**
   * Enqueue a task. Returns the task object (with assigned id).
   * @param {{ subject?: string, description?: string, id?: string }} taskData
   */
  enqueue(taskData) {
    const task = {
      id: taskData.id || String(this._nextId++),
      subject: taskData.subject || taskData.description?.substring(0, 80) || 'Task',
      description: taskData.description || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this._tasks.push(task);
    return task;
  }

  /** Get the current (first in_progress or first pending) task. */
  current() {
    return this._tasks.find(t => t.status === 'in_progress')
      || this._tasks.find(t => t.status === 'pending')
      || null;
  }

  /** Start working on a task (set to in_progress). */
  start(id) {
    const task = this._tasks.find(t => t.id === String(id));
    if (task) task.status = 'in_progress';
    return task;
  }

  /** Mark a task as completed. */
  complete(id) {
    const task = this._tasks.find(t => t.id === String(id));
    if (task) task.status = 'completed';
    return task;
  }

  /** Get all tasks. */
  list() {
    return [...this._tasks];
  }

  /** Get a task by id. */
  get(id) {
    return this._tasks.find(t => t.id === String(id)) || null;
  }

  /** Number of pending/in_progress tasks. */
  get pendingCount() {
    return this._tasks.filter(t => t.status !== 'completed').length;
  }
}
