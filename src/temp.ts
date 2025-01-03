// CompleteWorkerSystem.ts

/**
 * ---------------------------
 * Import Statements
 * ---------------------------
 */

/**
 * ---------------------------
 * Interface Definitions
 * ---------------------------
 */

/**
 * Represents a process that can execute tasks.
 */
interface Process {
  pid: number;
  mailbox: any[];
  pendingTasks: Task[];
  status: "running" | "waiting" | "done";

  receivePatterns?: {
    pattern: (msg: any) => boolean;
    callback: (msg: any) => void;
  }[];

  arg: { [key: string]: any };
  state: { [key: string]: any };
}

/**
 * Represents the result after a task is executed.
 */
interface ProcessResult {
  newState: Process;
  outgoingMessages: { to: number; msg: any }[];
  done?: boolean;
}

/**
 * ---------------------------
 * Immutable Deep Copy Function
 * ---------------------------
 */

/**
 * Creates an immutable deep copy of the provided object.
 * @param obj The object to deep clone.
 * @returns A deep-cloned copy of the object.
 */
// TODO use lodash deepclone
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * ---------------------------
 * Task Class Definition
 * ---------------------------
 */

/**
 * The Task class represents a unit of work that can be executed by a worker.
 * It includes a static method to register callbacks that are invoked when a new task is registered.
 */
class Task {
  // Global array to store all instantiated tasks
  static registeredTasks: Task[] = [];

  // Set to track unique taskIds
  private static taskIds: Set<string> = new Set();

  // Array of callbacks to be invoked when a new task is registered
  private static taskRegisteredCallbacks: Array<(task: Task) => void> = [];

  /**
   * Registers a callback to be invoked whenever a new task is registered.
   * @param callback The callback function to register.
   */
  static onTaskRegistered(callback: (task: Task) => void): void {
    Task.taskRegisteredCallbacks.push(callback);
  }

  /**
   * Creates a new Task.
   * @param taskId A unique identifier for the task.
   * @param execute The asynchronous function that defines the task's behavior.
   * @param schema The Zod schema to validate the process state before task execution.
   * @throws Will throw an error if the taskId is not unique.
   */
  constructor(public taskId: string, private execute: (process: Process) => Promise<ProcessResult>) {
    // Check for unique taskId
    if (Task.taskIds.has(taskId)) {
      throw new Error(`Task ID "${taskId}" is already registered. Please use a unique taskId.`);
    }
    Task.taskIds.add(taskId);

    // Automatically register the task upon instantiation
    Task.registeredTasks.push(this);

    // Invoke all registered callbacks
    Task.taskRegisteredCallbacks.forEach((cb) => cb(this));
  }

  /**
   * Executes the task's function.
   * @param process The current process executing the task.
   * @returns A promise that resolves to a ProcessResult.
   */
  public run = (process: Process): Promise<ProcessResult> => {
    return this.execute(process);
  };

  /**
   * Extracts the function body of the execute function as a string.
   * This is necessary to embed the function into the worker code.
   * @returns The function body as a string.
   */
  public getFunctionBody = (): string => {
    const fnStr = this.execute.toString();
    // Extract the body of the async arrow function
    const bodyMatch = fnStr.match(/async\s*\(\s*\w+\s*\)\s*=>\s*\{([\s\S]*)\}$/);
    if (!bodyMatch) {
      throw new Error("Invalid execute function format. Ensure it's an async arrow function.");
    }
    return bodyMatch[1];
  };
}

/**
 * ---------------------------
 * Throttle Utility Function
 * ---------------------------
 */

/**
 * Creates a throttled version of the provided function.
 * The throttled function ensures that the original function is called at most once every `delay` milliseconds.
 * @param delay The minimum time interval between successive calls in milliseconds.
 * @param func The function to throttle.
 * @returns The throttled function.
 */
function throttle<T extends (...args: any[]) => any>(delay: number, func: T): T {
  let lastCall = 0;
  let timeout: number | null = null;

  return function (...args: any[]) {
    const now = Date.now();
    const remaining = delay - (now - lastCall);

    if (remaining <= 0) {
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
      lastCall = now;
      func.apply(this, args);
    } else if (timeout === null) {
      timeout = window.setTimeout(() => {
        lastCall = Date.now();
        timeout = null;
        func.apply(this, args);
      }, remaining);
    }
  } as T;
}

