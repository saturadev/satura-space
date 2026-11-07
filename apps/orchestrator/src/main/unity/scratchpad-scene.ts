import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readLastScene, writeLastScene } from './project-scene-state'

const STARTER_SCENE = 'Assets/Scenes/Scratchpad.unity'

const STARTER_SCENE_YAML = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100000
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 100001}
  - component: {fileID: 100002}
  - component: {fileID: 100003}
  m_Layer: 0
  m_Name: Main Camera
  m_TagString: MainCamera
  m_IsActive: 1
--- !u!4 &100001
Transform:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 100000}
  serializedVersion: 2
  m_LocalRotation: {x: 0.21643962, y: 0, z: 0, w: 0.976296}
  m_LocalPosition: {x: 0, y: 3, z: -8}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children: []
  m_Father: {fileID: 0}
  m_LocalEulerAnglesHint: {x: 25, y: 0, z: 0}
--- !u!20 &100002
Camera:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 100000}
  m_Enabled: 1
  serializedVersion: 2
  m_ClearFlags: 1
  m_BackGroundColor: {r: 0.19215687, g: 0.3019608, b: 0.4745098, a: 0}
  near clip plane: 0.3
  far clip plane: 1000
  field of view: 60
  orthographic: 0
  m_Depth: -1
--- !u!81 &100003
AudioListener:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 100000}
  m_Enabled: 1
--- !u!1 &200000
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 200001}
  - component: {fileID: 200002}
  m_Layer: 0
  m_Name: Directional Light
  m_TagString: Untagged
  m_IsActive: 1
--- !u!4 &200001
Transform:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 200000}
  serializedVersion: 2
  m_LocalRotation: {x: 0.40821788, y: -0.23456968, z: 0.10938163, w: 0.8754261}
  m_LocalPosition: {x: 0, y: 3, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children: []
  m_Father: {fileID: 0}
  m_LocalEulerAnglesHint: {x: 50, y: -30, z: 0}
--- !u!108 &200002
Light:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 200000}
  m_Enabled: 1
  serializedVersion: 10
  m_Type: 1
  m_Color: {r: 1, g: 0.95686275, b: 0.8392157, a: 1}
  m_Intensity: 1
  m_Shadows:
    m_Type: 2
`

function hasScene(dir: string): boolean {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.unity')) return true
    if (e.isDirectory() && hasScene(join(dir, e.name))) return true
  }
  return false
}

export function ensureStarterScene(scratchpadPath: string): void {
  const last = readLastScene(scratchpadPath)
  if (last && existsSync(join(scratchpadPath, last))) return
  const starter = join(scratchpadPath, STARTER_SCENE)
  if (!existsSync(starter)) {
    if (hasScene(join(scratchpadPath, 'Assets'))) return
    mkdirSync(join(scratchpadPath, 'Assets', 'Scenes'), { recursive: true })
    writeFileSync(starter, STARTER_SCENE_YAML)
  }
  writeLastScene(scratchpadPath, STARTER_SCENE)
}
