import { homedir } from 'node:os'
import { join } from 'node:path'

export const TEST_PROJECT = process.env.SATURA_TEST_PROJECT || join(homedir(), 'projects', '_satura-test-alt')