/**
 * ---------------------------
 * Worker Code Generator
 * ---------------------------
 */

/**
 * Generates the worker code by embedding all registered task functions.
 * @returns A string representing the complete worker code.
 */
const generateWorkerCode = (): string => {
  // Start building the worker code
  let workerCode = `
    onmessage = async function(event) {
      const { taskId, pid, state } = event.data;

      let taskFn;
  `;

  // Embed each registered task's function body within a conditional block
  Task.registeredTasks.forEach((task) => {
    const functionBody = task.getFunctionBody();
    workerCode += `
      if (taskId === '${task.taskId}') {
        taskFn = async (process) => {
          ${functionBody}
        };
      }
    `;
  });

  // Handle the case where the taskId does not match any registered tasks
  workerCode += `
      if (!taskFn) {
        postMessage({ type: 'execute', taskId, success: false, error: 'Task not found.' });
        return;
      }

      try {
        const result = await taskFn({ pid, state });
        postMessage({ type: 'execute', taskId, success: true, result });
      } catch (error) {
        postMessage({ type: 'execute', taskId, success: false, error: error.message });
      }
    };
  `;

  return workerCode;
};

/**
 * ---------------------------
 * WorkerPool Class Definition
 * ---------------------------
 */

/**
 * Represents a message received from a worker.
 */
interface WorkerMessage {
  type: "execute";
  taskId: string;
  pid: number;
  state: any;
  success?: boolean;
  result?: ProcessResult;
  error?: string;
}

/**
 * Represents metadata for each worker in the pool.
 */
interface WorkerMetadata {
  id: number;
  worker: Worker;
  blobUrl: string; // To revoke Blob URL upon termination
  taskCount: number;
  flaggedForDestruction: boolean;
}

/**
 * Configuration options for the WorkerPool.
 */
interface WorkerPoolOptions {
  initialWorkers: number;
  minWorkers: number;
  maxWorkers: number;
  scaleUpThreshold: number;
  maxRetries?: number; // Maximum retry attempts for failed tasks
}

/**
 * The WorkerPool class manages a pool of workers, dynamically scaling the number based on task demand.
 */
class WorkerPool {
  private workers: WorkerMetadata[] = [];
  private busyWorkers = new Set<Worker>();
  private taskQueue: Array<{
    pid: number;
    task: Task;
    process: Process;
    resolve: (res: { result: ProcessResult; workerId: number }) => void;
    reject: (err: any) => void;
    retries: number;
  }> = [];

  // Dynamic scaling parameters
  private minWorkers: number;
  private maxWorkers: number;
  private scaleUpThreshold: number;
  private maxRetries: number;

  /**
   * Initializes the WorkerPool with dynamic scaling capabilities.
   * @param options An object containing configuration options.
   */
  constructor(options: WorkerPoolOptions) {
    const { initialWorkers, minWorkers, maxWorkers, scaleUpThreshold, maxRetries = 3 } = options;
    this.minWorkers = minWorkers;
    this.maxWorkers = maxWorkers;
    this.scaleUpThreshold = scaleUpThreshold;
    this.maxRetries = maxRetries;

    // Generate worker code with all registered tasks
    const workerCode = generateWorkerCode();

    // Create a Blob URL for the worker
    const blob = new Blob([workerCode], { type: "text/javascript" });
    const workerUrl = URL.createObjectURL(blob);

    // Initialize workers
    this.workers = Array.from({ length: initialWorkers }, (_, index) => {
      const worker = new Worker(workerUrl);
      worker.onerror = (error) => this.handleWorkerError(index + 1, error);
      worker.onmessage = this.handleWorkerMessage.bind(this, worker);
      return {
        id: index + 1,
        worker,
        blobUrl: workerUrl,
        taskCount: Task.registeredTasks.length,
        flaggedForDestruction: false,
      };
    });

    // Subscribe to Task.onTaskRegistered
    Task.onTaskRegistered(this.onNewTaskRegistered);

    // Periodically check for scaling (only scaling up)
    setInterval(() => this.scaleWorkers(), 1000); // Check every second
  }

