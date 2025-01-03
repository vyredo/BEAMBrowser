import { WorkerScheduler, WorkerPool, Task } from "./lib";

const workerUrl = new URL("./lib/worker.ts", import.meta.url).toString();
const workerPool = new WorkerPool(workerUrl, 2);
const scheduler = new WorkerScheduler(workerPool);

const pid1 = scheduler.spawnProcess({ count: 0 });
const pid2 = scheduler.spawnProcess({ count: 100 });

scheduler.runProcess(pid1, new Task("task-1"));
scheduler.runProcess(pid2, new Task("task-2"));

setInterval(() => {
  console.log(scheduler.visualize());
}, 500);
