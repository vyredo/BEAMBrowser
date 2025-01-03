# BEAMBrowser

**BEAMBrowser** is an experimental project implementing a simplified version of the BEAM (Erlang VM) concepts inside a web browser environment—using JavaScript, Web Workers, and a custom Scheduler.

## Overview

Erlang’s BEAM provides lightweight processes, scheduling, and message passing at scale. Here, we’re recreating core ideas in JavaScript to explore concurrency models in the browser, using Web Workers as the execution environment:

- **Task** – A chunk of code (function body) dynamically embedded and executed by a Web Worker.
- **Process** – A “green thread” representation with its own:
  - **PID**: Process Identifier
  - **Mailbox**: Queued messages
  - **Tasks**: Bundled functions for execution
- **Scheduler** – Responsible for deciding which Processes to run or terminate, and for visualizing their states.
- **WorkerPool** – A pool of Web Workers managed by the Scheduler, providing the backend for concurrent task execution.

## Project Structure

- BEAMBrowser/
  - src/
    - Task.js
    - Process.js
    - Scheduler.js
    - WorkerPool.js
    - workers/
      - worker.js (The actual Web Worker code)
  - README.md
  - index.html

### Task

- **File:** `Task.js`
- **Responsibilities:**
  - Encapsulates a small function body (JavaScript code) to be executed in a Web Worker.
  - Can be serialized and sent to a worker thread.
  - (Optional) May include logic for arguments or return values.

### Process

- **File:** `Process.js`
- **Responsibilities:**
  - Represents a “green thread” with:
    - **PID**: A unique identifier.
    - **Mailbox**: A queue for incoming messages (from other Processes, system events, etc.).
    - **Tasks**: One or more `Task` objects that the Process will execute in sequence.
  - Provides methods like:
    - `send(message)` – Send a message to another Process’s mailbox.
    - `receive()` – Pop a message from its own mailbox.
    - `runTask(task)` – Execute a task (optionally via a Web Worker).

### Scheduler

- **File:** `Scheduler.js`
- **Responsibilities:**
  - Manages creation and lifecycle of `Process` objects.
  - Decides which `Process` runs next (“preemptive” or “cooperative” scheduling).
  - Terminates finished or blocked Processes.
  - Provides visualization or debugging of:
    - Active Processes, PIDs
    - Mailbox status
    - State transitions

### WorkerPool

- **File:** `WorkerPool.js`
- **Responsibilities:**
  - Manages a pool of Web Workers.
  - Receives tasks from the Scheduler, assigns them to idle workers.
  - Coordinates responses/results back to the Scheduler.
  - Ensures efficient reuse of Web Workers instead of spawning new workers repeatedly.

## Getting Started

1. **Clone the Repository**
   ```bash
   git clone git@github-vidy:vyredo/BEAMBrowser.git
   cd BEAMBrowser
   ```