  /**
   * Handles worker errors by logging and potentially implementing retry mechanisms.
   * @param workerId The ID of the worker that encountered an error.
   * @param error The error event.
   */
  private handleWorkerError = (workerId: number, error: ErrorEvent): void => {
    console.error(`Worker ${workerId} encountered an error:`, error.message);
    // Implement additional error handling or alerting mechanisms here
  };

  /**
   * Handles new task registrations by flagging workers that cannot handle the increased task count.
   * @param newTask The newly registered task.
   */
  private onNewTaskRegistered = (newTask: Task): void => {
    const totalTasks = Task.registeredTasks.length;

    // Identify workers with taskCount < totalTasks
    const workersToFlag = this.workers.filter((worker) => worker.taskCount < totalTasks && !worker.flaggedForDestruction);

    workersToFlag.forEach((worker) => {
      worker.flaggedForDestruction = true;
      console.log(`Worker ${worker.id} flagged for destruction due to new task addition.`);
    });

    // Update taskCount for all workers
    this.workers.forEach((worker) => {
      worker.taskCount = totalTasks;
    });

    // Refresh WorkerPool to include new tasks
    this.refreshWorkerPoolThrottled();
  };

  /**
   * Refreshes the WorkerPool by terminating flagged workers and spawning new ones with updated code.
   * If any workers remain flagged after termination attempts, schedules another throttled call.
   */
  private refreshWorkerPoolThrottled = throttle(5000, (): void => {
    // Terminate flagged workers that are idle
    const workersToTerminate = this.workers.filter((worker) => worker.flaggedForDestruction && !this.busyWorkers.has(worker.worker));

    workersToTerminate.forEach((worker) => {
      console.log(`Terminating Worker ${worker.id} as it is flagged for destruction.`);
      worker.worker.terminate();
      // Revoke Blob URL to free memory
      URL.revokeObjectURL(worker.blobUrl);
      // Remove from workers array
      this.workers = this.workers.filter((w) => w.id !== worker.id);
    });

    if (workersToTerminate.length === 0) {
      // No workers were terminated in this attempt
      return;
    }

    // Generate updated worker code with all tasks
    const updatedWorkerCode = generateWorkerCode();

    // Create a new Blob URL for the updated worker code
    const blob = new Blob([updatedWorkerCode], { type: "text/javascript" });
    const updatedWorkerUrl = URL.createObjectURL(blob);

    // Spawn new workers to replace the terminated ones
    const workersToAdd = workersToTerminate.length;
    for (let i = 0; i < workersToAdd; i++) {
      if (this.workers.length >= this.maxWorkers) {
        console.warn("Maximum number of workers reached. Cannot add more workers.");
        break;
      }
      const newId = this.workers.length + 1;
      const worker = new Worker(updatedWorkerUrl);
      worker.onerror = (error) => this.handleWorkerError(newId, error);
      worker.onmessage = this.handleWorkerMessage.bind(this, worker);
      this.workers.push({
        id: newId,
        worker,
        blobUrl: updatedWorkerUrl,
        taskCount: Task.registeredTasks.length,
        flaggedForDestruction: false,
      });
      console.log(`Spawned new Worker ${newId} with updated task set.`);
    }

    // Check if any workers are still flagged for destruction
    const remainingFlaggedWorkers = this.workers.filter((worker) => worker.flaggedForDestruction);

    if (remainingFlaggedWorkers.length > 0) {
      console.log("Some workers are still flagged for destruction. Scheduling another refresh in 5 seconds.");
      this.refreshWorkerPoolThrottled();
    }
  });

