import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_RECENT_SCENES } from '@shared/unity/world'
import { SSPACE_DIR as SSPACE, ensureProjectSspaceSync } from '../sspace'

export const LAST_SCENE_FILE = 'last-scene.json'

interface SceneState {
  scene: string | null
  recent: string[]
}

function lastSceneFile(projectPath: string): string {
  return join(projectPath, SSPACE, LAST_SCENE_FILE)
}

function readState(projectPath: string): SceneState {
  const empty: SceneState = { scene: null, recent: [] }
  if (!projectPath) return empty
  try {
    const parsed = JSON.parse(readFileSync(lastSceneFile(projectPath), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return empty
    const rawScene = (parsed as { scene?: unknown }).scene
    const scene = typeof rawScene === 'string' && rawScene.length > 0 ? rawScene : null
    const rawRecent = (parsed as { recent?: unknown }).recent
    const recent = Array.isArray(rawRecent)
      ? rawRecent.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : scene
        ? [scene]
        : []
    return { scene, recent: recent.slice(0, MAX_RECENT_SCENES) }
  } catch {
    return empty
  }
}

function writeState(projectPath: string, state: SceneState): boolean {
  try {
    ensureProjectSspaceSync(projectPath)
    writeFileSync(lastSceneFile(projectPath), JSON.stringify(state), 'utf8')
    return true
  } catch {
    return false
  }
}

export function readLastScene(projectPath: string): string | null {
  return readState(projectPath).scene
}

export function readRecentScenes(projectPath: string): string[] {
  return readState(projectPath).recent
}

export function writeLastScene(projectPath: string, scene: string): boolean {
  if (!projectPath || typeof scene !== 'string' || scene.length === 0) return false
  const prev = readState(projectPath)
  const recent = [scene, ...prev.recent.filter((s) => s !== scene)].slice(0, MAX_RECENT_SCENES)
  return writeState(projectPath, { scene, recent })
}

export function writeObservedScene(projectPath: string, scene: string): boolean {
  if (!projectPath || typeof scene !== 'string' || scene.length === 0) return false
  const prev = readState(projectPath)
  if (prev.scene === scene) return true
  return writeState(projectPath, { scene, recent: prev.recent })
}

export function removeRecentScene(projectPath: string, scene: string): boolean {
  if (!projectPath || typeof scene !== 'string' || scene.length === 0) return false
  const prev = readState(projectPath)
  if (!prev.recent.includes(scene)) return true
  return writeState(projectPath, { scene: prev.scene, recent: prev.recent.filter((s) => s !== scene) })
}
