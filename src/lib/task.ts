import { ProcessResult, ProcessState } from "./process";

// Task contain function body
class Task {
  constructor(public taskId: string, private execute: (state: ProcessState) => Promise<ProcessResult>) {}

  public run(state: ProcessState): Promise<ProcessResult> {
    return this.execute(state);
  }
}
