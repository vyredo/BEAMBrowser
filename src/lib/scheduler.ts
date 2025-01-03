import { Task, ProcessState } from "./process";
import { type WorkerPool } from "./worker-pool";

/**
 *
 */
export class WorkerScheduler {
  private processes = new Map<number, ProcessState>();
  private readyQueue: number[] = [];
  private nextPid = 1;
  private isRunning = false;

  constructor(private workerPool: WorkerPool) {}

  public spawnProcess(initial: Partial<ProcessState> = {}): number {
    const pid = this.nextPid++;
    const state: ProcessState = {
      pid,
      mailbox: [],
      pendingTasks: [],
      status: "running",
      ...initial,
    };
    this.processes.set(pid, state);
    this.readyQueue.push(pid);
    return pid;
  }

  public runProcess(pid: number, task: Task) {
    const proc = this.processes.get(pid);
    if (!proc) throw new Error(`Process with PID ${pid} does not exist`);

    proc.pendingTasks.push(task);

    if (proc.status !== "done" && !this.readyQueue.includes(pid)) {
      this.readyQueue.push(pid);
    }

    this.runLoop().catch((err) => console.error("Scheduler loop error:", err));
  }

  private async runLoop() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      while (this.hasProcesses()) {
        await this.tick();
      }
    } finally {
      this.isRunning = false;
    }
  }

  private async tick() {
    if (this.readyQueue.length === 0) return;

    const pid = this.readyQueue.shift()!;
    const state = this.processes.get(pid);
    if (!state || state.status === "done") return;

    const nextTask = state.pendingTasks.shift();
    if (!nextTask) return;

    try {
      const { result } = await this.workerPool.runTask(pid, state, nextTask);
      this.processes.set(pid, result.newState);

      for (const { to, msg } of result.outgoingMessages) {
        const targetState = this.processes.get(to);
        if (targetState) {
          this.deliverMessage(targetState, msg);
        }
      }

      if (result.done) {
        state.status = "done";
      } else {
        this.readyQueue.push(pid);
      }
    } catch (err) {
      console.error(`Error processing task for PID ${pid}:`, err);
      state.status = "done";
    }
  }

  private deliverMessage(toState: ProcessState, msg: any) {
    if (toState.receivePatterns) {
      for (let i = 0; i < toState.receivePatterns.length; i++) {
        const { pattern, callback } = toState.receivePatterns[i];
        if (pattern(msg)) {
          toState.receivePatterns.splice(i, 1);
          callback(msg);
          return;
        }
      }
    }
    toState.mailbox.push(msg);
  }

  private hasProcesses(): boolean {
    if (this.readyQueue.length > 0) return true;
    for (const proc of this.processes.values()) {
      if (proc.status !== "done") return true;
    }
    return false;
  }

  public visualize() {
    return Array.from(this.processes.values()).map((p) => ({
      pid: p.pid,
      status: p.status,
      mailboxLen: p.mailbox.length,
      pendingTasks: p.pendingTasks.length,
      count: p.count ?? 0,
    }));
  }
}
