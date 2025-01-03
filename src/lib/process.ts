import { Task } from "./task";
export { Task };

// Processes is a green thread
export interface ProcessState {
  pid: number;
  mailbox: any[];
  pendingTasks: Task[];
  status: "running" | "waiting" | "done";

  receivePatterns?: {
    pattern: (msg: any) => boolean;
    callback: (msg: any) => void;
  }[];

  [key: string]: any;
}

export interface ProcessResult {
  newState: ProcessState;
  outgoingMessages: { to: number; msg: any }[];
  done?: boolean;
}