  /**
   * Handles messages received from workers.
   * @param worker The worker that sent the message.
   * @param event The message event.
   */
  private handleWorkerMessage = (worker: Worker, event: MessageEvent): void => {
    const data: WorkerMessage = event.data;

    if (data.type === "execute") {
      this.busyWorkers.delete(worker);

      const queuedTaskIndex = this.taskQueue.findIndex((t) => t.task.taskId === data.taskId && t.pid === data.pid);

      if (queuedTaskIndex !== -1) {
        const queuedTask = this.taskQueue[queuedTaskIndex];
        if (data.success) {
          queuedTask.resolve({ result: data.result!, workerId: this.getWorkerId(worker)! });
        } else {
          // Handle task failure with retry mechanism
          if (queuedTask.retries < this.maxRetries) {
            console.warn(`Task "${queuedTask.task.taskId}" for PID ${queuedTask.pid} failed. Retrying (${queuedTask.retries + 1}/${this.maxRetries})...`);
            queuedTask.retries += 1;
            this.taskQueue.push(queuedTask); // Re-enqueue the task
          } else {
            console.error(`Task "${queuedTask.task.taskId}" for PID ${queuedTask.pid} failed after ${this.maxRetries} retries: ${data.error}`);
            queuedTask.reject(data.error);
          }
        }
        this.taskQueue.splice(queuedTaskIndex, 1);
      }

      this.dispatchNextTask();
    }
  };

  /**
   * Dispatches the next task in the queue to an idle worker.
   */
  private dispatchNextTask = (): void => {
    if (this.taskQueue.length === 0) return;

    const idleWorker = this.workers.find(({ worker }) => !this.busyWorkers.has(worker));
    if (!idleWorker) return;

    const nextTask = this.taskQueue.shift()!;
    this.busyWorkers.add(idleWorker.worker);

    idleWorker.worker.postMessage({
      taskId: nextTask.task.taskId,
      pid: nextTask.pid,
      state: nextTask.process.state,
    });
  };

  /**
   * Runs a task by enqueueing it and dispatching to an available worker.
   * @param pid Process ID.
   * @param process Current process.
   * @param task The task to execute.
   * @returns A promise that resolves with the task result and worker ID.
   */
  public runTask = (pid: number, process: Process, task: Task): Promise<{ result: ProcessResult; workerId: number }> => {
    return new Promise<{ result: ProcessResult; workerId: number }>((resolve, reject) => {
      try {
        // Create a new immutable deep copy of the process with validated state
        const immutableProcess: Process = {
          ...process,
          state: deepClone(process.state),
        };

        this.taskQueue.push({ pid, task, process: immutableProcess, resolve, reject, retries: 0 });
        this.dispatchNextTask();
      } catch (err) {
        reject(err);
      }
    });
  };

  /**
   * Retrieves the worker's ID.
   * @param worker The worker instance.
   * @returns The worker's ID.
   */
  private getWorkerId = (worker: Worker): number | undefined => {
    const workerObj = this.workers.find((w) => w.worker === worker);
    return workerObj?.id;
  };

  /**
   * Scales the number of workers based on the current task queue length.
   * Only scales up as scaling down has been removed.
   */
  private scaleWorkers = (): void => {
    const queueLength = this.taskQueue.length;
    const currentWorkers = this.workers.length;

    // Scale Up
    if (queueLength > this.scaleUpThreshold && currentWorkers < this.maxWorkers) {
      const workersToAdd = Math.min(queueLength - this.scaleUpThreshold, this.maxWorkers - currentWorkers);
      for (let i = 0; i < workersToAdd; i++) {
        this.addWorker();
      }
      console.log(`Scaled up: Added ${workersToAdd} worker(s). Total workers: ${this.workers.length}`);
    }

    // Scale Down functionality has been removed as per user request
  };

  /**
   * Adds a new worker to the pool.
   */
  private addWorker = (): void => {
    const updatedWorkerCode = generateWorkerCode(); // Ensure worker code is up-to-date
    const blob = new Blob([updatedWorkerCode], { type: "text/javascript" });
    const workerUrl = URL.createObjectURL(blob);
    const newWorker = new Worker(workerUrl);
    newWorker.onerror = (error) => this.handleWorkerError(this.workers.length + 1, error);
    newWorker.onmessage = this.handleWorkerMessage.bind(this, newWorker);
    const newId = this.workers.length + 1;
    this.workers.push({
      id: newId,
      worker: newWorker,
      blobUrl: workerUrl,
      taskCount: Task.registeredTasks.length,
      flaggedForDestruction: false,
    });
    console.log(`Spawned new Worker ${newId} with updated task set.`);
  };

