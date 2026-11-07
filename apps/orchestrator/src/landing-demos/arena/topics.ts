export interface Topic {
  prop: string
  lines: string[]
}

export interface ComponentTopics {
  title: string
  intro: string
  fields: Topic[]
  outro: string
}

export const TOPICS: Record<string, ComponentTopics> = {
  GameObject: {
    title: 'GameObject',
    intro: 'This header belongs to the object itself, not a component.',
    fields: [
      { prop: 'm_IsActive', lines: ['Untick this and the object switches off, children too.'] },
      { prop: 'm_TagString', lines: ['Tags are labels your code can search for, like Player.'] },
      { prop: 'm_Layer', lines: ['Layers decide what cameras draw and what physics hits.'] }
    ],
    outro: 'Rename it here and the Hierarchy follows.'
  },
  Transform: {
    title: 'Transform',
    intro: 'Every object has a Transform. It says where the thing is.',
    fields: [
      { prop: 'm_LocalPosition', lines: ['Position, measured from the parent.'] },
      { prop: 'm_LocalRotation', lines: ['Rotation in degrees. The timeline keys these on the monolith.'] },
      { prop: 'm_LocalScale', lines: ['Scale per axis. 1, 1, 1 is the mesh at its own size.'] }
    ],
    outro: 'Drag a label left or right to scrub the number.'
  },
  Animator: {
    title: 'Animator',
    intro: 'The Animator plays clips from a controller.',
    fields: [
      { prop: 'm_Controller', lines: ['The controller holds two clips, Hover and Arrival.'] },
      { prop: 'm_ApplyRootMotion', lines: ['On, the clip can move the object itself.'] },
      { prop: 'm_UpdateMode', lines: ['Normal ticks with the frame rate.'] }
    ],
    outro: 'The timeline below edits Hover. Scrub it and the monolith turns.'
  },
  BoxCollider: {
    title: 'Box Collider',
    intro: 'A box collider gives the object a shape physics can hit.',
    fields: [
      { prop: 'm_IsTrigger', lines: ['A trigger reports overlaps but nothing bumps into it.'] },
      { prop: 'm_Center', lines: ["The middle of the box, in the object's own space."] },
      { prop: 'm_Size', lines: ['Width, height and depth of the box.'] }
    ],
    outro: 'Press Edit Collider, then drag the green dots in the scene.'
  },
  SphereCollider: {
    title: 'Sphere Collider',
    intro: 'A sphere is the cheapest collider there is. This one wraps the statue\'s head.',
    fields: [
      { prop: 'm_Center', lines: ['Where the ball sits, in local space.'] },
      { prop: 'm_Radius', lines: ['The radius. It scales with the biggest axis.'] }
    ],
    outro: 'Press Edit Collider and pull a dot to resize the ball.'
  },
  CapsuleCollider: {
    title: 'Capsule Collider',
    intro: 'A capsule is a cylinder with round caps. It suits a standing figure.',
    fields: [
      { prop: 'm_Radius', lines: ['How thick the capsule is.'] },
      { prop: 'm_Height', lines: ['Length end to end, caps included.'] },
      { prop: 'm_Direction', lines: ['Which local axis it runs along.'] }
    ],
    outro: 'Edit Collider puts dots on the sides and the caps.'
  },
  MeshFilter: {
    title: 'Mesh Filter',
    intro: 'The Mesh Filter picks which mesh to draw.',
    fields: [{ prop: 'm_Mesh', lines: ['Click the circle and pick Sphere. The pedestal turns into a ball.'] }],
    outro: 'The renderer below draws whatever mesh is here.'
  },
  MeshRenderer: {
    title: 'Mesh Renderer',
    intro: 'The Mesh Renderer draws the mesh with a material.',
    fields: [
      { prop: 'm_Materials', lines: ['The material sets the color and the shine.'] },
      { prop: 'm_CastShadows', lines: ['Turn this off and its shadow disappears.'] }
    ],
    outro: 'Swap the material and the scene updates right away.'
  },
  ParticleSystem: {
    title: 'Particle System',
    intro: 'These are the motes drifting up past the monolith. Every number here changes them.',
    fields: [
      { prop: 'InitialModule.startLifetime.scalar', lines: ['How long each mote lives, in seconds.'] },
      { prop: 'InitialModule.startSpeed.scalar', lines: ['How fast they rise. Raise it and they stream up.'] },
      { prop: 'InitialModule.startSize.scalar', lines: ['How big each mote is when it spawns.'] },
      { prop: 'InitialModule.gravityModifier.scalar', lines: ['Below zero, they float up instead of falling.'] },
      { prop: 'EmissionModule.rateOverTime.scalar', lines: ['Motes per second.'] },
      { prop: 'ShapeModule.angle', lines: ['The cone angle. Wider spreads them out.'] }
    ],
    outro: 'Each module below is one more rule. Tick a box to switch it on.'
  },
  Light: {
    title: 'Light',
    intro: 'A light. The scene view shows its glow right away.',
    fields: [
      { prop: 'm_Color', lines: ['The color of the light.'] },
      { prop: 'm_Intensity', lines: ['Brightness. 0 turns it off.'] },
      { prop: 'm_Range', lines: ['How far a point light reaches. This one lights the floor around the monolith.'] }
    ],
    outro: 'Untick the box in the header to switch it off.'
  },
  Camera: {
    title: 'Camera',
    intro: 'The game camera. The player sees through this one.',
    fields: [
      { prop: 'field of view', lines: ['How wide it sees, in degrees.'] },
      { prop: 'near clip plane', lines: ['Nothing closer than this gets drawn.'] },
      { prop: 'far clip plane', lines: ['Nothing farther than this gets drawn.'] }
    ],
    outro: 'The scene view has its own camera, so this one stays put.'
  },
  AudioListener: {
    title: 'Audio Listener',
    intro: 'The ears of the game. Scenes usually have one, on the camera.',
    fields: [],
    outro: 'It has no settings, so there is nothing to tweak.'
  }
}

export const PRIORITY = ['ParticleSystem', 'BoxCollider', 'SphereCollider', 'CapsuleCollider', 'Light', 'Camera', 'Animator', 'MeshFilter', 'MeshRenderer', 'AudioListener', 'Transform', 'GameObject']
