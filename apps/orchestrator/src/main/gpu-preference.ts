import { app } from 'electron'
import { pinExeToHighPerfGpu } from './win-gpu-affinity'

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('force_high_performance_gpu')
  app.commandLine.appendSwitch('use-angle', 'd3d11')
  pinExeToHighPerfGpu(process.execPath)
}
