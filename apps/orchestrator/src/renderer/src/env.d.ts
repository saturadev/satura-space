
/// <reference types="vite/client" />

declare global {
  var MonacoEnvironment:
    | {
        getWorker(workerId: string, label: string): Worker
      }
    | undefined
}

export {}
