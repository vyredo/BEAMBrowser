// basic worker body, to be expanded when task is about to run
onmessage = function (event) {
  const { pid, taskId, state } = event.data;
  const newState = { ...state };
  const outgoingMessages = [];

  postMessage({
    pid,
    taskId,
    result: {
      newState,
      outgoingMessages,
      done: false,
    },
  });
};