  /**
   * Terminates all workers in the pool.
   * Cleans up resources by revoking Blob URLs.
   */
  public terminate = (): void => {
    this.workers.forEach(({ worker, blobUrl, id }) => {
      console.log(`Terminating Worker ${id}.`);
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    });
    this.workers = [];
    this.busyWorkers.clear();
    this.taskQueue = [];
  };
}

/**
 * ---------------------------
 * WorkerScheduler Class Definition
 * ---------------------------
 */

/**
 * The WorkerScheduler class manages processes and dispatches tasks to the WorkerPool.
 */
class WorkerScheduler {
  private processes = new Map<number, Process>();
  private readyQueue: number[] = [];
  private nextPid = 1;
  private isRunning = false;

  /**
   * Initializes the WorkerScheduler with a reference to the WorkerPool.
   * @param workerPool The WorkerPool instance to dispatch tasks to.
   */
  constructor(private workerPool: WorkerPool) {}

  /**
   * Spawns a new process with an initial state.
   * @param params An object containing the initial state.
   * @param params.initialState The initial state for the process.
   * @returns The PID of the new process.
   */
  public spawnProcess = ({ initialState }: { initialState?: Partial<Process["state"]> } = {}): number => {
    const pid = this.nextPid++;
    const process: Process = {
      pid,
      mailbox: [],
      pendingTasks: [],
      status: "running",
      state: { ...initialState },
    };
    this.processes.set(pid, process);
    this.readyQueue.push(pid);
    this.runLoop().catch((err) => console.error("Scheduler loop error:", err));
    return pid;
  };

  /**
   * Enqueues a task to be run by a process.
   * @param pid The PID of the process.
   * @param task The task to run.
   */
  public runProcess = (pid: number, task: Task, arg): void => {
    const proc = this.processes.get(pid);
    if (!proc) throw new Error(`Process with PID ${pid} does not exist`);

    proc.pendingTasks.push(task);

    if (proc.status !== "done" && !this.readyQueue.includes(pid)) {
      this.readyQueue.push(pid);
    }

    this.runLoop().catch((err) => console.error("Scheduler loop error:", err));
  };

  /**
   * The main scheduler loop that dispatches tasks to workers.
   */
  private runLoop = async (): Promise<void> => {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      while (this.hasProcesses()) {
        await this.tick();
      }
    } finally {
      this.isRunning = false;
    }
  };

  /**
   * Executes a single tick of the scheduler loop.
   */
  private tick = async (): Promise<void> => {
    if (this.readyQueue.length === 0) return;

    const pid = this.readyQueue.shift()!;
    const process = this.processes.get(pid);
    if (!process || process.status === "done") return;

    const nextTask = process.pendingTasks.shift();
    if (!nextTask) return;

    try {
      const { result, workerId } = await this.workerPool.runTask(pid, process, nextTask);
      this.processes.set(pid, result.newState);

      for (const { to, msg } of result.outgoingMessages) {
        const targetProcess = this.processes.get(to);
        if (targetProcess) {
          this.deliverMessage(targetProcess, msg);
        }
      }

      if (result.done) {
        process.status = "done";
      } else {
        this.readyQueue.push(pid);
      }
    } catch (err) {
      console.error(`Error processing task "${nextTask.taskId}" for PID ${pid}:`, err);
      process.status = "done";
    }
  };

  /**
   * Delivers a message to a target process based on receive patterns.
   * @param targetProcess The target process.
   * @param msg The message to deliver.
   */
  private deliverMessage = (targetProcess: Process, msg: any): void => {
    if (targetProcess.receivePatterns) {
      for (let i = 0; i < targetProcess.receivePatterns.length; i++) {
        const { pattern, callback } = targetProcess.receivePatterns[i];
        if (pattern(msg)) {
          targetProcess.receivePatterns.splice(i, 1);
          callback(msg);
          return;
        }
      }
    }
    targetProcess.mailbox.push(msg);
  };

  /**
   * Checks if there are any active processes.
   * @returns True if there are active processes; otherwise, false.
   */
  private hasProcesses = (): boolean => {
    if (this.readyQueue.length > 0) return true;
    for (const proc of this.processes.values()) {
      if (proc.status !== "done") return true;
    }
    return false;
  };

  /**
   * Visualizes the current state of all processes.
   * @returns An array representing the state of each process.
   */
  public visualize = (): Array<{ pid: number; status: string; mailboxLen: number; pendingTasks: number; count: number }> => {
    return Array.from(this.processes.values()).map((p) => ({
      pid: p.pid,
      status: p.status,
      mailboxLen: p.mailbox.length,
      pendingTasks: p.pendingTasks.length,
      count: p.state.count ?? 0,
    }));
  };
}

