import {
  Clapperboard,
  Component,
  Ear,
  FileCode2,
  Film,
  Frame,
  Grid3x3,
  Image,
  LayoutTemplate,
  Lightbulb,
  Link,
  Mountain,
  Move3d,
  Navigation,
  Paintbrush,
  PersonStanding,
  Sparkles,
  Spline,
  SquareDashed,
  Type,
  Video,
  Volume2,
  Weight,
  Wind,
  type LucideIcon
} from 'lucide-react'

const BY_TYPE: Record<string, LucideIcon> = {
  Transform: Move3d,
  RectTransform: Frame,
  MeshFilter: Grid3x3,
  MeshRenderer: Paintbrush,
  SkinnedMeshRenderer: PersonStanding,
  SpriteRenderer: Image,
  LineRenderer: Spline,
  TrailRenderer: Spline,
  Animator: Film,
  Animation: Clapperboard,
  Light: Lightbulb,
  Camera: Video,
  AudioSource: Volume2,
  AudioListener: Ear,
  Rigidbody: Weight,
  Rigidbody2D: Weight,
  CharacterController: PersonStanding,
  ParticleSystem: Sparkles,
  ParticleSystemRenderer: Sparkles,
  Canvas: LayoutTemplate,
  Image: Image,
  RawImage: Image,
  Text: Type,
  TextMeshPro: Type,
  TextMeshProUGUI: Type,
  NavMeshAgent: Navigation,
  Terrain: Mountain,
  WindZone: Wind
}

export function componentIcon(type: string): LucideIcon {
  const short = type.slice(type.lastIndexOf('.') + 1)
  const hit = BY_TYPE[short]
  if (hit) return hit
  if (/Collider(2D)?$/.test(short)) return SquareDashed
  if (/Joint(2D)?$/.test(short)) return Link
  if (/Renderer$/.test(short)) return Paintbrush
  return type.startsWith('UnityEngine.') || type.startsWith('TMPro.') ? Component : FileCode2
}
