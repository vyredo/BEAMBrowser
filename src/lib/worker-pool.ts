import { ProcessResult, ProcessState, Task } from "./process";

/*
 * Pool of webworker
 */
export class WorkerPool {
  private workers: Array<{ id: number; worker: Worker }> = [];
  private busyWorkers = new Set<Worker>();
  private taskQueue: Array<{
    pid: number;
    task: Task;
    state: ProcessState;
    resolve: (res: { result: ProcessResult; workerId: number }) => void;
    reject: (err: any) => void;
  }> = [];

  constructor(workerCode: string, maxWorkers: number) {
    this.workers = Array.from({ length: maxWorkers }, (_, index) => {
      const blob = new Blob([workerCode], { type: "text/javascript" });
      const workerUrl = URL.createObjectURL(blob);
      const worker = new Worker(workerUrl);
      worker.onerror = (error) => console.error("Worker error:", error);
      worker.onmessage = this.handleWorkerMessage.bind(this, worker);
      return { id: index + 1, worker };
    });
  }

  private handleWorkerMessage(worker: Worker, event: MessageEvent) {
    this.busyWorkers.delete(worker);

    const { pid, taskId, result, error } = event.data || {};
    const queuedTask = this.taskQueue.find((t) => t.task.taskId === taskId);

    if (queuedTask) {
      if (error) {
        queuedTask.reject(error);
      } else {
        queuedTask.resolve({
          result,
          workerId: this.workers.find(({ worker: w }) => w === worker)?.id!,
        });
      }
      this.taskQueue = this.taskQueue.filter((t) => t.task.taskId !== taskId);
    }

    this.dispatchNextTask();
  }

  private dispatchNextTask() {
    if (this.taskQueue.length === 0) return;

    const idleWorker = this.workers.find(({ worker }) => !this.busyWorkers.has(worker));
    if (!idleWorker) return;

    const nextTask = this.taskQueue.shift()!;
    this.busyWorkers.add(idleWorker.worker);

    idleWorker.worker.postMessage({
      pid: nextTask.pid,
      taskId: nextTask.task.taskId,
      state: nextTask.state,
    });
  }

  public runTask(pid: number, state: ProcessState, task: Task): Promise<{ result: ProcessResult; workerId: number }> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ pid, task, state, resolve, reject });
      this.dispatchNextTask();
    });
  }

  public terminate() {
    this.workers.forEach(({ worker }) => worker.terminate());
  }
}