/**
 * ---------------------------
 * Main Execution Logic
 * ---------------------------
 */

// Initialize the WorkerPool with dynamic scaling parameters using named parameters
const workerPool = new WorkerPool({
  initialWorkers: 2, // Number of workers to start with
  minWorkers: 2, // Minimum number of workers to maintain
  maxWorkers: 10, // Maximum number of workers allowed
  scaleUpThreshold: 10, // Task queue length threshold to scale up
  maxRetries: 2, // Maximum retry attempts for failed tasks
});

// Initialize the WorkerScheduler with the WorkerPool
const scheduler = new WorkerScheduler(workerPool);

// Spawn two processes with initial counts
const pid1 = scheduler.spawnProcess({ initialState: { count: 0 } });
const pid2 = scheduler.spawnProcess({ initialState: { count: 100 } });

/**
 * ---------------------------
 * Task Definitions
 * ---------------------------
 */

// Define Zod schemas for task states

// Schema for the 'increment' task state

// Example Task 1: Increment Counter
const incrementTask = new Task("increment", async (process: Process): Promise<ProcessResult> => {
  // Ensure immutable state updates
  const currentCount = process.state.count;
  const newCount = currentCount + 1;

  return {
    newState: {
      ...process,
      state: {
        ...process.state,
        count: newCount,
      },
    },
    outgoingMessages: [],
    done: false,
  };
});

// Example Task 2: Decrement Counter
const decrementTask = new Task("decrement", async (process: Process): Promise<ProcessResult> => {
  // Ensure immutable state updates
  const currentCount = process.state.count;
  const newCount = currentCount - 1;

  return {
    newState: {
      ...process,
      state: {
        ...process.state,
        count: newCount,
      },
    },
    outgoingMessages: [],
    done: false,
  };
});

// Enqueue tasks for each process
scheduler.runProcess(pid1, incrementTask);
scheduler.runProcess(pid2, decrementTask);

// Visualize process states every 500ms
const visualizationInterval = setInterval(() => {
  console.log("Process States:", scheduler.visualize());
}, 500);

// Optional: Simulate adding a new task after some time (e.g., 5 seconds)
setTimeout(() => {
  console.log("Adding a new task: multiply");

  // Define and instantiate a new task
  const multiplyTask = new Task("multiply", async (process: Process): Promise<ProcessResult> => {
    // Ensure immutable state updates
    const currentCount = process.state.count;
    for (let i = 0; i < 1000000; i++) {
      // Simulate some work
      // Note: This loop is intentionally time-consuming
    }
    const newCount = currentCount * 2;

    return {
      newState: {
        ...process,
        state: {
          ...process.state,
          count: newCount,
        },
      },
      outgoingMessages: [],
      done: false,
    };
  });

  // Enqueue the new task for existing processes
  scheduler.runProcess(pid1, multiplyTask);
  scheduler.runProcess(pid2, multiplyTask);
}, 5000); // Add the new task after 5 seconds

// Optional: Clean up after a certain period (e.g., 15 seconds)
setTimeout(() => {
  console.log("Terminating all workers and stopping visualization.");
  workerPool.terminate();
  clearInterval(visualizationInterval);
}, 15000); // Terminate after 15 seconds

/**
 * ---------------------------
 * End of CompleteWorkerSystem.ts
 * ---------------------------
 */
